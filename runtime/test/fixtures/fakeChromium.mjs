#!/usr/bin/env node
// A tiny stand-in for chrome-headless-shell: CDP over fds 3 (in) / 4 (out), NUL-delimited JSON. Enough of the protocol for floq-browserd.
// FAKE_CHROMIUM_NEEDS_NO_SANDBOX=1 makes it exit like Chromium does when it has no usable sandbox, unless --no-sandbox is given.
import { createReadStream, createWriteStream } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("Fake Chromium 157.0.0.0"); process.exit(0); }
if (process.env.FAKE_CHROMIUM_NEEDS_NO_SANDBOX === "1" && !args.includes("--no-sandbox")) { console.error("FATAL: No usable sandbox!"); process.exit(1); }
const input = createReadStream(null, { fd: 3 });
const output = createWriteStream(null, { fd: 4 });
const send = (m) => output.write(JSON.stringify(m) + "\0");
let seq = 1;
const targets = new Map();
const sessions = new Map(); // sessionId -> targetId
let autoAttach = false;
const info = (t) => ({ targetId: t.id, type: "page", title: t.title, url: t.url, attached: false });
function addTarget(url) {
  const t = { id: "T" + String(seq++).padStart(15, "0") + "AB", url, title: url === "about:blank" ? "" : "Page", history: [url], index: 0 };
  targets.set(t.id, t);
  send({ method: "Target.targetCreated", params: { targetInfo: info(t) } });
  if (autoAttach) attach(t.id);
  return t;
}
function attach(targetId) {
  const sessionId = "S" + seq++;
  sessions.set(sessionId, targetId);
  send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { ...info(targets.get(targetId)), attached: true }, waitingForDebugger: false } });
  return sessionId;
}
addTarget("about:blank");
let buf = "";
input.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (let i = buf.indexOf("\0"); i >= 0; i = buf.indexOf("\0")) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); }
});
input.on("end", () => process.exit(0));
function handle(m) {
  const reply = (result = {}) => send({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
  const target = m.sessionId ? targets.get(sessions.get(m.sessionId)) : undefined;
  if (m.sessionId && !target && m.method !== "Target.detachFromTarget") return send({ id: m.id, sessionId: m.sessionId, error: { code: -32001, message: "Session with given id not found." } });
  switch (m.method) {
    case "Browser.getVersion": return reply({ product: "HeadlessChrome/157.0.0.0", protocolVersion: "1.3" });
    case "Browser.setDownloadBehavior": return reply();
    case "Browser.close": process.exit(0); return;
    case "Target.setDiscoverTargets": reply(); return;
    case "Target.setAutoAttach":
      if (!m.sessionId) { autoAttach = !!m.params.autoAttach; reply(); if (autoAttach) for (const id of targets.keys()) attach(id); return; }
      return reply();
    case "Target.attachToTarget": { if (!targets.has(m.params.targetId)) return send({ id: m.id, error: { code: -32602, message: "No target with given id found" } }); const sessionId = "S" + seq++; sessions.set(sessionId, m.params.targetId); return reply({ sessionId }); }
    case "Target.detachFromTarget": sessions.delete(m.params.sessionId); return reply();
    case "Target.createTarget": { const t = addTarget(m.params.url || "about:blank"); return reply({ targetId: t.id }); }
    case "Target.closeTarget": { process.stderr.write("CLOSE_TARGET\n"); targets.delete(m.params.targetId); send({ method: "Target.targetDestroyed", params: { targetId: m.params.targetId } }); return reply({ success: true }); }
    case "Target.activateTarget": return reply();
    case "Target.getTargets": return reply({ targetInfos: [...targets.values()].map(info) });
    case "Fetch.enable":
      if (process.env.FAKE_CHROMIUM_FETCH_FAILS === "1") return send({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), error: { code: -32000, message: "Fetch.enable failed" } });
      return reply();
    case "Runtime.runIfWaitingForDebugger": process.stderr.write("RUN_IF_WAITING\n"); return reply();
    case "Page.enable": case "Page.setLifecycleEventsEnabled": return reply();
    case "Page.navigate": {
      target.url = m.params.url; target.title = "Page"; target.history = target.history.slice(0, target.index + 1).concat(m.params.url); target.index++;
      reply({ frameId: "F" });
      send({ method: "Target.targetInfoChanged", params: { targetInfo: info(target) } });
      return;
    }
    case "Page.getNavigationHistory": return reply({ currentIndex: target.index, entries: target.history.map((url, id) => ({ id, url })) });
    case "Page.navigateToHistoryEntry": { target.index = m.params.entryId; target.url = target.history[target.index]; reply(); send({ method: "Target.targetInfoChanged", params: { targetInfo: info(target) } }); return; }
    case "Page.reload": case "Page.stopLoading": return reply();
    case "Page.startScreencast": reply(); send({ method: "Page.screencastFrame", sessionId: m.sessionId, params: { data: "/9j/FAKEJPEG", sessionId: 77, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 } } }); return;
    case "Page.stopScreencast": case "Page.screencastFrameAck": return reply();
    case "Input.dispatchMouseEvent": case "Input.dispatchKeyEvent": case "Input.insertText": process.stderr.write("INPUT " + m.method + " " + JSON.stringify(m.params) + "\n"); return reply();
    case "Runtime.evaluate": return reply({ result: { type: "string", value: "url=" + target.url } });
    default: return send({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), error: { code: -32601, message: m.method + " wasn't found" } });
  }
}
