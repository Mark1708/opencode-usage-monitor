# USAGE MONITOR PLUGIN

**Version:** 1.0.7 | **npm:** `opencode-usage-monitor` | **Plugin ID:** `usage-monitor:tui`

## OVERVIEW

Read-only API usage quota display for OpenAI and Z.AI (GLM) providers. Fetches usage data, caches with TTL, renders in sidebar.

## STRUCTURE

```
usage-monitor/
├── src/
│   ├── index.ts          # Plugin API stub (definePlugin)
│   ├── tui.ts            # TUI entry -- element/render/refresh loop (383 lines)
│   ├── auth.ts           # Reads ~/.config/opencode/auth.json for credentials
│   ├── cache.ts          # File-based TTL cache in /tmp/
│   ├── config.ts         # Reads ~/.config/opencode/usage-monitor.json
│   ├── format.ts         # Usage data formatting (severity, percentages, bars)
│   ├── layout.ts         # Layout constants, truncation, age formatting
│   ├── sanitize.ts       # Error message sanitization (strips secrets)
│   ├── severity.ts       # Severity color mapping
│   ├── providers/
│   │   ├── types.ts      # Core types: StandardUsageProvider, ProviderContext, UsageMonitorConfig
│   │   ├── registry.ts   # Adapter discovery + refresh orchestration
│   │   ├── shared.ts     # AbortController timeout helpers
│   │   ├── openai.ts     # OpenAI /dashboard/billing/usage adapter
│   │   └── zai.ts        # Z.AI (GLM) /api context adapter
│   └── views/
│       ├── types.ts      # View types: ProviderUsageView, UsageMetric
│       ├── index.ts      # providerToView() -- adapter output to view model
│       ├── common.ts     # Shared view formatting helpers
│       ├── openai-view.ts # OpenAI-specific view formatting
│       └── zai-view.ts   # Z.AI-specific view formatting
├── assets/               # Screenshots for README
├── .gitlab-ci.yml        # CI: validate -> build -> publish
└── package.json
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Add new provider | `src/providers/` -- implement `UsageProviderAdapter`, register in `registry.ts` |
| Change display format | `src/views/` -- modify `providerToView()` or add view file |
| Config options | `src/providers/types.ts` (`UsageMonitorConfig`) + `src/config.ts` (`CONFIG_DEFAULTS`) |
| Refresh logic | `src/tui.ts` -- `startRefreshCycle()`, `RefreshGuard` |
| Cache behavior | `src/cache.ts` -- `readCache()`, `writeCache()`, TTL logic |
| Keybind config | `src/config.ts` -- `refresh_keybind` field (default `<leader>q`) |

## CONVENTIONS (THIS REPO)

- **Provider adapter pattern**: Each provider implements `UsageProviderAdapter` interface with `id`, `displayName`, `isAvailable()`, `fetchUsage()`
- **View separation**: Providers output `StandardUsageProvider`; views transform to `ProviderUsageView` for display
- **Config fallback chain**: `usage-monitor.json` -> `oh-my-openagent.json` (usage_monitor key) -> defaults
- **Auth discovery**: Scans `~/.config/opencode/auth.json` entries, matches by field names (apiKey, token, etc.)
- **Secret regex**: `/sk-[a-zA-Z0-9_-]{20,}/g` used for sanitization -- never logged, stored, or displayed
- **Cache path**: `/tmp/opencode-usage-monitor-*.json` -- per-provider, TTL-based

## ANTI-PATTERNS

- NEVER add runtime dependencies beyond peer deps (`@opencode-ai/plugin`, `@opentui/solid`, `solid-js`)
- NEVER scrape provider dashboards -- use official API endpoints only
- NEVER set `refresh_ms` below 60000
- NEVER display raw API keys or tokens in error messages
- NEVER mutate the providers array -- registry returns new arrays
