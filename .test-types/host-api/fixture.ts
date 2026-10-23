import { Plugin as ServerPlugin } from "@opencode/plugin";
import { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { Rpc } from "@opencode/plugin/rpc";
import { createElement, insert, setProp, type JSX } from "@opentui/solid";

const AuthRpc = Rpc.define({
  id: "fixture.auth",
  methods: { prepare: { input: { type: "object", additionalProperties: false }, output: { type: "boolean" } } },
  events: {},
});

export const server = ServerPlugin.define({
  id: "fixture.server",
  async setup(context) {
    const registration = await context.rpc.register(AuthRpc, {
      prepare: async () => {
        const connection = await context.integration.connection.active("xai");
        if (connection?.type !== "credential" || connection.method !== "oauth") return false;
        const value = await context.integration.connection.resolve(connection);
        return value?.type === "oauth" && value.expires > Date.now();
      },
    });
    return () => registration.dispose();
  },
});

export const tui = TuiPlugin.define({
  id: "fixture.tui",
  setup(context) {
    const auth = context.client.rpc(AuthRpc);
    const removeUpdated = context.data.on("credential.updated", () => undefined);
    const removeSwitched = context.data.on("credential.switched", (event) => {
      void event.data.integrationID;
    });
    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const container = createElement("box");
        setProp(container, "width", "100%");
        insert(container, () => {
          const label = createElement("text");
          setProp(label, "fg", context.theme.text.base);
          insert(label, context.theme.text.muted ? "fixture" : "fixture");
          return label;
        });
        return container as unknown as JSX.Element;
      },
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "fixture.refresh",
        title: "Refresh fixture",
        slash: { name: "fixture-refresh" },
        run: async () => {
          await auth.prepare({});
          const credentials = await context.client.credential.list();
          context.ui.toast.show({
            title: "Fixture",
            message: `${credentials.length} credentials`,
            variant: "info",
          });
        },
      }],
    }));

    return () => {
      removeSlot();
      removeUpdated();
      removeSwitched();
    };
  },
});
