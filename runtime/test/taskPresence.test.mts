import test from "node:test";
import assert from "node:assert/strict";
import { expireStaleCursors } from "../dist/taskPresence.js";

test("stale cursors expire once while their task socket stays subscribed", () => {
  const peer = { activeAt: 1_000, cursorVisible: true };
  const peers = new Set([peer]);

  assert.deepEqual(expireStaleCursors(peers, 16_001), [peer]);
  assert.equal(peer.cursorVisible, false);
  assert.equal(peers.has(peer), true);
  assert.deepEqual(expireStaleCursors(peers, 21_001), []);

  peer.activeAt = 21_002;
  peer.cursorVisible = true;
  assert.deepEqual(expireStaleCursors(peers, 21_003), []);
  assert.equal(peers.has(peer), true);
});
