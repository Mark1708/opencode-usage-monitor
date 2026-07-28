/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import type { CacheV2Target } from "../provider-cache.js";
import type { ResolvedProviderConfigV2, ResolvedRefreshConfigV2 } from "../config-types.js";
import type { CredentialResolution } from "../credentials.js";
import type {
  CredentialLease,
  NonSecretAccountMetadataReader,
  ProviderBinding,
  ProviderRegistration,
} from "../providers/contracts.js";
import type { StandardUsageProvider } from "../providers/types.js";
import { createRefreshCoordinator, type RefreshCache, type RefreshCredentialResolver } from "../refresh.js";
import type { ProviderUsageView } from "../views/types.js";

const POLICY_MANUAL: ResolvedRefreshConfigV2 = Object.freeze({
  mode: "manual",
  interval_ms: 1_000,
  timeout_ms: 250,
  stale_after_ms: 500,
});
const ACCOUNT_SCOPE = "11111111-1111-4111-8111-111111111111";
const LEASE: CredentialLease = Object.freeze({ secret: "secret-alpha", source: "env", variant: "fixture", epoch: 1 });

type Deferred<T> = Readonly<{ promise: Promise<T>; resolve(value: T): void }>;

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return Object.freeze({ promise, resolve: (value) => resolvePromise?.(value) });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function snapshot(id = "review-provider", fetchedAt = 1_000): StandardUsageProvider {
  return { id, displayName: id, status: "ready", windows: [], fetchedAt };
}

function registration(id: string): ProviderRegistration {
  const metadata = Object.freeze({
    id,
    displayName: id,
    catalogOrder: 1,
    officialApi: Object.freeze({
      baseUrls: Object.freeze(["https://api.example.test"]),
      documentationUrl: "https://docs.example.test",
      endpoints: Object.freeze([{ method: "GET" as const, path: "/usage" }]),
    }),
  });
  return Object.freeze({
    metadata,
    credentialPolicy: Object.freeze({
      allowedSources: Object.freeze(["env" as const]),
      defaultCandidates: Object.freeze([{ source: "env" as const, variant: "fixture", name: "API_KEY" }]),
    }),
    parseOptions: () => ({ ok: false as const, issues: Object.freeze([]) }),
  });
}

function provider(
  id: string,
  fetchUsage: ProviderBinding["fetchUsage"],
  resolveScope: ProviderBinding["resolveCacheScopeMetadata"] = () => null,
): ResolvedProviderConfigV2 {
  const configured = registration(id);
  const binding: ProviderBinding = Object.freeze({
    metadata: configured.metadata,
    credentialPolicy: configured.credentialPolicy,
    fetchUsage,
    present: (): ProviderUsageView => ({ id, title: id, status: "ready", metrics: [] }),
    resolveCacheScopeMetadata: resolveScope,
  });
  return Object.freeze({ id, order: 1, registration: configured, ok: true, binding });
}

class SpyResolver implements RefreshCredentialResolver {
  calls: string[] = [];

  constructor(private readonly results: readonly (CredentialResolution | Promise<CredentialResolution>)[]) {}

  async resolve(registration: ProviderRegistration): Promise<CredentialResolution> {
    this.calls = [...this.calls, registration.metadata.id];
    const result = this.results[this.calls.length - 1];
    if (!result) throw new Error("missing resolver result");
    return result;
  }

  dispose(): void {}
}

class StaticCache implements RefreshCache {
  reads: CacheV2Target[] = [];

  constructor(private readonly cached?: StandardUsageProvider) {}

  read(target: CacheV2Target): ReturnType<RefreshCache["read"]> {
    this.reads = [...this.reads, target];
    return this.cached
      ? { status: "hit", snapshot: this.cached, storage: "memory" }
      : { status: "miss", diagnostic: "cache-miss" };
  }

  write(): Readonly<{ status: "written" }> {
    return { status: "written" };
  }

  dispose(): void {}
}

function resolved(): CredentialResolution {
  return Object.freeze({ ok: true, accountScope: ACCOUNT_SCOPE, lease: LEASE });
}

describe("Phase 7 final review regressions", () => {
  test("does not resolve stale credentials after a refreshing subscriber reconfigures", async () => {
    const genTwoBootstrap = deferred<CredentialResolution>();
    const genOne = provider("review-provider", async () => snapshot());
    const genTwo = provider("review-provider", async () => snapshot());
    const resolver = new SpyResolver([resolved(), genTwoBootstrap.promise]);
    const cache = new StaticCache(snapshot("review-provider", 1_000));
    const coordinator = createRefreshCoordinator({ providers: [genOne], policy: POLICY_MANUAL, credentialResolver: resolver, cache });
    await settle();
    let reconfigured = false;
    coordinator.subscribe((states) => {
      const current = states[0];
      if (!reconfigured && current?.generation === 1 && current.status === "refreshing") {
        reconfigured = true;
        coordinator.reconfigure([genTwo], POLICY_MANUAL);
      }
    });

    const staleRefresh = coordinator.refreshProvider("review-provider");
    await settle();
    genTwoBootstrap.resolve(resolved());
    await staleRefresh;
    await settle();

    expect(resolver.calls).toEqual(["review-provider", "review-provider"]);
    expect(coordinator.getStates()[0]).toMatchObject({ generation: 2, snapshot: snapshot("review-provider", 1_000) });
  });

  test("emits refreshing once when a subscriber reenters refreshProvider", async () => {
    const fetchResult = deferred<StandardUsageProvider>();
    const resolver = new SpyResolver([resolved(), resolved(), resolved()]);
    let fetches = 0;
    const coordinator = createRefreshCoordinator({
      providers: [provider("review-provider", () => { fetches += 1; return fetchResult.promise; })],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache: new StaticCache(),
    });
    await settle();
    let refreshingEmissions = 0;
    coordinator.subscribe((states) => {
      if (states[0]?.status !== "refreshing") return;
      refreshingEmissions += 1;
      void coordinator.refreshProvider("review-provider");
    });

    const refresh = coordinator.refreshProvider("review-provider");
    await settle();
    fetchResult.resolve(snapshot());
    await refresh;
    await settle();

    expect(refreshingEmissions).toBe(1);
    expect(fetches).toBe(1);
    expect(coordinator.getStates()[0]).toMatchObject({ status: "ready", requestSequence: 1 });
  });

  test("consumes a rejected Promise returned as provider cache scope", async () => {
    let unhandled: readonly unknown[] = Object.freeze([]);
    const onUnhandled = (reason: unknown): void => { unhandled = Object.freeze([...unhandled, reason]); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const scopeResolver = (_reader: NonSecretAccountMetadataReader) => Promise.reject(new Error("scope failure"));
      const coordinator = createRefreshCoordinator({
        providers: [provider(
          "review-provider",
          async () => snapshot(),
          scopeResolver as unknown as ProviderBinding["resolveCacheScopeMetadata"],
        )],
        policy: POLICY_MANUAL,
        credentialResolver: new SpyResolver([resolved()]),
        cache: new StaticCache(),
      });
      await settle();
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect(coordinator.getStates()[0]).toMatchObject({ status: "config_error", message: "Provider configuration is invalid" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
