import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

import type {
  DiscoveredProvider,
  OpenAIUsageData,
  ProviderId,
  ProviderUsageState,
  RefreshGuard,
  UsageMonitorConfig,
  ZaiUsageData,
} from "./types.js";
import { readUsageConfig, CONFIG_DEFAULTS } from "./config.js";
import { readAuthFile, discoverOpenAICredential, discoverZaiCredential, discoverProviders } from "./auth.js";
import { createRefreshGuard, fetchOpenAIUsage, fetchZaiUsage } from "./providers.js";
import {
  formatHeaderLine,
  formatAge,
  formatOpenAILine1,
  formatOpenAILine2,
  formatZaiLine1,
  formatZaiLine2,
  formatStaleSuffix,
  formatProviderStatusLine,
  truncateTo,
  sanitizeError,
} from "./format.js";

type Child = JSX.Element | string | number | null | undefined | false;

interface TextTheme {
  accent: unknown;
  background: unknown;
  borderActive: unknown;
  text: unknown;
  textMuted: unknown;
}

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

const DEFAULT_SIDEBAR_WIDTH = 34;
const STALE_AFTER_MS = 120_000;

function renderText(value: string, color: unknown): JSX.Element {
  return text({ fg: color }, [value]);
}

function renderPanel(children: Child[]): JSX.Element {
  return box({
    width: "100%",
    flexDirection: "column",
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
  }, children);
}

function renderUsagePanel(
  config: Required<UsageMonitorConfig>,
  providerStates: Record<ProviderId, ProviderUsageState>,
  collapsed: boolean,
  onToggle: () => void,
  theme: TextTheme,
): JSX.Element {
  const width = resolveWidth(config);
  const marker = config.symbols === "ascii" ? (collapsed ? ">" : "v") : (collapsed ? "▶" : "▼");
  const right = buildHeaderRight(providerStates);
  const headerLine = formatHeaderLine(`${marker} Usage`, right, width);
  const header = box({ width: "100%", onMouseDown: onToggle }, [renderText(headerLine, theme.accent)]);

  if (collapsed) return renderPanel([header]);

  const rows = orderedProviderStates(providerStates)
    .flatMap(([providerId, state]) => renderProviderRows(providerId, state, config, theme));
  return renderPanel([header, ...rows]);
}

function buildHeaderRight(providerStates: Record<ProviderId, ProviderUsageState>): string {
  const fetchedAtValues = Object.values(providerStates).flatMap((state) => {
    if (state.kind === "ready" || state.kind === "partial") return [state.fetchedAt];
    if (state.kind === "error" && state.lastGoodAt !== undefined) return [state.lastGoodAt];
    return [];
  });
  if (fetchedAtValues.length === 0) return "";

  const now = Date.now();
  const newestFetchedAt = Math.max(...fetchedAtValues);
  const staleFetchedAt = fetchedAtValues
    .filter((fetchedAt) => now - fetchedAt > STALE_AFTER_MS)
    .sort((left, right) => left - right)[0];
  const staleSuffix = staleFetchedAt === undefined ? "" : formatStaleSuffix(staleFetchedAt, now);
  return [formatAge(newestFetchedAt, now), staleSuffix].filter((part) => part.length > 0).join(" ");
}

function orderedProviderStates(
  providerStates: Record<ProviderId, ProviderUsageState>,
): Array<[ProviderId, ProviderUsageState]> {
  const ids: ProviderId[] = ["openai", "zai"];
  return ids.flatMap((id) => {
    const state = providerStates[id];
    return state ? [[id, state] as [ProviderId, ProviderUsageState]] : [];
  });
}

function renderProviderRows(
  providerId: ProviderId,
  state: ProviderUsageState,
  config: Required<UsageMonitorConfig>,
  theme: TextTheme,
): JSX.Element[] {
  const width = resolveWidth(config);
  switch (state.kind) {
    case "idle":
      return [renderText(formatProviderStatusLine(providerId, "...", width), theme.textMuted)];
    case "loading":
      return [renderText(formatProviderStatusLine(providerId, "loading...", width), theme.textMuted)];
    case "ready":
    case "partial":
      return providerId === "openai"
        ? renderOpenAIRows(state.data as OpenAIUsageData | Partial<OpenAIUsageData>, config, theme)
        : renderZaiRows(state.data as ZaiUsageData | Partial<ZaiUsageData>, config, theme);
    case "missing-auth":
      return [renderText(formatProviderStatusLine(providerId, state.message, width), theme.textMuted)];
    case "forbidden":
      return [renderText(formatProviderStatusLine(providerId, "forbidden", width), theme.textMuted)];
    case "unsupported":
      return [renderText(formatProviderStatusLine(providerId, "unsupported", width), theme.textMuted)];
    case "error":
      return [renderText(formatProviderStatusLine(providerId, truncateTo(state.message, 18), width), theme.textMuted)];
  }
}

function renderOpenAIRows(
  data: OpenAIUsageData | Partial<OpenAIUsageData>,
  config: Required<UsageMonitorConfig>,
  theme: TextTheme,
): JSX.Element[] {
  const width = resolveWidth(config);
  const lines: Child[] = [
    renderText(formatOpenAILine1(data, width), theme.text),
    config.show_details ? renderText(formatOpenAILine2(data, width), theme.textMuted) : null,
  ];
  return [box({ width: "100%", flexDirection: "column" }, lines)];
}

function renderZaiRows(
  data: ZaiUsageData | Partial<ZaiUsageData>,
  config: Required<UsageMonitorConfig>,
  theme: TextTheme,
): JSX.Element[] {
  const width = resolveWidth(config);
  const lines: Child[] = [
    renderText(formatZaiLine1(data, width), theme.text),
    config.show_details ? renderText(formatZaiLine2(data, width), theme.textMuted) : null,
  ];
  return [box({ width: "100%", flexDirection: "column" }, lines)];
}

function resolveWidth(config: Required<UsageMonitorConfig>): number {
  return Number.isFinite(config.width) && config.width > 0 ? config.width : DEFAULT_SIDEBAR_WIDTH;
}

function initializeProviderStates(providers: DiscoveredProvider[]): Record<ProviderId, ProviderUsageState> {
  return providers.reduce<Partial<Record<ProviderId, ProviderUsageState>>>((states, provider) => ({
    ...states,
    [provider.id]: provider.hasAuth
      ? { kind: "idle", provider: provider.id }
      : { kind: "missing-auth", provider: provider.id, message: provider.authMessage ?? "auth missing" },
  }), {}) as Record<ProviderId, ProviderUsageState>;
}

function withPreviousGood(
  nextState: ProviderUsageState,
  previousState: ProviderUsageState | undefined,
): ProviderUsageState {
  if (nextState.kind !== "error") return nextState;
  if (previousState?.kind === "ready" || previousState?.kind === "partial") {
    return {
      ...nextState,
      message: sanitizeError(nextState.message),
      lastGood: previousState.data as OpenAIUsageData | ZaiUsageData,
      lastGoodAt: previousState.fetchedAt,
    };
  }
  if (previousState?.kind === "error" && previousState.lastGood) {
    return {
      ...nextState,
      message: sanitizeError(nextState.message),
      lastGood: previousState.lastGood,
      lastGoodAt: previousState.lastGoodAt,
    };
  }
  return { ...nextState, message: sanitizeError(nextState.message) };
}

function sanitizeProviderState(state: ProviderUsageState): ProviderUsageState {
  if (state.kind === "error") return { ...state, message: sanitizeError(state.message) };
  if (state.kind === "forbidden") return { ...state, message: sanitizeError(state.message) };
  if (state.kind === "missing-auth") return { ...state, message: sanitizeError(state.message) };
  if (state.kind === "unsupported") return { ...state, message: sanitizeError(state.message) };
  return state;
}

function shouldRefreshProvider(provider: DiscoveredProvider, config: Required<UsageMonitorConfig>): boolean {
  if (!provider.hasAuth) return false;
  if (provider.id === "openai") return config.show_openai;
  if (provider.id === "zai") return config.show_zai;
  return false;
}

const plugin: TuiPluginModule & { id: string } = {
  id: "usage-monitor:tui",
  tui: async (api, _options, _meta) => {
    const [getCollapsed, setCollapsed] = createSignal<boolean>(false);
    const [getProviderStates, setProviderStates] = createSignal<Record<ProviderId, ProviderUsageState>>({} as Record<ProviderId, ProviderUsageState>);
    const [getConfig, setConfig] = createSignal<Required<UsageMonitorConfig>>(CONFIG_DEFAULTS);

    const config = await readUsageConfig();
    if (config.enabled === false) return;

    const resolvedConfig = { ...CONFIG_DEFAULTS, ...config };
    setConfig(resolvedConfig);
    setCollapsed(resolvedConfig.default_collapsed);

    const authState = await readAuthFile();
    const auth = authState.kind === "loaded" ? authState.auth : {};
    const providers = await discoverProviders(auth);
    setProviderStates(initializeProviderStates(providers));

    const guard: RefreshGuard = createRefreshGuard();
    const abortController = new AbortController();

    const refreshProvider = async (provider: DiscoveredProvider): Promise<void> => {
      const currentConfig = getConfig();
      if (!shouldRefreshProvider(provider, currentConfig)) return;

      const previousState = getProviderStates()[provider.id];
      setProviderStates({
        ...getProviderStates(),
        [provider.id]: { kind: "loading", provider: provider.id, startedAt: Date.now() },
      });
      api.renderer.requestRender();

      const nextState = provider.id === "openai"
        ? await fetchOpenAIProvider(auth, currentConfig.request_timeout_ms, abortController.signal)
        : await fetchZaiProvider(auth, currentConfig.request_timeout_ms, abortController.signal);
      const safeState = sanitizeProviderState(withPreviousGood(nextState, previousState));

      setProviderStates({ ...getProviderStates(), [provider.id]: safeState });
      api.renderer.requestRender();
    };

    const refreshAll = async (): Promise<void> => {
      if (!guard.start()) return;
      try {
        for (const provider of providers) {
          await refreshProvider(provider);
        }
      } finally {
        guard.finish();
      }
    };

    const toggleCollapsed = (): void => {
      setCollapsed(!getCollapsed());
      api.renderer.requestRender();
    };

    const pollTimer = setInterval(() => {
      refreshAll().catch(() => {});
    }, getConfig().refresh_ms);

    refreshAll().catch(() => {});

    api.lifecycle.onDispose(() => {
      clearInterval(pollTimer);
      abortController.abort();
    });

    api.slots.register({
      order: 840,
      slots: {
        sidebar_content() {
          return renderUsagePanel(
            getConfig(),
            getProviderStates(),
            getCollapsed(),
            toggleCollapsed,
            api.theme.current,
          );
        },
      },
    });
  },
};

async function fetchOpenAIProvider(
  auth: Parameters<typeof discoverOpenAICredential>[0],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProviderUsageState> {
  const credential = discoverOpenAICredential(auth);
  if (!("token" in credential)) {
    return { kind: "missing-auth", provider: "openai", message: sanitizeError(credential.message) };
  }
  return fetchOpenAIUsage(credential.token, timeoutMs, signal);
}

async function fetchZaiProvider(
  auth: Parameters<typeof discoverZaiCredential>[0],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProviderUsageState> {
  const credential = discoverZaiCredential(auth);
  if (!("token" in credential)) {
    return { kind: "missing-auth", provider: "zai", message: sanitizeError(credential.message) };
  }
  return fetchZaiUsage(credential.token, credential.baseUrl, timeoutMs, signal);
}

export default plugin;
