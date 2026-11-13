// Run: node --experimental-strip-types --test e2e/browser-stream.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeChallenge, mapPointerClamped, createClickCounter, wheelPixels, normalizeCursor, reduceBrowser } from "../src/lib/runtime/browser-stream.ts";

test("challenge titles and URLs are detected", () => {
  for (const t of ["Just a moment...", "Performing security verification", "Verifying you are human", "Verify you are human", "Attention Required! | Cloudflare", "Security Check"]) assert.equal(looksLikeChallenge(t, "https://a.test/"), true, t);
  assert.equal(looksLikeChallenge("x", "https://a.test/cdn-cgi/challenge-platform/h/b/orchestrate"), true);
  assert.equal(looksLikeChallenge("x", "https://a.test/?__cf_chl_tk=abc"), true);
  assert.equal(looksLikeChallenge("Example Domain", "https://example.com/"), false);
  assert.equal(looksLikeChallenge(undefined, undefined), false);
});
test("clamped mapping stays inside the page", () => {
  const box = { left: 10, top: 10, width: 800, height: 400 };
  assert.deepEqual(mapPointerClamped(-500, -500, box, { w: 400, h: 200 }), { x: 0, y: 0 });
  assert.deepEqual(mapPointerClamped(5000, 5000, box, { w: 400, h: 200 }), { x: 400, y: 200 });
});
test("click counter: +1 within 500ms/5px, same button, cap 3", () => {
  const c = createClickCounter();
  assert.equal(c(0, 10, 10, 0), 1); assert.equal(c(200, 12, 11, 0), 2); assert.equal(c(400, 12, 11, 0), 3); assert.equal(c(600, 12, 11, 0), 3);
  assert.equal(c(700, 12, 11, 2), 1); assert.equal(c(1500, 12, 11, 2), 1); assert.equal(c(1600, 60, 11, 2), 1);
});
test("wheel deltas normalise and clamp", () => {
  assert.equal(wheelPixels(3, 1, 800), 48); assert.equal(wheelPixels(2, 2, 800), 1600); assert.equal(wheelPixels(99999, 0, 800), 10000); assert.equal(wheelPixels(-99999, 0, 800), -10000);
});
test("unknown cursors map to default", () => { assert.equal(normalizeCursor("grab"), "grab"); assert.equal(normalizeCursor("zzz"), "default"); });

test("reducer: dialog, clipboard and download follow the bound page only", () => {
  const base = { state: "running", frame: null, targetId: "t1", nav: null, activity: 0, cursor: "default", agents: 0, error: null, dialog: null, clipboard: null, download: null } as any;
  const d = reduceBrowser(base, { type: "dialog", targetId: "t1", kind: "confirm", message: "ok?", defaultPrompt: "" });
  assert.deepEqual(d.dialog, { kind: "confirm", message: "ok?", defaultPrompt: "" });
  assert.equal(reduceBrowser(d, { type: "dialog", targetId: "other", kind: "alert", message: "x", defaultPrompt: "" }).dialog, d.dialog);
  assert.equal(reduceBrowser(d, { type: "dialogClosed", targetId: "t1" }).dialog, null);
  assert.equal(reduceBrowser(d, { type: "state", state: "stopped" }).dialog, null);
  const c1 = reduceBrowser(base, { type: "clipboard", targetId: "t1", text: "a" });
  const c2 = reduceBrowser(c1, { type: "clipboard", targetId: "t1", text: "a" });
  assert.equal(c2.clipboard.seq, 2);
  const dl = reduceBrowser(reduceBrowser(base, { type: "download", targetId: "t1", name: "f.txt", state: "started" }), { type: "download", targetId: "t1", name: "", state: "done" });
  assert.deepEqual(dl.download, { name: "f.txt", state: "done" });
});
