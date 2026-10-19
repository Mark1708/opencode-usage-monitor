import { Plugin as ServerPlugin } from "@opencode/plugin";
import { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { createElement, insert, setProp, type JSX } from "@opentui/solid";

export const server = ServerPlugin.define({
  id: "fixture.server",
  setup() {},
});

export const tui = TuiPlugin.define({
  id: "fixture.tui",
  setup(context) {
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
