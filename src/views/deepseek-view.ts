import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView, UsageMetric } from "./types.js";
import { metricSummary, statusView, stringMetric, toViewStatus, windowMetric, numberMetric } from "./common.js";

export function deepseekProviderToView(provider: StandardUsageProvider): ProviderUsageView {
  const status = statusView(provider);
  if (status) return status;

  const currency = readString(provider.additionalProperties?.deepseekCurrency);
  const metrics = [
    stringMetric("status", "status", provider.status === "partial" ? provider.statusText : undefined, 100, { compact: true, tone: "warn" }),
    ...provider.windows.map((window, index) => windowMetric(window, 90 - index)),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  const detailMetrics = [
    numberMetric("granted", "granted", provider.additionalProperties?.deepseekGrantedAmount, currency, 80, { detailOnly: true }),
    numberMetric("topped", "topped-up", provider.additionalProperties?.deepseekToppedAmount, currency, 70, { detailOnly: true }),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    ...(detailMetrics.length > 0 ? { details: detailMetrics } : {}),
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...(provider.staleAt !== undefined ? { stale: true } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
