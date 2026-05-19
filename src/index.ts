import type { Plugin } from "@opencode-ai/plugin";

const plugin: { id: string; server: Plugin } = {
  id: "usage-monitor",
  server: async (_input) => ({}),
};

export default plugin;
