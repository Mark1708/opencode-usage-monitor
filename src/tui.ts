import { type FSWatcher, watch } from "node:fs";
import type { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";

import { CONFIG_DEFAULTS, CONFIG_PATH, configFingerprint } from "./config.js";
import type { ResolvedUsageConfigV2 } from "./config-types.js";
import { createCredentialResolver } from "./credentials.js";
import {
	type FormattedLine,
	formatCollapsedSummary,
	formatHeader,
	formatProviderMetricsForState,
	formatProviderTitle,
} from "./format.js";
import { formatAge, truncateTo } from "./layout.js";
import { createProviderCacheV2 } from "./provider-cache.js";
import type {
	ProviderId,
	RefreshGuard,
	StandardUsageProvider,
	UsageMonitorConfig,
} from "./providers/types.js";
import {
	createRefreshCoordinator,
	type ProviderRuntimeState,
	type RefreshCoordinator,
} from "./refresh.js";
import { readUsageConfigV2 } from "./runtime-config.js";
import { sanitizeError } from "./sanitize.js";
import { providerToView } from "./views/index.js";
import type { ProviderUsageView, TextTheme } from "./views/types.js";

type Child = JSX.Element | string | number | null | undefined | false;

type RuntimeConfig = Readonly<{
	config?: ResolvedUsageConfigV2;
	render: Required<UsageMonitorConfig>;
	providers: Record<ProviderId, StandardUsageProvider>;
	fingerprint: string;
}>;

function element(
	tag: string,
	props: Record<string, unknown>,
	children: Child[] = [],
): JSX.Element {
	const node = createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value !== undefined) setProp(node, key, value);
	}
	for (const child of children) {
		if (child !== null && child !== undefined && child !== false)
			insert(node, child);
	}
	return node as unknown as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[]): JSX.Element {
	return element("text", props, children);
}

function box(
	props: Record<string, unknown>,
	children: Child[] = [],
): JSX.Element {
	return element("box", props, children);
}

export function createRefreshGuard(): RefreshGuard {
	let active = false;
	return {
		get isActive() {
			return active;
		},
		start: () => {
			if (active) return false;
			active = true;
			return true;
		},
		finish: () => {
			active = false;
		},
	};
}

export function renderUsagePanel(
	config: Required<UsageMonitorConfig>,
	providers: Record<ProviderId, StandardUsageProvider>,
	collapsed: boolean,
	collapsedProviderIds: ReadonlySet<ProviderId>,
	expandedDetailIds: ReadonlySet<ProviderId>,
	onToggleCollapsed: () => void,
	onToggleProvider: (id: ProviderId) => void,
	onToggleDetails: (id: ProviderId) => void,
	theme: TextTheme,
): JSX.Element {
	const width = resolveWidth(config);
	const right = buildHeaderRight(providers);
	const headerLine = formatHeader(
		Object.keys(providers).length,
		right,
		collapsed,
		width,
		config.symbols,
	);
	const header = box({ width: "100%", onMouseDown: onToggleCollapsed }, [
		renderText(headerLine.text, colorForSeverity(headerLine.severity, theme)),
	]);
	if (collapsed || config.enabled === false) return renderPanel([header]);

	const rows = orderedProviders(providers).map((provider) =>
		renderProviderBlock(
			providerToView(provider),
			config,
			collapsedProviderIds,
			expandedDetailIds,
			onToggleProvider,
			onToggleDetails,
			theme,
		),
	);
	return renderPanel([header, ...rows]);
}

export function toggleProviderCollapse(
	current: ReadonlySet<ProviderId>,
	clicked: ProviderId,
): Set<ProviderId> {
	if (current.has(clicked)) {
		return new Set([...current].filter((id) => id !== clicked));
	}
	return new Set([...current, clicked]);
}

export const toggleExpandedProviderId = toggleProviderCollapse;

function renderProviderBlock(
	view: ProviderUsageView,
	config: Required<UsageMonitorConfig>,
	collapsedProviderIds: ReadonlySet<ProviderId>,
	expandedDetailIds: ReadonlySet<ProviderId>,
	onToggleProvider: (id: ProviderId) => void,
	onToggleDetails: (id: ProviderId) => void,
	theme: TextTheme,
): JSX.Element {
	const width = resolveWidth(config);
	const providerCollapsed = collapsedProviderIds.has(view.id);

	if (providerCollapsed) {
		return box(
			{
				width: "100%",
				flexDirection: "column",
				onMouseDown: () => onToggleProvider(view.id),
			},
			renderLines([formatCollapsedSummary(view, width)], theme),
		);
	}

	const showDetails = expandedDetailIds.has(view.id);
	const titleLine = formatProviderTitle(view, false, width);
	const metrics = formatProviderMetricsForState(
		view,
		config,
		width,
		showDetails,
	);
	const titleEl = box(
		{ width: "100%", onMouseDown: () => onToggleProvider(view.id) },
		renderLines([titleLine], theme),
	);
	const metricEls = metrics.map((line) =>
		box(
			{ width: "100%", onMouseDown: () => onToggleDetails(view.id) },
			renderLines([line], theme),
		),
	);

	return box({ width: "100%", flexDirection: "column" }, [
		titleEl,
		...metricEls,
	]);
}

function renderLines(lines: FormattedLine[], theme: TextTheme): JSX.Element[] {
	return lines.map((line) => {
		if (line.suffix) {
			return box({ flexDirection: "row" }, [
				text({ fg: colorForSeverity(line.severity, theme) }, [
					truncateTo(line.text, line.text.length),
				]),
				text({ fg: theme.textMuted }, [
					truncateTo(` · ${line.suffix}`, line.suffix.length + 3),
				]),
			]);
		}
		return renderText(line.text, colorForSeverity(line.severity, theme));
	});
}

function renderText(value: string, color: unknown): JSX.Element {
	return text({ fg: color }, [truncateTo(value, value.length)]);
}

function renderPanel(children: Child[]): JSX.Element {
	return box(
		{
			width: "100%",
			flexDirection: "column",
			paddingTop: 0,
			paddingBottom: 0,
			paddingLeft: 0,
			paddingRight: 0,
		},
		children,
	);
}

function colorForSeverity(
	severity: FormattedLine["severity"],
	theme: TextTheme,
): unknown {
	if (severity === "warning") return theme.accent;
	if (severity === "critical") return theme.error ?? theme.accent;
	if (severity === "muted") return theme.textMuted;
	return theme.text;
}

function buildHeaderRight(
	providers: Record<ProviderId, StandardUsageProvider>,
): string {
	const timestamps = Object.values(providers).flatMap((provider) => {
		if (provider.fetchedAt !== undefined) return [provider.fetchedAt];
		if (provider.lastGoodAt !== undefined) return [provider.lastGoodAt];
		return [];
	});
	if (timestamps.length === 0) return "";
	const now = Date.now();
	const newest = Math.max(...timestamps);
	return formatAge(newest, now);
}

function orderedProviders(
	providers: Record<ProviderId, StandardUsageProvider>,
): StandardUsageProvider[] {
	const preferred = ["openai", "zai", "deepseek"];
	return Object.values(providers).sort((left, right) => {
		const leftIndex = preferred.indexOf(left.id);
		const rightIndex = preferred.indexOf(right.id);
		return (
			(leftIndex === -1 ? 99 : leftIndex) -
			(rightIndex === -1 ? 99 : rightIndex)
		);
	});
}

function resolveWidth(config: Required<UsageMonitorConfig>): number {
	return Number.isFinite(config.width) && config.width > 0
		? config.width
		: CONFIG_DEFAULTS.width;
}

function withPreviousGood(
	next: Record<ProviderId, StandardUsageProvider>,
	previous: Record<ProviderId, StandardUsageProvider>,
): Record<ProviderId, StandardUsageProvider> {
	return Object.fromEntries(
		Object.entries(next).map(([id, provider]) => {
			const previousProvider = previous[id];
			if (
				provider.status !== "error" ||
				previousProvider?.fetchedAt === undefined
			)
				return [id, provider];
			return [id, { ...provider, lastGoodAt: previousProvider.fetchedAt }];
		}),
	);
}

async function readRuntimeConfig(): Promise<RuntimeConfig> {
	const v2 = await readUsageConfigV2();
	if (v2.ok && v2.value.providers.length > 0) {
		const render = renderConfigFromV2(v2.value);
		return {
			config: v2.value,
			render,
			providers: {},
			fingerprint: configFingerprint(render),
		};
	}
	const message = v2.ok
		? "No providers configured"
		: formatConfigIssues(v2.issues);
	return configErrorRuntime(message);
}

function createRuntimeCoordinator(config: ResolvedUsageConfigV2): RefreshCoordinator {
	return createRefreshCoordinator({
		providers: config.providers,
		policy: config.refresh,
		credentialResolver: createCredentialResolver(),
		cache: createProviderCacheV2(),
	});
}

function renderConfigFromV2(
	config: ResolvedUsageConfigV2,
): Required<UsageMonitorConfig> {
	return {
		...CONFIG_DEFAULTS,
		enabled: config.enabled,
		default_collapsed: config.ui.panel_initial_state === "collapsed",
		refresh_ms: config.refresh.interval_ms,
		request_timeout_ms: config.refresh.timeout_ms,
		show_openai: config.providers.some((provider) => provider.id === "openai"),
		show_zai: config.providers.some((provider) => provider.id === "zai"),
		show_deepseek: config.providers.some(
			(provider) => provider.id === "deepseek",
		),
		default_provider_collapsed:
			config.ui.provider_initial_state === "collapsed",
		debug: config.diagnostics.debug,
		width: config.ui.width,
		symbols: config.ui.symbols,
		refresh_keybind:
			config.keybindings.refresh_all ?? CONFIG_DEFAULTS.refresh_keybind,
	};
}

export function runtimeStatesToProviders(
	states: readonly ProviderRuntimeState[],
	previous: Record<ProviderId, StandardUsageProvider>,
): Record<ProviderId, StandardUsageProvider> {
	return withPreviousGood(
		Object.fromEntries(
			states.map((state) => [
				state.id,
				runtimeStateToProvider(state, previous[state.id]),
			]),
		),
		previous,
	);
}

function runtimeStateToProvider(
	state: ProviderRuntimeState,
	previous: StandardUsageProvider | undefined,
): StandardUsageProvider {
	if (state.snapshot) return snapshotForRuntimeState(state, previous);
	const status =
		state.status === "needs_auth"
			? "missing-auth"
			: state.status === "loading" || state.status === "refreshing"
				? "loading"
				: "error";
	return {
		id: state.id,
		displayName: state.id,
		status,
		statusText: state.message,
		errorMessage: state.message,
		windows: [],
		...(previous?.fetchedAt ? { lastGoodAt: previous.fetchedAt } : {}),
	};
}

function snapshotForRuntimeState(
	state: ProviderRuntimeState,
	previous: StandardUsageProvider | undefined,
): StandardUsageProvider {
	const snapshot = state.snapshot;
	if (!snapshot)
		return runtimeStateToProvider({ ...state, snapshot: undefined }, previous);
	if (state.status === "stale")
		return { ...snapshot, staleAt: state.lastAttemptAt ?? Date.now() };
	if (state.status === "refreshing")
		return {
			...snapshot,
			...(previous?.fetchedAt ? { lastGoodAt: previous.fetchedAt } : {}),
		};
	return snapshot;
}

function configErrorRuntime(message: string): RuntimeConfig {
	return {
		render: { ...CONFIG_DEFAULTS, default_provider_collapsed: false },
		providers: {
			config: {
				id: "config",
				displayName: "config",
				status: "error",
				statusText: message,
				errorMessage: message,
				windows: [],
			},
		},
		fingerprint: `config-error:${message}`,
	};
}

function formatConfigIssues(issues: readonly { path: string; message: string }[]): string {
	return issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

type TuiContext = Parameters<Plugin.Definition["setup"]>[0];

type ResolvedThemeLike = {
	text: { base: unknown; muted: unknown; feedback: { warning: { base: unknown }; error: { base: unknown } } };
	background: { base: unknown };
	border: { base: unknown };
};

function textThemeFrom(theme: ResolvedThemeLike): TextTheme {
	return {
		text: theme.text.base,
		textMuted: theme.text.muted,
		accent: theme.text.feedback.warning.base,
		error: theme.text.feedback.error.base,
		background: theme.background.base,
		borderActive: theme.border.base,
	};
}

const plugin: Plugin.Definition = {
	id: "usage-monitor.tui",
	async setup(context: TuiContext) {
		const initialRuntime = await readRuntimeConfig();
		if (initialRuntime.render.enabled === false) return;

		const [getConfig, setConfig] = createSignal<Required<UsageMonitorConfig>>(
			initialRuntime.render,
		);
		const [getProviders, setProviders] = createSignal<
			Record<ProviderId, StandardUsageProvider>
		>({});
		const [getCollapsed, setCollapsed] = createSignal<boolean>(
			initialRuntime.render.default_collapsed,
		);
		const [getCollapsedProviderIds, setCollapsedProviderIds] = createSignal<
			Set<ProviderId>
		>(new Set());
		const [getExpandedDetailIds, setExpandedDetailIds] = createSignal<
			Set<ProviderId>
		>(new Set());
		let configWatcher: FSWatcher | undefined;
		let fingerprint = initialRuntime.fingerprint;
		let providerCollapseInitialized = false;
		let coordinator = initialRuntime.config
			? createRuntimeCoordinator(initialRuntime.config)
			: undefined;

		const setProvidersWithInitialCollapse = (
			providers: Record<ProviderId, StandardUsageProvider>,
		): void => {
			setProviders(providers);
			if (
				providerCollapseInitialized ||
				!getConfig().default_provider_collapsed
			)
				return;
			providerCollapseInitialized = true;
			setCollapsedProviderIds(new Set(Object.keys(providers)));
		};
		let unsubscribe = coordinator?.subscribe((states) => {
			setProvidersWithInitialCollapse(
				runtimeStatesToProviders(states, getProviders()),
			);
		}) ?? (() => undefined);
		setProvidersWithInitialCollapse(initialRuntime.providers);

		const reloadConfig = async (): Promise<void> => {
			const nextRuntime = await readRuntimeConfig();
			const nextFingerprint = nextRuntime.fingerprint;
			if (nextFingerprint === fingerprint) return;
			fingerprint = nextFingerprint;
			setConfig(nextRuntime.render);
			if (!nextRuntime.config) {
				unsubscribe();
				coordinator?.dispose();
				coordinator = undefined;
				unsubscribe = () => undefined;
				setProvidersWithInitialCollapse(nextRuntime.providers);
				return;
			}
			if (coordinator) {
				coordinator.reconfigure(
					nextRuntime.config.providers,
					nextRuntime.config.refresh,
				);
			} else {
				coordinator = createRuntimeCoordinator(nextRuntime.config);
				unsubscribe = coordinator.subscribe((states) => {
					setProvidersWithInitialCollapse(
						runtimeStatesToProviders(states, getProviders()),
					);
				});
			}
			setProvidersWithInitialCollapse(nextRuntime.providers);
			void coordinator.refreshAll();
		};

		const debounceConfigReload = createDebounced(
			() => void reloadConfig(),
			100,
		);
		try {
			configWatcher = watch(CONFIG_PATH, () => debounceConfigReload());
		} catch {
			configWatcher = undefined;
		}

		const toggleCollapsed = (): void => {
			setCollapsed(!getCollapsed());
		};
		const toggleProvider = (id: ProviderId): void => {
			setCollapsedProviderIds(
				toggleProviderCollapse(getCollapsedProviderIds(), id),
			);
		};
		const toggleDetails = (id: ProviderId): void => {
			const current = getExpandedDetailIds();
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setExpandedDetailIds(next);
		};

		void coordinator?.refreshAll();

		const theme = textThemeFrom(context.theme as unknown as ResolvedThemeLike);

		const unregisterSlot = context.ui.slot({
			append: "sidebar.content",
			render: () => {
				try {
					return renderUsagePanel(
						getConfig(),
						getProviders(),
						getCollapsed(),
						getCollapsedProviderIds(),
						getExpandedDetailIds(),
						toggleCollapsed,
						toggleProvider,
						toggleDetails,
						theme,
					);
				} catch (renderErr: unknown) {
					return box({ width: "100%" }, [
						text({ fg: theme.error ?? theme.textMuted }, [
							`usage-monitor render error: ${String(renderErr).slice(0, 80)}`,
						]),
					]);
				}
			},
		});

		context.keymap.layer(() => {
			const keybind = getConfig().refresh_keybind;
			return {
				mode: "global" as const,
				commands: [
					{
						id: "usage-monitor.refresh",
						title: "Refresh Usage Data",
						description:
							"Force refresh usage data from all providers",
						group: "usage-monitor",
						...(keybind ? { bind: keybind } : {}),
						slash: { name: "usage-refresh" },
						run: async () => {
							try {
								if (!coordinator)
									throw new Error("usage monitor config is invalid");
								await coordinator.refreshAll();
								context.ui.toast.show({
									title: "Usage Monitor",
									message: "Usage data refreshed",
									variant: "success",
									duration: 2000,
								});
							} catch (error: unknown) {
								context.ui.toast.show({
									title: "Usage Monitor",
									message: `Usage data refresh failed: ${sanitizeError(error)}`,
									variant: "error",
									duration: 2000,
								});
							}
						},
					},
				],
			};
		});

		return () => {
			debounceConfigReload.cancel();
			configWatcher?.close();
			unsubscribe();
			coordinator?.dispose();
			unregisterSlot();
		};
	},
};

function createDebounced(
	callback: () => void,
	delayMs: number,
): (() => void) & { cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const debounced = (() => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(callback, delayMs);
	}) as (() => void) & { cancel: () => void };
	debounced.cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	return debounced;
}

export default plugin;
