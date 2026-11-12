import { isTauri } from "@tauri-apps/api/core";
import { readClipboardImagePng } from "@/lib/clipboard";

export type PasteDecision = {
    /** Image files found in the DOM paste event (already given a stable name). */
    images: File[];
    /** True when the browser's own paste should insert the text (text is meaningful, not just the image's name/HTML). */
    pasteText: boolean;
    /** True when neither text nor image was in the event: the caller may try the native clipboard. */
    empty: boolean;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif|svg)$/i;

/** Text that only names/links the pasted image (file name, file URL, image URL, <img> HTML) and should not be inserted. */
export function isImageEcho(text: string, html: string, files: File[]): boolean {
    const t = text.trim();
    if (!t) return true;
    if (files.some((file) => file.name && t === file.name)) return true;
    if (!/\s/.test(t) && (IMAGE_EXT.test(t.split(/[?#]/)[0]) || /^data:image\//i.test(t))) return true;
    if (/^file:\/\/\S+$/i.test(t) && IMAGE_EXT.test(t)) return true;
    // Copying an image from a web page: text/plain is the alt text or URL while text/html is a lone <img>.
    if (html && /^\s*(<[^>]+>\s*)*<img\b[^>]*>\s*(<\/[^>]+>\s*)*$/i.test(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(meta|style)\b[^>]*>/gi, ""))) return true;
    return false;
}

const named = (file: File, index: number): File => {
    if (file.name && file.name !== "image.png") return file;
    const ext = file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
    return new File([file], `pasted-image-${Date.now()}${index ? `-${index}` : ""}.${ext}`, { type: file.type });
};

/** Synchronous classification of a DOM paste (must run before preventDefault is decided). */
export function classifyPaste(clip: DataTransfer | null | undefined): PasteDecision {
    if (!clip) return { images: [], pasteText: false, empty: true };
    const fromFiles = Array.from(clip.files ?? []).filter((file) => file.type.startsWith("image/"));
    const fromItems = fromFiles.length
        ? []
        : Array.from(clip.items ?? []).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => !!file);
    const images = [...fromFiles, ...fromItems].map(named);
    const text = clip.getData("text/plain") ?? "";
    const html = clip.getData("text/html") ?? "";
    const pasteText = !!text && (images.length === 0 || !isImageEcho(text, html, images));
    return { images, pasteText, empty: images.length === 0 && !text };
}

export type NativeImage = { name: string; size: number; blob: Blob };

/**
 * Fallback for webviews (WebView2) that expose a pasted screenshot only natively.
 * Never throws: a clipboard without an image is the normal case and yields null.
 */
export async function readNativeImage(read: () => Promise<Uint8Array | null> = readClipboardImagePng): Promise<NativeImage | null> {
    if (!isTauri()) return null;
    try {
        const png = await read();
        if (!png?.byteLength) return null;
        return { name: `pasted-image-${Date.now()}.png`, size: png.byteLength, blob: new Blob([png as BlobPart], { type: "image/png" }) };
    } catch {
        return null;
    }
}

/**
 * Shared paste handler for composers. Call from onPaste with the native event.
 * Text-only: untouched (normal paste). Image: preventDefault unless meaningful text should also paste, then `onImages`.
 * Empty event: native clipboard fallback, silently nothing when it has no image.
 */
export function handlePaste(event: ClipboardEvent, onImages: (files: File[]) => void, onNative?: (item: NativeImage) => void): PasteDecision {
    const decision = classifyPaste(event.clipboardData);
    if (decision.images.length) {
        if (!decision.pasteText) event.preventDefault();
        onImages(decision.images);
    } else if (decision.empty && onNative) {
        void readNativeImage().then((item) => { if (item) onNative(item); });
    }
    return decision;
}
