import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { StandardUsageProvider } from "./providers/types.js";

type CachePayload = {
  version: 1;
  providers: Record<string, StandardUsageProvider>;
};

const CACHE_FILE_NAME = "usage-monitor.json";

export let CACHE_DIR = join(process.env.HOME ?? homedir(), ".cache", "opencode");

export function setCacheDirForTests(cacheDir: string): void {
  CACHE_DIR = cacheDir;
}

export function getCachePath(): string {
  return join(CACHE_DIR, CACHE_FILE_NAME);
}

/** Read cache. Returns null if missing/corrupt. Never throws. */
export function readCache(): Record<string, StandardUsageProvider> | null {
  try {
    const cachePath = getCachePath();
    const content = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!isCachePayload(parsed)) return null;
    return parsed.providers;
  } catch {
    return null;
  }
}

/** Write cache atomically (write to .tmp, then rename). Never throws. */
export function writeCache(providers: Record<string, StandardUsageProvider>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const cachePath = getCachePath();
    const tmpPath = `${cachePath}.tmp`;
    const payload: CachePayload = { version: 1, providers };
    writeFileSync(tmpPath, JSON.stringify(payload, null, 0));
    renameSync(tmpPath, cachePath);
  } catch {
    return;
  }
}

/** Check if a single provider's cached data is fresh enough */
export function isProviderFresh(provider: StandardUsageProvider, ttlMs: number): boolean {
  return provider.fetchedAt !== undefined && Date.now() - provider.fetchedAt < ttlMs;
}

/** Filter out stale providers, return only fresh ones. May be empty. */
export function filterFreshProviders(
  cached: Record<string, StandardUsageProvider>,
  ttlMs: number,
): Record<string, StandardUsageProvider> {
  return Object.fromEntries(Object.entries(cached).filter(([, provider]) => isProviderFresh(provider, ttlMs)));
}

/** Get IDs of stale providers that need refresh */
export function staleProviderIds(
  cached: Record<string, StandardUsageProvider> | null,
  activeIds: string[],
  ttlMs: number,
): string[] {
  if (cached === null) return activeIds;
  return activeIds.filter((id) => {
    const provider = cached[id];
    return provider === undefined || !isProviderFresh(provider, ttlMs);
  });
}

function isCachePayload(value: unknown): value is CachePayload {
  if (!isRecord(value)) return false;
  return value.version === 1 && isProviderRecord(value.providers);
}

function isProviderRecord(value: unknown): value is Record<string, StandardUsageProvider> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isStandardUsageProvider);
}

function isStandardUsageProvider(value: unknown): value is StandardUsageProvider {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.displayName === "string"
    && isProviderStatus(value.status)
    && Array.isArray(value.windows);
}

function isProviderStatus(value: unknown): value is StandardUsageProvider["status"] {
  return value === "loading"
    || value === "ready"
    || value === "partial"
    || value === "missing-auth"
    || value === "forbidden"
    || value === "unsupported"
    || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
