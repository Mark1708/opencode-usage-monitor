/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { BUILTIN_PROVIDER_CATALOG } from "../providers/builtins.js";
import { deepseekUsageAdapter } from "../providers/deepseek.js";
import { openAIUsageAdapter } from "../providers/openai.js";
import {
  PROVIDER_ADAPTERS,
  resolveProviderRegistration,
} from "../providers/registry.js";
import { zaiUsageAdapter } from "../providers/zai.js";
import { makeFixtureDefinition } from "./_provider-contract-fixtures.js";

describe("provider registry resolution", () => {
  test("resolves catalog entries without central provider switches", () => {
    const fixture = makeFixtureDefinition().registration;
    const catalog = Object.freeze([...BUILTIN_PROVIDER_CATALOG, fixture]);

    expect(resolveProviderRegistration(catalog, "fixture")).toBe(fixture);
    expect(resolveProviderRegistration(catalog, "missing")).toBeUndefined();
  });

  test("keeps placeholder v2 definitions out of the unchanged runtime registry", () => {
    expect(PROVIDER_ADAPTERS).toEqual([
      openAIUsageAdapter,
      zaiUsageAdapter,
      deepseekUsageAdapter,
    ]);
  });
});
