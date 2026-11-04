import test from 'node:test';
import assert from 'node:assert/strict';

const { runViewTransition } = await import('../src/lib/view-transition.ts');

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installDocument(startViewTransition, { reducedClass = false, systemReduced = false } = {}) {
  const doc = {
    documentElement: { classList: { contains: (name) => name === 'floq-reduced-motion' && reducedClass } },
    body: { classList: { contains: () => false } },
    startViewTransition,
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: systemReduced }) },
  });
  return doc;
}

function restoreGlobals() {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete globalThis.window;
}

test('falls back to one direct update when the API is unavailable', () => {
  try {
    installDocument(undefined);
    let updates = 0;
    runViewTransition(() => updates++);
    assert.equal(updates, 1);
  } finally { restoreGlobals(); }
});

test('respects app and OS reduced-motion preferences without starting a transition', () => {
  for (const prefs of [{ reducedClass: true }, { systemReduced: true }]) {
    let starts = 0;
    let updates = 0;
    try {
      installDocument(() => { starts++; }, prefs);
      runViewTransition(() => updates++);
      assert.equal(starts, 0);
      assert.equal(updates, 1);
    } finally { restoreGlobals(); }
  }
});

test('flushes one update and skips an in-flight transition before rapid navigation', async () => {
  const transitions = [];
  const start = (update) => {
    let resolveFinished;
    const transition = {
      ready: Promise.resolve(),
      finished: new Promise((resolve) => { resolveFinished = resolve; }),
      skipped: 0,
      skipTransition() { this.skipped++; },
      resolveFinished,
    };
    update();
    transition.resolveFinished = resolveFinished;
    transitions.push(transition);
    return transition;
  };
  try {
    installDocument(start);
    let updates = 0;
    runViewTransition(() => updates++);
    runViewTransition(() => updates++);
    assert.equal(updates, 2);
    assert.equal(transitions[0].skipped, 1);
    transitions.forEach((transition) => transition.resolveFinished());
    await Promise.resolve();
  } finally { restoreGlobals(); }
});

test('does not repeat an update when transition setup throws after invoking its callback', () => {
  try {
    installDocument((update) => { update(); throw new Error('capture failed'); });
    let updates = 0;
    runViewTransition(() => updates++);
    assert.equal(updates, 1);
  } finally { restoreGlobals(); }
});
