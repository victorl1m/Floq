import test from "node:test";
import assert from "node:assert/strict";
import { PortRequests, type PortRequestFrame } from "../dist/portRequests.js";

const input = { sessionId: "s1", agentName: "Builder", port: 3000, protocol: "http", purpose: "preview the app" };

test("allow resolves accepted and pushes request + resolved frames", async () => {
  const requests = new PortRequests({ timeoutMs: 5_000 });
  const frames: PortRequestFrame[] = [];
  requests.subscribe("u1", (frame) => frames.push(frame));
  const pending = requests.request("u1", input);
  assert.equal(frames[0].type, "port-request");
  const view = requests.list("u1")[0];
  assert.equal(view.port, 3000);
  assert.ok(view.remainingMs > 0 && view.remainingMs <= 5_000);
  assert.equal(requests.list("u2").length, 0);
  requests.resolve("u1", view.id, { decision: "allow" });
  const outcome = await pending.promise;
  assert.equal(outcome.status, "accepted");
  assert.match(outcome.message, /localhost:3000/);
  assert.deepEqual(frames[1], { type: "port-request-resolved", id: view.id, sessionId: "s1", status: "accepted" });
  assert.equal(requests.list("u1").length, 0);
  assert.throws(() => requests.resolve("u1", view.id, { decision: "allow" }), /no longer pending/);
});

test("deny returns 'user denied'", async () => {
  const requests = new PortRequests();
  const pending = requests.request("u1", input);
  requests.resolve("u1", requests.list("u1")[0].id, { decision: "deny" });
  assert.deepEqual((await pending.promise).message, "user denied");
});

test("the server enforces the deadline and cleans up", async () => {
  const requests = new PortRequests({ timeoutMs: 40 });
  const frames: PortRequestFrame[] = [];
  requests.subscribe("u1", (frame) => frames.push(frame));
  const pending = requests.request("u1", input);
  const outcome = await pending.promise;
  assert.equal(outcome.status, "timeout");
  assert.match(outcome.message, /request cancelled/);
  assert.equal(requests.list("u1").length, 0);
  assert.equal(frames.at(-1)?.type, "port-request-resolved");
  // A late Allow cannot revive it.
  assert.throws(() => requests.resolve("u1", (frames[0] as { request: { id: string } }).request.id, { decision: "allow" }), /no longer pending/);
});

test("the default deadline is 60 seconds", () => {
  const requests = new PortRequests();
  const pending = requests.request("u1", input);
  assert.equal(requests.list("u1")[0].timeoutMs, 60_000);
  pending.abandon();
});

test("validates the port and protocol", () => {
  const requests = new PortRequests({ isDenied: (port) => port === 8787 });
  for (const port of [0, 65536, -1, 3000.5, "3000", null]) assert.throws(() => requests.request("u1", { ...input, port }), /port must be/);
  assert.throws(() => requests.request("u1", { ...input, port: 8787 }), /belongs to Floq/);
  assert.throws(() => requests.request("u1", { ...input, protocol: "ftp" }), /protocol/);
  assert.equal(requests.list("u1").length, 0);
});

test("privileged ports are flagged, never auto-approved", () => {
  const requests = new PortRequests();
  const pending = requests.request("u1", { ...input, port: 80 });
  assert.equal(requests.list("u1")[0].privileged, true);
  assert.equal(requests.list("u1").length, 1);
  pending.abandon();
});

test("duplicate requests for the same port share one decision; other ports queue separately", async () => {
  const requests = new PortRequests();
  const a = requests.request("u1", input);
  const b = requests.request("u1", input);
  const c = requests.request("u1", { ...input, port: 4000 });
  assert.equal(requests.list("u1").length, 2);
  requests.resolve("u1", requests.list("u1").find((r) => r.port === 3000)!.id, { decision: "allow" });
  assert.equal((await a.promise).status, "accepted");
  assert.equal((await b.promise).status, "accepted");
  c.abandon();
  assert.equal(requests.list("u1").length, 0);
});

test("one abandoned waiter keeps the request; the last one cancels it", async () => {
  const requests = new PortRequests();
  const a = requests.request("u1", input);
  const b = requests.request("u1", input);
  a.abandon();
  assert.equal(requests.list("u1").length, 1);
  b.abandon();
  assert.equal(requests.list("u1").length, 0);
});

test("session end cancels its waiters", async () => {
  const requests = new PortRequests();
  const pending = requests.request("u1", input);
  const other = requests.request("u1", { ...input, sessionId: "s2" });
  requests.cancelSession("s1");
  assert.equal((await pending.promise).status, "cancelled");
  assert.equal(requests.list("u1").length, 1);
  other.abandon();
});

test("a liveness check cancels requests of a vanished session", async () => {
  let alive = true;
  const requests = new PortRequests({ isAlive: () => alive, livenessMs: 10 });
  const pending = requests.request("u1", input);
  alive = false;
  assert.equal((await pending.promise).status, "cancelled");
});

test("client-side failure to open is reported to the agent", async () => {
  const requests = new PortRequests();
  const pending = requests.request("u1", input);
  requests.resolve("u1", requests.list("u1")[0].id, { decision: "error", message: "address in use" });
  const outcome = await pending.promise;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.message, /address in use/);
});

test("limits pending requests per session", () => {
  const requests = new PortRequests();
  for (let port = 3000; port < 3005; port++) requests.request("u1", { ...input, port });
  assert.throws(() => requests.request("u1", { ...input, port: 3005 }), /Too many/);
});
