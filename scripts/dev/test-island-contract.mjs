import test from "node:test";
import assert from "node:assert/strict";

test('empty snapshots wait through reconnects and settle after the grace period', async () => {
  const { deferEmptySnapshot } = await import('../../src/lib/island-contract.ts');
  const active = {epoch:'a', revision:1, connected:true, items:[{id:'a'}], busy:[]};
  const empty = {...active, items:[], connected:false};
  const held = deferEmptySnapshot(active, empty, null, 100);
  assert.deepEqual(held.snapshot.items, active.items);
  assert.equal(held.snapshot.connected, false);
  assert.equal(held.emptySince, 100);
  assert.deepEqual(deferEmptySnapshot(active, empty, 100, 1599).snapshot.items, active.items);
  assert.deepEqual(deferEmptySnapshot(active, empty, 100, 1600).snapshot.items, []);
  assert.equal(deferEmptySnapshot(active, active, 100, 200).emptySince, null);
});
