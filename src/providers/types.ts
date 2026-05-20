export type ProviderId = string;

export type UsageSeverity = "normal" | "warning" | "critical" | "muted";

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
  additionalProperties?: Record<string, unknown>;
};

export type StandardUsageAlert = {
  id: string;
  label: string;
  severity: UsageSeverity;
  additionalProperties?: Record<string, unknown>;
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
  additionalProperties?: Record<string, unknown>;
};

export type StandardUsageProvider = {
  id: ProviderId;
  displayName: string;
  status: "loading" | "ready" | "partial" | "missing-auth" | "forbidden" | "unsupported" | "error";
  statusText?: string;
  plan?: string;
  windows: StandardUsageWindow[];
  alerts?: StandardUsageAlert[];
  modelBreakdown?: StandardModelBreakdown[];
  additionalProperties?: Record<string, unknown>;
  fetchedAt?: number;
  staleAt?: number;
  lastGoodAt?: number;
  errorMessage?: string;
};

export type ProviderContext = {
  auth: Record<string, unknown>;
  env: Record<string, string | undefined>;
  config: UsageMonitorConfig;
  timeoutMs: number;
};

export type UsageProviderAdapter = {
  id: ProviderId;
  displayName: string;
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
  show_details?: boolean;
  default_provider_collapsed?: boolean;
  debug?: boolean;
  width?: number;
  symbols?: "unicode" | "ascii";
  max_detail_lines?: number;
  max_windows?: number;
  max_model_lines?: number;
};

export type RefreshGuard = {
  isActive: boolean;
  start: () => boolean;
  finish: () => void;
};

export type TextTheme = {
  accent: unknown;
  background: unknown;
  borderActive: unknown;
  text: unknown;
  textMuted: unknown;
  error?: unknown;
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
};

export type AuthJson = Record<string, AuthEntry>;

export type AuthState =
  | { kind: "loaded"; path: string; auth: AuthJson }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; error: string };
