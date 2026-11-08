import test from 'node:test';
import assert from 'node:assert/strict';
import { createIslandLayoutController } from '../../src/lib/island-layout.ts';

function fixture() {
  let now = 0, next = 0;
  const jobs = new Map(), frames = [];
  const controller = createIslandLayoutController(frame => { frames.push(frame); }, {
    set: (job, delay) => { const id = ++next; jobs.set(id, { job, at: now + delay }); return id; },
    clear: id => jobs.delete(id),
  });
  return { controller, frames, tick(ms) {
    now += ms;
    for (const [id, entry] of [...jobs]) if (entry.at <= now) { jobs.delete(id); entry.job(); }
  } };
}
const expanded = height => ({ expanded: true, height, pinned: false });
const collapsed = { expanded: false, height: 40, pinned: false };

test('native host grows immediately but stays large until the closing morph finishes', () => {
  const f = fixture();
  f.controller.request(expanded(300));
  assert.deepEqual(f.frames, [expanded(300)]);
  f.controller.request(collapsed);
  f.tick(319); assert.equal(f.frames.length, 1);
  f.tick(1); assert.deepEqual(f.frames[1], collapsed);
});

test('reopening cancels a pending shrink instead of clipping the reopened content', () => {
  const f = fixture();
  f.controller.request(expanded(300)); f.controller.request(collapsed);
  f.tick(100); f.controller.request(expanded(300)); f.tick(500);
  assert.ok(f.frames.every(frame => frame.expanded));
  assert.deepEqual(f.frames.at(-1), expanded(300));
});

test('shorter next requests wait for the shell resize, longer requests reserve space immediately', () => {
  const f = fixture();
  f.controller.request(expanded(400)); f.controller.request(expanded(160));
  f.tick(319); assert.equal(f.frames.length, 1);
  f.tick(1); assert.deepEqual(f.frames.at(-1), expanded(160));
  f.controller.request(expanded(480)); assert.deepEqual(f.frames.at(-1), expanded(480));
});

test('reduced motion applies final bounds immediately and disposal cancels pending work', () => {
  const f = fixture();
  f.controller.request(expanded(300)); f.controller.request(collapsed, true);
  assert.deepEqual(f.frames.at(-1), collapsed);
  f.controller.request(expanded(300)); f.controller.request(collapsed);
  f.controller.dispose(); f.tick(500);
  assert.deepEqual(f.frames.at(-1), expanded(300));
});

test('enabling reduced motion during closing flushes the pending final bounds', () => {
  const f = fixture();
  f.controller.request(expanded(300)); f.controller.request(collapsed);
  f.controller.request(collapsed, true);
  assert.deepEqual(f.frames.at(-1), collapsed);
});

test('reset for a hidden window cancels stale callbacks and resends identical layout on activation', () => {
  const f = fixture();
  f.controller.request(expanded(300)); f.controller.request(collapsed);
  f.controller.reset(); f.tick(500); assert.equal(f.frames.length, 1);
  f.controller.request(expanded(300)); assert.equal(f.frames.length, 2);
});
