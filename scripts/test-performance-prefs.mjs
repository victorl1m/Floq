import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};
globalThis.window = new EventTarget();

const prefs = await import('../src/lib/prefs.ts');

test('performance presets resolve to bounded per-terminal history limits', () => {
  assert.equal(prefs.effectiveScrollback({ mode: 'balanced', scrollback: 10_000 }), 10_000);
  assert.equal(prefs.effectiveScrollback({ mode: 'low-memory', scrollback: 10_000 }), 2_500);
  assert.equal(prefs.effectiveScrollback({ mode: 'custom', scrollback: 15_000 }), 15_000);
  assert.equal(prefs.effectiveScrollback({ mode: 'custom', scrollback: 2_500 }), 3_000);
});

test('automatic profile uses only the coarse device-memory hint and falls back safely', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { deviceMemory: 4 } });
  assert.equal(prefs.recommendedScrollback(), 2_500);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  assert.equal(prefs.recommendedScrollback(), 3_000);
  if (original) Object.defineProperty(globalThis, 'navigator', original);
  else delete globalThis.navigator;
});

test('persisted performance values are validated and background polling is bounded', () => {
  localStorage.setItem('floq.performance', JSON.stringify({ mode: 'custom', scrollback: 999_999, warmTerminals: 99, reduceMotion: true }));
  assert.deepEqual(prefs.loadPerformancePrefs(), {
    mode: 'custom', scrollback: 20_000, warmTerminals: 6, reduceMotion: true, smoothTerminalScrolling: false, reduceBackgroundRefresh: false,
  });
  assert.equal(prefs.runtimePollInterval(false, true), 5_000);
  assert.equal(prefs.runtimePollInterval(true, true), 30_000);
  assert.equal(prefs.runtimePollInterval(true, false), 5_000);
});
