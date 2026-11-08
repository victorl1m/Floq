import test from "node:test";
import assert from "node:assert/strict";
import { ProjectRefreshCoordinator } from "../../src/lib/runtime/project-refresh.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function options(client, fetch, result, now) {
  return {
    client,
    now: () => now.value,
    isCurrentClient: (value) => value === now.client,
    fetch,
    onStart() {},
    onSuccess(value) { result.push(value); },
    onError(error) { result.push(error); },
    onSettled() {},
  };
}

test("background polls join one slow projects request across multiple poll intervals", async () => {
  const coordinator = new ProjectRefreshCoordinator();
  const pending = deferred();
  const result = [];
  const clock = { value: 100_000, client: "runtime-a" };
  let calls = 0;
  const fetch = () => { calls++; return pending.promise; };
  const first = coordinator.refresh(options(clock.client, fetch, result, clock));
  for (clock.value = 105_000; clock.value <= 130_000; clock.value += 5_000) {
    const joined = coordinator.refresh(options(clock.client, fetch, result, clock));
    assert.equal(joined, first);
  }
  assert.equal(calls, 1);
  pending.resolve(["loaded"]);
  await first;
  assert.deepEqual(result, [["loaded"]]);
});

test("client changes, project mutations, and forced retries invalidate older responses", async () => {
  const coordinator = new ProjectRefreshCoordinator();
  const oldClient = deferred();
  const freshClient = deferred();
  const retry = deferred();
  const result = [];
  const clock = { value: 100_000, client: "runtime-a" };
  const stale = coordinator.refresh(options(clock.client, () => oldClient.promise, result, clock));
  clock.client = "runtime-b";
  const current = coordinator.refresh(options(clock.client, () => freshClient.promise, result, clock));
  oldClient.resolve(["old runtime"]);
  await stale;
  assert.deepEqual(result, []);
  freshClient.resolve(["runtime b"]);
  await current;
  assert.deepEqual(result, [["runtime b"]]);

  clock.value += 10_001;
  const beforeMutation = deferred();
  const pendingMutationRace = coordinator.refresh(options(clock.client, () => beforeMutation.promise, result, clock));
  coordinator.markMutation(clock.value);
  result.push(["created project"]);
  beforeMutation.resolve(["stale list"]);
  await pendingMutationRace;
  assert.deepEqual(result, [["runtime b"], ["created project"]]);

  clock.value += 10_001;
  const oldAttempt = deferred();
  const oldPromise = coordinator.refresh(options(clock.client, () => oldAttempt.promise, result, clock));
  const failedRetry = coordinator.refresh({
    ...options(clock.client, () => retry.promise, result, clock),
    force: true,
  });
  oldAttempt.resolve(["superseded"]);
  await oldPromise;
  retry.reject(new Error("retry failed"));
  await assert.rejects(failedRetry, /retry failed/);
  assert.deepEqual(result.at(-1).message, "retry failed");
});
