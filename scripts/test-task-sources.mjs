import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const L = await import('../src/lib/task-sources.ts');
const src = (pluginId, sourceId, label = sourceId) => ({ pluginId, sourceId, label, view: 'generic', missingSecrets: [] });
const SOURCES = [src('movidesk', 'tickets', 'Movidesk'), src('azure-devops', 'items', 'Azure DevOps')];

// localStorage stub for the persistence helpers
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };

test('source tabs persist like board tabs and are validated against the server list', () => {
  const key = 'floq.tasks.navigation.v1:rt:u1:org1:sources';
  assert.deepEqual(L.readSourcePrefs(key), L.EMPTY_SOURCE_PREFS);
  let prefs = L.openSource(L.EMPTY_SOURCE_PREFS, 'movidesk/tickets');
  prefs = L.openSource(prefs, 'azure-devops/items');
  prefs = L.openSource(prefs, 'movidesk/tickets'); // reopening does not duplicate, and makes it active
  assert.deepEqual(prefs, { open: ['movidesk/tickets', 'azure-devops/items'], active: 'movidesk/tickets' });
  L.writeSourcePrefs(key, prefs);
  assert.deepEqual(L.readSourcePrefs(key), prefs);
  // a source that is no longer listed (plugin disabled, secret removed...) drops out; the active one falls back to none
  assert.deepEqual(L.reconcileSourcePrefs(prefs, [SOURCES[1]]), { open: ['azure-devops/items'], active: '' });
  assert.deepEqual(L.reconcileSourcePrefs(prefs, SOURCES), prefs);
  // an intentionally empty set stays empty; nothing is opened automatically
  assert.deepEqual(L.reconcileSourcePrefs(L.EMPTY_SOURCE_PREFS, SOURCES), L.EMPTY_SOURCE_PREFS);
  assert.deepEqual(L.reconcileSourcePrefs(prefs, []), L.EMPTY_SOURCE_PREFS);
  // closing
  assert.deepEqual(L.closeSource(prefs, 'movidesk/tickets'), { open: ['azure-devops/items'], active: '' });
  assert.deepEqual(L.closeSource(prefs, 'azure-devops/items'), { open: ['movidesk/tickets'], active: 'movidesk/tickets' });
});

test('malformed or foreign stored preferences are ignored', () => {
  for (const raw of ['not json', '{"version":2,"open":["a/b"]}', '{"version":1,"open":"x","active":5}', 'null']) {
    store.set('k', raw);
    const p = L.readSourcePrefs('k');
    assert.ok(Array.isArray(p.open) && typeof p.active === 'string');
    assert.deepEqual(p.open, []);
  }
  store.set('k', JSON.stringify({ version: 1, open: ['a/b', 'a/b', 3, 'c/d'], active: 'a/b' }));
  assert.deepEqual(L.readSourcePrefs('k'), { open: ['a/b', 'c/d'], active: 'a/b' });
});

test('picker: one group per source; a query filters source entries only and never lists external items', () => {
  const all = L.sourceGroups(SOURCES, '');
  assert.deepEqual(all.map((g) => g.title), ['Movidesk', 'Azure DevOps']);
  assert.deepEqual(L.sourceGroups(SOURCES, 'azure').map((g) => g.title), ['Azure DevOps']);
  assert.deepEqual(L.sourceGroups(SOURCES, 'T-1042 login'), []); // a ticket title never matches: tickets are not searched here
  for (const g of all) assert.deepEqual(Object.keys(g).sort(), ['source', 'title']);
});

test('the Tasks page keeps native board search separate from sources', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync('src/components/tasks/tasks-page.tsx', 'utf8');
  // board groups are still built from boards only; sources render as their own groups below them
  assert.match(page, /\{ title: "Search results", items: boards\.filter/);
  assert.match(page, /sourceGroups\(sources, boardQuery\)/);
  assert.doesNotMatch(page, /taskSourceItems/); // listing external items is the source panel's job, not the picker's
});

test('tabs: arrow keys cross board and source tabs, and the source list refreshes when plugins change', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync('src/components/tasks/tasks-page.tsx', 'utf8');
  assert.match(page, /const tabs = \[\.\.\.openedBoards\.map\(\(item\) => "b:" \+ item\.id\), \.\.\.openedSources\.map\(\(item\) => "s:" \+ sourceTabId\(item\)\)\]/);
  assert.match(page, /onTabKeyDown\(event, "b:" \+ item\.id\)/);
  assert.match(page, /onTabKeyDown\(event, "s:" \+ id\)/);
  assert.match(page, /\[client, sourceScope, pluginsSignature\]/);
  assert.match(page, /usePlugins\(\)\.all\.map/);
});

test('client task-source methods hit the documented routes', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([init.method, String(url)]); return new Response(JSON.stringify({ sources: [], items: [], item: {} }), { status: 200 }); };
  try {
    const { RuntimeClient } = await server.ssrLoadModule('/src/lib/runtime/client.ts');
    const c = new RuntimeClient('http://rt', null);
    await c.taskSources();
    await c.taskSourceItems('movidesk', 'tickets');
    await c.taskSourceItems('movidesk', 'tickets', { query: 'a b', cursor: 'c2' });
    await c.taskSourceItem('movidesk', 'tickets', 'T/1');
    assert.deepEqual(calls.map((x) => x.join(' ')), [
      'GET http://rt/v1/task-sources', 'GET http://rt/v1/task-sources/movidesk/tickets/items',
      'GET http://rt/v1/task-sources/movidesk/tickets/items?query=a+b&cursor=c2', 'GET http://rt/v1/task-sources/movidesk/tickets/items/T%2F1',
    ]);
  } finally { globalThis.fetch = realFetch; await server.close(); }
});

test('the generic list renders its states through the kit', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const mod = await server.ssrLoadModule('/src/components/tasks/external-task-list.tsx');
    assert.equal(typeof mod.ExternalTaskList, 'function');
    assert.equal(typeof mod.TaskSourcePanel, 'function');
  } finally { await server.close(); }
});
