/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { CONFIG_DEFAULTS } from "../config.js";
import { formatProviderMetricsForState } from "../format.js";
import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderRuntimeState } from "../refresh.js";
import { runtimeStatesToProviders } from "../tui.js";
import { providerToView } from "../views/index.js";
import { TEST_WIDTH } from "./_helpers.js";

const deepseekSnapshot: StandardUsageProvider = {
	id: "deepseek",
	displayName: "deepseek",
	status: "ready",
	windows: [],
	details: [
		{
			key: "balance",
			label: "balance",
			value: { kind: "currency", value: 10.53, currency: "CNY" },
			visibility: "summary",
			priority: 100,
		},
		{
			key: "granted",
			label: "granted",
			value: { kind: "currency", value: 1.23, currency: "CNY" },
			visibility: "detail",
			priority: 80,
		},
	],
	fetchedAt: 1_700_000_000_000,
};

describe("TUI runtime cutover", () => {
	test("maps v2 coordinator snapshots into visible sidebar metrics", () => {
		const providers = runtimeStatesToProviders(
			[runtimeState(deepseekSnapshot)],
			{},
		);
		const view = providerToView(providers.deepseek);
		const baseLines = formatProviderMetricsForState(
			view,
			{ ...CONFIG_DEFAULTS, show_details: false },
			TEST_WIDTH,
			false,
		)
			.map((line) => line.text)
			.join("\n");

		expect(providers.deepseek.windows).toEqual([]);
		expect(baseLines).toContain("balance");
		expect(baseLines).toContain("¥10.53");
		expect(baseLines).not.toContain("granted");
	});

	test("renders configuration validation errors as an actionable provider row", () => {
		const view = providerToView({
			id: "config",
			displayName: "config",
			status: "error",
			statusText: "version: v1 config detected; migrate to version 2",
			errorMessage: "version: v1 config detected; migrate to version 2",
			windows: [],
		});
		const text = formatProviderMetricsForState(
			view,
			{ ...CONFIG_DEFAULTS, default_provider_collapsed: false },
			80,
			false,
		).map((line) => line.text).join("\n");

		expect(text).toContain("status");
		expect(text).toContain("migrate to version 2");
	});
});

function runtimeState(snapshot: StandardUsageProvider): ProviderRuntimeState {
	return {
		id: snapshot.id,
		generation: 1,
		requestSequence: 1,
		status: "ready",
		snapshot,
		lastAttemptAt: snapshot.fetchedAt,
		lastSuccessAt: snapshot.fetchedAt,
		credentialEpoch: 1,
	};
}
