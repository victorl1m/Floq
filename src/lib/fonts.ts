/** Keep in sync with --font-mono in src/index.css. */
export const MONO_FONT_FAMILY =
    '"SF Mono", SFMono-Regular, ui-monospace, Menlo, "Geist Mono Variable", monospace';

/** xterm measures glyphs when opened, so the mono font must be loaded first. */
export async function loadMonoFont(): Promise<void> {
    try {
        await document.fonts.load('13px "Geist Mono Variable"');
        await document.fonts.ready;
    } catch {
        /* fall back to whatever is available */
    }
}
