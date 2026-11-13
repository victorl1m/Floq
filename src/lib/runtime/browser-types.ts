// Agent browser wire types (docs/design/agent-browser.md §A.5, app <-> runtime /v1/browser/stream). Kept apart from types.ts.
export type BrowserState = "starting" | "running" | "stopped" | "disabled" | "unavailable";
export interface BrowserNav { targetId: string; url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean }
export interface BrowserFrame { n: number; targetId: string; jpeg: string; w: number; h: number; scale: number }
/** Egress of the agent browser (docs/design/browser-user-egress.md §4.2): `mode` is the user's choice, `state` the truth. */
export type BrowserEgressMode = "server" | "desktop" | "desktop-fallback";
export interface BrowserEgress { mode: BrowserEgressMode; state: "up" | "down" | "standby"; machine?: string; rttMs?: number; /** "Use the server connection this time" is active: transient on the runtime, the saved mode is unchanged. */ override?: boolean }
/** runtime -> app. */
export type BrowserServerMessage =
  | { type: "state"; state: BrowserState }
  | ({ type: "frame" } & BrowserFrame)
  | { type: "page"; targetId: string; created: boolean }
  | { type: "cursor"; cursor: string }
  | ({ type: "nav" } & BrowserNav)
  | { type: "agentActivity"; targetId: string; at: number }
  | { type: "dialog"; targetId: string; kind: "alert" | "confirm" | "prompt"; message: string; defaultPrompt: string }
  | { type: "dialogClosed"; targetId: string }
  | { type: "clipboard"; targetId: string; text: string }
  | { type: "download"; targetId: string; name: string; state: "started" | "done" | "failed" }
  | { type: "clients"; agents: number }
  | ({ type: "egress" } & BrowserEgress)
  | { type: "error"; code: string };
/** app -> runtime. Mouse/key messages use `kind` for the CDP event type because `type` names the message. */
export type BrowserClientMessage =
  | { type: "screencast.start"; maxW: number; maxH: number; quality: number }
  | { type: "screencast.stop" }
  | { type: "input.mouse"; kind: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: "none" | "left" | "middle" | "right"; buttons: number; clickCount: number; modifiers: number }
  | { type: "input.wheel"; x: number; y: number; dx: number; dy: number; modifiers: number }
  | { type: "input.key"; kind: "keyDown" | "keyUp"; key: string; code: string; text?: string; modifiers: number }
  | { type: "input.text"; text: string }
  | { type: "nav.go"; url: string }
  | { type: "nav.back" } | { type: "nav.forward" } | { type: "nav.reload" } | { type: "nav.stop" }
  | { type: "dialog.reply"; accept: boolean; text?: string }
  | { type: "viewport"; width: number; height: number; dpr: number }
  | { type: "page.close" };
/** GET /v1/browser. */
export interface BrowserStatus {
  state: BrowserState;
  agents?: number;
  tabs?: number;
  version?: { chromium: string; revision: string | number; playwrightMcp: string; build?: string } | null;
  profile?: string;
  sandbox?: string;
  egress?: BrowserEgress;
}
/** Cookie / data import (docs/design/agent-browser.md §A.13). Names and counts only: values never reach the app after upload. */
export interface BrowserDomainCount { domain: string; count: number }
export interface BrowserImportPreview {
  importId: string;
  format: "netscape" | "json" | "bookmarks";
  cookies: { total: number; domains: BrowserDomainCount[]; expired: number; malformed: number };
  bookmarks: { count: number };
  skippedStorage: boolean;
}
export interface BrowserImportResult { imported: number; failed: number; bookmarks: number }
export interface BrowserData { domains: BrowserDomainCount[]; bookmarks: number }
