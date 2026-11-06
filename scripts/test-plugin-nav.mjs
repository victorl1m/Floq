import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const V = await import('../src/lib/view-visibility.ts');
const { activeContributions } = await import('../src/plugins/registry.ts');

const info = (over = {}) => ({
  id: 'echo', name: 'Echo', version: '1.0.0', description: 'd', scope: 'install', status: 'enabled', enabled: true, userEnabled: true, secrets: [], settings: [],
  contributes: { views: [{ id: 'main', label: 'Echo view', icon: 'IconPlug' }], taskSources: [], rightSidebarTabs: [], settingsPanel: false }, ...over,
});
const Main = () => null;
const ALL_VIEWS = ['home', 'tasks', 'skills', 'secrets', 'canvas', 'terminal', 'session', 'plugin'];

test('core navigation order is unchanged', () => {
  const src = fs.readFileSync('src/components/app-sidebar.tsx', 'utf8');
  const nav = [...src.slice(src.indexOf('const NAV'), src.indexOf('export function AppSidebar')).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(nav, ['Home', 'Tasks', 'Skills & MCP', 'Secrets', 'Terminal']);
  // plugin views come after the core list, below a separator, only when there are any
  const body = src.slice(src.indexOf('export function AppSidebar'));
  assert.ok(body.indexOf('NAV.map') < body.indexOf('SidebarSeparator') && body.indexOf('SidebarSeparator') < body.indexOf('pluginViews.map'));
  assert.match(body, /pluginViews\.length > 0 &&/);
  assert.match(body, /navigate\("plugin", id\)/);
});

test('a plugin view appears and disappears with enablement', () => {
  const ui = { echo: { views: { main: Main } } };
  assert.deepEqual(activeContributions([info()], ui).views.map((v) => `${v.pluginId}/${v.viewId}`), ['echo/main']);
  assert.deepEqual(activeContributions([info({ status: 'disabled', enabled: false })], ui).views, []);
  assert.deepEqual(activeContributions([info({ userEnabled: false })], ui).views, []);
  assert.deepEqual(activeContributions([], ui).views, []);
});

test('the terminal is hidden, never unmounted, behind every non-terminal view including plugin views', () => {
  for (const view of ALL_VIEWS) assert.equal(V.isTerminalHidden(view), !['terminal', 'session'].includes(view), view);
  // The old enumerated rule hid it for exactly these views; the new rule is equivalent for them
  for (const view of ['home', 'tasks', 'canvas', 'skills', 'secrets']) assert.ok(V.isTerminalHidden(view));
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  const i = app.indexOf('<TerminalPanel />');
  assert.ok(i > 0 && app.indexOf('<TerminalPanel />', i + 1) < 0, 'TerminalPanel is rendered exactly once');
  const around = app.slice(app.lastIndexOf('<div', i), i); // the wrapper div directly around TerminalPanel
  assert.match(around, /isTerminalHidden\(view\) \? "hidden" : "absolute inset-0"/);
  assert.doesNotMatch(around, /\{view === "[a-z]+" &&/); // not behind a view conditional
  assert.match(app, /\{view === "plugin" && <PluginViewHost viewId=\{pluginViewId\} \/>\}/);
});

test('plugin pages cross-fade like other simple pages, the terminal and sessions do not', () => {
  assert.ok(V.canTransitionViewChange('home', 'plugin'));
  assert.ok(V.canTransitionViewChange('plugin', 'tasks'));
  assert.ok(!V.canTransitionViewChange('plugin', 'plugin'));
  assert.ok(!V.canTransitionViewChange('plugin', 'terminal'));
  assert.ok(!V.canTransitionViewChange('session', 'plugin'));
});

test('plugin view ids are validated', () => {
  assert.deepEqual(V.pluginEntry('echo/main'), { view: 'plugin', arg: 'echo/main' });
  for (const bad of ['echo', 'echo/', '/main', 'Echo/main', 'echo/main/extra', '../x', null, undefined, 5, '']) assert.equal(V.pluginEntry(bad), null, String(bad));
});

test('history back and forward work across plugin views', () => {
  let h = { stack: [{ view: 'home', arg: null }], index: 0 };
  const push = (entry) => { const n = V.pushEntry(h, entry); if (n) h = n; return n; };
  push(V.pluginEntry('echo/main'));
  push(V.pluginEntry('other/inbox'));
  push({ view: 'tasks', arg: null });
  assert.equal(push({ view: 'tasks', arg: null }), null); // same entry: no duplicate
  assert.deepEqual(h.stack.map((e) => e.arg ?? e.view), ['home', 'echo/main', 'other/inbox', 'tasks']);
  let m = V.moveEntry(h, -1); h = m.state;
  assert.deepEqual(m.entry, { view: 'plugin', arg: 'other/inbox' });
  m = V.moveEntry(h, -1); h = m.state;
  assert.deepEqual(m.entry, { view: 'plugin', arg: 'echo/main' });
  m = V.moveEntry(h, 1); h = m.state;
  assert.deepEqual(m.entry, { view: 'plugin', arg: 'other/inbox' });
  // going to a new place from the middle drops forward history
  push({ view: 'secrets', arg: null });
  assert.deepEqual(h.stack.map((e) => e.arg ?? e.view), ['home', 'echo/main', 'other/inbox', 'secrets']);
  assert.equal(V.moveEntry(h, 1), null);
  assert.equal(V.moveEntry({ stack: [{ view: 'home', arg: null }], index: 0 }, -1), null);
  // plugin -> plugin pushes a new entry
  push(V.pluginEntry('echo/main'));
  assert.equal(h.stack.at(-1).arg, 'echo/main');
});
