import type { StandardUsageProvider } from "../providers/types.js";
import {
	metricSummary,
	providerDetailsToMetrics,
	statusView,
	toViewStatus,
	windowMetric,
} from "./common.js";
import type { ProviderUsageView, UsageMetric } from "./types.js";

export function opencodeGoProviderToView(
	provider: StandardUsageProvider,
): ProviderUsageView {
	const status = statusView(provider);
	if (status) return status;

	const metrics = [
		...provider.windows.map((window, index) =>
			windowMetric(window, 80 - index),
		),
		...providerDetailsToMetrics(provider.details),
	].filter(
		(metric): metric is UsageMetric => metric !== undefined,
	);

	return {
		id: provider.id,
		title: provider.displayName,
		status:
			provider.staleAt !== undefined
				? "stale"
				: toViewStatus(provider.status),
		summary: metricSummary(metrics),
		metrics,
		fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
		...(provider.staleAt !== undefined ? { stale: true } : {}),
	};
}
