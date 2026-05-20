export type UsageTone = "normal" | "muted" | "good" | "warn" | "bad";

export type UsageMetric = {
  key: string;
  label: string;
  value: string;
  tone?: UsageTone;
  priority: number;
  compact?: boolean;
  detailOnly?: boolean;
};

export type ProviderUsageView = {
  id: string;
  title: string;
  status: "ready" | "partial" | "missing-auth" | "forbidden" | "unsupported" | "error" | "stale";
  headline?: string;
  summary?: string;
  metrics: UsageMetric[];
  details?: UsageMetric[];
  fetchedAt?: number;
  stale?: boolean;
};
