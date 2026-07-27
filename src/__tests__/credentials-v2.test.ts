/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
  type CredentialSourceReaders,
  createCredentialResolver,
  createNonSecretAccountMetadataReader,
} from "../credentials-v2.js";
import { BUILTIN_PROVIDER_CATALOG } from "../providers/builtins.js";
import type { CredentialSource, ProviderRegistration } from "../providers/contracts.js";

const SECRET_A = "credential-value-alpha";
const SECRET_B = "credential-value-beta";

function registration(id: "zai" | "deepseek") {
  const found = BUILTIN_PROVIDER_CATALOG.find((candidate) => candidate.metadata.id === id);
  if (!found) throw new Error(`Missing test registration: ${id}`);
  return found;
}

function makeReaders(
  auth: Readonly<Record<string, string | undefined>> = {},
  env: Readonly<Record<string, string | undefined>> = {},
  reads: string[] = [],
): CredentialSourceReaders {
  return {
    readOpenCodeEntry: (entry) => {
      reads.push(`auth:${entry}`);
      return auth[entry];
    },
    readEnv: (name) => {
      reads.push(`env:${name}`);
      return env[name];
    },
  };
}

function registrationWithPolicy(
  id: string,
  allowedSources: readonly CredentialSource[],
  candidates: ProviderRegistration["credentialPolicy"]["defaultCandidates"],
): ProviderRegistration {
  return {
    ...registration("deepseek"),
    metadata: { ...registration("deepseek").metadata, id },
    credentialPolicy: { allowedSources, defaultCandidates: candidates },
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

describe("v2 credential resolution", () => {
  test("reads only an explicit allowed reference and never falls back when it is missing", async () => {
    const reads: string[] = [];
    const resolver = createCredentialResolver(makeReaders({}, { ZAI_API_KEY: SECRET_A }, reads));

    const result = await resolver.resolve(registration("zai"), { source: "opencode", entry: "zai" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("missing");
    expect(reads).toEqual(["auth:zai"]);
  });

  test("uses provider default candidates in order and stops at the first non-empty secret", async () => {
    const reads: string[] = [];
    const resolver = createCredentialResolver(makeReaders(
      { "zai-coding-plan": "", zai: SECRET_A, zhipu: SECRET_B },
      { ZAI_API_KEY: SECRET_B },
      reads,
    ));

    const result = await resolver.resolve(registration("zai"));

    expect(result).toEqual({
      ok: true,
      lease: { secret: SECRET_A, source: "opencode", variant: "zai", epoch: 1 },
    });
    expect(reads).toEqual(["auth:zai-coding-plan", "auth:zai"]);
  });

  test.each([
    [{ source: "env", name: "UNLISTED_API_KEY" } as const],
    [{ source: "opencode", entry: "unlisted" } as const],
  ])("rejects a reference absent from the provider candidate allowlist", async (reference) => {
    const reads: string[] = [];
    const resolver = createCredentialResolver(makeReaders({}, {}, reads));

    const result = await resolver.resolve(registration("zai"), reference);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("config");
    expect(reads).toEqual([]);
  });

  test("rejects a disallowed default candidate without reading any source", async () => {
    const reads: string[] = [];
    const invalid = registrationWithPolicy("invalid-default", ["env"], [
      { source: "opencode", variant: "test", name: "test" },
    ]);

    const result = await createCredentialResolver(makeReaders({}, {}, reads)).resolve(invalid);

    expect(result).toMatchObject({ ok: false, kind: "config", message: "Credential policy is inconsistent" });
    expect(reads).toEqual([]);
  });

  test("rejects a disallowed explicit candidate without reading any source", async () => {
    const reads: string[] = [];
    const invalid = registrationWithPolicy("invalid-explicit", ["env"], [
      { source: "opencode", variant: "test", name: "test" },
    ]);

    const result = await createCredentialResolver(makeReaders({}, {}, reads)).resolve(
      invalid,
      { source: "opencode", entry: "test" },
    );

    expect(result).toMatchObject({ ok: false, kind: "config", message: "Credential policy is inconsistent" });
    expect(reads).toEqual([]);
  });

  test("keeps delimiter-containing identity tuples distinct", async () => {
    const first = registrationWithPolicy("a", ["opencode"], [
      { source: "opencode", variant: "first", name: "b:explicit:env:c" },
    ]);
    const second = registrationWithPolicy("a:explicit:opencode:b", ["env"], [
      { source: "env", variant: "second", name: "c" },
    ]);
    const resolver = createCredentialResolver(makeReaders(
      { "b:explicit:env:c": SECRET_A },
      { c: SECRET_B },
    ));

    const firstResult = await resolver.resolve(first, { source: "opencode", entry: "b:explicit:env:c" });
    const secondResult = await resolver.resolve(second, { source: "env", name: "c" });

    expect(firstResult.ok && firstResult.lease.epoch).toBe(1);
    expect(secondResult.ok && secondResult.lease.epoch).toBe(1);
  });

  test("supersedes an older out-of-order completion without mutating current state", async () => {
    const firstRead = deferred<string | undefined>();
    let readCount = 0;
    const resolver = createCredentialResolver({
      readOpenCodeEntry: () => undefined,
      readEnv: () => ++readCount === 1 ? firstRead.promise : SECRET_B,
    });

    const older = resolver.resolve(registration("deepseek"));
    const newer = await resolver.resolve(registration("deepseek"));
    firstRead.resolve(SECRET_A);
    const superseded = await older;
    const current = await resolver.resolve(registration("deepseek"));

    expect(newer).toEqual({
      ok: true,
      lease: { secret: SECRET_B, source: "env", variant: "deepseek", epoch: 1 },
    });
    expect(superseded).toEqual({
      ok: false,
      kind: "superseded",
      message: "Credential resolution was superseded",
      epoch: 1,
    });
    expect(current.ok && current.lease.epoch).toBe(1);
    expect(JSON.stringify(superseded)).not.toContain(SECRET_A);
    expect(JSON.stringify(superseded)).not.toContain(SECRET_B);
  });

  test("replaces source read failures with a fixed secret-free error", async () => {
    const readers: CredentialSourceReaders = {
      readOpenCodeEntry: () => { throw new Error(`reader failed with ${SECRET_A}`); },
      readEnv: () => SECRET_B,
    };
    const result = await createCredentialResolver(readers).resolve(
      registration("zai"),
      { source: "opencode", entry: "zai" },
    );
    const snapshot = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("source");
    expect(snapshot).not.toContain(SECRET_A);
    expect(snapshot).not.toContain(SECRET_B);
  });

  test("invalidates the epoch once for a source error and again after recovery", async () => {
    let shouldFail = false;
    const resolver = createCredentialResolver({
      readOpenCodeEntry: () => undefined,
      readEnv: () => {
        if (shouldFail) throw new Error("source unavailable");
        return SECRET_A;
      },
    });

    const found = await resolver.resolve(registration("deepseek"));
    shouldFail = true;
    const failed = await resolver.resolve(registration("deepseek"));
    const stillFailed = await resolver.resolve(registration("deepseek"));
    shouldFail = false;
    const recovered = await resolver.resolve(registration("deepseek"));

    expect(found.ok && found.lease.epoch).toBe(1);
    expect(!failed.ok && failed.epoch).toBe(2);
    expect(!stillFailed.ok && stillFailed.epoch).toBe(2);
    expect(recovered.ok && recovered.lease.epoch).toBe(3);
  });

  test("keeps an epoch stable for the same value and advances it when the value changes", async () => {
    let value = SECRET_A;
    const resolver = createCredentialResolver(makeReaders({}, new Proxy({}, {
      get: (_target, key) => key === "DEEPSEEK_API_KEY" ? value : undefined,
    })));

    const first = await resolver.resolve(registration("deepseek"));
    const same = await resolver.resolve(registration("deepseek"));
    value = SECRET_B;
    const changed = await resolver.resolve(registration("deepseek"));

    expect(first.ok && first.lease.epoch).toBe(1);
    expect(same.ok && same.lease.epoch).toBe(1);
    expect(changed.ok && changed.lease.epoch).toBe(2);
  });

  test("advances the default-reference epoch when source changes", async () => {
    let authValue: string | undefined;
    const readers: CredentialSourceReaders = {
      readOpenCodeEntry: (entry) => entry === "zai-coding-plan" ? authValue : undefined,
      readEnv: (name) => name === "ZAI_API_KEY" ? SECRET_A : undefined,
    };
    const resolver = createCredentialResolver(readers);

    const fromEnv = await resolver.resolve(registration("zai"));
    authValue = SECRET_A;
    const fromAuth = await resolver.resolve(registration("zai"));

    expect(fromEnv.ok && fromEnv.lease).toMatchObject({ source: "env", epoch: 1 });
    expect(fromAuth.ok && fromAuth.lease).toMatchObject({ source: "opencode", epoch: 2 });
  });

  test("invalidates the epoch once on a transition to missing", async () => {
    let value: string | undefined = SECRET_A;
    const resolver = createCredentialResolver({
      readOpenCodeEntry: () => undefined,
      readEnv: () => value,
    });

    const found = await resolver.resolve(registration("deepseek"));
    value = undefined;
    const missing = await resolver.resolve(registration("deepseek"));
    const stillMissing = await resolver.resolve(registration("deepseek"));

    expect(found.ok && found.lease.epoch).toBe(1);
    expect(!missing.ok && missing.epoch).toBe(2);
    expect(!stillMissing.ok && stillMissing.epoch).toBe(2);
    expect(JSON.stringify(missing)).not.toContain(SECRET_A);
  });

  test("clears credential state and prevents source reads after disposal", async () => {
    let reads = 0;
    const resolver = createCredentialResolver({
      readOpenCodeEntry: () => undefined,
      readEnv: () => {
        reads += 1;
        return SECRET_A;
      },
    });

    const found = await resolver.resolve(registration("deepseek"));
    resolver.dispose();
    const disposed = await resolver.resolve(registration("deepseek"));

    expect(found.ok).toBe(true);
    expect(disposed).toEqual({
      ok: false,
      kind: "source",
      message: "Credential resolver is disposed",
      epoch: 0,
    });
    expect(reads).toBe(1);
    expect(JSON.stringify(disposed)).not.toContain(SECRET_A);
  });
});

describe("non-secret account metadata", () => {
  test("exposes only explicitly allowed validated metadata", () => {
    const result = createNonSecretAccountMetadataReader(
      { account_id: "account-123", organization_id: "org-456", token: SECRET_A },
      ["account_id"],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.readAccountIdentifier("account_id")).toBe("account-123");
    expect(result.value.readAccountIdentifier("organization_id")).toBeUndefined();
    expect(result.value.readAccountIdentifier("token")).toBeUndefined();
    expect(JSON.stringify(result.value)).not.toContain(SECRET_A);
  });

  test("rejects invalid allowlist keys and traversal-shaped values without echoing input", () => {
    const secretLike = createNonSecretAccountMetadataReader({ token: SECRET_A }, ["token"]);
    const traversal = createNonSecretAccountMetadataReader({ account_id: "../private" }, ["account_id"]);

    expect(secretLike.ok).toBe(false);
    expect(traversal.ok).toBe(false);
    expect(JSON.stringify([secretLike, traversal])).not.toContain(SECRET_A);
    expect(JSON.stringify(traversal)).not.toContain("../private");
  });

  test("rejects secret-pattern values under safe metadata keys without echoing them", () => {
    const secretShapedAccountId = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = createNonSecretAccountMetadataReader(
      { account_id: secretShapedAccountId },
      ["account_id"],
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretShapedAccountId);
  });
});
