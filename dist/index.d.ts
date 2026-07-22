import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
    cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    [key: string]: unknown;
}
declare const CONFIG_PATH: string;
declare const CACHE_PATH: string;
declare const PI_MODELS_PATH: string;
declare function syncModels(): Promise<{
    config: BridgeConfig;
    cache: CacheEntry;
}>;
export default function omnirouteBridge(pi: ExtensionAPI): Promise<void>;
export { CONFIG_PATH, CACHE_PATH, PI_MODELS_PATH, syncModels };
