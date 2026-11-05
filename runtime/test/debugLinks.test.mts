import test from "node:test";
import assert from "node:assert/strict";
import { DebugLinkTracker, MAX_DEBUG_LINKS, matchDebugLine, stripAnsi, visibleDebugLinks } from "../dist/debugLinks.js";

// Real `flutter run -d web-server --web-hostname 127.0.0.1` output (Flutter 3.24), the VM service / DevTools lines after a browser connects.
const FLUTTER_WEB = [
  "Launching lib/main.dart on Web Server in debug mode...",
  "Waiting for connection from debug service on Web Server...         14.9s",
  "lib/main.dart is being served at http://127.0.0.1:41235",
  "The web-server device requires the Dart Debug Chrome extension for debugging. Consider using the Chrome or Edge devices for an improved development workflow.",
  "",
  "Debug service listening on ws://127.0.0.1:38457/xGxqzZ5Kp2E=/ws",
  "A Dart VM Service on Web Server is available at: http://127.0.0.1:38457/xGxqzZ5Kp2E=",
  "The Flutter DevTools debugger and profiler on Web Server is available at: http://127.0.0.1:9101?uri=http://127.0.0.1:38457/xGxqzZ5Kp2E=",
  "",
].join("\r\n");

// Real Vite 5 output as `npm run dev` prints it in a Tauri template, with its colors.
const VITE = "\r\n  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.2\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\r\n\r\n" +
  "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m1420\x1b[22m/\x1b[39m\r\n" +
  "  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: http://192.168.1.20:1420/\r\n";

test("Flutter web-server output yields preview, VM service and DevTools links", () => {
  const tracker = new DebugLinkTracker();
  tracker.feed(FLUTTER_WEB, 1000);
  // The long DevTools line is the last one: it waits a moment for a possible wrapped continuation, then counts as-is.
  assert.equal(tracker.links(1500).length, 2);
  const links = tracker.links(2000);
  assert.deepEqual(links.map((l) => [l.kind, l.url, l.port, l.label]), [
    ["preview", "http://127.0.0.1:41235/", 41235, "Flutter web app"],
    ["vm-service", "http://127.0.0.1:38457/xGxqzZ5Kp2E=", 38457, "Dart VM service"],
    ["devtools", "http://127.0.0.1:9101/?uri=http://127.0.0.1:38457/xGxqzZ5Kp2E=", 9101, "Flutter DevTools"],
  ]);
  assert.deepEqual(links[2].extraPorts, [38457]);
  assert.equal(links[0].detectedAt, 1000);
});

test("Linux desktop and URL-encoded DevTools lines", () => {
  const vm = matchDebugLine("A Dart VM Service on Linux is available at: http://127.0.0.1:37443/9kwVKa8Qx3k=/");
  assert.equal(vm?.kind, "vm-service");
  assert.equal(vm?.port, 37443);
  const dt = matchDebugLine("The Flutter DevTools debugger and profiler on Linux is available at: http://127.0.0.1:9100?uri=http%3A%2F%2F127.0.0.1%3A37443%2F9kwVKa8Qx3k%3D%2F");
  assert.equal(dt?.kind, "devtools");
  assert.deepEqual(dt?.extraPorts, [37443]);
  const old = matchDebugLine("An Observatory debugger and profiler on Linux is available at: http://127.0.0.1:40111/abc=/");
  assert.equal(old?.kind, "vm-service");
});

test("Vite Local line with ANSI colors, Network line ignored", () => {
  const tracker = new DebugLinkTracker();
  tracker.feed(VITE);
  assert.deepEqual(tracker.links().map((l) => [l.kind, l.url, l.port, l.label]), [["preview", "http://127.0.0.1:1420/", 1420, "Dev server"]]);
});

test("lines split across PTY chunks are joined", () => {
  const tracker = new DebugLinkTracker();
  tracker.feed("lib/main.dart is being ser");
  tracker.feed("ved at http://127.0.0.1:41");
  assert.equal(tracker.links().length, 0);
  tracker.feed("235\r\n");
  assert.equal(tracker.links()[0]?.url, "http://127.0.0.1:41235/");
});

test("a URL hard-wrapped by the agent TUI is joined with its continuation line", () => {
  const tracker = new DebugLinkTracker();
  tracker.feed("  ⎿  The Flutter DevTools debugger and profiler on Web Server is available at: http://127.0.0.1:9101?uri=http://127.0.0.1:384\r\n");
  assert.equal(tracker.links(Date.now()).length, 0); // waits for the next line
  tracker.feed("     57/xGxqzZ5Kp2E=\r\n     Debug service listening\r\n");
  assert.deepEqual(tracker.links().map((l) => [l.url, l.extraPorts]), [["http://127.0.0.1:9101/?uri=http://127.0.0.1:38457/xGxqzZ5Kp2E=", [38457]]]);
  // A normal next line is not glued on.
  const plain = new DebugLinkTracker();
  plain.feed("The Flutter DevTools debugger and profiler on Linux is available at: http://127.0.0.1:9100?uri=http://127.0.0.1:40000/a=/\nFlutter run key commands.\n");
  assert.equal(plain.links()[0]?.url, "http://127.0.0.1:9100/?uri=http://127.0.0.1:40000/a=/");
});

test("only loopback URLs with a port, rebuilt on 127.0.0.1; credentials rejected", () => {
  assert.equal(matchDebugLine("lib/main.dart is being served at http://10.0.0.5:8080"), null);
  assert.equal(matchDebugLine("  Local:   http://evil.example.com:3000/"), null);
  assert.equal(matchDebugLine("  Local:   http://localhost/"), null);
  assert.equal(matchDebugLine("  Local:   http://user:pw@localhost:3000/"), null);
  assert.equal(matchDebugLine("  Local:   http://0.0.0.0:3000/")?.url, "http://127.0.0.1:3000/");
  assert.equal(matchDebugLine("  Local:   http://[::1]:3000/app/?x=1#h")?.url, "http://127.0.0.1:3000/app/?x=1#h");
  assert.equal(matchDebugLine("  Local:   http://localhost:5173/base/")?.url, "http://127.0.0.1:5173/base/");
  assert.equal(matchDebugLine("  Local:   http://localhost:3000/.")?.url, "http://127.0.0.1:3000/");
  assert.equal(matchDebugLine("some unrelated http://localhost:3000 text"), null);
});

test("deduplicated by url, capped, cleared", () => {
  const tracker = new DebugLinkTracker();
  tracker.feed(VITE);
  tracker.feed(VITE); // TUI redraws repeat lines
  assert.equal(tracker.links().length, 1);
  for (let i = 0; i < MAX_DEBUG_LINKS + 5; i++) tracker.feed(`  Local:   http://localhost:${3000 + i}/\n`);
  const links = tracker.links();
  assert.equal(links.length, MAX_DEBUG_LINKS);
  assert.equal(links.at(-1)?.port, 3000 + MAX_DEBUG_LINKS + 4);
  tracker.clear();
  assert.deepEqual(tracker.links(), []);
});

test("stripAnsi turns cursor moves into separators", () => {
  assert.equal(stripAnsi("a\x1b[3Cb"), "a   b");
  assert.equal(stripAnsi("\x1b]0;title\x07x\x1b[2Ky\x1b[1Az"), "xy\nz");
});

test("visible links need every port listening, newest first", () => {
  const tracker = new DebugLinkTracker();
  tracker.feed(FLUTTER_WEB, 1000);
  tracker.feed(VITE, 2000);
  const all = tracker.links(3000);
  assert.deepEqual(visibleDebugLinks(all, []), []);
  assert.deepEqual(visibleDebugLinks(all, [{ port: 41235, address: "127.0.0.1" }, { port: 9101, address: "127.0.0.1" }]).map((l) => l.port), [41235]);
  assert.deepEqual(
    visibleDebugLinks(all, [41235, 9101, 38457, 1420].map((port) => ({ port, address: "127.0.0.1" }))).map((l) => l.port),
    [1420, 41235, 38457, 9101],
  );
});
