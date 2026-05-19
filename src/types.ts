export type ProviderId = "openai" | "zai";

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

export type ChatGptRateWindow = {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
};

export type ChatGptAdditionalRateLimit = {
  limit_name: string;
  metered_feature: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: ChatGptRateWindow;
    secondary_window: ChatGptRateWindow;
  };
};

export type OpenAIUsageData = {
  planType: string;
  rateLimit: {
    allowed: boolean;
    limitReached: boolean;
    primaryWindow: ChatGptRateWindow;
    secondaryWindow: ChatGptRateWindow;
  };
  additionalRateLimits: ChatGptAdditionalRateLimit[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    overageLimitReached: boolean;
    balance: string;
    approxLocalMessages: [number, number];
    approxCloudMessages: [number, number];
  };
  spendControl: {
    reached: boolean;
    individualLimit: number | null;
  };
  fetchedAt: number;
};

export type ZaiLimitType = "TIME_LIMIT" | "TOKENS_LIMIT" | "RATE_LIMIT" | "TIMES_LIMIT" | "SESSION_LIMIT";

export type ZaiLimitDetail = {
  modelCode: string;
  usage: number;
};

export type ZaiLimitEntry = {
  type: ZaiLimitType;
  percentage?: number;
  remaining?: number;
  nextResetTime?: number;
  usageDetails?: ZaiLimitDetail[];
};

export type ZaiUsageData = {
  planName?: string;
  limits?: ZaiLimitEntry[];
  fetchedAt: number;
};

export type ProviderUsageState =
  | { kind: "idle"; provider: ProviderId }
  | { kind: "loading"; provider: ProviderId; startedAt: number }
  | { kind: "ready"; provider: ProviderId; data: OpenAIUsageData | ZaiUsageData; fetchedAt: number }
  | { kind: "partial"; provider: ProviderId; data: Partial<OpenAIUsageData | ZaiUsageData>; fetchedAt: number; warnings: string[] }
  | { kind: "missing-auth"; provider: ProviderId; message: string }
  | { kind: "forbidden"; provider: ProviderId; message: string }
  | { kind: "unsupported"; provider: ProviderId; message: string }
  | { kind: "error"; provider: ProviderId; message: string; lastGood?: OpenAIUsageData | ZaiUsageData; lastGoodAt?: number };

export type UsageMonitorConfig = {
  enabled?: boolean;
  default_collapsed?: boolean;
  refresh_ms?: number;
  request_timeout_ms?: number;
  show_openai?: boolean;
  show_zai?: boolean;
  show_details?: boolean;
  width?: number;
  symbols?: "unicode" | "ascii";
};

export type DiscoveredProvider = {
  id: ProviderId;
  hasAuth: boolean;
  authMessage?: string;
};

export type RefreshGuard = {
  isActive: boolean;
  start: () => boolean;
  finish: () => void;
};
