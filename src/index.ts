import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const PROVIDER_ID = "omniroute";
const DEFAULT_BASE_URL = "http://localhost:20128";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface BridgeConfig {
	baseUrl: string;
	apiKey?: string;
	enabled: boolean;
	dailySync: boolean;
	syncIntervalHours: number;
	providerId: string;
	includePattern?: string;
	excludePattern?: string;
	lastSyncAt?: string;
	lastSyncError?: string;
}

interface CacheEntry {
	fetchedAt: string;
	baseUrl: string;
	models: PiModel[];
	raw: unknown;
}

interface PiModel {
	id: string;
	name?: string;
	api?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	[key: string]: unknown;
}

interface PiModelsJson {
	providers?: Record<string, unknown>;
	[key: string]: unknown;
}

const CONFIG_DIR = path.join(homedir(), ".pi", "agent", "omniroute-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const CACHE_PATH = path.join(CONFIG_DIR, "models-cache.json");
const PI_MODELS_PATH = path.join(homedir(), ".pi", "agent", "models.json");

function redact(value?: string): string | undefined {
	if (!value) return undefined;
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizeBaseUrl(input: string): string {
	return input.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function v1BaseUrl(baseUrl: string): string {
	return `${normalizeBaseUrl(baseUrl)}/v1`;
}

function endpoint(baseUrl: string, suffix: string): string {
	return `${v1BaseUrl(baseUrl)}/${suffix.replace(/^\/+/, "")}`;
}

function providerConfig(config: BridgeConfig, models: PiModel[]): ProviderConfig {
	return {
		baseUrl: v1BaseUrl(config.baseUrl),
		// Dynamic provider registration can use the stored key directly, which makes
		// the bridge survive Pi restarts even when the user's shell did not export it.
		apiKey: config.apiKey || "$OMNI_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models: models.map((model) => ({
			...model,
			name: model.name ?? model.id,
			reasoning: model.reasoning ?? false,
			input: (model.input as ("text" | "image")[] | undefined) ?? ["text"],
			cost: {
				input: model.cost?.input ?? 0,
				output: model.cost?.output ?? 0,
				cacheRead: model.cost?.cacheRead ?? 0,
				cacheWrite: model.cost?.cacheWrite ?? 0,
			},
			contextWindow: model.contextWindow ?? 128000,
			maxTokens: model.maxTokens ?? 16384,
		})),
	};
}

function hydrateOmniApiKey(config: BridgeConfig) {
	if (config.apiKey) process.env.OMNI_API_KEY = config.apiKey;
}

async function ensureConfigDir() {
	await mkdir(CONFIG_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function atomicWriteJson(file: string, data: unknown) {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	await rename(tmp, file);
}

async function loadConfig(): Promise<BridgeConfig> {
	return readJson<BridgeConfig>(CONFIG_PATH, {
		baseUrl: DEFAULT_BASE_URL,
		enabled: true,
		dailySync: true,
		syncIntervalHours: 24,
		providerId: PROVIDER_ID,
	});
}

async function saveConfig(config: BridgeConfig) {
	await ensureConfigDir();
	await atomicWriteJson(CONFIG_PATH, config);
}

function compilePattern(pattern?: string): RegExp | undefined {
	if (!pattern?.trim()) return undefined;
	return new RegExp(pattern.trim(), "i");
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "audio", "moderation", "rerank", "tts", "stt"]);
function normalizeModel(raw: Record<string, unknown>): PiModel | null {
	const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : undefined;
	if (!id) return null;
	// Skip non-chat models (embeddings, image/video generation, etc.) — pi can only use chat models.
	if (typeof raw.type === "string" && NON_CHAT_TYPES.has(raw.type.toLowerCase())) return null;
	const model: PiModel = { id };
	if (typeof raw.name === "string" && raw.name !== id) model.name = raw.name;
	else model.name = id;

	const contextWindow = toNumber(raw.contextWindow ?? raw.context_window ?? raw.context_length ?? raw.max_context_tokens);
	if (contextWindow) model.contextWindow = contextWindow;
	const maxTokens = toNumber(raw.maxTokens ?? raw.max_tokens ?? raw.max_output_tokens);
	if (maxTokens) model.maxTokens = maxTokens;

	const ownedBy = typeof raw.owned_by === "string" ? raw.owned_by : undefined;
	const caps = raw.capabilities && typeof raw.capabilities === "object" ? (raw.capabilities as Record<string, unknown>) : undefined;
	const inputModalities = Array.isArray(raw.input_modalities) ? (raw.input_modalities as unknown[]) : undefined;
	// Vision/image input: prefer explicit metadata, fall back to id heuristic.
	if (inputModalities?.includes("image") || caps?.vision === true || id.toLowerCase().includes("vision")) {
		model.input = ["text", "image"];
	}
	// Reasoning/thinking: prefer explicit capabilities, fall back to id heuristic.
	if (caps?.reasoning === true || caps?.thinking === true || id.toLowerCase().includes("reason") || id.toLowerCase().includes("thinking")) {
		model.reasoning = true;
	}
	// Map OmniRoute's declared effort tiers onto pi's thinkingLevelMap so the
	// model picker exposes the model's real vocabulary. Convention: canonical
	// order is none < minimal < low < medium < high < xhigh < max, and xhigh is
	// OmniRoute's internal top tier that normalizes to a native `max` upstream.
	const rawTiers: unknown = caps?.effort_tiers ?? raw.effort_tiers;
	const effortTiers = Array.isArray(rawTiers) ? rawTiers.filter((t): t is string => typeof t === "string") : [];
	if (model.reasoning && effortTiers.length > 0) {
		const canDisable = effortTiers.includes("none");
		const lowest = effortTiers.find((t) => t !== "none");
		const highest = effortTiers[effortTiers.length - 1];
		const map: Record<string, string> = {};
		if (lowest && !canDisable) {
			// Upstream cannot turn thinking off (e.g. GLM-5.3 always reasons), so
			// pi's "off"/"minimal" map to the floor tier instead of a disabled request.
			map.off = lowest;
			map.minimal = lowest;
		}
		if (highest === "max" || highest === "xhigh") map.xhigh = highest;
		if (effortTiers.includes("max")) map.max = "max";
		if (Object.keys(map).length > 0) model.thinkingLevelMap = map;
	}
	if (ownedBy && model.name === id) model.name = `${id} (${ownedBy})`;
	return model;
}

function extractModels(payload: unknown, config: BridgeConfig): PiModel[] {
	const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
		? (payload as { data: unknown[] }).data
		: Array.isArray(payload) ? payload : [];
	const include = compilePattern(config.includePattern);
	const exclude = compilePattern(config.excludePattern);
	const seen = new Set<string>();
	const models: PiModel[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const model = normalizeModel(item as Record<string, unknown>);
		if (!model) continue;
		if (include && !include.test(model.id) && !include.test(model.name ?? "")) continue;
		if (exclude && (exclude.test(model.id) || exclude.test(model.name ?? ""))) continue;
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Give up on /v1/models rather than hang; the on-disk cache is good enough. */
const FETCH_TIMEOUT_MS = 15_000;

async function fetchOmniRouteModels(config: BridgeConfig): Promise<{ models: PiModel[]; raw: unknown }> {
	if (!config.apiKey) throw new Error("OMNI_API_KEY is not configured. Run /omniroute-onboard first.");
	const response = await fetch(endpoint(config.baseUrl, "models"), {
		headers: { Authorization: `Bearer ${config.apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`GET /v1/models failed: ${response.status} ${response.statusText} ${await response.text()}`);
	const raw = await response.json() as unknown;
	return { models: extractModels(raw, config), raw };
}

async function updatePiModels(config: BridgeConfig, models: PiModel[]) {
	const piModels = await readJson<PiModelsJson>(PI_MODELS_PATH, { providers: {} });
	piModels.providers ??= {};
	piModels.providers[config.providerId || PROVIDER_ID] = providerConfig({ ...config, apiKey: undefined }, models);
	await atomicWriteJson(PI_MODELS_PATH, piModels);
}

async function syncModels(): Promise<{ config: BridgeConfig; cache: CacheEntry }> {
	const config = await loadConfig();
	if (!config.enabled) throw new Error("OmniRoute bridge is disabled.");
	try {
		const { models, raw } = await fetchOmniRouteModels(config);
		const cache: CacheEntry = { fetchedAt: new Date().toISOString(), baseUrl: normalizeBaseUrl(config.baseUrl), models, raw };
		await atomicWriteJson(CACHE_PATH, cache);
		config.lastSyncAt = cache.fetchedAt;
		delete config.lastSyncError;
		await saveConfig(config);
		await updatePiModels(config, models);
		return { config, cache };
	} catch (error) {
		config.lastSyncError = error instanceof Error ? error.message : String(error);
		await saveConfig(config);
		throw error;
	}
}

async function maybeDailySync(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }) {
	const config = await loadConfig();
	hydrateOmniApiKey(config);
	if (!config.enabled || !config.dailySync) return;
	const last = config.lastSyncAt ? Date.parse(config.lastSyncAt) : 0;
	const interval = Math.max(1, config.syncIntervalHours || 24) * 60 * 60 * 1000;
	if (Date.now() - last < interval) return;
	try {
		const { cache } = await syncModels();
		ctx.ui.notify(`OmniRoute synced ${cache.models.length} models. Use /reload or restart pi if /model does not update immediately.`, "info");
	} catch (error) {
		ctx.ui.notify(`OmniRoute daily sync failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

const statusTool = defineTool({
	name: "omniroute_status",
	label: "OmniRoute status",
	description: "Show OmniRoute bridge config, cache age, and synced model count without revealing the API key.",
	parameters: Type.Object({}),
	async execute() {
		const config = await loadConfig();
		const cache = await readJson<CacheEntry | null>(CACHE_PATH, null);
		return {
			content: [{ type: "text", text: JSON.stringify({ ...config, apiKey: redact(config.apiKey), cache: cache ? { fetchedAt: cache.fetchedAt, modelCount: cache.models.length, baseUrl: cache.baseUrl } : null }, null, 2) }],
			details: { config: { ...config, apiKey: redact(config.apiKey) }, cache },
		};
	},
});

// ─── /usage: provider quota from the OmniRoute management API ────────────────

interface QuotaWindow {
	used?: number;
	total?: number;
	remaining?: number;
	remainingPercentage?: number;
	resetAt?: string | null;
	unlimited?: boolean;
	currency?: string;
	displayName?: string;
}

interface ProviderLimitsEntry {
	plan?: string | null;
	quotas?: Record<string, QuotaWindow> | null;
	message?: string | null;
	fetchedAt?: string;
}

interface QuotaProviderRef {
	provider: string;
	name?: string;
	connectionId: string;
}

interface UsageSnapshot {
	refs: QuotaProviderRef[];
	caches: Record<string, ProviderLimitsEntry>;
	fetchedAt: number;
}

const USAGE_CACHE_TTL_MS = 60_000;
let usageCache: UsageSnapshot | null = null;

const USAGE_LABELS: Record<string, string> = {
	session: "Daily",
	"session (5h)": "Daily",
	daily: "Daily",
	weekly: "Weekly",
	"weekly (7d)": "Weekly",
	monthly: "Monthly",
	credits: "AI Credits",
	free_daily: "Free · daily",
	free_rpm: "Free · rpm",
};

async function fetchManagementJson(config: BridgeConfig, suffix: string): Promise<any> {
	if (!config.apiKey) throw new Error("OMNI_API_KEY is not configured. Run /omniroute-onboard first.");
	const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/${suffix.replace(/^\/+/, "")}`, {
		headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`GET /api/${suffix} failed: ${response.status} ${response.statusText}`);
	}
	return response.json();
}

/** Active connection refs (provider + connection name) for /usage completions. */
async function fetchQuotaProviderRefs(config: BridgeConfig): Promise<QuotaProviderRef[]> {
	const payload = await fetchManagementJson(config, "usage/quota");
	const providers = Array.isArray(payload?.providers) ? payload.providers : [];
	return providers
		.filter((p: any) => typeof p?.connectionId === "string" && typeof p?.provider === "string")
		.map((p: any) => ({ provider: p.provider as string, name: p.name as string | undefined, connectionId: p.connectionId as string }));
}

async function fetchProviderLimitsCaches(config: BridgeConfig): Promise<Record<string, ProviderLimitsEntry>> {
	const payload = await fetchManagementJson(config, "usage/provider-limits");
	return payload?.caches && typeof payload.caches === "object" ? payload.caches : {};
}

async function loadUsageSnapshot(config: BridgeConfig, force = false): Promise<UsageSnapshot> {
	if (!force && usageCache && Date.now() - usageCache.fetchedAt < USAGE_CACHE_TTL_MS) {
		return usageCache;
	}
	const [refs, caches] = await Promise.all([fetchQuotaProviderRefs(config), fetchProviderLimitsCaches(config)]);
	usageCache = { refs, caches, fetchedAt: Date.now() };
	return usageCache;
}

function formatReset(resetAt: string | null | undefined): string {
	if (!resetAt) return "";
	const reset = Date.parse(resetAt);
	if (!Number.isFinite(reset)) return "";
	const diff = reset - Date.now();
	if (diff <= 0) return "reset";
	if (diff < 24 * 60 * 60 * 1000) {
		const hours = Math.floor(diff / 3_600_000);
		const minutes = Math.max(1, Math.round((diff % 3_600_000) / 60_000));
		return hours > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${minutes}m`;
	}
	const wall = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(reset);
	const offsetMin = -new Date().getTimezoneOffset();
	const sign = offsetMin < 0 ? "-" : "+";
	const abs = Math.abs(offsetMin);
	const offset = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
	return `resets ${wall} (${offset})`;
}

function windowRow(labelWidth: number, label: string, quota: QuotaWindow): string {
	const total = Number(quota.total ?? 0);
	const used = Number(quota.used ?? 0);
	const remainingPct = Number(quota.remainingPercentage ?? 0);
	const percentUsed = total > 0 ? (used / total) * 100 : Math.max(0, 100 - remainingPct);
	// Water-tank semantics: the bar shows what is LEFT — full at 100% remaining,
	// empty at 0%.
	const percentLeft = Math.min(100, Math.max(0, 100 - percentUsed));
	const filled = Math.round(percentLeft / 5);
	const bar = "■".repeat(filled) + "·".repeat(20 - filled);
	const reset = formatReset(quota.resetAt);
	const resetPart = reset ? ` · ${reset}` : "";
	return `${label.padEnd(labelWidth)} ${bar}  ${Math.round(percentUsed)}% used${resetPart}`;
}

function creditsRow(labelWidth: number, label: string, quota: QuotaWindow): string {
	const symbol = quota.currency === "USD" ? "$" : `${quota.currency ?? "USD"} `;
	const amount = Number(quota.remaining ?? 0).toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	const capNote = quota.unlimited ? "· unlimited" : `${Math.round(quota.remainingPercentage ?? 0)}% left`;
	return `${label.padEnd(labelWidth)} ${symbol}${amount}  ${capNote}`;
}

const PROVIDER_LABELS: Record<string, string> = {
	antigravity: "Antigravity",
	agy: "Antigravity",
	claude: "Anthropic",
	codex: "Codex",
	deepseek: "DeepSeek",
	"devin-cli": "Devin",
	"devin-cli-agentic": "Devin",
	"devin-desktop": "Devin",
	openrouter: "OpenRouter",
	zai: "Zai",
	glm: "GLM",
	"glm-cn": "GLM",
	glmt: "GLM",
	kimi: "Kimi",
	"kimi-coding": "Kimi",
	minimax: "MiniMax",
	qoder: "Qoder",
	vertex: "Vertex",
	xai: "xAI",
};

function providerLabel(provider: string): string {
	const mapped = PROVIDER_LABELS[provider];
	if (mapped) return mapped;
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function renderConnection(provider: string, name: string | undefined, entry: ProviderLimitsEntry): string {
	const conn = name || provider;
	const providerName = providerLabel(provider);
	if (!entry.quotas || Object.keys(entry.quotas).length === 0) {
		return `${providerName} — ${conn}: ${entry.message ?? "no quota data"}`;
	}
	const rows: Array<{ label: string; quota: QuotaWindow; credits: boolean }> = [];
	for (const [key, quota] of Object.entries(entry.quotas)) {
		if (!quota || typeof quota !== "object") continue;
		if (quota.currency) {
			// Negative balances are upstream accounting dust (e.g. a near-empty
			// secondary-currency wallet) — skip them; a 0 balance still shows.
			if (Number(quota.remaining ?? 0) <= 0) continue;
			rows.push({ label: USAGE_LABELS.credits ?? "AI Credits", quota, credits: true });
		} else {
			rows.push({ label: quota.displayName || USAGE_LABELS[key] || key, quota, credits: false });
		}
	}
	const labelWidth = Math.max(10, ...rows.map((row) => row.label.length));
	const lines = rows.map((row) =>
		row.credits ? creditsRow(labelWidth, row.label, row.quota) : windowRow(labelWidth, row.label, row.quota)
	);
	// Header describes provider + connection + plan, e.g.
	// "Zai — xxxxxxace (Max plan)". When the connection name already leads with
	// the provider (users rename connections to carry plan/pricing notes), don't
	// duplicate it. A plan that merely repeats the provider ("OpenRouter",
	// "DeepSeek") also adds nothing and is dropped.
	const plan = (entry.plan ?? "").trim();
	const planSuffix =
		plan && plan.toLowerCase() !== providerName.toLowerCase() ? ` (${plan} plan)` : "";
	const connLeadsWithProvider = conn.toLowerCase().startsWith(providerName.toLowerCase());
	const header = connLeadsWithProvider ? `${conn}${planSuffix}` : `${providerName} — ${conn}${planSuffix}`;
	return [header, ...lines].join("\n");
}

export default async function omnirouteBridge(pi: ExtensionAPI) {
	const startupConfig = await loadConfig();
	hydrateOmniApiKey(startupConfig);
	const startupCache = await readJson<CacheEntry | null>(CACHE_PATH, null);
	if (startupConfig.enabled && startupCache?.models?.length) {
		pi.registerProvider(startupConfig.providerId || PROVIDER_ID, providerConfig(startupConfig, startupCache.models));
	}

	pi.registerTool(statusTool);

	pi.registerCommand("omniroute-onboard", {
		description: "Configure OmniRoute URL and OMNI_API_KEY, then sync models into ~/.pi/agent/models.json.",
		handler: async (_args, ctx) => {
			const current = await loadConfig();
			const baseUrl = await ctx.ui.input("OmniRoute base URL", current.baseUrl || DEFAULT_BASE_URL);
			if (!baseUrl) return;
			const apiKey = await ctx.ui.input("OMNI_API_KEY (stored in bridge config; also export it in your shell for pi model requests)", current.apiKey ? redact(current.apiKey) : "");
			if (!apiKey) return;
			const daily = await ctx.ui.confirm("Enable daily sync?", "The extension will refresh model metadata when pi starts after the sync interval has elapsed.");
			const config: BridgeConfig = {
				...current,
				baseUrl: normalizeBaseUrl(baseUrl),
				apiKey: apiKey.includes("…") ? current.apiKey : apiKey,
				enabled: true,
				dailySync: daily,
				providerId: current.providerId || PROVIDER_ID,
			};
			await saveConfig(config);
			hydrateOmniApiKey(config);
			const { cache } = await syncModels();
			pi.registerProvider(config.providerId || PROVIDER_ID, providerConfig(config, cache.models));
			ctx.ui.notify(`OmniRoute onboarded and synced ${cache.models.length} models. OmniRoute is registered for this session and future restarts.`, "info");
		},
	});

	pi.registerCommand("omniroute-sync", {
		description: "Fetch OmniRoute /v1/models and update Pi ~/.pi/agent/models.json.",
		handler: async (_args, ctx) => {
			const { config, cache } = await syncModels();
			pi.registerProvider(config.providerId || PROVIDER_ID, providerConfig(config, cache.models));
			ctx.ui.notify(`OmniRoute synced and registered ${cache.models.length} models to ${PI_MODELS_PATH}.`, "info");
		},
	});

	pi.registerCommand("omniroute-config", {
		description: "Show or edit OmniRoute bridge configuration. Pass 'edit' to edit JSON.",
		handler: async (args, ctx) => {
			const config = await loadConfig();
			if (args.trim() === "edit") {
				const edited = await ctx.ui.editor("Edit OmniRoute bridge config", JSON.stringify({ ...config, apiKey: config.apiKey ?? "" }, null, "\t"));
				if (!edited) return;
				await saveConfig(JSON.parse(edited) as BridgeConfig);
				ctx.ui.notify("OmniRoute bridge config saved.", "info");
				return;
			}
			ctx.ui.notify(`OmniRoute ${config.enabled ? "enabled" : "disabled"}: ${config.baseUrl}; key=${redact(config.apiKey)}; last=${config.lastSyncAt ?? "never"}`, config.lastSyncError ? "warning" : "info");
		},
	});

	pi.registerCommand("omniroute-cache", {
		description: "Show cached OmniRoute model metadata summary.",
		handler: async (_args, ctx) => {
			const cache = await readJson<CacheEntry | null>(CACHE_PATH, null);
			if (!cache) return ctx.ui.notify("No OmniRoute model cache yet. Run /omniroute-sync.", "warning");
			const preview = cache.models.slice(0, 12).map((m) => m.id).join(", ");
			ctx.ui.notify(`OmniRoute cache: ${cache.models.length} models fetched ${cache.fetchedAt}. ${preview}${cache.models.length > 12 ? ", …" : ""}`, "info");
		},
	});

	pi.registerCommand("usage", {
		description: "Show OmniRoute provider quota (windows + credits). Optionally pass a provider name.",
		getArgumentCompletions: async (argumentPrefix) => {
			const config = await loadConfig();
			if (!config.enabled || !config.apiKey) return null;
			try {
				const snapshot = await loadUsageSnapshot(config);
				const query = argumentPrefix.trim().toLowerCase();
				const byProvider = new Map<string, { count: number; plans: Set<string> }>();
				for (const ref of snapshot.refs) {
					const hit = byProvider.get(ref.provider) ?? { count: 0, plans: new Set<string>() };
					hit.count += 1;
					const plan = snapshot.caches[ref.connectionId]?.plan;
					if (plan) hit.plans.add(plan);
					byProvider.set(ref.provider, hit);
				}
				return [...byProvider.entries()]
					.filter(([provider]) => !query || provider.toLowerCase().startsWith(query))
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([provider, info]) => ({
						value: provider,
						label: provider,
						description: [...info.plans].join(", ") || `${info.count} connection${info.count === 1 ? "" : "s"}`,
					}));
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			const config = await loadConfig();
			if (!config.enabled) return ctx.ui.notify("OmniRoute bridge is disabled.", "warning");
			ctx.ui.notify("Fetching quota…", "info");
			try {
				await loadUsageSnapshot(config, true);
				const arg = args.trim().toLowerCase();
				const matches = (arg
					? usageCache!.refs.filter((ref) => ref.provider.toLowerCase() === arg)
					: usageCache!.refs
				).slice().sort(
					(a, b) =>
						a.provider.localeCompare(b.provider) ||
						(a.name ?? "").localeCompare(b.name ?? "")
				);
				if (matches.length === 0) {
					const available = [...new Set(usageCache!.refs.map((r) => r.provider))].sort().join(", ");
					return ctx.ui.notify(`No active OmniRoute connection for "${args.trim()}". Available: ${available || "none"}`, "warning");
				}
				const blocks: string[] = [];
				for (const ref of matches) {
					const entry = usageCache!.caches[ref.connectionId];
					if (!entry) continue;
					blocks.push(renderConnection(ref.provider, ref.name, entry));
				}
				if (blocks.length === 0) {
					return ctx.ui.notify("No OmniRoute quota caches yet. The router refreshes them on its Provider Limits schedule; try again shortly.", "warning");
				}
				ctx.ui.notify(blocks.join("\n\n"), "info");
			} catch (error) {
				ctx.ui.notify(`OmniRoute usage failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Register from the on-disk cache first so models are available
		// immediately, then refresh in the background. Awaiting the sync here
		// put a network round-trip on the startup path for data we already have.
		const config = await loadConfig();
		// Keep the key in the environment for model requests; maybeDailySync also
		// does this, but it no longer runs before we return.
		hydrateOmniApiKey(config);
		const cache = await readJson<CacheEntry | null>(CACHE_PATH, null);
		if (config.enabled && cache?.models?.length) {
			pi.registerProvider(config.providerId || PROVIDER_ID, providerConfig(config, cache.models));
		}
		void maybeDailySync(ctx);
	});
}

export { CONFIG_PATH, CACHE_PATH, PI_MODELS_PATH, syncModels };
