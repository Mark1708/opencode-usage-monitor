# USAGE MONITOR PLUGIN

**Version:** 3.0.0 | **npm:** `opencode-usage-monitor` | **Plugin IDs:** `usage-monitor`, `usage-monitor.tui`

## OVERVIEW

OpenCode V2-only sidebar plugin for OpenAI, Z.AI/GLM, and DeepSeek quota visibility. Runtime credentials come from the active OpenCode credential record; raw credentials and provider payloads never enter render state or persistent cache.

## STRUCTURE

```text
src/
├── index.ts               # V2 server entry (`@opencode/plugin`)
├── tui.ts                 # V2 TUI setup, lifecycle, events, signals
├── auth-v2.ts             # Active credential projection and generation-safe cache
├── runtime-config.ts      # Version 2 config parsing and source loading
├── refresh*.ts            # Refresh orchestration, scheduling, snapshot commits
├── provider-cache.ts      # Account-safe provider cache
├── snapshot-validation.ts # Canonical provider snapshot validation
├── providers/             # Provider adapters
└── views/                 # Provider-specific render models
scripts/verify-package.mjs # Packed-artifact and clean-consumer gate
```

## CONTRACTS

- Server dependency: `@opencode/plugin@2.0.32`.
- Host/TUI peers: `@opencode/theme`, `@opentui/core`, `@opentui/solid`, and `solid-js`.
- Package exports are `.` and `./tui`; local-directory host smoke uses disposable root wrappers, never repository root shims.
- `@opentui/solid` is imported only by the TUI entry/render boundary.
- A slot callback creates one stable container; reactive content is mounted with `insert(container, () => ...)`.
- Config accepts only `version: 2`. Invalid config starts no provider work.
- Provider credentials are active-only, normalized projections. Refresh tokens, arbitrary metadata, labels, and raw host records are forbidden.
- Canonical snapshots are validated before render/cache publication. Cache identity is provider- and account-scoped.
- Setup owns every disposable resource. Cleanup invalidates pending async work before closing resources.

## COMMANDS

```bash
bun run typecheck
bun run typecheck:host
bun test
bun run build:all
bun run verify:package
```

## ANTI-PATTERNS

- NEVER add `@opencode-ai/plugin`, `@opencode-ai/sdk`, V1 `{ id, server }`/`TuiPluginModule`, dual runtime shapes, or root entry shims.
- NEVER import `@opentui/solid` outside the TUI entry/render boundary.
- NEVER read `auth.json` in the V2 credential path.
- NEVER display, log, cache, or persist secrets or raw provider/credential records.
- NEVER call provider work after disposal or allow an older generation to commit state/cache.
- NEVER set refresh intervals below 60000 ms.
- NEVER use provider dashboard scraping; official APIs only.
