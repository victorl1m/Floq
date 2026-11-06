import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const F = await import('../src/plugins/settings-form.ts');
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
    const { PluginRow, SecretsStatus } = await server.ssrLoadModule('/src/components/settings/plugins-section.tsx');
    const plugin = (over = {}) => ({ id: 'echo', name: 'Echo', version: '1.2.3', description: 'Echoes things.', scope: 'user', status: 'enabled', enabled: true, userEnabled: true, icon: 'IconPlug',
      secrets: [{ name: 'ECHO_TOKEN', required: true, present: true }, { name: 'ECHO_OPT', required: false, present: false }], settings: [], contributes: { views: [], taskSources: [], rightSidebarTabs: [], settingsPanel: false }, ...over });
    const row = (p, isAdmin) => renderToStaticMarkup(React.createElement(PluginRow, { plugin: p, isAdmin, busy: false, onToggleInstall() {}, onToggleUser() {}, onOpenSecrets() {} }));
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
    const secrets = renderToStaticMarkup(React.createElement(SecretsStatus, { plugin: plugin(), onOpenSecrets() {} }));
    assert.match(secrets, /ECHO_TOKEN/); assert.match(secrets, /Present/); assert.match(secrets, /Missing/); assert.match(secrets, /Open Secrets/); assert.match(secrets, /never displayed/);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(SecretsStatus, { plugin: plugin({ secrets: [{ name: 'A', required: true, present: true }] }), onOpenSecrets() {} })), /Open Secrets/); // nothing missing: no action
  } finally { await server.close(); }
});

test('install-scope secrets: non-admins are told to ask an administrator instead of being sent to their own Secrets', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SecretsStatus } = await server.ssrLoadModule('/src/components/settings/plugins-section.tsx');
    const plugin = { id: 'waha', name: 'WhatsApp', scope: 'install', secrets: [{ name: 'WAHA_API_KEY', required: true, present: false }] };
    const html = (isAdmin) => renderToStaticMarkup(React.createElement(SecretsStatus, { plugin, isAdmin, onOpenSecrets() {} }));
    assert.match(html(false), /An administrator needs to add WAHA_API_KEY/); assert.doesNotMatch(html(false), /Open Secrets/);
    assert.match(html(true), /Open Secrets/); assert.doesNotMatch(html(true), /An administrator needs/);
    const user = renderToStaticMarkup(React.createElement(SecretsStatus, { plugin: { ...plugin, scope: 'user' }, isAdmin: false, onOpenSecrets() {} }));
    assert.match(user, /Open Secrets/); // user-scope secrets are the user's own
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

test('Open Secrets leaves the settings dialog and lands on the Secrets view (not Account)', () => {
  const sec = fs.readFileSync('src/components/settings/plugins-section.tsx', 'utf8');
  assert.match(sec, /setSettingsOpen\(false\); openSecrets\(\)/);
  assert.doesNotMatch(sec, /openSettings\("secrets"\)/);
});
