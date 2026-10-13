import type { Plugin } from "@opencode-ai/plugin"

// Dual V1/V2 entrypoint:
// - OpenCode V1 calls `server()` (object entrypoint, supported since 1.18.29).
// - OpenCode V2 reads `id` + `setup()` and ignores `server()`.
// The server side is intentionally empty: this is a TUI-only plugin, but the
// valid V2 definition keeps the package loadable when it is registered through
// `plugins` in opencode.json instead of failing with
// "Plugin must export a default definition with an id and an effect or setup function."
const plugin: { id: string; setup: () => Promise<void>; server: Plugin } = {
  id: "usage-monitor",
  async setup() {},
  server: async () => ({}),
};

export default plugin;
