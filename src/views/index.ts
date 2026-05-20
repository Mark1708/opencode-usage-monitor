import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView } from "./types.js";
import { openAIProviderToView } from "./openai-view.js";
import { zaiProviderToView } from "./zai-view.js";
import { metricSummary, statusView, stringMetric, toViewStatus, windowMetric } from "./common.js";

export function providerToView(provider: StandardUsageProvider): ProviderUsageView {
  if (provider.id === "openai") return openAIProviderToView(provider);
  if (provider.id === "zai") return zaiProviderToView(provider);

  const status = statusView(provider);
  if (status) return status;

  const metrics = [
    stringMetric("plan", "plan", provider.plan, 100, { compact: true }),
    ...provider.windows.map((window, index) => windowMetric(window, 80 - index)),
  ].filter((metric): metric is NonNullable<typeof metric> => metric !== undefined);

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
