export type ProviderId = string;

export type ProviderVisibilityConfigKey = "show_openai" | "show_zai" | "show_deepseek";

export type UsageSeverity = "normal" | "warning" | "critical" | "muted";

export type ProviderStatus = "loading" | "ready" | "partial" | "missing-auth" | "forbidden" | "unsupported" | "error";

export type UsageAmount =
  | Readonly<{ kind: "percent"; usedPercent: number }>
  | Readonly<{ kind: "quota"; used: number; limit: number; unit: string }>;

export type UsagePeriod =
  | Readonly<{ kind: "rolling"; durationMs: number }>
  | Readonly<{ kind: "calendar"; unit: "day" | "week" | "month" | "billing" }>
  | Readonly<{ kind: "unknown" }>;

export type DetailValue =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "number"; value: number; unit?: string }>
  | Readonly<{ kind: "currency"; value: number; currency: string }>
  | Readonly<{ kind: "flag"; value: boolean }>;

export type ProviderDetail = Readonly<{
  key: string;
  label: string;
  value: DetailValue;
  visibility: "summary" | "detail" | "debug";
  priority?: number;
  tone?: "normal" | "muted" | "good" | "warn" | "bad";
}>;

export type UsageWindowKind =
  | "rolling"
  | "daily"
  | "weekly"
  | "monthly"
  | "billing"
  | "tokens"
  | "requests"
  | "credits"
  | "cost"
  | "unknown";

export type StandardUsageWindow = {
  id: string;
  label: string;
  kind: UsageWindowKind;
  period: UsagePeriod;
  usage: UsageAmount;
  percentage?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  currentValue?: number;
  unitLabel?: string;
  resetAt?: number;
  resetLabel?: string;
  budgetLabel?: string;
  limitReached?: boolean;
  severity?: UsageSeverity;
  summaryDetails?: string[];
};

export type StandardUsageAlert = {
  id: string;
  label: string;
  severity: UsageSeverity;
};

export type StandardModelBreakdown = {
  id: string;
  label: string;
  percentage?: number;
  used?: number;
  unitLabel?: string;
  costUsd?: number;
  requests?: number;
  severity?: UsageSeverity;
};

export type StandardUsageProvider = {
  id: ProviderId;
  displayName: string;
  status: ProviderStatus;
  statusText?: string;
  plan?: string;
  windows: StandardUsageWindow[];
  details?: ProviderDetail[];
  alerts?: StandardUsageAlert[];
  modelBreakdown?: StandardModelBreakdown[];
  fetchedAt?: number;
  staleAt?: number;
  lastGoodAt?: number;
  errorMessage?: string;
};

export type UsageProviderSnapshot = Readonly<{
  id: ProviderId;
  displayName: string;
  status: ProviderStatus;
  statusText?: string;
  windows: readonly Readonly<StandardUsageWindow>[];
  details: readonly ProviderDetail[];
  alerts?: readonly StandardUsageAlert[];
  modelBreakdown?: readonly StandardModelBreakdown[];
  fetchedAt?: number;
  staleAt?: number;
  lastGoodAt?: number;
  errorMessage?: string;
}>;

export type ProviderContext = {
  auth: Record<string, unknown>;
  env: Record<string, string | undefined>;
  config: UsageMonitorConfig;
  timeoutMs: number;
};

export type UsageProviderAdapter = {
  id: ProviderId;
  displayName: string;
  /** A false value excludes the adapter from rendering, credential discovery, and network requests. */
  configKey?: ProviderVisibilityConfigKey;
  isAvailable(ctx: ProviderContext): boolean;
  fetchUsage(ctx: ProviderContext, signal: AbortSignal): Promise<StandardUsageProvider>;
};

export type UsageMonitorConfig = {
  enabled?: boolean;
  default_collapsed?: boolean;
  refresh_ms?: number;
  request_timeout_ms?: number;
  show_openai?: boolean;
  show_zai?: boolean;
  show_deepseek?: boolean;
  show_details?: boolean;
  default_provider_collapsed?: boolean;
  debug?: boolean;
  width?: number;
  symbols?: "unicode" | "ascii";
  max_detail_lines?: number;
  max_windows?: number;
  max_model_lines?: number;
  refresh_keybind?: string;
  zai_organization_id?: string;
  zai_project_id?: string;
};

export type RefreshGuard = {
  isActive: boolean;
  start: () => boolean;
  finish: () => void;
};

export type AuthEntry = {
  type?: string;
  key?: string;
  apiKey?: string;
  api_key?: string;
  token?: string;
  accessToken?: string;
  auth_token?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  metadata?: Record<string, string>;
};

export type AuthJson = Record<string, AuthEntry>;

export type AuthState =
  | { kind: "loaded"; path: string; auth: AuthJson }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; error: string };
