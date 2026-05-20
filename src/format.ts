import type { UsageMonitorConfig, UsageSeverity } from "./providers/types.js";
import { formatAge, formatHeaderLine, formatMetricLine, formatProviderTitleLine, metricLabelWidth, toneToSeverity, truncateTo } from "./layout.js";
import { splitMetricValue } from "./views/common.js";
import type { ProviderUsageView, UsageMetric } from "./views/types.js";

export type FormattedLine = { text: string; severity: UsageSeverity; suffix?: string };

const DEBUG_METRIC_PREFIXES = ["debug-", "raw-"];
const DEBUG_METRIC_KEYS = new Set(["has_credits", "provider-base-url", "debug-provider-base-url", "approx"]);
const COMPACT_SUMMARY_WINDOW_PRIORITY = ["5h", "day", "week", "month"];

/** Format provider title line */
export function formatProviderTitle(view: ProviderUsageView, collapsed: boolean, width: number): FormattedLine {
  return {
    text: formatProviderTitleLine(view.title, collapsed, collapsed ? view.summary : undefined, width),
    severity: providerTitleSeverity(view),
  };
}

/** Format all metric lines for a provider (expanded view) */
export function formatProviderMetrics(view: ProviderUsageView, config: Required<UsageMonitorConfig>, width: number): FormattedLine[] {
  const visibleMetrics = visibleExpandedMetrics(view, config);
  const labelWidth = metricLabelWidth(visibleMetrics);
  const metricLines = visibleMetrics.map((metric) => formatMetric(metric, labelWidth, width));
  const lastOk = formatLastOk(view, width);
  return [...metricLines, ...(lastOk ? [lastOk] : [])];
}

/** Format provider metric lines for expanded base/details states */
export function formatProviderMetricsForState(
  view: ProviderUsageView,
  config: Required<UsageMonitorConfig>,
  width: number,
  showDetails: boolean,
): FormattedLine[] {
  if (!showDetails) {
    const windowMetrics = view.metrics.filter((metric) => metric.key.startsWith("window-"));
    const labelWidth = metricLabelWidth(windowMetrics);
    return windowMetrics.map((metric) => formatMetric(metric, labelWidth, width));
  }

  const windowMetrics = view.metrics.filter((metric) => metric.key.startsWith("window-"));
  const detailMetrics = [...view.metrics, ...(view.details ?? [])].filter((metric) => {
    if (metric.key.startsWith("window-")) return false;
    if (metric.detailOnly === true && !showDetails) return false;
    if (isDebugMetric(metric) && !config.debug) return false;
    return true;
  });

  const allVisible = [...windowMetrics, ...detailMetrics];
  const labelWidth = metricLabelWidth(allVisible);
  return allVisible.map((metric) => {
    const isDetail = !metric.key.startsWith("window-");
    const line = formatMetric(metric, labelWidth, width);
    return isDetail ? { ...line, severity: "muted" as const } : line;
  });
}

/** Format collapsed provider summary (single line) */
export function formatCollapsedSummary(view: ProviderUsageView, width: number): FormattedLine {
  const summary = compactSummary(view.metrics) ?? view.summary ?? view.status;
  return { text: formatProviderTitleLine(view.title, true, summary, width), severity: providerTitleSeverity(view) };
}

/** Format header line */
export function formatHeader(providerCount: number, right: string, collapsed: boolean, width: number, symbols: "unicode" | "ascii"): FormattedLine {
  const indicator = collapsed ? (symbols === "ascii" ? ">" : "▶") : (symbols === "ascii" ? "v" : "▼");
  const headerRight = collapsed ? `${providerCount}p ${right}`.trim() : right;
  return { text: formatHeaderLine(`${indicator} Usage`, headerRight, width), severity: "normal" };
}

/** Format last ok line (only when stale/error) */
export function formatLastOk(view: ProviderUsageView, width: number): FormattedLine | undefined {
  if (view.stale !== true && view.status !== "stale" && view.status !== "error") return undefined;
  if (view.fetchedAt === undefined) return undefined;
  const age = formatAge(view.fetchedAt);
  if (age === "now") return undefined;
  return { text: formatMetricLine("last ok", age, metricLabelWidth([{ label: "last ok" }]), width), severity: "muted" };
}

function visibleExpandedMetrics(view: ProviderUsageView, config: Required<UsageMonitorConfig>): UsageMetric[] {
  const allMetrics = [...view.metrics, ...(config.show_details ? view.details ?? [] : [])];
  return allMetrics.filter((metric) => shouldShowMetric(metric, config));
}

function shouldShowMetric(metric: UsageMetric, config: Required<UsageMonitorConfig>): boolean {
  if (metric.detailOnly === true && !config.show_details) return false;
  if (isDebugMetric(metric) && !config.debug) return false;
  return true;
}

function isDebugMetric(metric: UsageMetric): boolean {
  return DEBUG_METRIC_KEYS.has(metric.key) || DEBUG_METRIC_KEYS.has(metric.label) || DEBUG_METRIC_PREFIXES.some((prefix) => metric.key.startsWith(prefix));
}

export function compactSummary(metrics: UsageMetric[]): string | undefined {
  const windowMetrics = [...metrics]
    .filter((candidate) => candidate.key.startsWith("window-") && candidate.compact === true && candidate.detailOnly !== true)
    .sort((left, right) => right.priority - left.priority);
  const priorityMetric = COMPACT_SUMMARY_WINDOW_PRIORITY
    .map((label) => windowMetrics.find((candidate) => candidate.label === label))
    .find((candidate): candidate is UsageMetric => candidate !== undefined);
  const metric = priorityMetric ?? windowMetrics[0];
  if (metric === undefined) return undefined;
  const { main } = splitMetricValue(metric.value);
  return `${metric.label} ${main.split(" · ")[0] ?? main}`;
}

function formatMetric(metric: UsageMetric, labelWidth: number, width: number): FormattedLine {
  const { main, suffix } = splitMetricValue(metric.value);
  const text = formatMetricLine(metric.label, main, labelWidth, width);
  const suffixBudget = suffix === undefined ? 0 : Math.max(0, width - text.length - 3);
  const visibleSuffix = suffixBudget > 0 && suffix !== undefined ? truncateTo(suffix, suffixBudget) : undefined;
  return {
    text,
    severity: toneToSeverity(metric.tone),
    ...(visibleSuffix === undefined ? {} : { suffix: visibleSuffix }),
  };
}

function providerTitleSeverity(view: ProviderUsageView): UsageSeverity {
  if (view.status === "error") return "muted";
  if (view.status === "missing-auth") return "muted";
  if (view.status === "stale" || view.stale === true) return "muted";
  return "warning";
}

export function formatProviderLine1(view: ProviderUsageView, width: number): FormattedLine {
  return formatCollapsedSummary(view, width);
}

export function formatProviderDetails(view: ProviderUsageView, width: number, config: Required<UsageMonitorConfig>): FormattedLine[] {
  return formatProviderMetrics(view, config, width);
}

export function formatProviderExpanded(view: ProviderUsageView, width: number): FormattedLine[] {
  return formatLastOk(view, width) ? [formatLastOk(view, width)].filter((line): line is FormattedLine => line !== undefined) : [];
}

export function formatCollapsedHeader(providerCount: number, right: string, width: number): string {
  return formatHeader(providerCount, right, true, width, "unicode").text;
}

export function ensureSingleLine(value: string, width: number): string {
  return truncateTo(value, width);
}
