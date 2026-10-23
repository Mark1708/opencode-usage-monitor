# usage-monitor architecture map

## 1. Runtime data flow

The plugin runtime is centered on `src/tui.ts` and `src/refresh*.ts`:

1. `src/tui.ts` loads `version: 2` config through `readUsageConfigV2()` from `src/runtime-config.ts`.
2. A `createCredentialResolver()` instance resolves only provider-allowlisted credential references.
3. `createProviderCacheV2()` creates an account-safe cache under `/tmp/opencode-usage-monitor-v2/`.
4. `createRefreshCoordinator()` owns bootstrap, explicit refreshes, stale timers, cancellation, cache reads/writes, and subscriber snapshots.
5. `runtimeStatesToProviders()` maps `ProviderRuntimeState[]` into `StandardUsageProvider` rows.
6. `providerToView()` converts provider snapshots into display-focused `ProviderUsageView` rows.
7. TUI rendering formats compact rows with `format.ts`, `layout.ts`, and provider-specific view helpers.

Invalid config stops at step 1 and renders a synthetic `config` provider row. No credential, cache, scheduler, or provider network work starts for invalid config.

## 2. Configuration contract

Config is loaded from:

1. `~/.config/opencode/usage-monitor.json`.
2. `usage_monitor` in `~/.config/opencode/oh-my-openagent.json` when the dedicated file is absent.

Only the `version: 2` shape is supported. Legacy flat keys such as `show_openai`, `show_zai`, `show_deepseek`, and `refresh_ms` are rejected with an actionable TUI error.

Provider presence under `providers` is the activation switch. Omitted providers do not resolve credentials, touch cache state, schedule refreshes, or make network requests. Provider-specific refresh policies are intentionally unsupported.

`usage-monitor.json` is watched with debounced reloads. Config fingerprinting skips no-op reloads, and panel/provider collapse state survives config reloads.

## 3. Provider model

Provider-specific code lives under `src/providers/`:

- `builtins.ts`: built-in provider catalog and ordering.
- `contracts.ts`: provider definition contract, option binding, legacy facade bridge.
- `openai.ts`: ChatGPT WHAM subscription quota provider.
- `zai.ts`: Z.AI / Zhipu quota provider.
- `deepseek.ts`: DeepSeek balance provider.
- `opencode-go.ts`: OpenCode Go rolling, weekly, and monthly usage provider.
- `registry.ts`: adapter resolution for legacy consumers.
- `types.ts`: shared normalized provider and runtime-facing types.

Providers own raw API parsing. Raw provider response shapes must not cross into `format.ts`, `views/`, or `tui.ts`.

## 4. Canonical provider snapshot contract

`StandardUsageProvider` is the renderer/cache contract:

- `status`: `loading`, `ready`, `partial`, `missing-auth`, `forbidden`, `unsupported`, or `error`.
- `plan`: optional safe provider plan label.
- `windows`: normalized quota/rate-limit windows with explicit `period` and `usage`.
- `alerts`: critical provider-level notices.
- `modelBreakdown`: optional per-model normalized usage.
- `details`: ordered, typed, provider-owned metadata for summary/detail/debug rows.

Snapshot validation rejects unsafe or non-canonical data before publication or cache writes. Rejected examples include raw `additionalProperties`, `Map`, oversized/deep objects, secret-like keys, values containing the active credential, throwing accessors, and proxy traps.

## 5. Credential and cache safety

`credentials.ts` resolves credentials through provider-specific allowlists. Credential leases carry an epoch and safe account metadata so refresh work can reject stale completions after credential changes.

OpenAI requires top-level OpenCode OAuth metadata: `type: "oauth"`, `access`, `accountId`, and `expires`. Z.AI / Zhipu, DeepSeek, and OpenCode Go can use OpenCode auth entries or supported environment variables. Refresh-only OpenCode entries are treated as missing secrets.

`provider-cache.ts` separates persistent cache identity by provider, account-safe scope, credential variant, and options. Entries without a validated account scope stay memory-only. Cache files are written through private directories, schema validation, digest checks, and atomic temp-file replacement.

## 6. Provider mappings

### OpenAI

OpenAI uses `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>` and `ChatGPT-Account-Id`. When reset expiry is enabled and an available reset credit exists, it also uses `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`.

- `plan_type` maps to `plan`.
- Primary and secondary rate-limit windows map to canonical windows.
- Additional reached limits map to critical `alerts`.
- Credits and spend-control fields map to allowlisted typed `details`.
- `rate_limit_reset_credits.available_count` maps to the summary `resets` detail unless `show_resets` is false.
- `show_reset_expiry` is off by default. When enabled, the nearest available credit expiry maps to the reset suffix with normal (>24h), warning (<=24h), and critical (<=2h) severity.
- Supplemental reset-expiry failures omit only the expiry; cancellation and timeout still terminate the complete provider request.
- HTTP 401/403 maps to `forbidden`.
- Incomplete but parseable payloads map to `partial`.

### Z.AI / GLM

Z.AI uses `GET {baseUrl}/api/monitor/usage/quota/limit` with raw `Authorization: <token>`.

- Z.AI credential variants use `https://api.z.ai`.
- Zhipu credential variants use `https://open.bigmodel.cn`.
- Enterprise coding plans require `providers.zai.options.organization_id` and `providers.zai.options.project_id`, or the corresponding `ZHIPU_ORGANIZATION_ID` and `ZHIPU_PROJECT_ID` environment variables.
- When both enterprise identifiers are present, the provider uses `?type=2` and `Bigmodel-Organization` / `Bigmodel-Project` headers.
- Limits with reliable `used + limit` data map to `usage.kind="quota"`; percent-only limits map to `usage.kind="percent"`.
- Unknown limit units fall back to normalized type/name labels and `period.kind="unknown"`.

### DeepSeek

DeepSeek uses `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <token>`.

- `total_balance` maps to a summary currency detail.
- `granted_balance` and `topped_up_balance` map to expanded detail rows.
- `is_available=false` remains visible without inventing reset semantics.
- DeepSeek does not emit fake windows because the API exposes balance, not quota reset periods.

### OpenCode Go

OpenCode Go uses `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <token>`.

- `usage.rolling`, `usage.weekly`, and `usage.monthly` map to canonical 5h, week, and billing-month windows.
- `percent` maps to percent usage and `resetsAt` maps to the window reset timestamp.
- `status="rate-limited"` or a percentage of at least 100 maps to a reached limit.
- Missing windows map to `partial`.


## 7. Rendering rules

The opt-in `grok` provider uses the active OpenCode `xai` OAuth credential and the official Grok CLI's undocumented billing endpoint. Before projecting that credential, the TUI calls `usage-monitor.grok-auth.prepare`; the server invokes the host's active-connection resolver to renew OAuth if needed. The RPC returns status only, never credentials. After successful preparation, the reader performs a fresh list instead of reusing pre-renewal projections. Credential events and disposal invalidate stale work; concurrent server preparations coalesce. Valid subscription percentages produce windows; an omitted zero is accepted only for an active validated typed unified-billing period, verified against the live usage UI. Other missing usage stays partial with separate reset/prepaid details; on-demand spending never supplies a subscription percentage. There is no persistent account cache scope, browser fallback, plugin-owned OAuth exchange, or model request for renewal.

Window ordering is deterministic:

1. Reached limits first.
2. Higher percentage first.
3. Earlier reset time first.

The provider summary row uses the first sorted window. Window-less balance providers can show summary details in the main row. Expanded provider rows show secondary windows, alerts, details, and limited model breakdown.

Severity is calculated in `severity.ts`:

- `critical`: reached limit, percentage `>= 100`, or remaining quota `0`.
- `warning`: percentage `>= 75`.
- `normal`: ordinary usage pressure.
- `muted`: status and metadata that are not quota pressure.

Rendered values are single-line and width-truncated. Debug details are hidden unless config enables diagnostics debug mode.

## 8. Known limitations

- OpenAI WHAM response fields are private/undocumented and may change.
- Z.AI quota response field names are normalized defensively; unknown future fields may be hidden or rendered only as generic safe metadata.
- The OpenCode Go usage endpoint is read-only but is not documented as a stable public API; response changes may require a provider update.
- Only the dedicated config file is watched directly; restart OpenCode after changing the secondary `oh-my-openagent.json` source.
- Partial provider data can render without all expected quota windows.
