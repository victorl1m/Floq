/** Client-side prep for organization images: centre-crop to a square and resize, so uploads stay small and uniform. */

export const ORG_IMAGE_SIZE = 256;
export const ORG_IMAGE_PICK_LIMIT = 15 * 1024 * 1024;
export const ORG_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";

/** Rectangle of the source that a centred square crop keeps. */
export function squareCrop(width: number, height: number): { sx: number; sy: number; side: number } {
    const side = Math.min(width, height);
    return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Returns a 256px square WebP (PNG when the browser cannot encode WebP). Throws an Error with a user-facing message. */
export async function prepareOrganizationImage(file: Blob, size = ORG_IMAGE_SIZE): Promise<Blob> {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") throw new Error("Choose a PNG, JPEG or WebP image.");
    if (file.size > ORG_IMAGE_PICK_LIMIT) throw new Error("That image is too large. Choose one under 15 MB.");
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error("That file could not be read as an image.");
    }
    try {
        const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image editing is not available here.");
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
        const webp = await toBlob(canvas, "image/webp", 0.9);
        const out = webp && webp.type === "image/webp" ? webp : await toBlob(canvas, "image/png");
        if (!out) throw new Error("The image could not be prepared.");
        return out;
    } finally {
        bitmap.close();
    }
}

/** First image among pasted/dropped items. */
export function firstImageFile(files: FileList | File[] | null | undefined): File | null {
    return Array.from(files ?? []).find((file) => file.type.startsWith("image/")) ?? null;
}
