import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView, UsageMetric } from "./types.js";
import { metricSummary, providerDetailsToMetrics, statusView, stringMetric, toViewStatus, windowMetric } from "./common.js";

export function deepseekProviderToView(provider: StandardUsageProvider): ProviderUsageView {
  const status = statusView(provider);
  if (status) return status;

  const metrics = [
    stringMetric("status", "status", provider.status === "partial" ? provider.statusText : undefined, 100, { compact: true, tone: "warn" }),
    ...provider.windows.map((window, index) => windowMetric(window, 90 - index)),
    ...providerDetailsToMetrics(provider.details),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...(provider.staleAt !== undefined ? { stale: true } : {}),
  };
}
