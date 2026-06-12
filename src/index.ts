import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

async function fetchOmniRouteModels(config: BridgeConfig): Promise<{ models: PiModel[]; raw: unknown }> {
	if (!config.apiKey) throw new Error("OMNI_API_KEY is not configured. Run /omniroute-onboard first.");
	const response = await fetch(endpoint(config.baseUrl, "models"), {
		headers: { Authorization: `Bearer ${config.apiKey}` },
	});
	if (!response.ok) throw new Error(`GET /v1/models failed: ${response.status} ${response.statusText} ${await response.text()}`);
	const raw = await response.json() as unknown;
	return { models: extractModels(raw, config), raw };
}

async function updatePiModels(config: BridgeConfig, models: PiModel[]) {
	const piModels = await readJson<PiModelsJson>(PI_MODELS_PATH, { providers: {} });
	piModels.providers ??= {};
	piModels.providers[config.providerId || PROVIDER_ID] = {
		baseUrl: v1BaseUrl(config.baseUrl),
		apiKey: "$OMNI_API_KEY",
		api: "openai-completions",
		authHeader: true,
		models,
	};
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

export default function omnirouteBridge(pi: ExtensionAPI) {
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
			process.env.OMNI_API_KEY = config.apiKey;
			const { cache } = await syncModels();
			ctx.ui.notify(`OmniRoute onboarded and synced ${cache.models.length} models. Export OMNI_API_KEY in your shell and run /reload.`, "info");
		},
	});

	pi.registerCommand("omniroute-sync", {
		description: "Fetch OmniRoute /v1/models and update Pi ~/.pi/agent/models.json.",
		handler: async (_args, ctx) => {
			const { cache } = await syncModels();
			ctx.ui.notify(`OmniRoute synced ${cache.models.length} models to ${PI_MODELS_PATH}. Run /reload if needed.`, "info");
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

	pi.on("session_start", async (_event, ctx) => {
		await maybeDailySync(ctx);
	});
}

export { CONFIG_PATH, CACHE_PATH, PI_MODELS_PATH, syncModels };
