import type { ProviderContext, StandardUsageProvider, UsageMonitorConfig, UsageProviderAdapter } from "./types.js";
import { openAIUsageAdapter } from "./openai.js";
import { zaiUsageAdapter } from "./zai.js";
import { sanitizeError } from "../sanitize.js";

export const PROVIDER_ADAPTERS: UsageProviderAdapter[] = [openAIUsageAdapter, zaiUsageAdapter];

export function getActiveAdapters(
  ctx: ProviderContext,
  config: Required<UsageMonitorConfig>,
): UsageProviderAdapter[] {
  return PROVIDER_ADAPTERS.filter((adapter) => {
    if (adapter.id === "openai" && !config.show_openai) return false;
    if (adapter.id === "zai" && !config.show_zai) return false;
    return adapter.isAvailable(ctx);
  });
}

export async function refreshAllAdapters(
  ctx: ProviderContext,
  config: Required<UsageMonitorConfig>,
  signal: AbortSignal,
): Promise<Record<string, StandardUsageProvider>> {
  const adapters = getActiveAdapters(ctx, config);
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.fetchUsage(ctx, signal)));
  return Object.fromEntries(results.map((result, index) => {
    const adapter = adapters[index];
    if (!adapter) return ["unknown", makeErrorProvider("unknown", "unknown", "missing adapter")];
    if (result.status === "fulfilled") return [adapter.id, result.value];
    return [adapter.id, makeErrorProvider(adapter.id, adapter.displayName, sanitizeError(result.reason))];
  }));
}

function makeErrorProvider(id: string, displayName: string, message: string): StandardUsageProvider {
  return {
    id,
    displayName,
    status: "error",
    errorMessage: sanitizeError(message),
    statusText: sanitizeError(message),
    windows: [],
  };
}
