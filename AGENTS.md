# USAGE MONITOR PLUGIN

**Version:** 2.0.0 | **npm:** `opencode-usage-monitor` | **Plugin ID:** `usage-monitor:tui`

## OVERVIEW

Read-only OpenCode TUI sidebar plugin for provider quota and balance visibility. It displays OpenAI ChatGPT subscription usage, Z.AI / GLM quota windows, and DeepSeek account balance without rendering raw credentials or provider API dumps.

## CURRENT ARCHITECTURE

```text
usage-monitor/
├── src/
│   ├── index.ts               # Plugin API stub (definePlugin)
│   ├── tui.ts                 # TUI entry, config watching, render state, keybindings
│   ├── runtime-config.ts      # Version 2 config parser and fail-closed source loading
│   ├── credentials.ts         # Credential resolver with provider allowlists and epochs
│   ├── provider-cache.ts      # Account-safe provider cache under /tmp/opencode-usage-monitor-v2/
│   ├── refresh*.ts            # Refresh coordinator, scheduling, snapshot commits
│   ├── snapshot-validation.ts # Canonical provider snapshot validation
│   ├── auth.ts                # OpenCode auth.json discovery and metadata sanitization
│   ├── format.ts              # Compact line formatting and provider state text
│   ├── layout.ts              # Width, truncation, age, and compact layout helpers
│   ├── severity.ts            # Severity color mapping
│   ├── providers/             # Provider definitions and legacy facade bridge
│   └── views/                 # Provider-specific view models for TUI rendering
├── assets/                    # README screenshots
├── .gitlab-ci.yml             # CI validate/build/publish pipeline
└── package.json               # Package metadata, scripts, and peer dependencies
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Add a provider | `src/providers/` plus registration in `src/providers/builtins.ts` |
| Change provider API mapping | `src/providers/openai.ts`, `src/providers/zai.ts`, or `src/providers/deepseek.ts` |
| Change displayed rows | `src/views/` first, then `src/format.ts` only for shared formatting |
| Change config shape | `src/runtime-config.ts` and `src/__tests__/runtime-config.test.ts` |
| Change credential behavior | `src/credentials.ts`, `src/auth.ts`, and credential tests |
| Change refresh behavior | `src/refresh*.ts` and `src/__tests__/refresh*.test.ts` |
| Change cache behavior | `src/provider-cache.ts` and `src/__tests__/provider-cache.test.ts` |
| Change TUI wiring | `src/tui.ts` and `src/__tests__/tui-lifecycle.test.ts` |
| Update release docs | `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `MAP.md` |

## CONTRACTS

- **Config**: only `version: 2` config is accepted. Missing config, legacy flat keys, unknown provider ids, and malformed provider options render a TUI-visible `config` error and do not start provider work.
- **Provider activation**: provider presence under `providers` enables that provider. Omitted providers do not resolve credentials, read or write cache entries, or make network requests.
- **Credentials**: providers may use only allowlisted credential references. OpenAI requires non-expired OpenCode OAuth metadata (`access`, `accountId`, `expires`, `type: "oauth"`). Refresh tokens are never usable provider secrets.
- **Snapshots**: providers publish canonical `windows`, `alerts`, `modelBreakdown`, and typed ordered `details`. Raw provider objects, `Map`, `additionalProperties`, secret-like keys, and active credential values are rejected before render/cache publication.
- **Cache**: persistent cache identity is account-safe and provider-scoped. Null-scope entries stay in memory only.
- **Rendering**: balance-only providers must use summary/detail currency metrics, not fake reset windows.

## ANTI-PATTERNS

- NEVER add runtime dependencies beyond peer deps (`@opencode-ai/plugin`, `@opentui/keymap`, `@opentui/solid`, `solid-js`).
- NEVER scrape provider dashboards. Use official API endpoints only; OpenAI ChatGPT subscription quota uses the WHAM endpoint because OpenCode OAuth credentials expose subscription quota, not organization usage.
- NEVER support legacy flat config as fallback in the runtime path.
- NEVER set `refresh.interval_ms` below 60000.
- NEVER display raw API keys, tokens, auth payloads, or provider response dumps.
- NEVER mutate provider registries or runtime snapshots; return new arrays/objects.
- NEVER publish provider snapshots before validation and active credential redaction checks.
