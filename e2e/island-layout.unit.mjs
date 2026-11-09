// Run: node --experimental-strip-types --test e2e/island-layout.unit.mjs  (controller logic, no browser needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIslandLayoutController, ISLAND_MORPH_MS } from '../src/lib/island-layout.ts';

function harness() {
  let now = 0; const jobs = []; const applied = [];
  const clock = { set: (job, delay) => { const j = { job, at: now + delay, id: jobs.length }; jobs.push(j); return j; }, clear: j => { j.dead = true; } };
  const advance = ms => { now += ms; for (const j of jobs) if (!j.dead && !j.done && j.at <= now) { j.done = true; j.job(); } };
  return { c: createIslandLayoutController(l => { applied.push(l); }, clock), applied, advance };
}

test('growth of an expanded island applies immediately; shrinks wait for the morph and coalesce', () => {
  const { c, applied, advance } = harness();
  c.request({ expanded: true, height: 300, pinned: false });
  c.request({ expanded: true, height: 360, pinned: false });
  assert.equal(applied.length, 2, 'growth is never delayed');
  c.request({ expanded: true, height: 340, pinned: false });
  c.request({ expanded: true, height: 320, pinned: false });
  assert.equal(applied.length, 2);
  advance(ISLAND_MORPH_MS);
  assert.equal(applied.length, 3);
  assert.equal(applied[2].height, 320);
});

test('field comparison ignores key order', () => {
  const { c, applied } = harness();
  c.request({ expanded: true, height: 300, pinned: false });
  c.request({ pinned: false, height: 300, expanded: true });
  assert.equal(applied.length, 1);
});

test('collapse waits for the CSS morph and a re-expand cancels it', () => {
  const { c, applied, advance } = harness();
  c.request({ expanded: true, height: 300, pinned: false });
  c.request({ expanded: false, height: 40, pinned: false });
  advance(ISLAND_MORPH_MS - 1);
  assert.equal(applied.length, 1);
  c.request({ expanded: true, height: 300, pinned: false });
  advance(1000);
  assert.equal(applied.length, 1);
  c.request({ expanded: false, height: 40, pinned: false });
  advance(ISLAND_MORPH_MS);
  assert.deepEqual(applied.at(-1), { expanded: false, height: 40, pinned: false });
});

test('reduced motion applies every change immediately', () => {
  const { c, applied } = harness();
  c.request({ expanded: true, height: 300, pinned: false }, true);
  c.request({ expanded: true, height: 320, pinned: false }, true);
  c.request({ expanded: false, height: 40, pinned: false }, true);
  assert.equal(applied.length, 3);
});

const tick = () => new Promise(r => setImmediate(r));

test('nativeReady: false until the resize resolved, true again for a re-expand during the pending shrink', async () => {
  const { c, applied, advance } = harness();
  assert.equal(c.nativeReady(300), false, 'collapsed window is never ready');
  c.request({ expanded: true, height: 300, pinned: false });
  assert.equal(c.nativeReady(300), false, 'resize requested but not confirmed yet');
  await tick();
  assert.equal(c.nativeReady(300), true);
  assert.equal(c.nativeReady(320), false, 'window is shorter than the card needs');
  c.request({ expanded: false, height: 40, pinned: false });
  advance(ISLAND_MORPH_MS - 100);
  assert.equal(c.nativeReady(300), true, 'shrink still pending: window is still big');
  c.request({ expanded: true, height: 300, pinned: false });
  assert.equal(applied.length, 1, 're-expand during the pending shrink issues no native call');
  assert.equal(c.nativeReady(300), true, 'so the capsule can open immediately');
  advance(1000);
  assert.equal(applied.length, 1, 'the cancelled shrink never fires');
});

test('nativeReady: false once the shrink was issued (in flight) and until the next resize is confirmed', async () => {
  const { c, advance } = harness();
  c.request({ expanded: true, height: 300, pinned: false });
  await tick();
  c.request({ expanded: false, height: 40, pinned: false });
  advance(ISLAND_MORPH_MS);
  assert.equal(c.nativeReady(300), false, 'native window is collapsing');
  await tick();
  c.request({ expanded: true, height: 300, pinned: false });
  assert.equal(c.nativeReady(300), false, 'growth not confirmed yet: wait for the round trip');
  await tick();
  assert.equal(c.nativeReady(300), true);
});

test('reset forgets the confirmed window', async () => {
  const { c } = harness();
  c.request({ expanded: true, height: 300, pinned: false });
  await tick();
  c.reset();
  assert.equal(c.nativeReady(300), false);
});
