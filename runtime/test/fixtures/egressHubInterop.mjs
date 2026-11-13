// Interop fixture for src-tauri/src/egress.rs (`interop_with_the_real_runtime_hub`): the REAL EgressHub behind a bare WebSocket
// server, plus a scripted daemon. argv[2] = port of a TCP echo server the "browser" wants to reach.
// Prints: "PORT <n>" when listening, then "ECHO <text>" once a stream opened through the real Rust client echoed our bytes back.
import { WebSocketServer } from "ws";
import { EgressHub } from "../../dist/browserEgress.js";
import { RecordStream, T, decodeFrame, encodeFrame, encodeOpen, lengthPrefixed } from "../../dist/egressCodec.js";

const echoPort = Number(process.argv[2]);
const hub = new EgressHub({ helloTimeoutMs: 8000 });
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let upSeen = false, got = "";
const records = new RecordStream((r) => {
  const d = decodeFrame(r);
  if (!d.ok) return;
  const f = d.frame;
  if (f.type === T.LINK && f.payload[0] === 1 && !upSeen) {
    upSeen = true;
    daemon.push(lengthPrefixed(encodeFrame(T.OPEN, 1, encodeOpen({ atyp: 1, host: "127.0.0.1", port: echoPort }))));
  } else if (f.type === T.OPENED && f.streamId === 1) {
    if (f.payload[0] !== 0) { console.log("OPENED_FAIL " + f.payload[0]); process.exit(2); }
    daemon.push(lengthPrefixed(encodeFrame(T.DATA, 1, Buffer.from("hello-interop"))));
  } else if (f.type === T.DATA) {
    got += f.payload.toString();
    if (got === "hello-interop") { console.log("ECHO " + got); setTimeout(() => process.exit(0), 50); }
  } else if (f.type === T.RST) { console.log("RST " + f.payload[0]); process.exit(3); }
}, () => undefined);
const daemon = hub.attachDaemon("u", { write: (b) => records.push(b), close: () => undefined });
wss.on("connection", (ws, req) => {
  const peer = hub.attachDesktop("u", { send: (f) => ws.send(f, { binary: true }), close: (c, r) => ws.close(c, r) }, { peerIp: "203.0.113.9" });
  ws.on("message", (d, bin) => peer.onMessage(Buffer.isBuffer(d) ? d : Buffer.from(d), bin));
  ws.on("close", () => peer.onClose());
  void req;
});
wss.on("listening", () => console.log("PORT " + wss.address().port));
setTimeout(() => { console.log("TIMEOUT"); process.exit(4); }, 20000).unref();
