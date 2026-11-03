import { isTauri } from "@tauri-apps/api/core";
import { readImage, readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Writes text to the clipboard (no permission prompt in either environment). */
export async function copyText(text: string): Promise<void> {
    if (isTauri()) {
        await writeText(text);
        return;
    }
    // navigator.clipboard only exists in secure contexts (https/localhost), so a web app served over
    // plain http has none. It also rejects writes outside a user gesture; execCommand covers both.
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            /* fall through to the legacy path */
        }
    }
    if (!execCommandCopy(text)) throw new Error("Clipboard write was blocked by the browser");
}

function execCommandCopy(text: string): boolean {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    try {
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        area.remove();
        previous?.focus({ preventScroll: true });
    }
}

/**
 * Reads the clipboard. Only available in Tauri: in a plain browser reading would trigger a
 * permission prompt, so callers should rely on a normal paste event (Ctrl/Cmd+V) instead.
 */
export async function readClipboardText(): Promise<string | null> {
    if (!isTauri()) return null;
    return (await readText()) ?? "";
}

export const canReadClipboard = (): boolean => isTauri();

export const pasteShortcut = (): string =>
    /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘V" : "Ctrl+V";

/** Reads an image from the Tauri clipboard and encodes it as PNG; null when there is no image. */
export async function readClipboardImagePng(): Promise<Uint8Array | null> {
    if (!isTauri()) return null;
    try {
        const image = await readImage();
        const { width, height } = await image.size();
        if (!width || !height) return null;
        const rgba = await image.rgba();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } catch {
        return null;
    }
}
