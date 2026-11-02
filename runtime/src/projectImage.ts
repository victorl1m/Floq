export const MAX_PROJECT_IMAGE_BYTES = 32 * 1024;
const PROJECT_IMAGE_DATA_URL = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/;

/** Project marks accept direct HTTP(S) URLs or small, normalized WebP thumbnails. */
export function isAllowedProjectImage(value: string): boolean {
  if (value.length <= 2048) {
    try {
      const url = new URL(value);
      if (["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password) return true;
    } catch {
      // Continue with the embedded thumbnail format check.
    }
  }

  if (value.length > Math.ceil(MAX_PROJECT_IMAGE_BYTES / 3) * 4 + 32) return false;
  const match = PROJECT_IMAGE_DATA_URL.exec(value);
  if (!match) return false;
  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length > 0 && bytes.length <= MAX_PROJECT_IMAGE_BYTES && bytes.toString("base64") === encoded &&
    bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}
