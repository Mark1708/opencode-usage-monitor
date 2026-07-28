/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
	type ConfigTextReader,
	parseUsageConfigV2,
	readUsageConfigV2,
} from "../runtime-config.js";

const validConfig = {
	version: 2,
	providers: {
		zai: {},
		deepseek: {},
	},
} as const;

describe("v2 config parser", () => {
	test("resolves defaults and immutable provider bindings from the built-in catalog", () => {
		const result = parseUsageConfigV2(validConfig);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.version).toBe(2);
		expect(result.value.providers.map((provider) => provider.id)).toEqual([
			"zai",
			"deepseek",
		]);
		expect(result.value.providers.every((provider) => provider.ok)).toBe(true);
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.providers)).toBe(true);
		expect(Object.isFrozen(result.value.refresh)).toBe(true);
		expect(Object.isFrozen(result.value.providers[0])).toBe(true);
	});

	test("accepts all root sections and typed credential references", () => {
		const result = parseUsageConfigV2({
			version: 2,
			enabled: false,
			keybindings: { refresh_all: null, refresh_provider: "<leader>p" },
			ui: {
				width: 48,
				symbols: "ascii",
				panel_initial_state: "collapsed",
				provider_initial_state: "expanded",
			},
			refresh: {
				mode: "automatic",
				interval_ms: 60_000,
				timeout_ms: 1_000,
				stale_after_ms: 60_000,
			},
			diagnostics: { debug: true },
			providers: {
				zai: { credential: { source: "opencode", entry: "zai" } },
				deepseek: { credential: { source: "env", name: "DEEPSEEK_API_KEY" } },
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.keybindings).toEqual({
			refresh_all: null,
			refresh_provider: "<leader>p",
		});
		expect(
			result.value.providers.map((provider) => provider.credential),
		).toEqual([
			{ source: "opencode", entry: "zai" },
			{ source: "env", name: "DEEPSEEK_API_KEY" },
		]);
	});

	test("rejects syntactically valid references outside a provider candidate allowlist", () => {
		const env = parseUsageConfigV2({
			version: 2,
			providers: {
				zai: { credential: { source: "env", name: "UNLISTED_API_KEY" } },
			},
		});
		const auth = parseUsageConfigV2({
			version: 2,
			providers: {
				deepseek: { credential: { source: "opencode", entry: "other" } },
			},
		});

		expect(env.ok).toBe(false);
		expect(auth.ok).toBe(false);
	});

	test("orders providers by explicit order, then catalog order, then id", () => {
		const result = parseUsageConfigV2({
			version: 2,
			providers: {
				zai: { order: 40 },
				deepseek: { order: 10 },
			},
		});

		expect(
			result.ok && result.value.providers.map((provider) => provider.id),
		).toEqual(["deepseek", "zai"]);
	});

	test("isolates sanitized provider option issues without blocking valid providers", () => {
		const result = parseUsageConfigV2({
			version: 2,
			providers: {
				zai: { options: { plan: "enterprise", organization_id: "org" } },
				deepseek: {},
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const zai = result.value.providers.find(
			(provider) => provider.id === "zai",
		);
		const deepseek = result.value.providers.find(
			(provider) => provider.id === "deepseek",
		);
		expect(zai?.ok).toBe(false);
		expect(zai !== undefined && !zai.ok && zai.issues[0]?.path).toBe(
			"providers.zai.options.organization_id",
		);
		expect(deepseek?.ok).toBe(true);
	});

	test("keeps organization and project option identifiers valid", () => {
		const result = parseUsageConfigV2({
			version: 2,
			providers: {
				zai: {
					options: {
						plan: "enterprise",
						organization_id: "org",
						project_id: "project",
					},
				},
			},
		});

		expect(result.ok).toBe(true);
		expect(result.ok && result.value.providers[0]?.ok).toBe(true);
	});

	test.each([
		["unknown root field", { ...validConfig, extra: true }, "extra"],
		[
			"unknown keybinding field",
			{ ...validConfig, keybindings: { refresh_all: "r", extra: "x" } },
			"keybindings.extra",
		],
		["unknown UI field", { ...validConfig, ui: { extra: true } }, "ui.extra"],
		[
			"unknown refresh field",
			{ ...validConfig, refresh: { extra: true } },
			"refresh.extra",
		],
		[
			"unknown diagnostics field",
			{ ...validConfig, diagnostics: { extra: true } },
			"diagnostics.extra",
		],
		[
			"unknown provider id",
			{ version: 2, providers: { "unknown-provider": {} } },
			"providers.unknown-provider",
		],
		[
			"unknown provider field",
			{ version: 2, providers: { zai: { extra: true } } },
			"providers.zai.extra",
		],
		[
			"nested enabled",
			{ version: 2, providers: { zai: { enabled: true } } },
			"providers.zai.enabled",
		],
		[
			"nested refresh",
			{ version: 2, providers: { zai: { refresh: {} } } },
			"providers.zai.refresh",
		],
		[
			"raw credential",
			{
				version: 2,
				providers: {
					zai: { credential: { source: "env", key: "not-a-secret" } },
				},
			},
			"providers.zai.credential.key",
		],
		[
			"credential interpolation",
			{
				version: 2,
				providers: {
					zai: { credential: { source: "env", name: "$" + "{ZAI_API_KEY}" } },
				},
			},
			"providers.zai.credential.name",
		],
		[
			"env name starting with underscore",
			{
				version: 2,
				providers: { zai: { credential: { source: "env", name: "_BAD" } } },
			},
			"providers.zai.credential.name",
		],
		[
			"overlong keybinding",
			{ ...validConfig, keybindings: { refresh_all: "x".repeat(65) } },
			"keybindings.refresh_all",
		],
		[
			"multiline keybinding",
			{ ...validConfig, keybindings: { refresh_provider: "a\nb" } },
			"keybindings.refresh_provider",
		],
	])("rejects structural error: %s", (_name, input, path) => {
		const result = parseUsageConfigV2(input);

		expect(result.ok).toBe(false);
		expect(
			!result.ok && result.issues.some((issue) => issue.path === path),
		).toBe(true);
	});

	test("rejects nested raw credential-like option fields without exposing values", () => {
		const result = parseUsageConfigV2({
			version: 2,
			providers: { zai: { options: { routing: { api_key: "placeholder" } } } },
		});

		expect(result.ok).toBe(false);
		expect(
			!result.ok &&
				result.issues.some(
					(issue) => issue.path === "providers.zai.options.routing.api_key",
				),
		).toBe(true);
		expect(
			!result.ok &&
				result.issues.every((issue) => !issue.message.includes("placeholder")),
		).toBe(true);
	});

	test("fails closed when provider options exceed the validation depth", () => {
		const result = parseUsageConfigV2({
			version: 2,
			providers: { zai: { options: nestedOptions(10) } },
		});

		expect(result.ok).toBe(false);
		expect(
			!result.ok &&
				result.issues.some((issue) => issue.message.includes("nesting depth")),
		).toBe(true);
	});

	test.each([
		["ui.width", { ...validConfig, ui: { width: 0 } }],
		[
			"refresh.interval_ms",
			{ ...validConfig, refresh: { mode: "automatic", interval_ms: 59_999 } },
		],
		["refresh.timeout_ms", { ...validConfig, refresh: { timeout_ms: 0 } }],
		[
			"refresh.stale_after_ms",
			{ ...validConfig, refresh: { stale_after_ms: 0 } },
		],
		["providers.zai.order", { version: 2, providers: { zai: { order: -1 } } }],
	])("validates numeric bound at %s", (path, input) => {
		const result = parseUsageConfigV2(input);
		expect(result.ok).toBe(false);
		expect(
			!result.ok && result.issues.some((issue) => issue.path === path),
		).toBe(true);
	});

	test("requires version 2 and providers while identifying v1 config safely", () => {
		const v1 = parseUsageConfigV2({
			enabled: true,
			show_zai: true,
			refresh_ms: 60_000,
		});
		const missingProviders = parseUsageConfigV2({ version: 2 });

		expect(v1.ok).toBe(false);
		expect(!v1.ok && v1.issues[0]?.message).toContain("migrate");
		expect(!v1.ok && v1.issues[0]?.message).not.toContain("60_000");
		expect(missingProviders.ok).toBe(false);
		expect(!missingProviders.ok && missingProviders.issues[0]?.path).toBe(
			"providers",
		);
	});

	test("accepts OpenAI subscription provider with explicit OpenCode credential reference", () => {
		const result = parseUsageConfigV2({
			version: 2,
			providers: {
				openai: { credential: { source: "opencode", entry: "openai" } },
			},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.providers.map((provider) => provider.id)).toEqual([
			"openai",
		]);
		expect(result.value.providers[0]?.credential).toEqual({
			source: "opencode",
			entry: "openai",
		});
	});
});

function nestedOptions(depth: number): unknown {
	return depth === 0 ? { value: "safe" } : { level: nestedOptions(depth - 1) };
}

describe("v2 config source loading", () => {
	test("fails closed on malformed dedicated config without reading OMO", async () => {
		const reads: string[] = [];
		const readText: ConfigTextReader = async (path) => {
			reads.push(path);
			return path === "dedicated"
				? { exists: true, text: "{" }
				: {
						exists: true,
						text: JSON.stringify({ usage_monitor: validConfig }),
					};
		};

		const result = await readUsageConfigV2({
			dedicatedPath: "dedicated",
			omoPath: "omo",
			readText,
		});

		expect(result.ok).toBe(false);
		expect(reads).toEqual(["dedicated"]);
	});

	test("reads OMO only when the dedicated file is absent", async () => {
		const reads: string[] = [];
		const readText: ConfigTextReader = async (path) => {
			reads.push(path);
			return path === "dedicated"
				? { exists: false }
				: {
						exists: true,
						text: JSON.stringify({
							usage_monitor: { version: 2, providers: { deepseek: {} } },
						}),
					};
		};

		const result = await readUsageConfigV2({
			dedicatedPath: "dedicated",
			omoPath: "omo",
			readText,
		});

		expect(
			result.ok && result.value.providers.map((provider) => provider.id),
		).toEqual(["deepseek"]);
		expect(reads).toEqual(["dedicated", "omo"]);
	});

	test("fails closed when both dedicated and OMO config sources are absent", async () => {
		const readText: ConfigTextReader = async () => ({ exists: false });
		const result = await readUsageConfigV2({
			dedicatedPath: "dedicated",
			omoPath: "omo",
			readText,
		});

		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues[0]).toEqual({
			path: "config",
			message: "Usage monitor config file not found",
		});
	});

	test("fails closed when OMO config omits the usage_monitor section", async () => {
		const readText: ConfigTextReader = async (path) => path === "dedicated"
			? { exists: false }
			: { exists: true, text: JSON.stringify({ other: {} }) };
		const result = await readUsageConfigV2({
			dedicatedPath: "dedicated",
			omoPath: "omo",
			readText,
		});

		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues[0]).toEqual({
			path: "usage_monitor",
			message: "usage_monitor config section is required",
		});
	});
});
