import type { ProviderContext, StandardUsageProvider, UsageMonitorConfig, UsageProviderAdapter } from "./types.js";
import { openAIUsageAdapter } from "./openai.js";
import { zaiUsageAdapter } from "./zai.js";
import { deepseekUsageAdapter } from "./deepseek.js";
import { sanitizeError } from "../sanitize.js";

export const PROVIDER_ADAPTERS: readonly UsageProviderAdapter[] = Object.freeze([
  openAIUsageAdapter,
  zaiUsageAdapter,
  deepseekUsageAdapter,
]);

export function selectActiveAdapters(
  adapters: readonly UsageProviderAdapter[],
  ctx: ProviderContext,
  config: Required<UsageMonitorConfig>,
): UsageProviderAdapter[] {
  return adapters.filter((adapter) => {
    if (adapter.configKey && !isConfigEnabled(config[adapter.configKey])) return false;
    return adapter.isAvailable(ctx);
  });
}

export async function refreshAdapters(
  adapters: readonly UsageProviderAdapter[],
  ctx: ProviderContext,
  config: Required<UsageMonitorConfig>,
  signal: AbortSignal,
): Promise<Record<string, StandardUsageProvider>> {
  const active = selectActiveAdapters(adapters, ctx, config);
  const results = await Promise.allSettled(active.map((adapter) => adapter.fetchUsage(ctx, signal)));
  return Object.fromEntries(results.map((result, index) => {
    const adapter = active[index];
    if (!adapter) return ["unknown", makeErrorProvider("unknown", "unknown", "missing adapter")];
    if (result.status === "fulfilled") return [adapter.id, result.value];
    return [adapter.id, makeErrorProvider(adapter.id, adapter.displayName, sanitizeError(result.reason))];
  }));
}

export function getActiveAdapters(
  ctx: ProviderContext,
  config: Required<UsageMonitorConfig>,
): UsageProviderAdapter[] {
  return selectActiveAdapters(PROVIDER_ADAPTERS, ctx, config);
}

export async function refreshAllAdapters(
  ctx: ProviderContext,
  config: Required<UsageMonitorConfig>,
  signal: AbortSignal,
): Promise<Record<string, StandardUsageProvider>> {
  return refreshAdapters(PROVIDER_ADAPTERS, ctx, config, signal);
}

function isConfigEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
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
