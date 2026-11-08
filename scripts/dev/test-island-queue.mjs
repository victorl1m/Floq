import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import * as contract from '../../src/lib/island-contract.ts';

// Render the actual component and its DecisionCard, using deterministic hook/event/clock
// adapters. Intents are captured at the Tauri boundary; only snapshots acknowledge actions.
const source = fs.readFileSync(new URL('../../src/components/island/island-root.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const decision = (id, questions = ['q']) => ({ kind: 'decision', id, createdAt: '2026-01-01', decision: {
  id, sessionName: id, source: 'native', answerMode: 'structured',
  questions: questions.map(q => ({ id: q, header: id, question: `Question ${q}`, options: [{ id: 'o', label: 'Option' }], multiSelect: false, allowText: true })),
} });
const approval = id => ({ kind: 'approval', id, createdAt: '2026-01-01', approval: { id, action: id, detail: '', requester: {}, target: {} } });
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');

async function mount(items) {
  const slots = [], pendingEffects = [], listeners = new Map(), timers = new Map(), intents = [];
  let cursor = 0, dirty = false, root, time = 0, timerId = 0, revision = 1, failDispatch = false;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        previous?.cleanup?.();
        slots[index] = { deps };
        pendingEffects.push(() => { slots[index].cleanup = callback(); });
      }
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const schedule = (fn, delay = 0, interval = false) => {
    const id = ++timerId; timers.set(id, { fn, at: time + delay, interval: interval ? delay : 0 }); return id;
  };
  const require = name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '@/lib/island-contract') return contract;
    if (name === './use-island-layout') return { useIslandLayout: ({ expanded }) => ({ height: expanded ? 160 : 40, expanded, width: 440, contentMaxHeight: 158 }) }; // Geometry has its own controller tests.
    if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => {
      if (command === 'island_intent' && args.intent.type !== 'ready') {
        intents.push(args.intent);
        if (failDispatch) { failDispatch = false; throw new Error('dispatch failed'); }
      }
    } };
    if (name === '@tauri-apps/api/event') return { listen: async (event, handler) => {
      listeners.set(event, handler); return () => listeners.delete(event);
    } };
    if (name === '@/lib/approval-format') return { riskLevel: () => 'low', RISK_LABEL: { low: 'Low risk' }, actorLabel: () => 'Agent' };
    return new Proxy({}, { get: () => () => null });
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    require, exports,
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
  });
  const initialSnapshot = { epoch: 'test', revision, connected: true, busy: [], items };
  function render() {
    let turns = 0;
    do {
      assert.ok(++turns < 30, 'hook updates settle'); dirty = false; cursor = 0;
      root = exports.default({ initialSnapshot, initialExpanded: true });
      for (const effect of pendingEffects.splice(0)) effect();
    } while (dirty);
  }
  async function flush() { await new Promise(setImmediate); render(); }
  const nodes = () => {
    function walk(node) {
      if (Array.isArray(node)) return node.flatMap(walk);
      if (!node || typeof node !== 'object') return [];
      if (typeof node.type === 'function') return walk(node.type(node.props));
      return [node, ...walk(node.props?.children)];
    }
    return walk(root);
  };
  const find = predicate => nodes().find(predicate);
  const button = label => find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label));
  const click = label => { const b = button(label); assert.ok(b, `${label} exists`); if (!b.props.disabled) b.props.onClick(); render(); };
  render(); await flush();
  return {
    intents, button, find, click, flush,
    current: () => find(node => node.props?.className === 'island-title-command')?.props.children ?? find(node => node.type === 'textarea')?.props.value,
    draft: (value, index = 0) => { nodes().filter(node => node.type === 'textarea')[index].props.onChange({ target: { value } }); render(); },
    values: () => nodes().filter(node => node.type === 'textarea').map(node => node.props.value),
    outcome: () => !!find(node => node.props?.className?.includes('island-result-label')),
    expanded: () => root?.props.className.includes(' expanded'),
    collapse: () => { root.props.onKeyDown({ key: 'Escape' }); render(); },
    expand: () => { root.props.onMouseEnter(); render(); },
    failDispatch: () => { failDispatch = true; },
    snapshot: async (nextItems, busy = [], error) => {
      listeners.get('island:snapshot')({ payload: { ...initialSnapshot, revision: ++revision, items: nextItems, busy, error } });
      render(); await flush();
    },
    tick: async ms => {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; time = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        timer.fn(); render();
      }
      time = end; await flush();
    },
  };
}

test('A/B drafts survive navigation, snapshots and collapse; ack opens next immediately, only final ack shows result', async () => {
  const a = decision('a'), b = decision('b'); const ui = await mount([a, b]);
  ui.draft('draft A'); ui.click('Next request'); ui.draft('draft B');
  ui.click('Previous request'); assert.deepEqual(ui.values(), ['draft A']);
  ui.collapse(); ui.expand(); await ui.snapshot([a, b]);
  assert.deepEqual(ui.values(), ['draft A']);
  ui.click('Send');
  assert.equal(ui.intents[0].id, 'a'); assert.equal(ui.intents[0].answers[0].text, 'draft A');
  await ui.snapshot([a, b], ['a']); await ui.snapshot([a, b]);
  assert.equal(ui.outcome(), false); assert.equal(ui.expanded(), true);
  assert.deepEqual(ui.values(), ['draft B']);
  // A may remain in main-window snapshots during deferred empty-queue synchronization.
  await ui.snapshot([a, b]);
  assert.deepEqual(ui.values(), ['draft B']); assert.equal(ui.button('Next request'), undefined);
  ui.click('Send');
  assert.equal(ui.intents[1].id, 'b'); assert.equal(ui.intents[1].answers[0].text, 'draft B');
  await ui.snapshot([a, b], ['b']); await ui.snapshot([a, b]);
  assert.equal(ui.outcome(), true); await ui.tick(3000);
  assert.equal(ui.outcome(), false); assert.equal(ui.expanded(), undefined);
});

test('API error keeps current and drafts for retry; while busy cycling and duplicate submit are disabled', async () => {
  const a = decision('a'), b = decision('b'); const ui = await mount([a, b]);
  ui.draft('retry A'); ui.click('Next request'); ui.draft('keep B'); ui.click('Previous request');
  const send = ui.button('Send'), next = ui.button('Next request');
  send.props.onClick(); send.props.onClick(); next.props.onClick(); await ui.flush();
  assert.equal(ui.intents.length, 1);
  assert.equal(ui.button('Next request').props.disabled, true);
  assert.equal(ui.button('Previous request').props.disabled, true);
  ui.click('Next request'); assert.deepEqual(ui.values(), ['retry A']);
  await ui.snapshot([a, b], ['a']); await ui.snapshot([a, b], [], 'API failed');
  assert.deepEqual(ui.values(), ['retry A']); assert.equal(ui.outcome(), false);
  ui.click('Send'); assert.equal(ui.intents.length, 2);
  await ui.snapshot([a, b], ['a']); await ui.snapshot([b]);
  assert.deepEqual(ui.values(), ['keep B']); assert.equal(ui.outcome(), false);
});

test('dispatch failure never removes current or clears its draft', async () => {
  const a = decision('a'), b = decision('b'); const ui = await mount([a, b]);
  ui.draft('not lost'); ui.failDispatch(); ui.click('Send'); await ui.flush();
  assert.deepEqual(ui.values(), ['not lost']); assert.equal(ui.outcome(), false);
  ui.click('Next request'); ui.click('Previous request'); assert.deepEqual(ui.values(), ['not lost']);
});

test('approval advances without intermediate outcome; multi-question DecisionView stays one atomic request', async () => {
  const a = approval('approval'), b = decision('decision', ['q1', 'q2']); const ui = await mount([a, b]);
  ui.click('Accept'); await ui.snapshot([a, b], [a.id]); await ui.snapshot([b]);
  assert.equal(ui.outcome(), false); ui.draft('answer one', 0); ui.draft('answer two', 1); ui.click('Send');
  assert.equal(ui.intents.length, 2);
  assert.equal(ui.intents[1].answers.length, 2); assert.equal(ui.intents[1].id, b.id);
  await ui.snapshot([], []); assert.equal(ui.outcome(), true);
});

test('a new pending request interrupts final outcome without collapsing and completed ids stay filtered', async () => {
  const a = decision('a'), b = decision('b'); const ui = await mount([a]);
  ui.draft('done'); ui.click('Send'); await ui.snapshot([a], ['a']); await ui.snapshot([a]);
  assert.equal(ui.outcome(), true);
  await ui.snapshot([a, b]);
  assert.equal(ui.outcome(), false); assert.equal(ui.expanded(), true); assert.deepEqual(ui.values(), ['']);
  assert.equal(ui.button('Next request'), undefined); await ui.tick(3200);
  assert.equal(ui.expanded(), true); assert.deepEqual(ui.values(), ['']);
});


test('a temporarily absent unsent request retains its draft across snapshots', async () => {
  const a = decision('a'), b = decision('b'); const ui = await mount([a, b]);
  ui.draft('unsent A'); await ui.snapshot([b]); ui.draft('unsent B');
  await ui.snapshot([a, b]); assert.deepEqual(ui.values(), ['unsent A']);
  ui.click('Next request'); assert.deepEqual(ui.values(), ['unsent B']);
});
