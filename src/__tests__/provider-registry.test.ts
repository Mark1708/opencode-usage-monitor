/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { BUILTIN_PROVIDER_CATALOG } from "../providers/builtins.js";
import { LegacyAdapterFacade } from "../providers/contracts.js";
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

	test("directs every legacy adapter through migrated provider facades", () => {
		expect(PROVIDER_ADAPTERS).toEqual([
			openAIUsageAdapter,
			zaiUsageAdapter,
			deepseekUsageAdapter,
		]);
		expect(openAIUsageAdapter).toBeInstanceOf(LegacyAdapterFacade);
		expect(zaiUsageAdapter).toBeInstanceOf(LegacyAdapterFacade);
		expect(deepseekUsageAdapter).toBeInstanceOf(LegacyAdapterFacade);
		expect(
			BUILTIN_PROVIDER_CATALOG.some((entry) => entry.metadata.id === "openai"),
		).toBe(true);
	});
});
