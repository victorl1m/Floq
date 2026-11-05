import test from 'node:test';
import assert from 'node:assert/strict';

const { HeldInput, isMouseReport } = await import('../src/lib/held-input.ts');

test('keystrokes typed while disconnected come back in order', () => {
  const h = new HeldInput();
  assert.ok(h.hold('hel', 0));
  assert.ok(h.hold('lo\r', 10));
  assert.equal(h.size, 6);
  assert.equal(h.take(20), 'hello\r');
  assert.equal(h.size, 0);
  assert.equal(h.take(30), '');
});

test('mouse reports are never held', () => {
  const h = new HeldInput();
  assert.ok(isMouseReport('\x1b[<0;12;5M'));
  assert.ok(!isMouseReport('\x1b[A'));
  assert.equal(h.hold('\x1b[<0;12;5M', 0), false);
  assert.ok(h.hold('\x1b[A', 0), 'arrow keys are held');
  assert.equal(h.take(1), '\x1b[A');
});

test('input past the size cap is dropped and counted', () => {
  const h = new HeldInput(5, 60_000);
  assert.ok(h.hold('abcd', 0));
  assert.equal(h.hold('ef', 1), false);
  assert.equal(h.dropped, 2);
  assert.equal(h.take(2), 'abcd');
});

test('stale input expires instead of landing later', () => {
  const h = new HeldInput(100, 1_000);
  h.hold('old', 0);
  h.hold('new', 900);
  assert.equal(h.take(1_500), 'new');
  assert.equal(h.dropped, 3);
});
