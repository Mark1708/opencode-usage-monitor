/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";

import serverPlugin from "../index.js";

import { CONFIG_DEFAULTS } from "../config.js";
import type { ResolvedUsageConfigV2 } from "../config-types.js";
import { formatProviderMetricsForState } from "../format.js";
import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderRuntimeState, RefreshCoordinator } from "../refresh.js";
import usageTuiPlugin, {
	createUsageTuiDefinition,
	mountUsagePanel,
	runtimeStatesToProviders,
} from "../tui.js";
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

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

const resolvedConfig: ResolvedUsageConfigV2 = {
	version: 2,
	enabled: true,
	keybindings: { refresh_all: null, refresh_provider: null },
	ui: {
		width: 40,
		symbols: "unicode",
		panel_initial_state: "expanded",
		provider_initial_state: "expanded",
	},
	refresh: {
		mode: "manual",
		interval_ms: 60_000,
		timeout_ms: 5_000,
		stale_after_ms: 120_000,
	},
	diagnostics: { debug: false },
	providers: [],
};

function theme(base: string) {
	return {
		text: {
			base,
			muted: `${base}-muted`,
			feedback: {
				warning: { base: `${base}-warning` },
				error: { base: `${base}-error` },
			},
		},
		background: { base: `${base}-background` },
		border: { base: `${base}-border` },
	};
}

describe("TUI runtime cutover", () => {
	test("exports V2 definitions with only id and setup fields", () => {
		expect(Object.keys(serverPlugin).sort()).toEqual(["id", "setup"]);
		expect(Object.keys(usageTuiPlugin).sort()).toEqual(["id", "setup"]);
		expect(serverPlugin.id).toBe("usage-monitor");
		expect(usageTuiPlugin.id).toBe("usage-monitor.tui");
	});

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

	test("mounts one tracked subtree whose provider, collapse, click, and theme reads stay live", () => {
		let disposeRoot = (): void => undefined;
		let inserts = 0;
		let containers = 0;
		let rendered = "";
		let click = (): void => undefined;
		createRoot((dispose) => {
			disposeRoot = dispose;
			const [getConfig] = createSignal({ ...CONFIG_DEFAULTS });
			const [getProviders, setProviders] = createSignal<Record<string, StandardUsageProvider>>({});
			const [getCollapsed, setCollapsed] = createSignal(false);
			const [getCollapsedProviders] = createSignal(new Set<string>());
			const [getExpandedDetails] = createSignal(new Set<string>());
			const [getTheme, setTheme] = createSignal(theme("light"));
			const container = mountUsagePanel({
				getConfig,
				getProviders,
				getCollapsed,
				getCollapsedProviderIds: getCollapsedProviders,
				getExpandedDetailIds: getExpandedDetails,
				onToggleCollapsed: () => setCollapsed((value) => !value),
				onToggleProvider: () => undefined,
				onToggleDetails: () => undefined,
				getTheme,
			}, {
				createContainer: () => {
					containers += 1;
					return { kind: "container" };
				},
				insert: (_container, accessor) => {
					inserts += 1;
					createEffect(() => {
						rendered = String(accessor());
					});
				},
				render: (input) => {
					click = input.onToggleCollapsed;
					return `${Object.keys(input.providers).join(",")}|${input.collapsed}|${String(input.theme.text)}`;
				},
				renderError: (message) => `error:${message}`,
			});

			expect(container).toEqual({ kind: "container" });
			expect(rendered).toBe("|false|light");
			setProviders({ deepseek: deepseekSnapshot });
			expect(rendered).toBe("deepseek|false|light");
			setCollapsed(true);
			expect(rendered).toBe("deepseek|true|light");
			setTheme(theme("dark"));
			expect(rendered).toBe("deepseek|true|dark");
			click();
			expect(rendered).toBe("deepseek|false|dark");
		});

		expect(containers).toBe(1);
		expect(inserts).toBe(1);
		disposeRoot();
	});

	test("cleanup during a delayed config reload prevents late coordinator, subscription, and fetch creation", async () => {
		const delayedRuntime = deferred<{
			readonly config: ResolvedUsageConfigV2;
			readonly render: typeof CONFIG_DEFAULTS;
			readonly providers: Record<string, StandardUsageProvider>;
			readonly fingerprint: string;
		}>();
		let reads = 0;
		let coordinatorCreations = 0;
		let reload: (() => void) | undefined;
		let watcherCloses = 0;
		let slotDisposals = 0;
		let dataDisposals = 0;
		let keymapLayers = 0;
		const coordinator: RefreshCoordinator = {
			refreshAll: async () => undefined,
			refreshProvider: async () => undefined,
			invalidateCredentials: () => undefined,
			reconfigure: () => undefined,
			getStates: () => [],
			subscribe: () => () => undefined,
			dispose: () => undefined,
		};
		const definition = createUsageTuiDefinition({
			readRuntimeConfig: async () => {
				reads += 1;
				if (reads === 1) {
					return {
						render: { ...CONFIG_DEFAULTS },
						providers: {},
						fingerprint: "initial-error",
					};
				}
				return delayedRuntime.promise;
			},
			createRuntimeCoordinator: () => {
				coordinatorCreations += 1;
				return coordinator;
			},
			createCredentialReader: () => Object.assign(
				async () => undefined,
				{ invalidate: () => undefined },
			),
			watchConfig: (callback) => {
				reload = callback;
				return { close: () => { watcherCloses += 1; } };
			},
			createReloadTrigger: (callback) => Object.assign(callback, { cancel: () => undefined }),
		});
		const context = {
			client: {},
			data: {
				on: () => () => { dataDisposals += 1; },
			},
			theme: theme("light"),
			keymap: {
				layer: () => { keymapLayers += 1; },
			},
			ui: {
				slot: () => () => { slotDisposals += 1; },
				toast: { show: () => undefined },
			},
		};
		const setupResult = await Reflect.apply(definition.setup, undefined, [context]);
		if (typeof setupResult !== "function") throw new Error("Expected setup cleanup");
		if (!reload) throw new Error("Expected config watcher callback");

		reload();
		await settle();
		expect(reads).toBe(2);
		await setupResult();
		delayedRuntime.resolve({
			config: resolvedConfig,
			render: { ...CONFIG_DEFAULTS },
			providers: {},
			fingerprint: "valid",
		});
		await settle();

		expect(coordinatorCreations).toBe(0);
		expect(watcherCloses).toBe(1);
		expect(slotDisposals).toBe(1);
		expect(dataDisposals).toBe(2);
		expect(keymapLayers).toBe(1);
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
