import type { StandardUsageWindow, UsageSeverity } from "./providers/types.js";

export function isLimitReached(window: StandardUsageWindow): boolean {
  return window.limitReached === true || (window.percentage ?? 0) >= 100 || window.remaining === 0;
}

export function getWindowSeverity(window: StandardUsageWindow): UsageSeverity {
  if (isLimitReached(window)) return "critical";
  if ((window.percentage ?? 0) >= 75) return "warning";
  return "normal";
}

export function sortWindowsForDisplay(windows: StandardUsageWindow[]): StandardUsageWindow[] {
  return [...windows].sort((a, b) => {
    const aLimit = isLimitReached(a) ? 1 : 0;
    const bLimit = isLimitReached(b) ? 1 : 0;
    if (aLimit !== bLimit) return bLimit - aLimit;

    const aPct = a.percentage ?? -1;
    const bPct = b.percentage ?? -1;
    if (aPct !== bPct) return bPct - aPct;

    const aReset = a.resetAt ?? Number.POSITIVE_INFINITY;
    const bReset = b.resetAt ?? Number.POSITIVE_INFINITY;
    return aReset - bReset;
  });
}
