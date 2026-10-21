# opencode-usage-monitor

[Русская версия](./README.ru.md)

> OpenCode TUI sidebar plugin that shows OpenAI, Z.AI / GLM, DeepSeek, and OpenCode Go quota/balance usage without exposing provider credentials in the UI.

[![Package](https://img.shields.io/badge/npm-opencode--usage--monitor-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)](https://www.npmjs.com/package/opencode-usage-monitor)
![Runtime](https://img.shields.io/badge/runtime-Bun-111827?style=for-the-badge&logo=bun&logoColor=5b5ef4)
![Host](https://img.shields.io/badge/host-OpenCode-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![License](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)

| Field | Value |
|---|---|
| Status | Actively maintained personal OpenCode tool/plugin |
| Type | OpenCode TUI plugin / host extension |
| Host app | OpenCode `>=2.0.32`; release smoke also covers current `2.1.2` |
| Package | `opencode-usage-monitor` `3.1.0` |
| Runtime | Bun `>= 1.3.0` for local development |
| Maintainer checks | `bun install --frozen-lockfile && bun run typecheck && bun run typecheck:host && bun test && bun run build:all && bun run verify:package` |

## Screenshots

The plugin renders inside the OpenCode terminal UI sidebar.

![Collapsed sidebar view](assets/sidebar-collapsed.png)

![Provider expanded view](assets/provider-expanded.png)

![Fully expanded view](assets/fully-expanded.png)

## Summary

- Displays OpenAI ChatGPT usage windows, available Codex reset credits, and optional nearest reset-credit expiry.
- Displays Z.AI and GLM 5h/week/month quota windows with reset timing and optional plan details. Supports enterprise/org coding plans via organization and project scoping.
- Displays DeepSeek account balance (CNY) with an optional granted/topped-up breakdown.
- Displays OpenCode Go 5h/week/month usage windows with reset timing.
- Standardizes provider output as explicit usage windows plus typed provider-owned details; DeepSeek balance is displayed as a balance detail rather than a reset window.
- Discovers credentials from OpenCode auth storage and supported environment variables.
- Redacts secrets from error messages before rendering them in the TUI.
- Rejects raw provider attribute dumps in runtime snapshots; providers must map safe attributes into ordered details.
- Uses stale-data indicators and guarded refreshes to avoid overlapping API calls.
- Supports two-level collapse/expand behavior: the full panel and per-provider detail views.

## Quick start

```sh
# OpenCode v2: register the TUI plugin in ~/.config/opencode/cli.json
# (see "Installation" below)

# optional: build from a local checkout for development
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install
bun run build:all
```

## Installation

### OpenCode v2

Install the release with the v2 plugin manager:

```sh
opencode plugin add opencode-usage-monitor@3.1.0
```

The equivalent explicit configuration is:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-usage-monitor@3.1.0"]
}
```

Add the package once, either to `~/.config/opencode/cli.json` or to the v2
`plugins` field in `opencode.json(c)`. The package exports separate v2 server
and TUI definitions.

This major does not support OpenCode v1. V1 users must pin
`opencode-usage-monitor@2.0.1`; there is no dual-runtime compatibility shim.

### Package install for local development

```sh
bun add opencode-usage-monitor@3.1.0
```

### Local checkout

```sh
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install --frozen-lockfile
bun run build:all
bun run verify:package
```

The build emits the server definition and TUI bundle into `dist/`; the package
verifier writes the release candidate to `.artifacts/package.tgz`. Repository
root shims are intentionally absent.

## Compatibility

| Component | Supported version | Source |
|---|---|---|
| Host app | OpenCode `>=2.0.32` (smoked on `2.0.32` and `2.1.2`) | Release smoke contract |
| Plugin API | `@opencode/plugin 2.0.32` | `package.json` dependency |
| Theme API | `@opencode/theme 2.0.32` | `package.json` peer dependency |
| TUI runtime | `@opentui/core >=0.5.17`, `@opentui/solid >=0.5.17`, `solid-js 1.9.12` | `package.json` peer dependencies |
| Local runtime | Bun `>=1.3.0` | `package.json` engine |
| TypeScript | `^5.5.0` | `package.json` dev dependency |


## Configuration

Version 2.0 uses the versioned configuration contract only. Legacy flat fields such as `show_openai`, `show_zai`, `show_deepseek`, and `refresh_ms` are rejected with an actionable configuration error in the TUI instead of being interpreted as fallback settings.

The plugin first reads a dedicated config file:

```text
~/.config/opencode/usage-monitor.json
```

Smallest useful configuration:

```json
{
  "version": 2,
  "providers": {
    "openai": {},
    "zai": {},
    "deepseek": {},
    "opencode-go": {}
  }
}
```

Full documented shape:

```json
{
  "version": 2,
  "enabled": true,
  "keybindings": {
    "refresh_all": "<leader>q",
    "refresh_provider": null
  },
  "ui": {
    "width": 34,
    "symbols": "unicode",
    "panel_initial_state": "expanded",
    "provider_initial_state": "collapsed"
  },
  "refresh": {
    "mode": "automatic",
    "interval_ms": 300000,
    "timeout_ms": 15000,
    "stale_after_ms": 600000
  },
  "diagnostics": {
    "debug": false
  },
  "providers": {
    "openai": {
      "credential": { "source": "opencode", "entry": "openai" },
      "options": {
        "show_resets": true,
        "show_reset_expiry": false
      }
    },
    "zai": {
      "credential": { "source": "opencode", "entry": "zai-coding-plan" },
      "options": { "plan": "personal" }
    },
    "deepseek": {
      "credential": { "source": "opencode", "entry": "deepseek" }
    },
    "opencode-go": {
      "credential": { "source": "opencode", "entry": "opencode-go" }
    }
  }
}
```

The `providers` object controls provider activation. Presence enables a provider; omission disables it and prevents credential, cache, and network work for that provider. Provider-specific refresh policies are intentionally unsupported.

Alternatively, add a `usage_monitor` section to `oh-my-openagent.json`. Dedicated `usage-monitor.json` values take precedence.

## Credentials

### OpenAI

OpenAI displays ChatGPT/Codex subscription quota windows from the active
OpenCode OAuth credential, not from OpenAI Platform API keys. The plugin calls
the v2 credential client and retains only the normalized access token, expiry,
and `metadata.accountID`/`metadata.accountId` projection needed by the provider.

The plugin never reads `auth.json`, never falls back to inactive credentials,
and never retains refresh tokens, labels, arbitrary metadata, or raw host
credential records. `OPENAI_API_KEY` and `OPENAI_ADMIN_KEY` are not used for
subscription quota.

Available Codex reset credits are shown by default from the primary usage
response. Set `providers.openai.options.show_resets` to `false` to hide them.
Set `show_reset_expiry` to `true` to make a conditional supplemental request
and show the nearest available credit expiry. The supplemental request runs
only when resets are visible and at least one credit is available; a failure
omits the expiry without hiding the usage windows or reset count.

### Z.AI and GLM

The plugin supports Z.AI and Zhipu / GLM credentials from OpenCode auth storage or environment variables:

```sh
export ZAI_API_KEY="your-zai-key"
export ZAI_CODING_PLAN_API_KEY="your-coding-plan-key"
export ZHIPU_API_KEY="your-zhipu-key"
export ZHIPUAI_API_KEY="your-zhipuai-key"
```

#### Enterprise / organization coding plan

Enterprise (organization-scoped) GLM coding plans require both an organization id and a project id. When both are provided the plugin queries `{baseUrl}/api/monitor/usage/quota/limit?type=2` with `Bigmodel-Organization` and `Bigmodel-Project` headers; otherwise it uses the personal plan endpoint.

Configure them in `usage-monitor.json`:

```json
{
  "version": 2,
  "providers": {
    "zai": {
      "options": {
        "plan": "enterprise",
        "organization_id": "your-org-id",
        "project_id": "your-project-id"
      }
    }
  }
}
```

Or via environment variables when provider options are not set:

```sh
export ZHIPU_ORGANIZATION_ID="your-org-id"
export ZHIPU_PROJECT_ID="your-project-id"
```

### DeepSeek

The plugin displays the DeepSeek account balance (CNY) from the balance endpoint. Configure an API key via OpenCode auth storage or:

```sh
export DEEPSEEK_API_KEY="your-deepseek-key"
```

The balance row shows the total CNY amount; expanding the provider reveals the granted (promotional) and topped-up (paid) breakdown.

### OpenCode Go

OpenCode Go displays rolling 5h, weekly, and monthly usage from `GET https://opencode.ai/zen/go/v1/usage`. The stored OpenCode credential named `opencode-go` is preferred. For an explicit environment fallback, set:

```sh
export OPENCODE_GO_API_KEY="your-opencode-go-key"
```

The endpoint is read-only and currently used by OpenCode Go clients, but it is not documented as a stable public API. Future response changes may require a plugin update.


## Usage

- Click the main usage header to collapse or expand the full panel.
- Click provider rows to toggle provider details independently.
- Use `/usage-refresh` or the configured refresh keybind, default `<leader>q`, to refresh manually.
- Runtime refreshes use the account-safe provider cache under `/tmp/opencode-usage-monitor-v2/`.
- Render errors are caught and displayed inside an error boundary.

## Project structure

```text
.
├── assets/                    # Local screenshots used by this README
├── dist/                      # Built package output
├── src/
│   ├── auth.ts                # OpenCode auth and environment credential discovery
│   ├── provider-cache.ts      # Account-safe provider cache
│   ├── runtime-config.ts      # Versioned runtime config parsing and validation
│   ├── credentials.ts         # Credential resolver for provider registrations
│   ├── index.ts               # OpenCode plugin entry
│   ├── refresh*.ts            # Runtime refresh coordinator modules
│   ├── sanitize.ts            # Secret redaction helpers
│   ├── snapshot-validation.ts # Snapshot validation before publication/cache
│   ├── tui.ts                 # TUI plugin module
│   ├── providers/             # OpenAI, Z.AI / GLM, DeepSeek, and OpenCode Go clients
│   └── views/                 # TUI view rendering helpers
├── package.json               # Package metadata, scripts, peer dependencies
├── tsconfig.json              # Strict TypeScript config
└── LICENSE
```

## Troubleshooting

- If OpenAI shows `auth missing`, `oauth missing`, `oauth expired`, or `account id missing`, run `opencode providers login` for OpenAI and verify the OpenCode auth entry contains non-expired OAuth `openai.access`, `openai.accountId`, `openai.expires`, and `openai.type: "oauth"`.
- If Z.AI shows `auth missing`, configure a supported Z.AI or Zhipu environment variable or OpenCode auth entry.
- If Z.AI shows `partial` on an enterprise/org account, set `providers.zai.options.organization_id` and `providers.zai.options.project_id` (or `ZHIPU_ORGANIZATION_ID` / `ZHIPU_PROJECT_ID`) so the `?type=2` endpoint is used.
- If DeepSeek shows `auth missing`, set `DEEPSEEK_API_KEY` or activate a DeepSeek credential in OpenCode.
- If OpenCode Go shows `auth missing`, run `/connect`, select OpenCode Go, and enter its API key, or set `OPENCODE_GO_API_KEY`.
- If the panel shows a `config` error, migrate `usage-monitor.json` to the `version: 2` shape and define at least one provider under `providers`.
- If the panel is too wide or narrow, adjust `ui.width` in `usage-monitor.json`.
- If refreshes appear stale, lower `refresh.interval_ms` or check provider API connectivity.
- If build output is missing, run `bun run build:all` and verify `dist/index.js` and `dist/tui.js` exist.
- If cached data appears stale, check `/tmp/opencode-usage-monitor-v2/`.

## Limitations / Security

- The plugin reads local OpenCode auth metadata and supported environment variables, but examples in this README use placeholders only.
- Secrets are redacted from rendered error messages before they reach the TUI.
- Provider data depends on external OpenAI, Z.AI, Zhipu, DeepSeek, and OpenCode Go API availability and credential permissions.
- The package is a host extension; runtime behavior depends on compatible OpenCode and OpenTUI APIs.

## Status

Actively maintained personal OpenCode tool/plugin. Public issues and improvements are welcome, but the project is primarily maintained around the author's own workflow.

## Links / License

- Package: <https://www.npmjs.com/package/opencode-usage-monitor>
- Repository: <https://github.com/Mark1708/opencode-usage-monitor>
- Host app: <https://opencode.ai/>
- Listed under Plugins in the curated [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) directory.
- License: MIT, see [`LICENSE`](LICENSE)
