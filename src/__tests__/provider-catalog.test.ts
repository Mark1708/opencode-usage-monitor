/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import {
  BUILTIN_PROVIDER_CATALOG,
  createProviderCatalog,
} from "../providers/builtins.js";
import {
  mockJsonResponse,
  restoreFetch,
  zaiFixture,
} from "./_helpers.js";
import {
  makeFixtureDefinition,
  readyProvider,
} from "./_provider-contract-fixtures.js";

afterEach(() => {
  restoreFetch();
});

describe("v2 built-in provider catalog", () => {
  test("has unique provider ids and catalog orders in deterministic order", () => {
    const ids = BUILTIN_PROVIDER_CATALOG.map((entry) => entry.metadata.id);
    const orders = BUILTIN_PROVIDER_CATALOG.map((entry) => entry.metadata.catalogOrder);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
  });

  test("is frozen at catalog, registration, metadata, and API metadata boundaries", () => {
    const first = BUILTIN_PROVIDER_CATALOG[0];
    expect(Object.isFrozen(BUILTIN_PROVIDER_CATALOG)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.metadata)).toBe(true);
    expect(Object.isFrozen(first?.metadata.officialApi)).toBe(true);
    expect(Object.isFrozen(first?.metadata.officialApi.baseUrls)).toBe(true);
    expect(Object.isFrozen(first?.metadata.officialApi.endpoints)).toBe(true);
    expect(Reflect.set(BUILTIN_PROVIDER_CATALOG, 0, makeFixtureDefinition().registration)).toBe(false);
  });

  test("publishes every official host and data-shaping endpoint", () => {
    const zai = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "zai");
    const deepseek = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "deepseek");

    expect(zai?.metadata.officialApi.baseUrls).toEqual([
      "https://api.z.ai",
      "https://open.bigmodel.cn",
    ]);
    expect(zai?.metadata.officialApi.endpoints.map((endpoint) => endpoint.path)).toEqual([
      "/api/monitor/usage/quota/limit",
      "/api/monitor/usage/quota/limit?type=2",
    ]);
    expect(deepseek?.metadata.officialApi.baseUrls).toEqual(["https://api.deepseek.com"]);
  });

  test("excludes OpenAI according to ADR 0001", () => {
    expect(BUILTIN_PROVIDER_CATALOG.map((entry) => entry.metadata.id)).toEqual(["zai", "deepseek"]);
  });

  test("owns provider-specific presenters", () => {
    const zai = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "zai")?.parseOptions({});
    const deepseek = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "deepseek")?.parseOptions({});

    expect(zai?.ok && zai.value.present(readyProvider("zai", "z.ai")).id).toBe("zai");
    expect(deepseek?.ok && deepseek.value.present(readyProvider("deepseek")).id).toBe("deepseek");
  });

  test("lists every supported Z.AI and DeepSeek credential alias in legacy discovery order", () => {
    const zai = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "zai");
    const deepseek = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "deepseek");

    expect(zai?.credentialPolicy.defaultCandidates).toEqual([
      { source: "opencode", variant: "zai", name: "zai-coding-plan" },
      { source: "opencode", variant: "zai", name: "zai" },
      { source: "opencode", variant: "zhipu", name: "zhipu" },
      { source: "env", variant: "zai", name: "ZAI_API_KEY" },
      { source: "env", variant: "zai", name: "ZAI_CODING_PLAN_API_KEY" },
      { source: "env", variant: "zhipu", name: "ZHIPU_API_KEY" },
      { source: "env", variant: "zhipu", name: "ZHIPUAI_API_KEY" },
    ]);
    expect(deepseek?.credentialPolicy.defaultCandidates).toEqual([
      { source: "opencode", variant: "deepseek", name: "deepseek" },
      { source: "env", variant: "deepseek", name: "DEEPSEEK_API_KEY" },
    ]);
  });

  test("accepts a fixture definition without a central provider switch", () => {
    const fixture = makeFixtureDefinition().registration;
    expect(createProviderCatalog([...BUILTIN_PROVIDER_CATALOG, fixture])).toContain(fixture);
  });

  test("executes a catalog provider fetch instead of a placeholder", async () => {
    const registration = BUILTIN_PROVIDER_CATALOG.find((entry) => entry.metadata.id === "zai");
    const parsed = registration?.parseOptions({});
    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    mockJsonResponse(zaiFixture());

    const provider = await parsed.value.fetchUsage({
      credential: { secret: "zai-token", source: "env", variant: "zai", epoch: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });

    expect(provider.status).toBe("ready");
  });
});
