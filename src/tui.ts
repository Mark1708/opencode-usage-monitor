import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { watch, type FSWatcher } from "node:fs";
import { createSignal } from "solid-js";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

import type { ProviderContext, ProviderId, RefreshGuard, StandardUsageProvider, TextTheme, UsageMonitorConfig } from "./providers/types.js";
import { CONFIG_DEFAULTS, CONFIG_PATH, configFingerprint, mergeUsageConfig, readUsageConfig } from "./config.js";
import { filterFreshProviders, readCache, staleProviderIds, writeCache } from "./cache.js";
import { getActiveAdapters, refreshAllAdapters } from "./providers/registry.js";
import { formatCollapsedSummary, formatHeader, formatProviderMetricsForState, formatProviderTitle, type FormattedLine } from "./format.js";
import { formatAge, truncateTo } from "./layout.js";
import { sanitizeError } from "./sanitize.js";
import { readAuthFile } from "./auth.js";
import { providerToView } from "./views/index.js";
import type { ProviderUsageView } from "./views/types.js";

type Child = JSX.Element | string | number | null | undefined | false;

function element(tag: string, props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) insert(node, child);
  }
  return node as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[]): JSX.Element {
  return element("text", props, children);
}

function box(props: Record<string, unknown>, children: Child[] = []): JSX.Element {
  return element("box", props, children);
}

export function createRefreshGuard(): RefreshGuard {
  let active = false;
  return {
    get isActive() { return active; },
    start: () => {
      if (active) return false;
      active = true;
      return true;
    },
    finish: () => { active = false; },
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
  const headerLine = formatHeader(Object.keys(providers).length, right, collapsed, width, config.symbols);
  const header = box({ width: "100%", onMouseDown: onToggleCollapsed }, [renderText(headerLine.text, colorForSeverity(headerLine.severity, theme))]);
  if (collapsed || config.enabled === false) return renderPanel([header]);

  const rows = orderedProviders(providers).map((provider) => renderProviderBlock(
    providerToView(provider),
    config,
    collapsedProviderIds,
    expandedDetailIds,
    onToggleProvider,
    onToggleDetails,
    theme,
  ));
  return renderPanel([header, ...rows]);
}

export function toggleProviderCollapse(current: ReadonlySet<ProviderId>, clicked: ProviderId): Set<ProviderId> {
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
      { width: "100%", flexDirection: "column", onMouseDown: () => onToggleProvider(view.id) },
      renderLines([formatCollapsedSummary(view, width)], theme),
    );
  }

  const showDetails = expandedDetailIds.has(view.id);
  const titleLine = formatProviderTitle(view, false, width);
  const metrics = formatProviderMetricsForState(view, config, width, showDetails);
  const titleEl = box({ width: "100%", onMouseDown: () => onToggleProvider(view.id) }, renderLines([titleLine], theme));
  const metricEls = metrics.map((line) => box({ width: "100%", onMouseDown: () => onToggleDetails(view.id) }, renderLines([line], theme)));

  return box({ width: "100%", flexDirection: "column" }, [titleEl, ...metricEls]);
}

function renderLines(lines: FormattedLine[], theme: TextTheme): JSX.Element[] {
  return lines.map((line) => {
    if (line.suffix) {
      return box({ flexDirection: "row" }, [
        text({ fg: colorForSeverity(line.severity, theme) }, [truncateTo(line.text, line.text.length)]),
        text({ fg: theme.textMuted }, [truncateTo(` · ${line.suffix}`, line.suffix.length + 3)]),
      ]);
    }
    return renderText(line.text, colorForSeverity(line.severity, theme));
  });
}

function renderText(value: string, color: unknown): JSX.Element {
  return text({ fg: color }, [truncateTo(value, value.length)]);
}

function renderPanel(children: Child[]): JSX.Element {
  return box({ width: "100%", flexDirection: "column", paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 }, children);
}

function colorForSeverity(severity: FormattedLine["severity"], theme: TextTheme): unknown {
  if (severity === "warning") return theme.accent;
  if (severity === "critical") return theme.error ?? theme.accent;
  if (severity === "muted") return theme.textMuted;
  return theme.text;
}

function buildHeaderRight(providers: Record<ProviderId, StandardUsageProvider>): string {
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

function orderedProviders(providers: Record<ProviderId, StandardUsageProvider>): StandardUsageProvider[] {
  const preferred = ["openai", "zai"];
  return Object.values(providers).sort((left, right) => {
    const leftIndex = preferred.indexOf(left.id);
    const rightIndex = preferred.indexOf(right.id);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  });
}

function resolveWidth(config: Required<UsageMonitorConfig>): number {
  return Number.isFinite(config.width) && config.width > 0 ? config.width : CONFIG_DEFAULTS.width;
}

function withPreviousGood(
  next: Record<ProviderId, StandardUsageProvider>,
  previous: Record<ProviderId, StandardUsageProvider>,
): Record<ProviderId, StandardUsageProvider> {
  return Object.fromEntries(Object.entries(next).map(([id, provider]) => {
    const previousProvider = previous[id];
    if (provider.status !== "error" || previousProvider?.fetchedAt === undefined) return [id, provider];
    return [id, { ...provider, lastGoodAt: previousProvider.fetchedAt }];
  }));
}

function markProvidersStale(providers: Record<string, StandardUsageProvider>): Record<string, StandardUsageProvider> {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, { ...provider, fetchedAt: 0 }]));
}

function envSubset(): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ZAI_CODING_PLAN_API_KEY: process.env.ZAI_CODING_PLAN_API_KEY,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
    ZHIPUAI_API_KEY: process.env.ZHIPUAI_API_KEY,
  };
}

const plugin: TuiPluginModule & { id: string } = {
  id: "usage-monitor:tui",
  tui: async (api, _options, _meta) => {
    const initialConfig = mergeUsageConfig(await readUsageConfig());
    if (initialConfig.enabled === false) return;

    const authState = await readAuthFile();
    const auth = authState.kind === "loaded" ? authState.auth : {};
    const [getConfig, setConfig] = createSignal<Required<UsageMonitorConfig>>(initialConfig);
    const [getProviders, setProviders] = createSignal<Record<ProviderId, StandardUsageProvider>>({});
    const [getCollapsed, setCollapsed] = createSignal<boolean>(initialConfig.default_collapsed);
    const [getCollapsedProviderIds, setCollapsedProviderIds] = createSignal<Set<ProviderId>>(new Set());
    const [getExpandedDetailIds, setExpandedDetailIds] = createSignal<Set<ProviderId>>(new Set());
    const guard = createRefreshGuard();
    const abortController = new AbortController();
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let configWatcher: FSWatcher | undefined;
    let fingerprint = configFingerprint(initialConfig);
    let unregisterRefreshCommand: (() => void) | undefined;
    let providerCollapseInitialized = false;

    const makeContext = (): ProviderContext => ({ auth, env: envSubset(), config: getConfig(), timeoutMs: getConfig().request_timeout_ms });
    const requestRender = (): void => api.renderer.requestRender();
    const setProvidersWithInitialCollapse = (providers: Record<ProviderId, StandardUsageProvider>): void => {
      setProviders(providers);
      if (providerCollapseInitialized || !getConfig().default_provider_collapsed) return;
      providerCollapseInitialized = true;
      setCollapsedProviderIds(new Set(Object.keys(providers)));
    };
    const refreshAll = async (): Promise<void> => {
      if (!guard.start()) return;
      try {
        const config = getConfig();
        const ctx = makeContext();
        const ttlMs = config.refresh_ms;
        const previousProviders = getProviders();

        const cached = readCache();
        if (cached !== null) {
          const freshProviders = filterFreshProviders(cached, ttlMs);
          const activeIds = getActiveAdapters(ctx, config).map((adapter) => adapter.id);
          const allFresh = staleProviderIds(cached, activeIds, ttlMs).length === 0;

          if (allFresh) {
            const providers = withPreviousGood(freshProviders, previousProviders);
            setProvidersWithInitialCollapse(providers);
            requestRender();
            return;
          }

          if (Object.keys(freshProviders).length > 0) {
            setProvidersWithInitialCollapse(withPreviousGood(freshProviders, previousProviders));
            requestRender();
          }
        }

        const providers = withPreviousGood(
          await refreshAllAdapters(ctx, config, abortController.signal),
          previousProviders,
        );
        setProvidersWithInitialCollapse(providers);
        writeCache(providers);
      } catch (error: unknown) {
        const cached = readCache();
        if (cached && Object.keys(cached).length > 0) {
          setProvidersWithInitialCollapse(cached);
        } else {
          setProvidersWithInitialCollapse({ usage: { id: "usage", displayName: "usage", status: "error", statusText: sanitizeError(error), errorMessage: sanitizeError(error), windows: [] } });
        }
      } finally {
        guard.finish();
        requestRender();
      }
    };

    const restartPoll = (): void => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      pollTimer = setInterval(() => void refreshAll(), getConfig().refresh_ms);
    };

    const reloadConfig = async (): Promise<void> => {
      const nextConfig = mergeUsageConfig(await readUsageConfig());
      const nextFingerprint = configFingerprint(nextConfig);
      if (nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      setConfig(nextConfig);
      restartPoll();
      requestRender();
      void refreshAll();
    };

    const debounceConfigReload = createDebounced(() => void reloadConfig(), 100);
    try {
      configWatcher = watch(CONFIG_PATH, () => debounceConfigReload());
    } catch {
      configWatcher = undefined;
    }

    const toggleCollapsed = (): void => {
      setCollapsed(!getCollapsed());
      requestRender();
    };
    const toggleProvider = (id: ProviderId): void => {
      setCollapsedProviderIds(toggleProviderCollapse(getCollapsedProviderIds(), id));
      requestRender();
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
      requestRender();
    };

    restartPoll();
    void refreshAll();
    api.lifecycle.onDispose(() => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      debounceConfigReload.cancel();
      configWatcher?.close();
      abortController.abort();
      unregisterRefreshCommand?.();
    });

    api.slots.register({
      order: 840,
      slots: {
        sidebar_content() {
          return renderUsagePanel(
            getConfig(),
            getProviders(),
            getCollapsed(),
            getCollapsedProviderIds(),
            getExpandedDetailIds(),
            toggleCollapsed,
            toggleProvider,
            toggleDetails,
            api.theme.current,
          );
        },
      },
    });

    unregisterRefreshCommand = api.command?.register(() => [{
      title: "Refresh Usage Data",
      value: "usage-monitor:refresh",
      description: "Force refresh usage data from all providers",
      category: "usage-monitor",
      keybind: "shift+r",
      slash: { name: "usage-refresh" },
      onSelect: async (_dialog) => {
        try {
          const cachedProviders = readCache();
          if (cachedProviders !== null) writeCache(markProvidersStale(cachedProviders));
          await refreshAll();
          api.ui.toast({ title: "Usage Monitor", message: "Usage data refreshed", variant: "success", duration: 2000 });
        } catch (error: unknown) {
          api.ui.toast({ title: "Usage Monitor", message: `Usage data refresh failed: ${sanitizeError(error)}`, variant: "error", duration: 2000 });
        }
      },
    }]);
  },
};

function createDebounced(callback: () => void, delayMs: number): (() => void) & { cancel: () => void } {
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
