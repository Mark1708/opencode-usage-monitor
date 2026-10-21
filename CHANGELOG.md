# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.0] - 2026-10-21

### Added

- Added OpenCode Go rolling 5h, weekly, and monthly usage through the read-only Go usage endpoint.
- Added deterministic `opencode-go` credential discovery with `OPENCODE_GO_API_KEY` as the explicit environment fallback.
- Added available OpenAI Codex reset-credit counts with optional nearest-expiry lookup and severity.

## [3.0.0] - 2026-10-19

### Breaking

- Requires OpenCode v2 and the `@opencode/plugin` v2 server/TUI contracts. OpenCode v1 users must remain on `opencode-usage-monitor@2.0.1`.
- Removes legacy root entrypoint shims and direct `auth.json` discovery.

### Added

- Reads active OpenCode credentials through the v2 credential client, with generation-safe cache invalidation after credential changes.
- Adds terminal `forbidden` and `unsupported` provider states that clear stale usage snapshots.
- Adds Zhipu aliases `zhipuai-coding-plan` and `zhipuai`.
- Adds strict host API, declaration-closure, packed-artifact, clean-import, and consumer type checks.

### Changed

- Uses stable tracked Solid render roots so provider, collapse, configuration, and live theme changes update without snapshot re-registration.
- Makes configuration reload and teardown generation-safe.
- Builds and publishes only `dist/index.js`, `dist/tui.js`, and their reachable declarations.
- Moved required checks and exact-artifact npm releases from GitLab CI to GitHub Actions with Trusted Publishing/OIDC.

### Fixed

- Prevents stale credential-list and provider-fetch completions from repopulating state or cache after credential rotation.
- Maps semantic Z.AI authentication failures to a sanitized terminal state.

## [2.0.1] - 2026-07-28

### Fixed

- Updated the Russian README to match the 2.0 configuration, credential, DeepSeek, and local installation documentation.

## [2.0.0] - 2026-07-28

### Breaking

- Replaced the legacy flat runtime config with a strict `version: 2` contract.
- Removed fallback support for `show_openai`, `show_zai`, `show_deepseek`, `refresh_ms`, and other legacy flat fields.
- Changed provider activation to be driven by provider presence under `providers`.
- Changed OpenAI quota collection to require OpenCode OAuth subscription credentials instead of OpenAI Platform API keys.
- Changed balance-only provider rendering so DeepSeek no longer appears as a fake reset window.

### Added

- Added a deterministic refresh coordinator with bootstrap cache reads, explicit refreshes, stale timers, cancellation, and subscriber snapshots.
- Added account-safe provider cache isolation under `/tmp/opencode-usage-monitor-v2/`.
- Added a provider credential resolver with provider allowlists, credential epochs, and safe account metadata.
- Added canonical provider snapshot validation before render/cache publication.
- Added TUI-visible config errors for missing, malformed, or legacy config.
- Added DeepSeek balance summary/detail rendering.
- Added local tarball installation guidance for testing without npm publish.

### Changed

- OpenAI, Z.AI / GLM, and DeepSeek providers now publish canonical `windows`, `alerts`, `modelBreakdown`, and typed `details`.
- Provider-specific view files now own provider display mapping before shared formatting.
- Runtime config reloads preserve panel and provider collapse state.
- Z.AI enterprise coding plan config now uses `providers.zai.options.organization_id` and `providers.zai.options.project_id`.
- README screenshots were refreshed for the 2.0 runtime display.
- Architecture and contributor docs were updated to describe the current runtime, cache, credential, and release flow.

### Fixed

- OpenAI and Z.AI windows with missing usage are omitted instead of being displayed as `0%`.
- Z.AI empty plan levels no longer publish invalid empty plan details.
- Z.AI model breakdown snapshots no longer publish own `undefined` fields.
- Provider errors and snapshots reject active credential leaks before rendering or cache writes.
- Refresh work rejects stale completions after credential/config changes.

### Removed

- Removed historical architecture notes from the published documentation set.
- Removed project-owned version-suffixed source and test filenames in favor of runtime names.

## [1.0.4] - 2025-05-22

### Changed

- Version bump to match agents-sidebar (version parity).

## [1.0.3] - 2025-05-22

### Added

- CHANGELOG.md (Keep a Changelog format).
- npm version and license badges to README.
- Contributing guidelines with code style rules.

### Changed

- README: replaced `npm install` with `bun add`.
- LICENSE: updated copyright to MIT, Mark1708, 2025-2026.
- package.json: homepage now points to npm.
- .gitignore: added `*.tgz`.

### Removed

- Unused GitHub Actions workflow.

## [1.0.2] - 2025-05-21

### Added

- Initial changelog tracking.

[1.0.2]: https://github.com/Mark1708/opencode-usage-monitor/releases/tag/v1.0.2
