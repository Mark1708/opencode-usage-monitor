# ADR 0002: Require the OpenCode 1.15 TUI API generation

- Status: Accepted
- Date: 2026-07-27

## Context

Version 2.0 needs synchronous slot registration, reactive render requests, lifecycle disposal, `DialogSelect`, and keymap layers. `api.command` is deprecated. The installed plugin declarations confirm that slot callbacks are synchronous and dialogs are host-owned JSX.

The keymap API is available in the `@opencode-ai/plugin` 1.15 generation, whose peer floor is OpenTUI 0.2.10. Its declarations require `@opentui/keymap` types.

The upstream OpenTUI 0.2.10 declarations do not pass regular TypeScript with `skipLibCheck: false` even in an isolated project. This is an upstream declaration limitation, not a plugin fixture failure.

## Decision

Set these peer floors:

- `@opencode-ai/plugin >=1.15.0`
- `@opentui/keymap >=0.2.10`
- `@opentui/solid >=0.2.10`
- `solid-js >=1.9.12`

Maintain an isolated `.test-types/host-api` project pinned to the minimum versions. Its compiler is strict and validates the plugin's exact slot, keymap, dialog, render, and disposal calls. It uses `skipLibCheck: true` only to bypass known upstream declaration-body errors.

Register provider selection dialogs through `api.ui.dialog.replace(() => api.ui.DialogSelect(...))`. `api.keymap.registerLayer(...)` returns the cleanup callback used during plugin disposal.

## Consequences

- Version 2.0 does not support the older 1.4 TUI API generation.
- No OpenTUI package becomes a bundled runtime dependency; the host provides runtime objects.
- The minimum-version fixture is part of release verification.

## Evidence

- `node_modules/@opencode-ai/plugin/dist/tui.d.ts`
- npm metadata for `@opencode-ai/plugin@1.15.0`
- npm metadata for `@opentui/keymap@0.2.10`
- `.test-types/host-api/fixture.ts`
