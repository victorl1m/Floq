import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import { mountSegments, type MountItem } from "@/lib/mount-path";

/**
 * Download a workspace file, or a folder as a zip. The runtime streams it (no size cap, Range, shard kept awake); the desktop app
 * asks where to save with the OS save dialog, streams it there through the Rust downloader and reveals the file in its folder.
 * A plain browser navigates to the signed link and lets the browser's download manager take over.
 */
export async function downloadWorkspacePath(client: RuntimeClient, sessionId: string, path: string, kind: "file" | "dir", name: string, source: "workspace" | "artifacts" = "workspace"): Promise<void> {
  const fallback = kind === "dir" ? `${name || "workspace"}.zip` : name || "download";
  const id = toast.loading(kind === "dir" ? `Preparing ${fallback}…` : `Downloading ${fallback}…`);
  try {
    const url = source === "artifacts" ? await client.artifactDownloadUrl(sessionId, path) : await client.fileDownloadUrl(sessionId, path);
    if (isTauri()) {
      // The OS save dialog picks the folder and name; the saved file is then shown in Explorer/Finder/the file manager.
      const saved = await invoke<string | null>("download_with_picker", { url, fallbackName: fallback });
      if (!saved) { toast.dismiss(id); return; } // the user cancelled the dialog
      toast.success(`Saved ${saved.split(/[\\/]/).pop() ?? fallback}`, { id, description: saved });
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = "";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast.success(`Download started: ${fallback}`, { id });
  } catch (cause) {
    toast.error(typeof cause === "string" ? cause : errorMessage(cause), { id });
  }
}

/** Explorer/Finder can only reach a share over HTTPS (the Windows client sends the token in the URL path). */
export const canOpenInExplorer = (client: RuntimeClient): boolean => isTauri() && client.baseUrl.startsWith("https://");

const MOUNTS = new Map<string, string>();

/** Is a share of this project open from this app run (so Eject makes sense)? */
export const hasOpenMount = (projectId: string): boolean => MOUNTS.has(projectId);

function mountError(cause: unknown): string {
  const text = typeof cause === "string" ? cause : errorMessage(cause);
  const match = /^(webclient_\w+): (.*)$/s.exec(text);
  return match ? match[2] : text;
}

/** Create a read-only share of the project's folders and open it in the OS file manager (or map it as a drive on Windows). */
export async function openProjectInExplorer(client: RuntimeClient, projectId: string, mapDrive = false, item?: MountItem & { isDir: boolean }): Promise<void> {
  const id = toast.loading("Opening your project files…");
  try {
    const mount = await client.createFileMount(projectId);
    const davUrl = `${client.baseUrl.replace(/\/+$/, "")}${mount.path}`;
    MOUNTS.set(projectId, mount.token);
    // The item's folder inside the share: the file manager opens there (and selects a file) instead of at the share root.
    const sub = mountSegments(mount.folders ?? [], item);
    const message = await invoke<string>("open_dav_mount", { davUrl, mapDrive, sub, isFile: !!item && !item.isDir && sub.length > 1 });
    toast.success(message, { id, description: "Read-only, available for 8 hours or until you eject it. Files over 50 MB: use Download." });
  } catch (cause) {
    // Do not leave a live share behind when the OS could not open it.
    const token = MOUNTS.get(projectId);
    MOUNTS.delete(projectId);
    if (token) void client.revokeFileMount(projectId, token).catch(() => undefined);
    toast.error(mountError(cause), { id });
  }
}

/** Revoke the project's shares on the server (this ends access immediately) and disconnect a mapped drive. */
export async function ejectProjectMount(client: RuntimeClient, projectId: string): Promise<void> {
  const token = MOUNTS.get(projectId);
  MOUNTS.delete(projectId);
  try {
    if (token) await invoke("eject_dav_mount", { davUrl: `${client.baseUrl.replace(/\/+$/, "")}/dav/${token}/` }).catch(() => undefined);
    await client.revokeFileMount(projectId);
    toast.success("Explorer access stopped");
  } catch (cause) {
    toast.error(errorMessage(cause));
  }
}
