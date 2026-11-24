// Imported first by network-main.tsx so module-level isTauri() checks (port forwarding) see the mocked desktop bridge.
// window.__calls: Tauri invokes; egress_status answers window.__status.
const w = window as unknown as Record<string, any>;
w.__calls = [];
w.__status = null;
if (new URLSearchParams(location.search).get("tauri") !== "0") {
  w.isTauri = true;
  w.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (s: string) => s,
    async invoke(cmd: string, args: unknown) {
      w.__calls.push({ cmd, args });
      if (cmd === "egress_status") return w.__status;
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "egress_start") setTimeout(() => w.__onStart?.(), 20); // the Rust relay reports its status by event
      return null;
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}
export {};
