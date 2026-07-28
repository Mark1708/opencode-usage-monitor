import type {
  ProviderBinding,
  ProviderRegistration,
  ValidationIssue,
} from "./providers/contracts.js";

export type ConfigVersion = 2;
export type RefreshModeV2 = "automatic" | "manual";
export type InitialStateV2 = "expanded" | "collapsed";
export type SymbolModeV2 = "unicode" | "ascii";

export type KeybindingsConfigV2 = Readonly<{
  refresh_all?: string | null;
  refresh_provider?: string | null;
}>;

export type UiConfigV2 = Readonly<{
  width?: number;
  symbols?: SymbolModeV2;
  panel_initial_state?: InitialStateV2;
  provider_initial_state?: InitialStateV2;
}>;

export type RefreshConfigV2 = Readonly<{
  mode?: RefreshModeV2;
  interval_ms?: number;
  timeout_ms?: number;
  stale_after_ms?: number;
}>;

export type DiagnosticsConfigV2 = Readonly<{
  debug?: boolean;
}>;

export type CredentialReferenceV2 =
  | Readonly<{ source: "opencode"; entry: string }>
  | Readonly<{ source: "env"; name: string }>;

export type ProviderConfigV2 = Readonly<{
  order?: number;
  credential?: CredentialReferenceV2;
  options?: unknown;
}>;

export type UsageConfigV2 = Readonly<{
  version: ConfigVersion;
  enabled?: boolean;
  keybindings?: KeybindingsConfigV2;
  ui?: UiConfigV2;
  refresh?: RefreshConfigV2;
  diagnostics?: DiagnosticsConfigV2;
  providers: Readonly<Record<string, ProviderConfigV2>>;
}>;

export type ResolvedKeybindingsConfigV2 = Readonly<{
  refresh_all: string | null;
  refresh_provider: string | null;
}>;

export type ResolvedUiConfigV2 = Readonly<{
  width: number;
  symbols: SymbolModeV2;
  panel_initial_state: InitialStateV2;
  provider_initial_state: InitialStateV2;
}>;

export type ResolvedRefreshConfigV2 = Readonly<{
  mode: RefreshModeV2;
  interval_ms: number;
  timeout_ms: number;
  stale_after_ms: number;
}>;

export type ResolvedDiagnosticsConfigV2 = Readonly<{
  debug: boolean;
}>;

type ResolvedProviderBaseV2 = Readonly<{
  id: string;
  order: number;
  registration: ProviderRegistration;
  credential?: CredentialReferenceV2;
}>;

export type ResolvedProviderConfigV2 = ResolvedProviderBaseV2 & (
  | Readonly<{ ok: true; binding: ProviderBinding }>
  | Readonly<{ ok: false; issues: readonly ValidationIssue[] }>
);

export type ResolvedUsageConfigV2 = Readonly<{
  version: ConfigVersion;
  enabled: boolean;
  keybindings: ResolvedKeybindingsConfigV2;
  ui: ResolvedUiConfigV2;
  refresh: ResolvedRefreshConfigV2;
  diagnostics: ResolvedDiagnosticsConfigV2;
  providers: readonly ResolvedProviderConfigV2[];
}>;

export type ConfigTextResult =
  | Readonly<{ exists: false }>
  | Readonly<{ exists: true; text: string }>;

export type ConfigTextReader = (path: string) => Promise<ConfigTextResult>;

export type ReadUsageConfigV2Options = Readonly<{
  dedicatedPath?: string;
  omoPath?: string;
  readText?: ConfigTextReader;
}>;
