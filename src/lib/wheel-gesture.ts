/** Mouse-wheel vs touchpad classification shared by the agent canvas and the memory graph.
 *  Chromium/WebView2 deliver touchpad scroll AND pinch as `wheel` events (pinch has ctrlKey=true), so the
 *  event alone has to tell a notched mouse wheel from a precision touchpad. Pure and DOM-free for unit tests. */
export type WheelKind = "mouse" | "touchpad";
export type WheelMode = "auto" | "trackpad" | "mouse";
/** pan = move the view; zoom = let the stock wheel-zoom handle it; pinch = smooth proportional zoom at the cursor. */
export type WheelAction = "pan" | "zoom" | "pinch";

export interface WheelLike { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey?: boolean; shiftKey?: boolean }
export interface WheelState { kind: WheelKind | null; at: number }

/** How long the last classification is trusted for ambiguous events (a fast touchpad fling ends in integer deltas). */
export const STICKY_MS = 250;

export function newWheelState(): WheelState { return { kind: null, at: -Infinity }; }

/** Notched mice report multiples of 100 (Chromium/Windows 100 per notch, 120 on some drivers). */
function isNotch(d: number): boolean {
  const a = Math.abs(d);
  return a >= 100 && (a % 100 === 0 || a % 120 === 0);
}

/** Classify one wheel event and remember the verdict in `state`. */
export function classifyWheel(e: WheelLike, state: WheelState, now: number): WheelKind {
  let kind: WheelKind | null = null;
  const dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode !== 0) kind = "mouse"; // line/page units: only real wheels send them
  else if (dx !== 0 || !Number.isInteger(dy) || !Number.isInteger(dx)) kind = "touchpad"; // horizontal motion or sub-pixel deltas
  else if (isNotch(dy)) kind = state.kind === "touchpad" && now - state.at < STICKY_MS ? "touchpad" : "mouse";
  else if (state.kind && now - state.at < STICKY_MS) kind = state.kind; // ambiguous integer: keep the recent verdict
  else kind = Math.abs(dy) < 50 ? "touchpad" : "mouse";
  state.kind = kind; state.at = now;
  return kind;
}

/** What a wheel event should do given the user's setting. Ctrl/Cmd+wheel is zoom in every mode. */
export function wheelAction(e: WheelLike, mode: WheelMode, state: WheelState, now: number): WheelAction {
  const kind = classifyWheel(e, state, now);
  if (e.ctrlKey || e.metaKey) return kind === "touchpad" ? "pinch" : "zoom";
  if (mode === "mouse") return "zoom";
  if (mode === "trackpad") return "pan";
  return kind === "touchpad" ? "pan" : "zoom";
}

/** Wheel delta in CSS pixels (line and page units converted). */
export function wheelPixels(e: WheelLike, pageSize = 600): { x: number; y: number } {
  const u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageSize : 1;
  return { x: e.deltaX * u, y: e.deltaY * u };
}

/** Zoom factor for a pinch wheel event: proportional and smooth, clamped so one event cannot jump. */
export function pinchFactor(deltaY: number, deltaMode = 0): number {
  const d = Math.max(-60, Math.min(60, deltaMode === 1 ? deltaY * 16 : deltaY));
  return Math.exp(-d * 0.01);
}
