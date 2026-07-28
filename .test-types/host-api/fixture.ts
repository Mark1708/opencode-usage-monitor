import type {
  TuiDialogSelectOption,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";

export function verifyHostApi(api: TuiPluginApi): void {
  const slotId: string = api.slots.register({
    slots: {
      sidebar_content: () => api.ui.DialogSelect({
        title: "Host API fixture",
        options: [],
      }),
    },
  });

  const unregisterLayer = api.keymap.registerLayer({
    commands: [{
      name: "usage-monitor.fixture",
      run: () => undefined,
    }],
    bindings: [{
      key: "<leader>q",
      cmd: "usage-monitor.fixture",
    }],
  });

  const options: TuiDialogSelectOption<string>[] = [
    { title: "Open", value: "open" },
  ];
  api.ui.dialog.replace(() => api.ui.DialogSelect({
    title: "Select provider",
    options,
    onSelect: () => api.ui.dialog.clear(),
  }));
  api.renderer.requestRender();
  api.lifecycle.onDispose(() => unregisterLayer());
  void slotId;
}
