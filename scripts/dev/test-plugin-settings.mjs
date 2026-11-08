import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const F = await import('../../src/plugins/settings-form.ts');
const DECLS = [
  { key: 'greeting', type: 'text', label: 'Greeting', required: true },
  { key: 'baseUrl', type: 'url', label: 'Base URL' },
  { key: 'limit', type: 'number', label: 'Limit' },
  { key: 'verbose', type: 'boolean', label: 'Verbose' },
  { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
  { key: 'tokenName', type: 'secretRef', label: 'Token secret' },
];

test('drafts convert to typed values; empty optional fields are omitted', () => {
  const draft = { greeting: ' hi ', baseUrl: 'https://x.test/a', limit: '12.5', verbose: 'true', mode: 'b', tokenName: 'MY_TOKEN' };
  assert.deepEqual(F.draftToValues(DECLS, draft), { values: { greeting: 'hi', baseUrl: 'https://x.test/a', limit: 12.5, verbose: true, mode: 'b', tokenName: 'MY_TOKEN' }, errors: {} });
  assert.deepEqual(F.draftToValues(DECLS, { greeting: 'x' }).values, { greeting: 'x', verbose: false });
  const bad = F.draftToValues(DECLS, { greeting: '', baseUrl: 'ftp://x', limit: 'abc', mode: 'zzz', tokenName: 'lower' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['baseUrl', 'greeting', 'limit', 'mode', 'tokenName']);
  // messages name the field, never the value
  assert.ok(!JSON.stringify(bad.errors).includes('zzz') && !JSON.stringify(bad.errors).includes('ftp://x'));
});

test('initial drafts round-trip saved values and track dirtiness', () => {
  const saved = { greeting: 'hi', limit: 3, verbose: true, mode: 'a' };
  const d = F.initialDraft(DECLS, saved);
  assert.deepEqual(d, { greeting: 'hi', baseUrl: '', limit: '3', verbose: 'true', mode: 'a', tokenName: '' });
  assert.ok(!F.isDirty(DECLS, d, saved));
  assert.ok(F.isDirty(DECLS, { ...d, greeting: 'ho' }, saved));
  assert.ok(!F.isDirty(DECLS, { ...d, greeting: 'hi  ' }, saved));
});

test('the generic form renders every field type with the shared field primitives', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PluginSettingsForm } = await server.ssrLoadModule('/src/plugins/kit/plugin-settings-form.tsx');
    const html = renderToStaticMarkup(React.createElement(PluginSettingsForm, { pluginId: 'echo', decls: DECLS.map((d) => ({ ...d, description: d.key === 'greeting' ? 'Used by the hello route.' : undefined })), values: { greeting: 'hi', mode: 'a', verbose: true, limit: 3 }, onSave: async () => {} }));
    for (const label of ['Greeting', 'Base URL', 'Limit', 'Verbose', 'Mode', 'Token secret']) assert.match(html, new RegExp(label));
    assert.match(html, /id="plugin-echo-greeting"[^>]*value="hi"/);
    assert.match(html, /type="url"/); assert.match(html, /type="number"/);
    assert.match(html, /role="switch"/); assert.match(html, /role="combobox"/);
    assert.match(html, /placeholder="MY_SECRET"/); assert.match(html, /never its value/);
    assert.match(html, /Used by the hello route\./);
    assert.match(html, /data-slot="plugin-settings-form"/);
    assert.match(html, /disabled=""[^>]*>Save settings|Save settings/); // nothing changed yet: Save is disabled
    assert.match(renderToStaticMarkup(React.createElement(PluginSettingsForm, { pluginId: 'e', decls: [], values: {}, onSave: async () => {} })), /no settings/);
  } finally { await server.close(); }
});

test('Settings > Plugins rows show version and status, gate admin controls, and never print secret values', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PluginRow } = await server.ssrLoadModule('/src/components/settings/plugins-section.tsx');
    const plugin = (over = {}) => ({ id: 'echo', name: 'Echo', version: '1.2.3', description: 'Echoes things.', scope: 'user', status: 'enabled', enabled: true, userEnabled: true, icon: 'IconPlug',
      secrets: [{ name: 'ECHO_TOKEN', required: true, present: true }, { name: 'ECHO_OPT', required: false, present: false }], settings: [], contributes: { views: [], taskSources: [], rightSidebarTabs: [], settingsPanel: false }, ...over });
    const row = (p, isAdmin) => renderToStaticMarkup(React.createElement(PluginRow, { plugin: p, isAdmin, busy: false, onToggleInstall() {}, onToggleUser() {} }));
    const admin = row(plugin(), true), member = row(plugin(), false);
    for (const html of [admin, member]) { assert.match(html, /Echo/); assert.match(html, /v1\.2\.3/); assert.match(html, />On</); assert.match(html, /On for me/); assert.match(html, /Configure/); }
    assert.match(admin, /for this runtime/); assert.doesNotMatch(member, /for this runtime/); // enable/disable is admin-only
    assert.match(row(plugin({ scope: 'install' }), false), /Whole runtime/);
    assert.doesNotMatch(row(plugin({ scope: 'install' }), false), /On for me/); // install scope has no per-user toggle
    assert.match(row(plugin({ status: 'disabled', enabled: false, userEnabled: false }), true), />Off</);
    assert.doesNotMatch(row(plugin({ status: 'disabled', enabled: false }), false), /On for me/);
    const invalid = row(plugin({ status: 'invalid', enabled: false, userEnabled: false, version: '', error: 'apiVersion must be 1' }), true);
    assert.match(invalid, /Invalid/); assert.match(invalid, /apiVersion must be 1/); assert.doesNotMatch(invalid, /Configure/);
    assert.match(row(plugin({ status: 'failed', enabled: false }), true), /failed to start/);
  } finally { await server.close(); }
});

const CRED_PLUGIN = (over = {}) => ({ id: 'waha', name: 'WhatsApp', scope: 'install', secrets: [{ name: 'WAHA_API_KEY', required: true, present: false }, { name: 'WAHA_OPT', required: false, present: true }], ...over });
const ROWS = (editable, over = {}) => [
  { name: 'WAHA_API_KEY', description: 'API key for the gateway.', required: true, present: false, updatedAt: null, scope: 'install', editable, ...over },
  { name: 'WAHA_OPT', description: '', required: false, present: true, updatedAt: '2026-01-01T00:00:00.000Z', scope: 'install', editable },
];

test('Credentials group: Present/Missing, required marker, Set/Replace/Remove for editors, no Open Secrets anywhere', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PluginCredentials } = await server.ssrLoadModule('/src/components/settings/plugin-credentials.tsx');
    const html = (props) => renderToStaticMarkup(React.createElement(PluginCredentials, { plugin: CRED_PLUGIN(), isAdmin: true, api: null, ...props }));
    const admin = html({ initialRows: ROWS(true) });
    assert.match(admin, /Credentials/); assert.match(admin, /WAHA_API_KEY/); assert.match(admin, /Missing/); assert.match(admin, /Present/);
    assert.match(admin, /Required/); assert.match(admin, /Optional/); assert.match(admin, /API key for the gateway\./);
    assert.match(admin, />Set</); assert.match(admin, />Replace</); assert.match(admin, />Remove</);
    assert.doesNotMatch(admin, /Open Secrets/); assert.doesNotMatch(admin, /Configured by an administrator/);
    // members: presence only, no action, a plain explanation
    const member = html({ isAdmin: false, initialRows: ROWS(false) });
    assert.match(member, /Configured by an administrator/); assert.match(member, /Missing/);
    assert.doesNotMatch(member, />Set<|>Replace<|>Remove<|type="password"/);
    // before the status call returns, presence comes from GET /v1/plugins and install scope follows the admin flag
    assert.match(html({ isAdmin: false }), /Configured by an administrator/);
    assert.match(html({}), />Set</);
    // user scope is the caller's own: editable even for a non-admin
    assert.match(html({ plugin: CRED_PLUGIN({ scope: 'user' }), isAdmin: false }), />Set</);
    assert.equal(html({ plugin: CRED_PLUGIN({ secrets: [] }) }), '');
  } finally { await server.close(); }
});

test('the value field is a write-only password input that starts empty', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PluginCredentials } = await server.ssrLoadModule('/src/components/settings/plugin-credentials.tsx');
    const html = renderToStaticMarkup(React.createElement(PluginCredentials, { plugin: CRED_PLUGIN(), isAdmin: true, api: null, initialRows: ROWS(true), initialEditing: 'WAHA_API_KEY' }));
    const input = html.match(/<input[^>]*type="password"[^>]*>/)?.[0];
    assert.ok(input, 'a password input is shown');
    assert.match(input, /autoComplete="off"|autocomplete="off"/i); assert.doesNotMatch(input, /value="[^"]+"/);
    assert.match(html, /Cancel/);
  } finally { await server.close(); }
});

test('after the response the draft is cleared and no value reaches state, markup or errors', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { submitCredential, PluginCredentials } = await server.ssrLoadModule('/src/components/settings/plugin-credentials.tsx');
    const SECRET = 'sk-live-TOPSECRET-123';
    const sent = []; let cleared = 0;
    const ok = await submitCredential({ setPluginSecret: async (...a) => { sent.push(a); } }, 'waha', 'WAHA_API_KEY', SECRET, () => { cleared += 1; });
    assert.equal(ok, ''); assert.deepEqual(sent, [['waha', 'WAHA_API_KEY', SECRET]]); assert.equal(cleared, 1);
    // failure: the server message is shown, the draft is cleared anyway, the value is not echoed
    const err = await submitCredential({ setPluginSecret: async () => { throw new Error('Only an administrator can change this'); } }, 'waha', 'WAHA_API_KEY', SECRET, () => { cleared += 1; });
    assert.equal(err, 'Only an administrator can change this'); assert.equal(cleared, 2); assert.ok(!err.includes(SECRET));
    // rows come from the status call only: even a value smuggled into a row prop never renders
    const html = renderToStaticMarkup(React.createElement(PluginCredentials, { plugin: CRED_PLUGIN(), isAdmin: true, api: null, initialRows: ROWS(true, { value: SECRET }) }));
    assert.ok(!html.includes(SECRET));
  } finally { await server.close(); }
});

test('Remove asks for confirmation, notices dismiss, and Open Secrets is gone from the plugin settings source', () => {
  const cred = fs.readFileSync('src/components/settings/plugin-credentials.tsx', 'utf8');
  assert.match(cred, /<AlertDialog open=\{removing !== null\}/); // the delete call only runs from the dialog's action
  assert.match(cred, /onClick=\{\(\) => \{ if \(removing\) void remove\(removing\); \}\}/);
  assert.match(cred, /onRemove=\{\(\) => setRemoving\(row\.name\)\}/); assert.doesNotMatch(cred, /onRemove=\{\(\) => void remove/);
  assert.match(cred, /setDraft\(""\)/); // cleared on unmount, cancel and after every response
  const sec = fs.readFileSync('src/components/settings/plugins-section.tsx', 'utf8');
  assert.doesNotMatch(sec, /Open Secrets|openSecrets|SecretsStatus/);
  assert.match(sec, /dismissPluginSecretMigrations\(\)/);
  const page = fs.readFileSync('src/components/secrets/secrets-page.tsx', 'utf8');
  assert.match(page, /getPluginSecretMigrations/); assert.match(page, /dismissPluginSecretMigrations/);
  assert.doesNotMatch(page, /getPluginSecrets\(/); // the Secrets page never reads plugin secrets
});

test('migration notices list names only and carry a Dismiss action', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { MigrationNotice, MovedSecretsNotice } = await server.ssrLoadModule('/src/components/settings/plugin-credentials.tsx');
    const items = [{ pluginName: 'Movidesk', name: 'MOVIDESK_TOKEN', keptInVault: false }, { pluginName: 'WhatsApp', name: 'WAHA_API_KEY', keptInVault: true }];
    const a = renderToStaticMarkup(React.createElement(MigrationNotice, { items, onDismiss() {} }));
    assert.match(a, /Credentials migrated from Secrets/); assert.match(a, /MOVIDESK_TOKEN/); assert.match(a, /Movidesk/); assert.match(a, /Dismiss/);
    const b = renderToStaticMarkup(React.createElement(MovedSecretsNotice, { items, onDismiss() {} }));
    assert.match(b, /MOVIDESK_TOKEN<\/code> moved to Settings &gt; Plugins &gt; Movidesk/); assert.match(b, /kept here because another tool still uses it/); assert.match(b, /Dismiss/);
    assert.equal(renderToStaticMarkup(React.createElement(MigrationNotice, { items: [], onDismiss() {} })), '');
    assert.equal(renderToStaticMarkup(React.createElement(MovedSecretsNotice, { items: [], onDismiss() {} })), '');
  } finally { await server.close(); }
});

test('client methods follow the contract and never keep a value', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
  const { RuntimeClient } = await server.ssrLoadModule('/src/lib/runtime/client.ts');
  const calls = [];
  const c = new RuntimeClient('http://x.test', 't');
  c.call = async (method, path, body) => { calls.push([method, path, body]); return { secrets: [], items: [] }; };
  await c.getPluginSecrets('a b'); await c.setPluginSecret('p', 'N_1', 'v'); await c.deletePluginSecret('p', 'N_1'); await c.getPluginSecretMigrations(); await c.dismissPluginSecretMigrations();
  assert.deepEqual(calls, [
    ['GET', '/v1/plugins/a%20b/secrets', undefined], ['PUT', '/v1/plugins/p/secrets/N_1', { value: 'v' }], ['DELETE', '/v1/plugins/p/secrets/N_1', undefined],
    ['GET', '/v1/plugins/secret-migrations', undefined], ['POST', '/v1/plugins/secret-migrations/dismiss', undefined]]);
  } finally { await server.close(); }
});

test('the settings dialog lists Plugins in the General group and admin gating uses the shared hook', () => {
  const dlg = fs.readFileSync('src/components/settings/settings-dialog.tsx', 'utf8');
  const general = dlg.slice(dlg.indexOf('title: "General"'), dlg.indexOf('title: "Agents"'));
  assert.match(general, /id: "plugins", label: "Plugins"/);
  assert.match(dlg, /section === "plugins"\) content = <PluginsSection \/>/);
  const sec = fs.readFileSync('src/components/settings/plugins-section.tsx', 'utf8');
  assert.match(sec, /useIsAdmin\(\)/);
  assert.doesNotMatch(sec, /\.value\b/); // the section never reads a secret value
});
