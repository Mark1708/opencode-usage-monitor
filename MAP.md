# usage-monitor architecture map

## 1. Provider adapter architecture

The TUI renders only `StandardUsageProvider` objects. Provider-specific code lives under `src/providers/`:

- `types.ts`: shared standard provider types.
- `openai.ts`: ChatGPT WHAM usage adapter.
- `zai.ts`: Z.AI/Zhipu quota adapter.
- `registry.ts`: active adapter filtering and `Promise.allSettled` refresh orchestration.

`src/tui.ts` builds a `ProviderContext`, calls `refreshAllAdapters`, stores normalized providers in Solid signals, and passes those providers to generic formatters.

## 2. StandardUsageProvider format

`StandardUsageProvider` is the normalized renderer contract:

- `status`: loading, ready, partial, missing-auth, forbidden, unsupported, or error.
- `plan`: provider plan label.
- `windows`: normalized quotas/rate limits.
- `alerts`: critical provider-level notices.
- `modelBreakdown`: optional per-model normalized usage.
- `additionalProperties`: sanitized display-safe metadata.

Raw API response shapes never cross into `format.ts` or `tui.ts`.

## 3. OpenAI mapping

OpenAI uses `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <token>`.

Mapping:

- `plan_type` -> `plan`.
- `rate_limit.primary_window` -> rolling window, label derived from seconds (`18000` -> `5h`).
- `rate_limit.secondary_window` -> weekly window.
- `additional_rate_limits[]` with `limit_reached=true` -> critical `alerts`.
- `credits`, `spend_control`, and `rate_limit_reset_credits` -> sanitized `additionalProperties`.
- HTTP 401/403 -> `forbidden`.
- Incomplete but parseable payload -> `partial`.

## 4. Z.AI mapping

Z.AI uses `GET {baseUrl}/api/monitor/usage/quota/limit` with raw `Authorization: <token>`.

Credential source determines base URL:

- `zai-coding-plan`, `zai`, `ZAI_API_KEY`, `ZAI_CODING_PLAN_API_KEY` -> `https://api.z.ai`.
- `zhipu`, `ZHIPU_API_KEY`, `ZHIPUAI_API_KEY` -> `https://open.bigmodel.cn`.

Mapping:

- `data.level` -> `plan`.
- Every `data.limits[]` entry -> one `StandardUsageWindow`.
- `unit=3, number=5` -> rolling `5h`.
- `unit=6, number=1` -> daily `day`.
- `unit=5, number=1` -> monthly `month`.
- `usageDetails[].modelCode` -> `modelBreakdown[].label`.
- Unknown units fall back to normalized type/name labels and `kind="unknown"`.

## 5. Main window selection algorithm

`sortWindowsForDisplay` is the single source of ordering:

1. Windows with reached limits first.
2. Higher `percentage` first.
3. Earlier `resetAt` first.

`formatProviderLine1` uses the first sorted window as the provider's main row.

## 6. Severity thresholds

Severity is calculated in `severity.ts`:

- `critical`: `limitReached=true`, `percentage >= 100`, or `remaining === 0`.
- `warning`: `percentage >= 75`.
- `normal`: everything else.
- `muted`: UI status/details that are not quota pressure.

## 7. additionalProperties rules

`additionalProperties` are optional compact metadata. Before display:

- Keys matching `key|token|authorization|secret|password|credential` are skipped.
- Values matching secret/token patterns are skipped.
- Arrays and objects are summarized instead of expanded.
- Rendered values are single-line and width-truncated.

## 8. Provider detail view

Default provider block:

- Row 1: provider name, plan/main window label, percentage.
- Detail rows: secondary windows, alerts, limited model breakdown.

Clicking a provider toggles its expanded detail view. Only one provider can be expanded at a time.

## 9. Security and sanitization

Secrets are never logged, stored, or rendered. API keys/tokens are used only in adapter fetch calls. Errors pass through `sanitizeError`; display metadata passes through `sanitizeAdditionalProperties`.

`@opentui/solid` and `solid-js` are imported only in `src/tui.ts`.

## 10. Config options

Config is loaded from:

1. `~/.config/opencode/usage-monitor.json`.
2. `usage_monitor` section in `~/.config/opencode/oh-my-openagent.json`.

Defaults:

- `enabled: true`
- `default_collapsed: false`
- `refresh_ms: 60000`
- `request_timeout_ms: 15000`
- `show_openai: true`
- `show_zai: true`
- `show_details: true`
- `width: 34`
- `symbols: "unicode"`
- `max_detail_lines: 4`
- `max_windows: 3`
- `max_model_lines: 1`

`usage-monitor.json` is watched with a debounced reload. No-op reloads are skipped via config fingerprinting. Collapsed/expanded UI state is not reset on config reload.

## 11. Known limitations

- OpenAI WHAM response fields are private/undocumented and may change.
- Z.AI quota response field names are normalized defensively, but unknown future fields may render only as generic metadata.
- Only the dedicated config file is watched directly; fallback config is read on reload but not watched.
- Partial provider data can render without all quota windows.
