/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import type { ProviderRegistration } from "../providers/contracts.js";
import { deepseekProviderDefinition, deepseekUsageAdapter } from "../providers/deepseek.js";
import { createTimeoutController } from "../providers/shared.js";
import { zaiProviderDefinition, zaiUsageAdapter } from "../providers/zai.js";
import {
  captureRequest,
  deepseekFixture,
  makeCtx,
  mockJsonResponse,
  restoreFetch,
  zaiFixture,
} from "./_helpers.js";

afterEach(() => {
  restoreFetch();
});

describe("native Z.AI provider definition", () => {
  test("binds enterprise options and fetches Zhipu quota with the raw credential", async () => {
    const binding = parseBinding(zaiProviderDefinition.registration, {
      plan: "enterprise",
      organization_id: "org-1",
      project_id: "project-1",
    });
    const captured = captureRequest(zaiFixture());

    const provider = await binding.fetchUsage({
      credential: { secret: "zhipu-token", source: "env", variant: "zhipu", epoch: 4 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(captured.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
    expect(captured.headers.Authorization).toBe("zhipu-token");
    expect(captured.headers["Bigmodel-Organization"]).toBe("org-1");
    expect(captured.headers["Bigmodel-Project"]).toBe("project-1");
    expect(provider.status).toBe("ready");
  });

  test("uses the Z.AI endpoint for a personal zai credential", async () => {
    const binding = parseBinding(zaiProviderDefinition.registration, {});
    const captured = captureRequest(zaiFixture());

    await binding.fetchUsage({
      credential: { secret: "zai-token", source: "opencode", variant: "zai", epoch: 2 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(captured.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(captured.headers.Authorization).toBe("zai-token");
  });

  test("rejects incomplete enterprise options before fetch", () => {
    const parsed = zaiProviderDefinition.registration.parseOptions({
      plan: "enterprise",
      organization_id: "org-1",
    });

    expect(parsed.ok).toBe(false);
  });

  test("rejects non-string enterprise identifiers and identifiers on personal plans", () => {
    const invalidOptions = [
      { plan: "enterprise", organization_id: 1, project_id: "project-1" },
      { plan: "enterprise", organization_id: "org-1", project_id: false },
      { plan: "personal", organization_id: "org-1" },
      { project_id: "project-1" },
    ];

    expect(invalidOptions.map((options) => zaiProviderDefinition.registration.parseOptions(options).ok)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("accepts UUID-like enterprise identifiers and rejects unsafe, oversized, and secret-shaped values", () => {
    const valid = zaiProviderDefinition.registration.parseOptions({
      plan: "enterprise",
      organization_id: "550e8400-e29b-41d4-a716-446655440000",
      project_id: "project_1.prod:@region",
    });
    const invalidIds = [
      "line\nbreak",
      "control\u0000value",
      "x".repeat(129),
      "sk-abcdefghijklmnopqrstuvwxyz123456",
    ];

    expect(valid.ok).toBe(true);
    expect(invalidIds.map((organizationId) => zaiProviderDefinition.registration.parseOptions({
      plan: "enterprise",
      organization_id: organizationId,
      project_id: "project-1",
    }).ok)).toEqual([false, false, false, false]);
  });

  test("rejects an unknown credential variant without making a request", async () => {
    const binding = parseBinding(zaiProviderDefinition.registration, {});
    const captured = captureRequest(zaiFixture());

    const provider = await binding.fetchUsage({
      credential: { secret: "credential", source: "env", variant: "unknown", epoch: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(provider).toMatchObject({ status: "error", statusText: "invalid credential variant" });
    expect(captured.url).toBe("");
  });

  test("returns cancelled without making a request when the caller signal is already aborted", async () => {
    const binding = parseBinding(zaiProviderDefinition.registration, {});
    const captured = captureRequest(zaiFixture());
    const caller = new AbortController();
    caller.abort();

    const provider = await binding.fetchUsage({
      credential: { secret: "zai-token", source: "env", variant: "zai", epoch: 1 },
      signal: caller.signal,
      timeoutMs: 1000,
    });

    expect(provider).toMatchObject({ status: "error", statusText: "cancelled" });
    expect(captured.url).toBe("");
  });

  test("exactly redacts the active credential from request failures", async () => {
    const binding = parseBinding(zaiProviderDefinition.registration, {});
    const credential = "arbitrary-placeholder";
    rejectFetch(new Error(`failure for ${credential}`));

    const provider = await binding.fetchUsage({
      credential: { secret: credential, source: "env", variant: "zai", epoch: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(provider.statusText).toBe("failure for [redacted]");
    expect(provider.statusText).not.toContain(credential);
  });

  test("returns persistent cache metadata only for enterprise scope with safe credential variant", () => {
    const enterprise = parseBinding(zaiProviderDefinition.registration, {
      plan: "enterprise",
      organization_id: "org-1",
      project_id: "project-1",
    });
    const personal = parseBinding(zaiProviderDefinition.registration, {});
    const safeReader = {
      readAccountIdentifier: (key: string) => key === "credential_variant" ? "zhipu" : undefined,
    };

    expect(enterprise.resolveCacheScopeMetadata(safeReader)).toEqual({
      accountId: '["org-1","project-1"]',
      credentialVariant: "zhipu",
      dataShape: { plan: "enterprise" },
    });
    expect(enterprise.resolveCacheScopeMetadata({ readAccountIdentifier: () => undefined })).toBeNull();
    expect(enterprise.resolveCacheScopeMetadata({ readAccountIdentifier: () => "unknown" })).toBeNull();
    expect(personal.resolveCacheScopeMetadata(safeReader)).toBeNull();
  });

  test("keeps delimiter-containing enterprise account tuples distinct", () => {
    const first = parseBinding(zaiProviderDefinition.registration, {
      plan: "enterprise",
      organization_id: "a:b",
      project_id: "c",
    });
    const second = parseBinding(zaiProviderDefinition.registration, {
      plan: "enterprise",
      organization_id: "a",
      project_id: "b:c",
    });
    const reader = { readAccountIdentifier: () => "zai" };

    expect(first.resolveCacheScopeMetadata(reader)?.accountId).not.toBe(
      second.resolveCacheScopeMetadata(reader)?.accountId,
    );
  });

  test("legacy bridge discovers auth once and preserves auth-over-env priority", async () => {
    let authReads = 0;
    const auth = new Proxy({ "zai-coding-plan": { key: "auth-token" } }, {
      get: (target, property, receiver) => {
        if (property === "zai-coding-plan") authReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const captured = captureRequest(zaiFixture());

    await zaiUsageAdapter.fetchUsage(makeCtx(auth, { ZAI_API_KEY: "env-token" }), new AbortController().signal);

    expect(authReads).toBe(1);
    expect(captured.headers.Authorization).toBe("auth-token");
  });
});

describe("native DeepSeek provider definition", () => {
  test("binds empty options and fetches balance with Bearer authorization", async () => {
    const binding = parseBinding(deepseekProviderDefinition.registration, {});
    const captured = captureRequest(deepseekFixture());

    const provider = await binding.fetchUsage({
      credential: { secret: "deepseek-token", source: "env", variant: "deepseek", epoch: 3 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(captured.url).toBe("https://api.deepseek.com/user/balance");
    expect(captured.headers.Authorization).toBe("Bearer deepseek-token");
    expect(provider.windows[0]?.currentValue).toBe(10.53);
    expect(binding.resolveCacheScopeMetadata({ readAccountIdentifier: () => "account-1" })).toBeNull();
  });

  test("preserves forbidden and API error snapshots", async () => {
    const binding = parseBinding(deepseekProviderDefinition.registration, {});
    const context = {
      credential: { secret: "deepseek-token", source: "env" as const, variant: "deepseek", epoch: 3 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    };

    mockJsonResponse({}, 403);
    expect(await binding.fetchUsage(context)).toMatchObject({ status: "forbidden", statusText: "forbidden" });
    mockJsonResponse({}, 500);
    expect(await binding.fetchUsage(context)).toMatchObject({ status: "error", statusText: "api 500" });
  });

  test("rejects an unknown credential variant without making a request", async () => {
    const binding = parseBinding(deepseekProviderDefinition.registration, {});
    const captured = captureRequest(deepseekFixture());

    const provider = await binding.fetchUsage({
      credential: { secret: "credential", source: "env", variant: "unknown", epoch: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(provider).toMatchObject({ status: "error", statusText: "invalid credential variant" });
    expect(captured.url).toBe("");
  });

  test("returns cancelled without making a request when the caller signal is already aborted", async () => {
    const binding = parseBinding(deepseekProviderDefinition.registration, {});
    const captured = captureRequest(deepseekFixture());
    const caller = new AbortController();
    caller.abort();

    const provider = await binding.fetchUsage({
      credential: { secret: "deepseek-token", source: "env", variant: "deepseek", epoch: 1 },
      signal: caller.signal,
      timeoutMs: 1000,
    });

    expect(provider).toMatchObject({ status: "error", statusText: "cancelled" });
    expect(captured.url).toBe("");
  });

  test("exactly redacts the active credential from request failures", async () => {
    const binding = parseBinding(deepseekProviderDefinition.registration, {});
    const credential = "arbitrary-placeholder";
    rejectFetch(new Error(`failure for ${credential}`));

    const provider = await binding.fetchUsage({
      credential: { secret: credential, source: "env", variant: "deepseek", epoch: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(provider.statusText).toBe("failure for [redacted]");
    expect(provider.statusText).not.toContain(credential);
  });

  test("legacy bridge discovers auth once and preserves auth-over-env priority", async () => {
    let authReads = 0;
    const auth = new Proxy({ deepseek: { key: "auth-token" } }, {
      get: (target, property, receiver) => {
        if (property === "deepseek") authReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const captured = captureRequest(deepseekFixture());

    await deepseekUsageAdapter.fetchUsage(makeCtx(auth, { DEEPSEEK_API_KEY: "env-token" }), new AbortController().signal);

    expect(authReads).toBe(1);
    expect(captured.headers.Authorization).toBe("Bearer auth-token");
  });
});

describe("timeout controller", () => {
  test("immediately mirrors an already-aborted parent", () => {
    const parent = new AbortController();
    parent.abort();

    const controller = createTimeoutController(1000, parent.signal);

    expect(controller.signal.aborted).toBe(true);
    controller.dispose();
  });
});

function parseBinding(registration: ProviderRegistration, options: unknown) {
  const parsed = registration.parseOptions(options);
  if (!parsed.ok) throw new Error(`Expected valid options: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

function rejectFetch(error: Error): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: () => Promise.reject(error),
  });
}
