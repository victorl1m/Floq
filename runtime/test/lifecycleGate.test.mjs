import test from "node:test";
import assert from "node:assert/strict";
import { CapacityReservations, ClosingGate, coalesce } from "../dist/lifecycleGate.js";

test("capacity reservations allow parallel work only up to the remaining session limit", async () => {
  const gate = new CapacityReservations();
  const one = gate.reserve("user", 1, 3);
  const two = gate.reserve("user", 1, 3);
  assert.ok(one);
  assert.ok(two);
  assert.equal(gate.reserve("user", 1, 3), null);
  assert.ok(gate.reserve("other-user", 0, 1));
  one();
  assert.ok(gate.reserve("user", 1, 3));
  two();
});

test("a failed lifecycle operation releases capacity and the same key can retry", async () => {
  const capacity = new CapacityReservations();
  const release = capacity.reserve("user", 0, 1);
  assert.ok(release);
  try {
    throw new Error("launch failed");
  } catch (error) {
    assert.match(error.message, /launch failed/);
  } finally {
    release();
  }
  assert.ok(capacity.reserve("user", 0, 1));

  const pending = new Map();
  await assert.rejects(coalesce(pending, "user:session", async () => { throw new Error("resume failed"); }), /resume failed/);
  assert.equal(await coalesce(pending, "user:session", async () => "resumed"), "resumed");
});

test("same-user provider login requests share one in-flight start", async () => {
  const pending = new Map();
  let starts = 0;
  let finish;
  const start = () => coalesce(pending, "user:claude", async () => {
    starts++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = start();
  const duplicate = start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  finish({ id: "login-session" });
  assert.deepEqual(await first, { id: "login-session" });
  assert.deepEqual(await duplicate, { id: "login-session" });
});

test("closing the runtime lifecycle gate rejects work after an async wait before spawn", async () => {
  const gate = new ClosingGate();
  let release;
  let spawned = false;
  const launch = async () => {
    await new Promise((resolve) => { release = resolve; });
    gate.assertOpen(new Error("runtime is shutting down"));
    spawned = true;
  };
  const pending = launch();
  gate.close();
  release();
  await assert.rejects(pending, /shutting down/);
  assert.equal(spawned, false);
  gate.close();
  assert.throws(() => gate.assertOpen(new Error("runtime is shutting down")), /shutting down/);
});
