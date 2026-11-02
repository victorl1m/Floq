import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Opens an http(s) URL in the user's browser. Anything else is ignored. */
export async function openExternal(uri: string): Promise<void> {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (isTauri()) await openUrl(url.toString());
    else window.open(url.toString(), "_blank", "noopener,noreferrer");
}
