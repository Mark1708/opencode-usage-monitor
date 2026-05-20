import type { UsageMonitorConfig } from "./providers/types.js";

const HOME = process.env.HOME ?? "";
export const CONFIG_PATH = `${HOME}/.config/opencode/usage-monitor.json`;
export const OMO_CONFIG_PATH = `${HOME}/.config/opencode/oh-my-openagent.json`;

export const CONFIG_DEFAULTS: Required<UsageMonitorConfig> = {
  enabled: true,
  default_collapsed: false,
  refresh_ms: 60_000,
  request_timeout_ms: 15_000,
  show_openai: true,
  show_zai: true,
  show_details: false,
  default_provider_collapsed: true,
  debug: false,
  width: 34,
  symbols: "unicode",
  max_detail_lines: 4,
  max_windows: 3,
  max_model_lines: 1,
};

export function mergeUsageConfig(partial: UsageMonitorConfig): Required<UsageMonitorConfig> {
  return { ...CONFIG_DEFAULTS, ...partial };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return JSON.parse(await file.text()) as Record<string, unknown>;
  } catch (_error: unknown) {
    return null;
  }
}

export async function readUsageConfig(): Promise<UsageMonitorConfig> {
  const dedicated = await readJsonFile(CONFIG_PATH);
  if (dedicated) return mergeUsageConfig(parseUsageConfig(dedicated));

  const omo = await readJsonFile(OMO_CONFIG_PATH);
  if (omo && typeof omo.usage_monitor === "object" && omo.usage_monitor !== null) {
    return mergeUsageConfig(parseUsageConfig(omo.usage_monitor as Record<string, unknown>));
  }

  return { ...CONFIG_DEFAULTS };
}

export function parseUsageConfig(raw: Record<string, unknown>): UsageMonitorConfig {
  const { enabled, default_collapsed, refresh_ms, request_timeout_ms, show_openai, show_zai } = raw;
  const { show_details, default_provider_collapsed, debug, width, symbols, max_detail_lines, max_windows, max_model_lines } = raw;
  return {
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof default_collapsed === "boolean" ? { default_collapsed } : {}),
    ...(typeof refresh_ms === "number" ? { refresh_ms } : {}),
    ...(typeof request_timeout_ms === "number" ? { request_timeout_ms } : {}),
    ...(typeof show_openai === "boolean" ? { show_openai } : {}),
    ...(typeof show_zai === "boolean" ? { show_zai } : {}),
    ...(typeof show_details === "boolean" ? { show_details } : {}),
    ...(typeof default_provider_collapsed === "boolean" ? { default_provider_collapsed } : {}),
    ...(typeof debug === "boolean" ? { debug } : {}),
    ...(typeof width === "number" ? { width } : {}),
    ...(symbols === "unicode" || symbols === "ascii" ? { symbols } : {}),
    ...(typeof max_detail_lines === "number" ? { max_detail_lines } : {}),
    ...(typeof max_windows === "number" ? { max_windows } : {}),
    ...(typeof max_model_lines === "number" ? { max_model_lines } : {}),
  };
}

export function configFingerprint(config: Required<UsageMonitorConfig>): string {
  return JSON.stringify(Object.entries(config).sort(([left], [right]) => left.localeCompare(right)));
}
