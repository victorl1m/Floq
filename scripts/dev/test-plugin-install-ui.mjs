import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const U = await import('../../src/plugins/install-ui.ts');
const item = (over = {}) => ({ id: 'movidesk', name: 'Movidesk', version: '1.1.0', apiVersion: 1, description: 'Tickets.', icon: 'IconHeadset', scope: 'user', secrets: ['MOVIDESK_TOKEN'], network: ['api.movidesk.com'], contributes: ['taskSources'], builtin: false, installedVersion: null, updateAvailable: false, ...over });

test('row state: built-ins have no actions; available, installed and update rows offer the right ones', () => {
  assert.deepEqual(U.rowState(item({ builtin: true })), { status: 'builtin', actions: [] });
  assert.deepEqual(U.rowState(item()), { status: 'available', actions: ['install', 'purge'] });
  assert.deepEqual(U.rowState(item({ installedVersion: '1.1.0' })), { status: 'installed', actions: ['uninstall'] });
  assert.deepEqual(U.rowState(item({ installedVersion: '1.0.0', updateAvailable: true })), { status: 'update', actions: ['update', 'uninstall'] });
  assert.deepEqual(U.rowState(item({ builtin: true, installedVersion: '1.0.0', updateAvailable: true })).actions, []);
});

test('the typed confirmation needs the exact id', () => {
  assert.ok(U.confirmMatches('movidesk', 'movidesk')); assert.ok(U.confirmMatches('  movidesk ', 'movidesk'));
  for (const bad of ['', 'Movidesk', 'movide', 'movidesk2', 'azure-devops']) assert.ok(!U.confirmMatches(bad, 'movidesk'), bad);
});

test('the summary shows scope, secrets, hosts and what the plugin adds', () => {
  assert.deepEqual(U.summarize(item()), ['Each user turns it on', 'Secrets: MOVIDESK_TOKEN', 'Contacts: api.movidesk.com', 'Adds: task sources']);
  assert.deepEqual(U.summarize(item({ scope: 'install', secrets: [], network: [], contributes: ['views', 'webhooks', 'internalRoutes'] })), ['One setup for the whole runtime', 'Adds: a screen, webhooks, agent access']);
});

test('the trust warning is honest and identical in the dialog and the docs', () => {
  assert.match(U.TRUST_WARNING, /full privileges/); assert.match(U.TRUST_WARNING, /sha256/); assert.match(U.TRUST_WARNING, /guard rail, not a sandbox/); assert.match(U.TRUST_WARNING, /Install only plugins you trust as much as Floq itself/);
  const docs = fs.readFileSync('docs/plugins/README.md', 'utf8').replace(/\s+/g, ' ');
  assert.ok(docs.includes(U.TRUST_WARNING), 'docs/plugins/README.md carries the same text');
});

test('catalog rows and the confirmation render with shared components', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { CatalogRow, ConfirmBody } = await server.ssrLoadModule('/src/components/settings/plugin-catalog-dialog.tsx');
    const row = (it, busy = false) => renderToStaticMarkup(React.createElement(CatalogRow, { item: it, busy, onAction() {} }));
    const available = row(item());
    assert.match(available, /Movidesk/); assert.match(available, /v1\.1\.0/); assert.match(available, /MOVIDESK_TOKEN/); assert.match(available, /api\.movidesk\.com/); assert.match(available, />Install</); assert.match(available, /Delete data/);
    assert.doesNotMatch(available, /Uninstall/);
    const upd = row(item({ installedVersion: '1.0.0', updateAvailable: true }));
    assert.match(upd, /Update available/); assert.match(upd, /you have v1\.0\.0/); assert.match(upd, />Update</); assert.match(upd, /Uninstall/);
    const builtin = row(item({ builtin: true }));
    assert.match(builtin, /Built in/); assert.doesNotMatch(builtin, /<button/);
    assert.match(row(item(), true), /disabled/);
    const body = (action, typed = '') => renderToStaticMarkup(React.createElement(ConfirmBody, { item: item({ installedVersion: '1.0.0' }), action, typed, onTyped() {} }));
    assert.match(body('install'), /full privileges/); assert.match(body('install'), /Type <code[^>]*>movidesk<\/code> to confirm/);
    assert.match(body('uninstall'), /data and settings are kept/); assert.match(body('uninstall'), /Type/);
    assert.match(body('purge'), /permanently deletes/); assert.match(body('purge'), /cannot be undone/);
    assert.match(body('update'), /goes back to v1\.0\.0/); assert.doesNotMatch(body('update'), /Type <code/);
    assert.match(body('install', 'wrong'), /aria-invalid="true"/); assert.doesNotMatch(body('install', 'movidesk'), /aria-invalid="true"/);
  } finally { await server.close(); }
});

test('Browse plugins is for administrators only, and errors use the shared toast', () => {
  const sec = fs.readFileSync('src/components/settings/plugins-section.tsx', 'utf8');
  assert.match(sec, /\{isAdmin && \(\s*<div className="flex justify-end">[\s\S]*Browse plugins/);
  assert.match(sec, /\{isAdmin && <PluginCatalogDialog/);
  const dlg = fs.readFileSync('src/components/settings/plugin-catalog-dialog.tsx', 'utf8');
  assert.match(dlg, /toast\.error\(`Could not/); assert.match(dlg, /AppDialog/);
  assert.match(dlg, /disabled=\{busy \|\| !ok\}/); // the confirm button stays off until the id is typed
});

test('client install methods hit the documented admin routes with the typed confirmation', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([init?.method ?? 'GET', String(url), init?.body]); return new Response(JSON.stringify({ plugins: [], plugin: {}, uninstalled: true, purged: true }), { status: 200, headers: { 'X-Floq-Plugin-Sha256': 'abc' } }); };
  try {
    const { RuntimeClient } = await server.ssrLoadModule('/src/lib/runtime/client.ts');
    const c = new RuntimeClient('http://rt', 'tok');
    await c.pluginCatalog();
    await c.installPlugin('movidesk', 'movidesk');
    await c.updatePlugin('movidesk');
    await c.uninstallPlugin('movidesk', 'movidesk');
    await c.purgePluginData('movidesk', 'movidesk');
    const ui = await c.pluginUiScript('waha');
    assert.deepEqual(calls.map((x) => x.slice(0, 2).join(' ')), ['GET http://rt/v1/plugins/catalog', 'POST http://rt/v1/plugins/install', 'POST http://rt/v1/plugins/movidesk/update', 'DELETE http://rt/v1/plugins/movidesk?confirm=movidesk', 'POST http://rt/v1/plugins/movidesk/purge', 'GET http://rt/v1/plugins/waha/ui.js']);
    assert.equal(calls[1][2], '{"id":"movidesk","confirm":"movidesk"}'); assert.equal(calls[4][2], '{"confirm":"movidesk"}');
    assert.equal(ui.sha256, 'abc');
  } finally { globalThis.fetch = realFetch; await server.close(); }
});

test('repository installs: the stronger warning, the review facts (including the sha256) and the app-open toast text', () => {
  assert.match(U.REPO_TRUST_WARNING, /GitHub repository you chose/); assert.match(U.REPO_TRUST_WARNING, /cannot vouch/); assert.match(U.REPO_TRUST_WARNING, /guard rail, not a sandbox/);
  const lines = U.previewLines({ repo: 'someone/my-plugin', tag: 'v1.0.0', version: '1.0.0', secrets: ['MINE_TOKEN'], network: ['api.example.com'], contributes: ['routes'], scope: 'user', sha256: 'a'.repeat(64), size: 10 });
  assert.equal(lines[0], 'Repository: someone/my-plugin (v1.0.0)'); assert.ok(lines.includes('Secrets: MINE_TOKEN')); assert.ok(lines.includes('Contacts: api.example.com')); assert.ok(lines.includes('sha256: ' + 'a'.repeat(64)));
  assert.equal(U.updateToast([]), null);
  const one = U.updateToast([{ name: 'Movidesk', installedVersion: '1.0.0', availableVersion: '1.1.0' }]);
  assert.equal(one.title, 'A plugin update is available'); assert.match(one.description, /Movidesk 1\.0\.0 to 1\.1\.0/); assert.match(one.description, /Settings > Plugins/);
  const many = U.updateToast(['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, installedVersion: '1.0.0', availableVersion: '2.0.0' })));
  assert.equal(many.title, '5 plugin updates are available'); assert.match(many.description, /and 2 more/);
});

test('wiring: the dialog reviews before installing and updates stay manual; the toast only reads and only for admins', () => {
  const dialog = fs.readFileSync('src/components/settings/plugin-catalog-dialog.tsx', 'utf8');
  assert.match(dialog, /inspectPluginRepo/); assert.match(dialog, /installPluginFromRepo\(url, preview\.sha256, typed\.trim\(\)\)/); assert.match(dialog, /updatePlugin\(preview\.id, preview\.sha256\)/);
  assert.match(dialog, /REPO_TRUST_WARNING/);
  const host = fs.readFileSync('src/plugins/host.tsx', 'utf8');
  assert.match(host, /myRole\(\)\) !== "admin"/); assert.match(host, /pluginUpdates\(\)/); assert.match(host, /openSettings\("plugins"\)/);
  assert.doesNotMatch(host, /updatePlugin\(/); // the toast never updates anything
});
