/** Largest decoded OSC 52 payload we will put on the clipboard (bytes of UTF-8). */
export const OSC52_MAX_BYTES = 1_000_000;

/**
 * Parses the data of an OSC 52 sequence (`<targets>;<base64>`, without the `ESC ] 52 ;` prefix and
 * terminator) and returns the text to copy, or null when nothing should be copied.
 *
 * - Only the clipboard target is honoured: `c`, or an empty target list (which defaults to clipboard).
 *   Pure `p` / `s` (primary / selection) writes are ignored: browsers have no such buffer, and
 *   mapping them onto the system clipboard would overwrite it unexpectedly.
 * - A `?` payload is a read query. It is never answered, so a program in the terminal cannot read the
 *   clipboard.
 * - Malformed base64, invalid UTF-8, empty or oversize payloads yield null. Never throws.
 */
export function parseOsc52(data: string): string | null {
    const sep = data.indexOf(";");
    if (sep < 0) return null;
    const targets = data.slice(0, sep);
    const payload = data.slice(sep + 1).trim();
    if (targets !== "" && !targets.includes("c")) return null;
    if (payload === "" || payload === "?") return null;
    // Decoded size is ~3/4 of the base64 length; reject early so a huge payload is never decoded.
    if (payload.length > Math.ceil((OSC52_MAX_BYTES * 4) / 3) + 4) return null;
    if (payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
    try {
        const binary = atob(payload);
        if (binary.length === 0 || binary.length > OSC52_MAX_BYTES) return null;
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return text === "" ? null : text;
    } catch {
        return null;
    }
}
