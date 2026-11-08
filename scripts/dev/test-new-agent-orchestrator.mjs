import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

// Execute the actual dialog component with deterministic hooks and UI primitives.
// No DOM is needed: handlers are taken from the JSX it renders and requests hit a fake client.
const source = fs.readFileSync(new URL('../../src/components/agents/new-agent-dialog.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const ORCHESTRATOR_ROLE = 'orchestrator';
const metadata = [{ id: ORCHESTRATOR_ROLE, label: 'Orchestrator', capability: 'high' }, { id: 'reviewer', label: 'Reviewer', capability: 'high' }];

async function dialog({ roles = metadata, fail = false, usable = ['codex'], model = '' } = {}) {
  const state = [], effects = [], components = new Map(), requests = [];
  let cursor = 0, dirty = false, tree;
  const component = (name) => {
    if (!components.has(name)) components.set(name, function Primitive() {});
    return components.get(name);
  };
  const runtime = {
    newAgentOpen: true, view: 'canvas', activeProjectId: 'p', activeWorkspaceId: 'w',
    projects: [{ id: 'p' }], info: { providers: [{ id: 'codex', models: [] }] },
    client: { agentRoles: async () => roles, createSession: async (input) => {
      requests.push(input);
      if (runtime.fail) throw new Error('retry me');
      return { id: 'created', projectId: 'p' };
    } },
    fail, setNewAgentOpen: (open) => { runtime.newAgentOpen = open; },
    upsertSession() {}, focusOnCanvas() {}, openSession() {}, refresh: async () => {},
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (value) => {
        const next = typeof value === 'function' ? value(state[index]) : value;
        if (!Object.is(next, state[index])) { state[index] = next; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!state[index] || deps.some((value, i) => !Object.is(value, state[index][i]))) {
        state[index] = deps;
        effects.push(callback);
      }
    },
  };
  const require = (name) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'sonner') return { toast: { error() {} } };
    if (name === 'cn') return { cn: (...classes) => classes.filter(Boolean).join(' ') };
    if (name.endsWith('/runtime/store')) return { useRuntime: () => runtime, errorMessage: (error) => error.message };
    if (name.endsWith('/runtime/orchestrator')) return { ORCHESTRATOR_ROLE, ORCHESTRATOR_HINT: 'Coordinates agents.' };
    if (name.endsWith('/prefs')) return { loadComposerPrefs: () => ({ provider: 'codex', models: { codex: model } }) };
    if (name === './use-usable-providers') return { useUsableProviders: () => ({ loading: false, usable }) };
    // One-time auto-approve confirmation: this harness covers the create request, so the answer is always "keep".
    // Without this stub the Proxy default returns undefined, which the dialog reads as "cancelled" and never sends.
    if (name === './auto-approve-confirm') return { confirmAutoApprove: async () => true };
    if (name === './model-select') return { default: component('ModelSelect'), normalizeModels: () => model ? [{ value: model }] : [] };
    return new Proxy({}, { get: (_, key) => component(String(key)) });
  };
  const exports = {};
  vm.runInNewContext(compiled, { require, exports });
  function render() {
    do {
      dirty = false; cursor = 0;
      tree = exports.default();
      for (const effect of effects.splice(0)) effect();
    } while (dirty);
  }
  async function flush() {
    await new Promise(setImmediate);
    render();
  }
  function find(predicate) {
    function walk(node) {
      if (Array.isArray(node)) return node.flatMap(walk);
      if (!node || typeof node !== 'object') return [];
      return [...(predicate(node) ? [node] : []), ...walk(node.props?.children), ...walk(node.props?.footer)];
    }
    return walk(tree);
  }
  const get = (name) => find((node) => node.type === components.get(name))[0];
  render(); await flush();
  return {
    runtime, requests, get, find, flush,
    render,
    async toggle(value) { get('Switch').props.onCheckedChange(value); render(); },
    async role(value) { get('Select').props.onValueChange(value); render(); },
    async submit() { find((node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await flush(); },
  };
}

test('switch starts off, stays synchronized with role picker, and sends one orchestrator create request', async () => {
  const d = await dialog();
  assert.equal(d.get('Switch')?.props.checked, false);
  await d.toggle(true);
  assert.equal(d.get('Select').props.value, ORCHESTRATOR_ROLE);
  await d.submit();
  assert.deepEqual({ ...d.requests[0] }, { provider: 'codex', projectId: 'p', workspaceId: 'w', specKit: true, lead: true, role: ORCHESTRATOR_ROLE, model: 'auto' });
  assert.equal(d.requests.length, 1);
});

test('turning switch off creates Generalist without automatic model or role', async () => {
  const d = await dialog();
  await d.toggle(true); await d.toggle(false); await d.submit();
  assert.equal(d.requests[0].role, undefined);
  assert.equal(d.requests[0].model, undefined);
});

test('role picker controls switch and explicit model wins over role auto', async () => {
  const d = await dialog({ model: 'chosen-model' });
  await d.role(ORCHESTRATOR_ROLE);
  assert.equal(d.get('Switch').props.checked, true);
  await d.role('reviewer');
  assert.equal(d.get('Switch').props.checked, false);
  await d.submit();
  assert.equal(d.requests[0].role, 'reviewer');
  assert.equal(d.requests[0].model, 'chosen-model');
});

test('failed creation retains orchestrator for retry, fresh open resets it', async () => {
  const d = await dialog({ fail: true });
  await d.toggle(true); await d.submit();
  assert.equal(d.get('Switch').props.checked, true);
  assert.equal(d.get('Select').props.value, ORCHESTRATOR_ROLE);
  d.runtime.fail = false;
  await d.submit();
  assert.equal(d.requests.length, 2);
  assert.equal(d.requests[1].role, ORCHESTRATOR_ROLE);
  d.runtime.newAgentOpen = true; d.render();
  assert.equal(d.get('Switch').props.checked, false);
  await d.toggle(true);
  d.runtime.newAgentOpen = false; d.render();
  d.runtime.newAgentOpen = true; d.render();
  assert.equal(d.get('Switch').props.checked, false);
});

test('unsupported metadata and disconnected providers do not expose orchestrator choice', async () => {
  for (const options of [{ roles: [] }, { roles: [metadata[1]] }, { usable: [] }]) {
    const d = await dialog(options);
    assert.equal(d.get('Switch'), undefined);
  }
});

test('orchestrator creation preserves an explicit model and project/workspace fields', async () => {
  const d = await dialog({ model: 'explicit-model' });
  await d.toggle(true); await d.submit();
  assert.equal(d.requests.length, 1);
  assert.equal(d.requests[0].role, ORCHESTRATOR_ROLE);
  assert.equal(d.requests[0].model, 'explicit-model');
  assert.equal(d.requests[0].projectId, 'p');
  assert.equal(d.requests[0].workspaceId, 'w');
  assert.equal(d.requests[0].lead, true);
});
