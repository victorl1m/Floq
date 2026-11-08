import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createIslandLayoutController } from '../../src/lib/island-layout.ts';

// Execute the real hook/controller; adapt only React scheduling, DOM measurement
// and the native IPC boundary, which cannot run in the Node test process.
function mount() {
  const slots = [], effects = [], jobs = new Map(), calls = [];
  let cursor = 0, dirty = false, value, now = 0, timer = 0, resize;
  const props = { active: true, expanded: false, pinned: false, requestKey: 'a', content: { current: { scrollHeight: 158 } } };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useLayoutEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((entry, i) => !Object.is(entry, previous.deps[i]))) {
        previous?.cleanup?.(); slots[index] = { deps };
        effects.push(() => { slots[index].cleanup = callback(); });
      }
    },
  };
  const clock = {
    set(job, delay) { const id = ++timer; jobs.set(id, { job, at: now + delay }); return id; },
    clear(id) { jobs.delete(id); },
  };
  const exports = {};
  const source = fs.readFileSync(new URL('../../src/components/island/use-island-layout.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return hooks;
      if (name === '@/lib/island-layout') return { createIslandLayoutController: apply => createIslandLayoutController(apply, clock) };
      if (name === '@tauri-apps/api/core') return { invoke: (_command, frame) => {
        if (!frame.expanded) { calls.push({ frame }); return Promise.resolve({ width: 220, height: 40 }); }
        return new Promise(resolve => { calls.push({ frame, resolve: viewport => resolve(viewport ?? { width: 440, height: frame.height }) }); });
      } };
      throw new Error(`Unexpected import: ${name}`);
    },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
  });
  function render() {
    let count = 0;
    do {
      assert.ok(++count < 30, 'layout settles'); cursor = 0; dirty = false;
      value = exports.useIslandLayout(props);
      for (const effect of effects.splice(0)) effect();
    } while (dirty);
  }
  render();
  return {
    calls, props,
    value: () => ({ height: value.height, expanded: value.expanded }),
    geometry: () => ({ ...value }),
    render,
    async flush() { await new Promise(setImmediate); render(); },
    resize(height) { props.content.current.scrollHeight = height - 2; resize(); render(); },
    tick(ms) { now += ms; for (const [id, entry] of [...jobs]) if (entry.at <= now) { jobs.delete(id); entry.job(); } },
  };
}

test('opening and taller cards reveal only after native space is acknowledged', async () => {
  const ui = mount(); await ui.flush();
  ui.props.expanded = true; ui.render();
  assert.deepEqual(ui.value(), { height: 40, expanded: false });
  ui.calls.at(-1).resolve(); await ui.flush();
  assert.deepEqual(ui.value(), { height: 160, expanded: true });
  ui.resize(400);
  assert.equal(ui.value().height, 160);
  ui.calls.at(-1).resolve(); await ui.flush();
  assert.equal(ui.value().height, 400);
});

test('closing starts visibly before native shrink and late opening cannot reopen it', async () => {
  const ui = mount(); await ui.flush();
  ui.props.expanded = true; ui.render();
  const opening = ui.calls.at(-1);
  ui.props.expanded = false; ui.render();
  opening.resolve(); await ui.flush();
  assert.deepEqual(ui.value(), { height: 40, expanded: false });
  assert.equal(ui.calls.at(-1), opening);
  ui.tick(320); await ui.flush();
  assert.equal(ui.calls.at(-1).frame.expanded, false);
});

test('shorter cards morph first and hidden-window reactivation waits for fresh native bounds', async () => {
  const ui = mount(); await ui.flush();
  ui.props.expanded = true; ui.render(); ui.calls.at(-1).resolve(); await ui.flush();
  const count = ui.calls.length;
  ui.resize(100); assert.equal(ui.value().height, 100);
  assert.equal(ui.calls.length, count);
  ui.tick(320); ui.calls.at(-1).resolve(); await ui.flush();
  assert.equal(ui.calls.at(-1).frame.height, 100);
  ui.props.active = false; ui.render();
  ui.props.active = true; ui.render();
  assert.equal(ui.value().expanded, false);
  ui.calls.at(-1).resolve(); await ui.flush();
  assert.deepEqual(ui.value(), { height: 100, expanded: true });
});

test('native monitor clamps bound the shell and its scroll area, with stable width after collapse', async () => {
  const ui = mount(); await ui.flush();
  ui.props.expanded = true; ui.render();
  ui.calls.at(-1).resolve({ width: 360, height: 120 }); await ui.flush();
  assert.deepEqual(ui.value(), { height: 120, expanded: true });
  assert.equal(ui.geometry().width, 360);
  assert.equal(ui.geometry().contentMaxHeight, 118);
  ui.props.expanded = false; ui.render(); ui.tick(320); await ui.flush();
  assert.equal(ui.geometry().width, 360);
});
