import { useCallback } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useRuntime, errorMessage } from "@/lib/runtime/store";

/**
 * Saves a file a plugin route streams (a GET route returning PluginDownload). The runtime signs a one-minute link; the desktop app asks where to save
 * with the OS save dialog and streams to disk through the Rust downloader (nothing is held in memory), a plain browser starts a normal download.
 * Resolves true when the download started (or was saved), false when the user cancelled the save dialog or it failed (the toast says why).
 */
export function usePluginDownload(pluginId: string) {
  const { client } = useRuntime();
  return useCallback(async (path: string, query: Record<string, string>, fallbackName: string): Promise<boolean> => {
    if (!client) { toast.error("Not signed in"); return false; }
    const id = toast.loading(`Preparing ${fallbackName}…`);
    try {
      const url = await client.pluginDownloadUrl(pluginId, path, query);
      if (isTauri()) {
        const saved = await invoke<string | null>("download_with_picker", { url, fallbackName });
        if (!saved) { toast.dismiss(id); return false; }
        toast.success(`Saved ${saved.split(/[\\/]/).pop() ?? fallbackName}`, { id, description: saved });
        return true;
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = "";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success(`Download started: ${fallbackName}`, { id });
      return true;
    } catch (cause) {
      toast.error(typeof cause === "string" ? cause : errorMessage(cause), { id });
      return false;
    }
  }, [client, pluginId]);
}
