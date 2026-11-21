// The user's machine as the Browser node's Chromium should report it (screen, pointer, timezone, languages): sent in the stream URL when a node
// opens, applied by the runtime at the next browser start (runtime/src/browserProtocol.ts sanitizeClientEnv). Plain facts only: nothing here is invented.
export interface BrowserClientEnv { screenW: number; screenH: number; dpr: number; tz?: string; langs: string[]; pointerFine?: boolean; hover?: boolean }

export function collectBrowserEnv(): BrowserClientEnv | null {
  if (typeof window === "undefined" || typeof screen === "undefined") return null;
  const mq = (q: string): boolean | undefined => { try { return typeof window.matchMedia === "function" ? window.matchMedia(q).matches : undefined; } catch { return undefined; } };
  let tz: string | undefined;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { /* no Intl timezone */ }
  const langs = (typeof navigator !== "undefined" ? (navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : []) : []).slice(0, 5);
  const pointerFine = mq("(pointer: fine)"), hover = mq("(hover: hover)");
  const w = Math.round(screen.width), h = Math.round(screen.height);
  if (!(w > 0 && h > 0)) return null;
  return { screenW: w, screenH: h, dpr: typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1, ...(tz ? { tz } : {}), langs, ...(pointerFine !== undefined ? { pointerFine } : {}), ...(hover !== undefined ? { hover } : {}) };
}
