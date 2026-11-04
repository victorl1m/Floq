import { useEffect } from "react";
import { toast } from "sonner";
import { layoutEvent } from "./project-folders";
import { backupLocalDoc, FOLDERS_PULL_EVENT, loadSyncMeta, readLocalDoc, saveSyncMeta, writeLocalDoc } from "./project-folders-cache";
import { FolderSync, isEmptyDoc } from "./project-folders-sync";
import { projectScope } from "./prefs";
import { useRuntime } from "./runtime/store";

const POLL_MS = 60_000;
const MIN_PULL_GAP_MS = 5_000;

/**
 * Keeps the sidebar folder layout in step with the runtime (per user). Mount once, inside the signed-in app.
 * Loads on sign-in, saves (debounced) on change, saves on pagehide, and re-reads every 60 s and when the window
 * regains focus so changes made on another device show up.
 */
export function useProjectFoldersSync(): void {
  const { client, baseUrl, user } = useRuntime();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!client || !baseUrl || !userId) return;
    const scope = projectScope(baseUrl, userId);
    // First time on this device for this account: keep what is here before anything can replace it.
    if (loadSyncMeta(scope) === null) {
      const existing = readLocalDoc(scope, baseUrl, userId);
      if (!isEmptyDoc(existing)) backupLocalDoc(scope, existing);
    }
    const sync = new FolderSync({
      api: { get: () => client.projectFolders(), put: (version, doc, options) => client.saveProjectFolders(version, doc, options) },
      local: { read: () => readLocalDoc(scope, baseUrl, userId), write: (doc) => writeLocalDoc(scope, doc) },
      meta: { load: () => loadSyncMeta(scope), save: (meta) => saveSyncMeta(scope, meta) },
      timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (handle) => window.clearTimeout(handle as number) },
      backup: (doc) => backupLocalDoc(scope, doc),
      onRepeatedFailure: () => toast.error("Couldn't save your project folders", { id: "project-folders-sync", description: "Your changes are kept on this device and will sync when the connection to the runtime returns." }),
    });
    let lastPull = 0;
    const pull = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPull < MIN_PULL_GAP_MS) return;
      lastPull = now;
      sync.pull().catch(() => { /* offline: the cache keeps working, the next poll retries */ });
    };
    const onLocalChange = () => sync.notifyLocalChange();
    const onVisibility = () => { if (document.visibilityState === "visible") pull(); else void sync.flush({ keepalive: true }); };
    const onFocus = () => pull();
    const onPageHide = () => { void sync.flush({ keepalive: true }); };
    const onPullRequest = () => pull(true);
    // Writes made by this engine are ignored inside notifyLocalChange, so listening to our own events is safe.
    window.addEventListener(layoutEvent(), onLocalChange);
    window.addEventListener("floq:recent-repos", onLocalChange);
    window.addEventListener("storage", onLocalChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener(FOLDERS_PULL_EVENT, onPullRequest);
    document.addEventListener("visibilitychange", onVisibility);
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") pull(true); }, POLL_MS);
    pull(true);
    return () => {
      window.removeEventListener(layoutEvent(), onLocalChange);
      window.removeEventListener("floq:recent-repos", onLocalChange);
      window.removeEventListener("storage", onLocalChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener(FOLDERS_PULL_EVENT, onPullRequest);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(poll);
      // Sign-out or switching account: push pending edits for THIS user with THIS user's client, then stop.
      void sync.flush({ keepalive: true });
      sync.dispose();
    };
  }, [client, baseUrl, userId]);
}
