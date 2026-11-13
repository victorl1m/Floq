import test from "node:test";
import assert from "node:assert/strict";
import { JsonLines, RateWindow, normalizeNavUrl, toViewerMessage, validateClientMessage } from "../dist/browserProtocol.js";

const TID = "C711BB681855D07964DB653782FFBE88";
const ok = (m) => { const r = validateClientMessage(m); assert.equal(r.ok, true, JSON.stringify(m)); return r.msg; };
const bad = (m, code) => { const r = validateClientMessage(m); assert.equal(r.ok, false, JSON.stringify(m)?.slice(0, 100)); if (code) assert.equal(r.code, code); };

test("every message the canvas node sends is accepted", () => {
  ok({ type: "screencast.start", targetId: TID, maxW: 900, maxH: 600, quality: 60 });
  ok({ type: "screencast.stop" });
  ok({ type: "input.mouse", kind: "mouseMoved", x: 1, y: 2.5, button: "none", clickCount: 0, modifiers: 0 });
  ok({ type: "input.wheel", x: 1, y: 1, dx: 0, dy: -120 });
  ok({ type: "input.key", kind: "keyDown", key: "Enter", code: "Enter", modifiers: 0 });
  ok({ type: "input.key", kind: "keyDown", key: "é", code: "KeyE", text: "é", modifiers: 8 });
  ok({ type: "input.key", kind: "keyUp", key: "F12", code: "F12", modifiers: 0 });
  ok({ type: "input.text", text: "héllo 😀" });
  ok({ type: "nav.go", targetId: TID, url: "https://example.com/a?b=c" });
  for (const t of ["nav.back", "nav.forward", "nav.reload", "nav.stop"]) ok({ type: t });
  ok({ type: "tab.new" }); ok({ type: "tab.new", url: "http://localhost:3000/" });
  ok({ type: "tab.close", targetId: TID }); ok({ type: "tab.select", targetId: TID });
});

test("messages are rebuilt: unknown fields are dropped, sizes are capped", () => {
  assert.deepEqual(ok({ type: "nav.reload", cdp: { method: "Runtime.evaluate" } }), { type: "nav.reload" });
  assert.deepEqual(ok({ type: "nav.go", targetId: TID, url: "https://example.com", __proto__: { x: 1 }, extra: 1 }), { type: "nav.go", targetId: TID, url: "https://example.com/" });
  const s = ok({ type: "screencast.start", targetId: TID, maxW: 9999, maxH: 9999.4, quality: 60.2 });
  assert.deepEqual([s.maxW, s.maxH, s.quality], [1600, 1200, 60]);
});

test("runtime-only and unknown messages are refused from the app", () => {
  for (const type of ["hello", "frame.ack", "shutdown", "ready", "Target.attachToTarget", "Runtime.evaluate", "__proto__", "constructor", "", "input", "nav.go ", "NAV.GO"]) bad({ type, n: 1, targetId: TID, url: "https://a.test/" });
  for (const v of [null, undefined, 0, 1, "x", [], [{ type: "nav.back" }], {}, { type: 5 }, { type: null }]) bad(v);
});

test("coordinates, counts and key names are bounded", () => {
  const mouse = { type: "input.mouse", kind: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 };
  for (const patch of [{ x: -1 }, { y: -0.1 }, { x: 20000 }, { x: NaN }, { x: Infinity }, { y: "1" }, { x: null }, { kind: "mouseWheel" }, { button: "back" }, { clickCount: 4 }, { clickCount: 1.5 }, { clickCount: -1 }, { modifiers: 16 }, { modifiers: 1.5 }]) bad({ ...mouse, ...patch });
  const wheel = { type: "input.wheel", x: 1, y: 1, dx: 0, dy: 1 };
  for (const patch of [{ dx: 10001 }, { dy: -10001 }, { dx: NaN }, { x: -1 }, { dy: "1" }, { dy: undefined }]) bad({ ...wheel, ...patch });
  const key = { type: "input.key", kind: "keyDown", key: "a", code: "KeyA", modifiers: 0 };
  for (const patch of [{ key: "" }, { key: "ab" }, { key: "Enterr" }, { key: "\u0007" }, { key: "\u007f" }, { key: "\ud800" }, { key: 5 }, { key: "F25" }, { kind: "keyPress" }, { code: "Key A" }, { code: "x".repeat(33) }, { text: "123456789" }, { text: "\u0001" }, { text: 5 }, { modifiers: -1 }]) bad({ ...key, ...patch });
  bad({ type: "screencast.start", targetId: "../x", maxW: 1, maxH: 1, quality: 1 });
  bad({ type: "screencast.start", targetId: TID, maxW: 0, maxH: 1, quality: 1 });
  bad({ type: "screencast.start", targetId: TID, maxW: 1, maxH: 1, quality: 101 });
  bad({ type: "screencast.start", targetId: TID, maxW: "1", maxH: 1, quality: 1 });
  bad({ type: "tab.close" }); bad({ type: "tab.select", targetId: "x y" }); bad({ type: "tab.close", targetId: "a".repeat(65) });
});

test("text is limited to 4 KiB of UTF-8 and may not contain NUL", () => {
  ok({ type: "input.text", text: "a".repeat(4096) });
  bad({ type: "input.text", text: "a".repeat(4097) });
  bad({ type: "input.text", text: "é".repeat(2049) });
  ok({ type: "input.text", text: "é".repeat(2048) });
  bad({ type: "input.text", text: "a\u0000b" });
  bad({ type: "input.text", text: 5 });
});

test("navigation: only http, https and the exact about:blank, however the URL is dressed", () => {
  const forbidden = [
    "file:///etc/passwd", "chrome://settings", "devtools://devtools/bundled/inspector.html", "javascript:alert(1)", "data:text/html,<script>1</script>",
    "JAVASCRIPT:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "java\tscript:alert(1)", "\u0000javascript:alert(1)", "vbscript:x", "blob:https://e.test/uuid",
    "about:srcdoc", "about:blank#x", "about:blank?x", "ABOUT:BLANK", "view-source:https://e.test", "chrome-extension://abc/x", "ftp://e.test", "ws://e.test", "wss://e.test",
    "http://", "https:///", "//e.test", "e.test", "", "http://e x.test", "http://e.test/\n", " http://e.test", "http://e.test ", "https://e.test\u2028", "https://e.test\u200b/", "\ufeffhttps://e.test",
    "x".repeat(2049), "https://" + "a".repeat(2050), "chrome-untrusted://x", "filesystem:https://e.test/temporary/x", "http:e.test", "http:/e.test", "https:\\\\e.test", "http://[::1", "http://exa\u0000mple.com",
    "jar:https://e.test!/", "data:,x", "tel:123", "mailto:a@b.c", "intent://x", "http\u0000s://e.test",
  ];
  for (const u of forbidden) assert.equal(normalizeNavUrl(u), null, JSON.stringify(u).slice(0, 80));
  for (const bad of [null, undefined, 5, {}, ["https://a.com"]]) assert.equal(normalizeNavUrl(bad), null);
  assert.equal(normalizeNavUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeNavUrl("HTTP://Example.COM:8080/a%20b"), "http://example.com:8080/a%20b");
  assert.equal(normalizeNavUrl("https://münchen.de/"), "https://xn--mnchen-3ya.de/");
  assert.equal(normalizeNavUrl("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeNavUrl("about:blank"), "about:blank");
  bad({ type: "nav.go", targetId: TID, url: "javascript:1" }, "bad_url");
  bad({ type: "tab.new", url: "data:text/html,x" }, "bad_url");
});

test("daemon messages are rebuilt for viewers; ready, exit and unknown types never pass", () => {
  assert.equal(toViewerMessage({ type: "ready", port: 1, token: "secret" }), null);
  assert.equal(toViewerMessage({ type: "exit" }), null);
  assert.equal(toViewerMessage({ type: "bogus" }), null);
  assert.equal(toViewerMessage(null), null);
  assert.deepEqual(toViewerMessage({ type: "frame", n: 3, targetId: TID, jpeg: "QQ==", w: 800, h: 600, scale: 2, token: "x" }), { type: "frame", n: 3, targetId: TID, jpeg: "QQ==", w: 800, h: 600, scale: 2 });
  assert.equal(toViewerMessage({ type: "frame", n: -1, targetId: TID, jpeg: "x", w: 1, h: 1, scale: 1 }), null);
  assert.equal(toViewerMessage({ type: "frame", n: 1, targetId: "bad id", jpeg: "x", w: 1, h: 1, scale: 1 }), null);
  const tabs = toViewerMessage({ type: "tabs", tabs: [{ targetId: TID, title: "T".repeat(500), url: "https://a.test", opener: "agent", cookie: "c" }, { targetId: "bad id" }, 5, null, { targetId: TID, opener: "weird" }] });
  assert.equal(tabs.tabs.length, 2);
  assert.equal(tabs.tabs[0].title.length, 300);
  assert.deepEqual(Object.keys(tabs.tabs[0]).sort(), ["opener", "targetId", "title", "url"]);
  assert.equal(tabs.tabs[1].opener, "user");
  assert.deepEqual(toViewerMessage({ type: "error", code: "no_target", message: "leaky" }), { type: "error", code: "no_target" });
  assert.deepEqual(toViewerMessage({ type: "error", code: "Bad Code!" }), { type: "error", code: "failed" });
  assert.deepEqual(toViewerMessage({ type: "clients", agents: 2 }), { type: "clients", agents: 2 });
  assert.equal(toViewerMessage({ type: "clients", agents: -1 }), null);
});

test("JsonLines splits across chunks, skips blank lines and drops an oversize line without buffering it", () => {
  const lines = []; let overflow = 0;
  const l = new JsonLines((x) => lines.push(x), () => overflow++, 32);
  l.push('{"a":1}\n{"b"'); l.push(':2}\n\n');
  l.push("x".repeat(100)); l.push("y".repeat(100) + "\n");
  l.push('{"c":3}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(overflow, 1);
  const split = [];
  const m = new JsonLines((x) => split.push(x));
  const bytes = Buffer.from('{"t":"é😀"}\n');
  m.push(bytes.subarray(0, 8)); m.push(bytes.subarray(8));
  assert.equal(JSON.parse(split[0]).t.length >= 1, true);
});

test("RateWindow allows `limit` per window and recovers in the next one", () => {
  let now = 1000;
  const r = new RateWindow(3, 1000, () => now);
  assert.deepEqual([r.allow(), r.allow(), r.allow(), r.allow(), r.allow()], [true, true, true, false, false]);
  now += 999; assert.equal(r.allow(), false);
  now += 1; assert.equal(r.allow(), true);
});
