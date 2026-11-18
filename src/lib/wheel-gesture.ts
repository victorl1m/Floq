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

/** A touchpad gesture keeps its owner until the fingers pause this long (no wheel events). */
export const GESTURE_GAP_MS = 180;

/** Who handles a wheel event: the canvas (pan/zoom) or the element under the cursor (its own scroll). */
export type WheelOwner = "canvas" | "inner";
export interface GestureLatch { owner: WheelOwner | null; at: number }
export function newGestureLatch(): GestureLatch { return { owner: null, at: -Infinity }; }

export interface RouteInput {
  /** Event target sits inside a `.nowheel` element (terminal, composer, input, list). */
  inNoWheel: boolean;
  /** That element insists on the wheel (an interactive terminal mirror scrolling its TUI). */
  innerOwnsWheel: boolean;
  /** Something between the target and the `.nowheel` boundary can still scroll in the gesture's direction. */
  innerCanScroll: boolean;
}

/**
 * Route one wheel event. Pinch (Ctrl/Cmd+wheel) always zooms the canvas, even over a terminal: the page must
 * never zoom and terminals have no pinch of their own. A touchpad gesture stays with whoever started it until
 * the fingers pause, so a pan that slides over a terminal's input keeps panning instead of dying mid-gesture.
 * A new gesture that starts over an input which cannot scroll that way pans the canvas.
 */
export function routeWheel(e: WheelLike, kind: WheelKind, input: RouteInput, latch: GestureLatch, now: number): WheelOwner {
  const continuing = kind === "touchpad" && latch.owner !== null && now - latch.at < GESTURE_GAP_MS;
  let owner: WheelOwner;
  if (e.ctrlKey || e.metaKey) owner = "canvas";
  else if (continuing) owner = latch.owner!;
  else if (!input.inNoWheel) owner = "canvas";
  else if (input.innerOwnsWheel || input.innerCanScroll || kind === "mouse") owner = "inner";
  else owner = "canvas";
  if (kind === "touchpad") { latch.owner = owner; latch.at = now; } else latch.owner = null;
  return owner;
}
