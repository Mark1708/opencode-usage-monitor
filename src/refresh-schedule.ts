import {
  type CacheV2ReadResult,
  type CacheV2Target,
  validateCacheScope,
} from "./provider-cache.js";
import type { ResolvedProviderConfigV2, ResolvedRefreshConfigV2 } from "./config-types.js";
import {
  type CredentialResolution,
  createNonSecretAccountMetadataReader,
} from "./credentials.js";
import type { CacheScopeMetadata, CredentialLease } from "./providers/contracts.js";
import type { StandardUsageProvider } from "./providers/types.js";
import { successfulRuntimeStatus } from "./refresh-snapshot.js";

export type ProviderRuntimeStatus =
  | "loading"
  | "ready"
  | "partial"
  | "refreshing"
  | "stale"
  | "needs_auth"
  | "forbidden"
  | "unsupported"
  | "config_error"
  | "error";

export interface ProviderRuntimeState {
  readonly id: string;
  readonly generation: number;
  readonly requestSequence: number;
  readonly status: ProviderRuntimeStatus;
  readonly snapshot?: StandardUsageProvider;
  readonly lastAttemptAt?: number;
  readonly lastSuccessAt?: number;
  readonly nextDueAt?: number;
  readonly credentialEpoch: number;
  readonly message?: string;
}

export interface MonotonicClock {
  now(): number;
}

export interface OneShotTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RefreshCache {
  read(target: CacheV2Target): CacheV2ReadResult;
  write(target: CacheV2Target, snapshot: StandardUsageProvider): unknown;
  dispose(): void;
}

export type SelectedResolvedProvider = ResolvedProviderConfigV2;

export type ResolvedCacheScope = Readonly<{
  scope: CacheScopeMetadata | null;
  persistentIdentity: string | null;
}>;

export type ProviderContextState = Readonly<{
  selection: SelectedResolvedProvider;
  credentialEpoch: number;
  accountScope?: string;
  scope?: CacheScopeMetadata | null;
  scopeKey?: string;
}>;

export const CONFIG_ERROR_MESSAGE = "Provider configuration is invalid";
export const CREDENTIAL_MESSAGES = Object.freeze({
  missing: "Credential is required",
  config: "Credential configuration is invalid",
  source: "Credential source is unavailable",
  superseded: "Credential resolution was superseded",
});

export function createInitialStates(
  providers: readonly SelectedResolvedProvider[],
  generation: number,
): ReadonlyMap<string, ProviderRuntimeState> {
  return new Map(providers.map((provider) => [provider.id, freezeState({
    id: provider.id,
    generation,
    requestSequence: 0,
    credentialEpoch: 0,
    status: provider.ok ? "loading" : "config_error",
    ...(provider.ok ? {} : { message: CONFIG_ERROR_MESSAGE }),
  })]));
}

export function createInitialContexts(
  providers: readonly SelectedResolvedProvider[],
): ReadonlyMap<string, ProviderContextState> {
  return new Map(providers.map((provider) => [provider.id, Object.freeze({
    selection: provider,
    credentialEpoch: 0,
  })]));
}

export function reconfigureStates(
  providers: readonly SelectedResolvedProvider[],
  previousProviders: readonly SelectedResolvedProvider[],
  previousStates: ReadonlyMap<string, ProviderRuntimeState>,
  generation: number,
  policy: ResolvedRefreshConfigV2,
  now: number,
): ReadonlyMap<string, ProviderRuntimeState> {
  return new Map(providers.map((provider) => {
    const priorSelection = previousProviders.find((candidate) => candidate.id === provider.id);
    const prior = priorSelection === provider ? previousStates.get(provider.id) : undefined;
    return [provider.id, reconfiguredState(provider, prior, generation, policy, now)];
  }));
}

export function reconfigureContexts(
  providers: readonly SelectedResolvedProvider[],
  previousProviders: readonly SelectedResolvedProvider[],
  previous: ReadonlyMap<string, ProviderContextState>,
): ReadonlyMap<string, ProviderContextState> {
  return new Map(providers.map((provider) => {
    const priorSelection = previousProviders.find((candidate) => candidate.id === provider.id);
    const prior = priorSelection === provider ? previous.get(provider.id) : undefined;
    return [provider.id, prior ?? Object.freeze({ selection: provider, credentialEpoch: 0 })];
  }));
}

export function deriveScope(
  provider: SelectedResolvedProvider & { readonly ok: true },
  lease: CredentialLease,
): Readonly<{ ok: true; value: ResolvedCacheScope }> | Readonly<{ ok: false }> {
  const reader = createNonSecretAccountMetadataReader(
    { credential_variant: lease.variant },
    ["credential_variant"],
  );
  if (!reader.ok) return { ok: false };
  try {
    const raw = provider.binding.resolveCacheScopeMetadata(reader.value);
    if (raw instanceof Promise) {
      void raw.catch(() => undefined);
      return { ok: false };
    }
    if (raw === null) return { ok: true, value: Object.freeze({ scope: null, persistentIdentity: null }) };
    const validated = validateCacheScope(provider.id, raw);
    return validated
      ? { ok: true, value: Object.freeze({ scope: validated.scope, persistentIdentity: validated.identity }) }
      : { ok: false };
  } catch (_error: unknown) {
    return { ok: false };
  }
}

export function safeCacheRead(cache: RefreshCache, target: CacheV2Target): CacheV2ReadResult {
  try {
    return cache.read(target);
  } catch (_error: unknown) {
    return { status: "invalid", diagnostic: "cache-invalid" };
  }
}

export function safeCacheWrite(
  cache: RefreshCache,
  target: CacheV2Target,
  snapshot: StandardUsageProvider,
): void {
  try {
    cache.write(target, snapshot);
  } catch (_error: unknown) {
    return;
  }
}

export function scopeIdentity(scope: ResolvedCacheScope, accountScope: string): string {
  return scope.persistentIdentity ?? JSON.stringify(["memory", accountScope]);
}

export function makeTarget(
  providerId: string,
  generation: number,
  credentialEpoch: number,
  accountScope: string,
  scope: CacheScopeMetadata | null,
): CacheV2Target {
  return Object.freeze({ providerId, generation, credentialEpoch, accountScope, scope });
}

export function shouldRefreshImmediately(state: ProviderRuntimeState | undefined, now: number): boolean {
  return !state
    || state.status === "stale"
    || state.nextDueAt === undefined
    || state.nextDueAt <= now;
}

export function credentialErrorStatus(
  kind: Exclude<CredentialResolution, { ok: true }>["kind"],
): ProviderRuntimeStatus {
  if (kind === "missing") return "needs_auth";
  if (kind === "config") return "config_error";
  return "error";
}

export function automaticDue(policy: ResolvedRefreshConfigV2, completedAt: number): number | undefined {
  return policy.mode === "automatic" ? completedAt + policy.interval_ms : undefined;
}

export function nearestDeadline(
  states: readonly ProviderRuntimeState[],
  policy: ResolvedRefreshConfigV2,
  busyIds: ReadonlySet<string>,
): number | undefined {
  const deadlines = states.flatMap((state) => stateDeadlines(state, policy, busyIds));
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

export function isDue(state: ProviderRuntimeState | undefined, now: number): boolean {
  return state?.status === "stale"
    || (state?.nextDueAt !== undefined && state.nextDueAt <= now);
}

export function becomesStale(
  state: ProviderRuntimeState,
  policy: ResolvedRefreshConfigV2,
  now: number,
): boolean {
  return (state.status === "ready" || state.status === "partial")
    && state.lastSuccessAt !== undefined
    && now - state.lastSuccessAt >= policy.stale_after_ms;
}

export function freezeState(state: ProviderRuntimeState): ProviderRuntimeState {
  return Object.freeze(state);
}

export function withoutKey<K, V>(source: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(source);
  next.delete(key);
  return next;
}

export const DEFAULT_CLOCK: MonotonicClock = Object.freeze({ now: () => Date.now() });
export const DEFAULT_TIMERS: OneShotTimers = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number): unknown => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

function reconfiguredState(
  provider: SelectedResolvedProvider,
  prior: ProviderRuntimeState | undefined,
  generation: number,
  policy: ResolvedRefreshConfigV2,
  now: number,
): ProviderRuntimeState {
  if (!provider.ok) return freezeState({
    id: provider.id, generation, requestSequence: 0, credentialEpoch: 0,
    status: "config_error", message: CONFIG_ERROR_MESSAGE,
  });
  if (!prior) return freezeState({
    id: provider.id, generation, requestSequence: 0, credentialEpoch: 0, status: "loading",
    nextDueAt: policy.mode === "automatic" ? now : undefined,
  });
  return freezeState({
    ...prior,
    generation,
    requestSequence: 0,
    status: retainedStatus(prior, policy, now),
    nextDueAt: recomputedDue(prior, policy, now),
    message: undefined,
  });
}

function retainedStatus(
  prior: ProviderRuntimeState,
  policy: ResolvedRefreshConfigV2,
  now: number,
): ProviderRuntimeStatus {
  if (!prior.snapshot || prior.lastSuccessAt === undefined) return "loading";
  if (now - prior.lastSuccessAt >= policy.stale_after_ms) return "stale";
  return successfulRuntimeStatus(prior.snapshot);
}

function recomputedDue(
  prior: ProviderRuntimeState,
  policy: ResolvedRefreshConfigV2,
  now: number,
): number | undefined {
  if (policy.mode !== "automatic") return undefined;
  const completedAt = prior.lastAttemptAt ?? prior.lastSuccessAt;
  return completedAt === undefined ? now : completedAt + policy.interval_ms;
}

function stateDeadlines(
  state: ProviderRuntimeState,
  policy: ResolvedRefreshConfigV2,
  busyIds: ReadonlySet<string>,
): readonly number[] {
  const automatic = !busyIds.has(state.id) && policy.mode === "automatic"
    ? state.nextDueAt
    : undefined;
  const stale = (state.status === "ready" || state.status === "partial")
    && state.lastSuccessAt !== undefined
    ? state.lastSuccessAt + policy.stale_after_ms
    : undefined;
  return [automatic, stale].filter((value): value is number => value !== undefined);
}
