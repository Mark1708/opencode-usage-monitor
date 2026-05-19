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
git clone https://github.com/user/opencode-usage-monitor.git
cd opencode-usage-monitor
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
  "refresh_ms": 60000,
  "request_timeout_ms": 15000,
  "show_openai": true,
  "show_zai": true,
  "show_details": true,
  "width": 34,
  "symbols": "unicode"
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
    "refresh_ms": 60000,
    "request_timeout_ms": 15000,
    "show_openai": true,
    "show_zai": true,
    "show_details": true,
    "width": 34,
    "symbols": "unicode"
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

### Z.AI and GLM

The plugin supports Z.AI and Zhipu/GLM credentials from OpenCode auth storage or environment variables:

```bash
export ZAI_API_KEY="your-zai-key"
export ZAI_CODING_PLAN_API_KEY="your-coding-plan-key"
export ZHIPU_API_KEY="your-zhipu-key"
export ZHIPUAI_API_KEY="your-zhipuai-key"
```

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
│   ├── config.ts
│   ├── format.ts
│   ├── index.ts
│   ├── providers.ts
│   ├── tui.ts
│   └── types.ts
├── tui.test.ts
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

## License

MIT. See [LICENSE](LICENSE).
