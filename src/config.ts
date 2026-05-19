import type { UsageMonitorConfig } from "./types.js";

const HOME = process.env.HOME ?? "";
const CONFIG_PATH = `${HOME}/.config/opencode/usage-monitor.json`;
const OMO_CONFIG_PATH = `${HOME}/.config/opencode/oh-my-openagent.json`;

export const CONFIG_DEFAULTS: Required<UsageMonitorConfig> = {
  enabled: true,
  default_collapsed: false,
  refresh_ms: 60_000,
  request_timeout_ms: 15_000,
  show_openai: true,
  show_zai: true,
  show_details: true,
  width: 34,
  symbols: "unicode",
};

function mergeDefaults(partial: UsageMonitorConfig): Required<UsageMonitorConfig> {
  return { ...CONFIG_DEFAULTS, ...partial };
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "Invalid JSON";
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
  // Try dedicated config file first
  const dedicated = await readJsonFile(CONFIG_PATH);
  if (dedicated) {
    const { enabled, default_collapsed, refresh_ms, request_timeout_ms, show_openai, show_zai, show_details, width, symbols } = dedicated;
    return mergeDefaults({
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof default_collapsed === "boolean" ? { default_collapsed } : {}),
      ...(typeof refresh_ms === "number" ? { refresh_ms } : {}),
      ...(typeof request_timeout_ms === "number" ? { request_timeout_ms } : {}),
      ...(typeof show_openai === "boolean" ? { show_openai } : {}),
      ...(typeof show_zai === "boolean" ? { show_zai } : {}),
      ...(typeof show_details === "boolean" ? { show_details } : {}),
      ...(typeof width === "number" ? { width } : {}),
      ...(symbols === "unicode" || symbols === "ascii" ? { symbols } : {}),
    });
  }

  // Fallback to oh-my-openagent.json usage_monitor section
  const omo = await readJsonFile(OMO_CONFIG_PATH);
  if (omo && typeof omo.usage_monitor === "object" && omo.usage_monitor !== null) {
    const section = omo.usage_monitor as Record<string, unknown>;
    const { enabled, default_collapsed, refresh_ms, request_timeout_ms, show_openai, show_zai, show_details, width, symbols } = section;
    return mergeDefaults({
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof default_collapsed === "boolean" ? { default_collapsed } : {}),
      ...(typeof refresh_ms === "number" ? { refresh_ms } : {}),
      ...(typeof request_timeout_ms === "number" ? { request_timeout_ms } : {}),
      ...(typeof show_openai === "boolean" ? { show_openai } : {}),
      ...(typeof show_zai === "boolean" ? { show_zai } : {}),
      ...(typeof show_details === "boolean" ? { show_details } : {}),
      ...(typeof width === "number" ? { width } : {}),
      ...(symbols === "unicode" || symbols === "ascii" ? { symbols } : {}),
    });
  }

  return { ...CONFIG_DEFAULTS };
}
