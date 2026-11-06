import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const { activeContributions, idsToLoad, isActive } = await import('../src/plugins/registry.ts');

const info = (over = {}) => ({
  id: 'echo', name: 'Echo', version: '1.0.0', description: 'd', scope: 'install', status: 'enabled', enabled: true, userEnabled: true,
  secrets: [], settings: [],
  contributes: { views: [{ id: 'main', label: 'Echo view' }], taskSources: [{ id: 'gen', label: 'Generic', view: 'generic' }, { id: 'cus', label: 'Custom', view: 'custom' }], rightSidebarTabs: [{ id: 'tab', label: 'Tab' }], settingsPanel: false },
  ...over,
});
const Main = () => null;
const Tab = () => null;
const ui = { views: { main: Main, ghost: Main }, rightSidebarTabs: { tab: Tab } };

test('an enabled plugin with a UI half contributes views, tabs and task sources', () => {
  const c = activeContributions([info()], { echo: ui });
  assert.deepEqual(c.views.map((v) => `${v.pluginId}/${v.viewId}`), ['echo/main']); // 'ghost' is not declared by the manifest
  assert.equal(c.views[0].label, 'Echo view');
  assert.equal(c.views[0].Component, Main);
  assert.equal(c.tabs.length, 1);
  assert.deepEqual(c.taskSources.map((s) => s.sourceId), ['gen']); // custom source has no component, generic is host-rendered
});

test('disabled, failed, invalid, user-off or unknown-to-server plugins contribute nothing', () => {
  for (const over of [{ status: 'disabled', enabled: false }, { status: 'failed', enabled: false }, { status: 'invalid' }, { status: 'available', enabled: false }, { userEnabled: false }, { enabled: false }]) {
    const c = activeContributions([info(over)], { echo: ui });
    assert.deepEqual([c.plugins.length, c.views.length, c.tabs.length, c.taskSources.length], [0, 0, 0, 0], JSON.stringify(over));
  }
  // a UI half whose id the server does not list (missing) is ignored
  assert.equal(activeContributions([], { echo: ui, other: ui }).views.length, 0);
  // enabled on the server but UI code not loaded (yet): no views
  assert.equal(activeContributions([info()], {}).views.length, 0);
});

test('plugins are ordered by name, then manifest order', () => {
  const b = info({ id: 'b', name: 'Beta' });
  const a = info({ id: 'a', name: 'Alpha' });
  assert.deepEqual(activeContributions([b, a], { a: ui, b: ui }).views.map((v) => v.pluginId), ['a', 'b']);
});

test('idsToLoad only requests active plugins that have a loader and were not attempted', () => {
  const loaders = { echo: () => null, off: () => null };
  const list = [info(), info({ id: 'off', status: 'disabled', enabled: false }), info({ id: 'noloader' })];
  assert.deepEqual(idsToLoad(list, {}, loaders), ['echo']);
  assert.deepEqual(idsToLoad(list, { echo: true }, loaders), []);
  assert.ok(isActive(info()));
});

test('a component that throws renders the boundary fallback instead of a blank app', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PluginBoundary } = await server.ssrLoadModule('/src/plugins/host.tsx');
    assert.equal(typeof PluginBoundary.getDerivedStateFromError, 'function');
    assert.equal(PluginBoundary.getDerivedStateFromError(new Error('boom')).error.message, 'boom');
    // class boundaries cannot catch during SSR, so render the state the client enters after a throw
    const html = renderToStaticMarkup(React.createElement(PluginBoundary, { pluginId: 'echo', error: new Error('boom') }, React.createElement('p', null, 'child')));
    assert.match(html, /data-plugin-error="echo"/);
    assert.match(html, /This plugin ran into a problem/);
    assert.match(html, /Retry/);
    assert.doesNotMatch(html, /child/);
    assert.doesNotMatch(html, /boom/); // internal error text is not shown to the user
    const ok = renderToStaticMarkup(React.createElement(PluginBoundary, { pluginId: 'echo' }, React.createElement('p', null, 'child')));
    assert.match(ok, /child/);
    // only the dev-only example may be registered
    const { UI_PLUGINS } = await server.ssrLoadModule('/src/plugins/index.ts');
    assert.deepEqual(Object.keys(UI_PLUGINS).filter((id) => !['example', 'movidesk', 'azure-devops', 'waha'].includes(id)), []);
  } finally { await server.close(); }
});

test('client methods hit the documented routes', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([init.method, String(url), init.body]); return new Response(JSON.stringify({ plugins: [], plugin: {}, settings: {}, ok: 1 }), { status: 200 }); };
  try {
    const { RuntimeClient } = await server.ssrLoadModule('/src/lib/runtime/client.ts');
    const c = new RuntimeClient('http://rt', null);
    await c.listPlugins();
    await c.setPluginEnabled('echo', true);
    await c.setPluginEnabled('echo', false);
    await c.setPluginEnabled('echo', true, 'user');
    await c.getPluginSettings('echo');
    await c.savePluginSettings('echo', { a: 1 });
    const toggled = await c.setPluginEnabled('echo', true, 'user');
    assert.deepEqual(Object.keys(toggled).sort(), ['mcpProblems', 'plugin']);
    assert.deepEqual(toggled.mcpProblems, []); // always an array, so the UI can show what could not be installed
    calls.pop();
    await c.pluginFetch('echo', '/items/1', { method: 'POST', body: { x: 1 } });
    for (const bad of ['/../../vault', '/a/../b', '/%2e%2e/x', '//evil', '/a%2Fb', '/x\\y', '/..']) assert.throws(() => c.pluginFetch('echo', bad), /Invalid plugin path/, bad);
    await c.pluginFetch('echo', '/items.v2/a..b?x=1');
    assert.deepEqual(calls.map((x) => x.slice(0, 2).join(' ')), [
      'GET http://rt/v1/plugins', 'POST http://rt/v1/plugins/echo/enable', 'POST http://rt/v1/plugins/echo/disable', 'PUT http://rt/v1/plugins/echo/user',
      'GET http://rt/v1/plugins/echo/settings', 'PUT http://rt/v1/plugins/echo/settings', 'POST http://rt/v1/plugins/echo/api/items/1', 'GET http://rt/v1/plugins/echo/api/items.v2/a..b?x=1',
    ]);
    assert.equal(calls[3][2], '{"enabled":true}');
    assert.equal(calls[5][2], '{"settings":{"a":1}}');
  } finally { globalThis.fetch = realFetch; await server.close(); }
});

test('UI types mirror the runtime sdk and host key lists field by field', () => {
  // Top-level property names of `export interface <name> { ... }` (brace-depth aware, so nested object types are skipped).
  const keys = (file, name) => {
    const src = fs.readFileSync(file, 'utf8');
    const start = src.search(new RegExp(`export interface ${name}(?:<[^>]*>)?\\s*\\{`));
    assert.ok(start >= 0, `${name} not found in ${file}`);
    let i = src.indexOf('{', start) + 1, depth = 1, buf = '', out = [];
    for (; depth > 0 && i < src.length; i++) {
      const ch = src[i];
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      if (ch === '}' || ch === ']' || ch === ')') depth--;
      if (depth === 1 && ch !== '}') buf += ch;
      else if (depth === 1) buf += ch;
      if (depth === 1 && (ch === ';' || ch === '\n' || ch === ',')) { const m = buf.match(/^\s*(?:readonly\s+)?(\w+)\??\s*:/); if (m) out.push(m[1]); buf = ''; }
    }
    const m = buf.match(/^\s*(?:readonly\s+)?(\w+)\??\s*:/);
    if (m) out.push(m[1]);
    return [...new Set(out)].sort();
  };
  const rt = 'runtime/src/plugins/sdk.ts';
  const ui = 'src/lib/runtime/types.ts';
  for (const name of ['PluginSettingDecl', 'PluginViewDecl', 'PluginTaskSourceDecl', 'PluginRightSidebarTabDecl']) { assert.ok(keys(rt, name).length >= 3, name + ' keys parsed'); assert.deepEqual(keys(ui, name), keys(rt, name), name); }
  // PluginContributes: the UI exposes the subset the host publishes
  const published = keys('runtime/src/plugins/host.ts', 'PublicPlugin');
  assert.ok(published.length >= 10); assert.deepEqual(keys(ui, 'PluginInfo'), published, 'PluginInfo vs PublicPlugin');
  const rtContrib = new Set(keys(rt, 'PluginContributes'));
  for (const k of keys(ui, 'PluginContributes')) assert.ok(rtContrib.has(k), 'contributes.' + k);
  const hostSrc = fs.readFileSync('runtime/src/plugins/host.ts', 'utf8');
  assert.match(hostSrc, /Pick<PluginManifest\["contributes"\], "views" \| "taskSources" \| "rightSidebarTabs" \| "settingsPanel">/);
  for (const [t, re] of [['PluginStatus', /"available" \| "enabled" \| "disabled" \| "failed" \| "invalid"/], ['PluginSettingType', /"text" \| "url" \| "number" \| "boolean" \| "select" \| "secretRef"/]]) {
    assert.match(fs.readFileSync(ui, 'utf8'), new RegExp(`export type ${t} = ${re.source}`));
  }
});

test('right sidebar: core tabs unchanged, plugin tabs resolve only while active, otherwise fall back to changes', async () => {
  const { resolveRightSidebarTab, CORE_TABS } = await import('../src/lib/right-sidebar.ts');
  assert.deepEqual(CORE_TABS, ['changes', 'files', 'conversations', 'app']);
  for (const t of CORE_TABS) assert.equal(resolveRightSidebarTab(t, []), t);
  assert.equal(resolveRightSidebarTab('plugin:echo/tab', ['plugin:echo/tab']), 'plugin:echo/tab');
  assert.equal(resolveRightSidebarTab('plugin:echo/tab', []), 'changes'); // plugin disabled or removed
  assert.equal(resolveRightSidebarTab('plugin:echo/tab', ['plugin:other/tab']), 'changes');
});

test('plugin icons resolve by name with a safe fallback', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { resolvePluginIcon, PLUGIN_ICONS } = await server.ssrLoadModule('/src/plugins/icons.ts');
    assert.equal(resolvePluginIcon('IconHeadset'), PLUGIN_ICONS.IconHeadset);
    assert.equal(resolvePluginIcon('IconDoesNotExist'), PLUGIN_ICONS.IconPlug);
    assert.equal(resolvePluginIcon('constructor'), PLUGIN_ICONS.IconPlug);
    assert.equal(resolvePluginIcon(undefined), PLUGIN_ICONS.IconPlug);
  } finally { await server.close(); }
});

test('plugin event frames reach only matching subscribers and stop after unsubscribe', async () => {
  const { dispatchPluginFrame, subscribePluginEvent, isPluginFrame } = await import('../src/plugins/events.ts');
  const got = [];
  const off = subscribePluginEvent('echo', 'tick', (d) => got.push(['a', d]));
  subscribePluginEvent('echo', 'tick', () => { throw new Error('boom'); });
  subscribePluginEvent('echo', 'tick', (d) => got.push(['b', d]));
  subscribePluginEvent('echo', 'other', (d) => got.push(['other', d]));
  const origError = console.error; console.error = () => {};
  try {
    dispatchPluginFrame({ type: 'plugin', pluginId: 'echo', name: 'tick', data: 1 });
    dispatchPluginFrame({ type: 'plugin', pluginId: 'nope', name: 'tick', data: 2 });
    dispatchPluginFrame({ type: 'approval-request', pluginId: 'echo', name: 'tick', data: 3 });
    dispatchPluginFrame(null); dispatchPluginFrame('x');
    off();
    dispatchPluginFrame({ type: 'plugin', pluginId: 'echo', name: 'tick', data: 4 });
  } finally { console.error = origError; }
  assert.deepEqual(got, [['a', 1], ['b', 1], ['b', 4]]);
  assert.ok(isPluginFrame({ type: 'plugin', pluginId: 'a', name: 'b' }));
  assert.ok(!isPluginFrame({ type: 'plugin', pluginId: 1, name: 'b' }));
});
