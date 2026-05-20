# opencode-usage-monitor

[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1.0-black)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Powered by OpenCode](https://img.shields.io/badge/powered%20by-OpenCode-black)](https://opencode.ai/)

OpenCode TUI sidebar plugin that displays API usage quotas for OpenAI and Z.AI (GLM) providers.

## Features

- Displays OpenAI daily cost, token, and request usage in the OpenCode sidebar.
- Displays Z.AI and GLM quota status, reset timing, and plan information.
- Discovers credentials from OpenCode auth storage and environment variables.
- Supports dedicated plugin configuration and `oh-my-openagent.json` integration.
- Redacts secrets from error messages before rendering them in the TUI.
- Uses stale-data indicators and guarded refreshes to avoid overlapping API calls.
- Features two-level toggle: main panel collapse/expand and provider-level detail views.

## Requirements

- OpenCode >= v1.14.49
- Bun >= 1.1.0

## Installation

### npm package

```bash
npm install opencode-usage-monitor
```

Register the package in your OpenCode plugin configuration according to your OpenCode setup.

### Local checkout

```bash
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd usage-monitor
bun install
bun run build:all
```

Then point OpenCode to the built `dist/index.js` plugin entry.

## Configuration

The plugin reads a dedicated configuration file first:

```json
{
  "enabled": true,
  "default_collapsed": false,
  "default_provider_collapsed": true,
  "debug": false,
  "refresh_ms": 60000,
  "request_timeout_ms": 15000,
  "show_openai": true,
  "show_zai": true,
  "show_details": true,
  "width": 34,
  "symbols": "unicode",
  "max_detail_lines": 4,
  "max_windows": 3,
  "max_model_lines": 1
}
```

Save it at:

```text
~/.config/opencode/usage-monitor.json
```

Alternatively, add a `usage_monitor` section to `oh-my-openagent.json`:

```json
{
  "usage_monitor": {
    "enabled": true,
    "default_collapsed": false,
    "default_provider_collapsed": true,
    "debug": false,
    "refresh_ms": 60000,
    "request_timeout_ms": 15000,
    "show_openai": true,
    "show_zai": true,
    "show_details": true,
    "width": 34,
    "symbols": "unicode",
    "max_detail_lines": 4,
    "max_windows": 3,
    "max_model_lines": 1
  }
}
```

Dedicated `usage-monitor.json` values take precedence over `oh-my-openagent.json` values.

## Supported providers

### OpenAI

OpenAI usage and cost endpoints require an admin key. Set one of the following:

```bash
export OPENAI_ADMIN_KEY="your-admin-key"
```

The plugin can detect `OPENAI_API_KEY` or an OpenCode `auth.json` OpenAI entry, but those credentials are marked unsupported for organization usage endpoints unless they are admin keys.

Features two-level toggle: main panel collapse/expand and provider-level detail views. OpenAI displays primary + secondary windows with rate limits.

### Z.AI and GLM

The plugin supports Z.AI and Zhipu/GLM credentials from OpenCode auth storage or environment variables:

```bash
export ZAI_API_KEY="your-zai-key"
export ZAI_CODING_PLAN_API_KEY="your-coding-plan-key"
export ZHIPU_API_KEY="your-zhipu-key"
export ZHIPUAI_API_KEY="your-zhipuai-key"
```

Provider-level detail views can be toggled collapsed/expanded independently of the main panel state.

## Usage

- Click the main usage header to collapse/expand the entire panel
- Click individual provider rows to toggle provider details (OpenAI has primary + secondary windows, providers can be toggled collapsed/expanded)
- Use `/usage-refresh` slash command or press `shift+r` to manually refresh
- Cache is stored at `~/.cache/opencode/usage-monitor.json`
- Render errors are caught and displayed safely within an error boundary

## Development

```bash
bun install
bun run build:all
bun test
bun run typecheck
```

Available scripts:

- `bun run build:index` builds the OpenCode plugin entry.
- `bun run build` builds the TUI module.
- `bun run build:all` builds both outputs into `dist/`.
- `bun test` runs the test suite.
- `bun run typecheck` runs TypeScript validation without emitting files.

## Project structure

```text
.
├── src/
│   ├── auth.ts
│   ├── cache.ts
│   ├── config.ts
│   ├── format.ts
│   ├── index.ts
│   ├── layout.ts
│   ├── sanitize.ts
│   ├── severity.ts
│   ├── tui.test.ts
│   ├── tui.ts
│   ├── providers/
│   │   ├── openai.ts
│   │   ├── registry.ts
│   │   ├── shared.ts
│   │   ├── types.ts
│   │   └── zai.ts
│   └── views/
│       ├── common.ts
│       ├── index.ts
│       ├── openai-view.ts
│       ├── types.ts
│       └── zai-view.ts
├── package.json
├── tsconfig.json
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

## Troubleshooting

- If OpenAI shows `needs admin key`, set `OPENAI_ADMIN_KEY` with an organization admin key.
- If Z.AI shows `auth missing`, configure a supported Z.AI or Zhipu environment variable or OpenCode auth entry.
- If the panel is too wide or narrow, adjust `width` in `usage-monitor.json`.
- If refreshes appear stale, lower `refresh_ms` or check network access to provider APIs.
- If build output is missing, run `bun run build:all` and verify `dist/index.js` and `dist/tui.js` exist.
- If data appears stale, check cache location at `~/.cache/opencode/usage-monitor.json`.

## Screenshots

<!-- TODO: add screenshot -->

## License

MIT. See [LICENSE](LICENSE).