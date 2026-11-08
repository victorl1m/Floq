import test from 'node:test';
import assert from 'node:assert/strict';

// Generic plugin host behaviour (toast frames, owner-only nav). The Movidesk / Azure DevOps / WAHA specific tests live in their own repositories.

test('plugin toasts reach the host on any screen and ignore malformed frames', async () => {
  const { dispatchPluginFrame, subscribePluginToasts } = await import('../../src/plugins/events.ts');
  const got = [];
  const off = subscribePluginToasts((t) => got.push(t));
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 'WhatsApp: Ana', description: 'Oi' } });
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 5 } });
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: null });
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 'x'.repeat(500), description: 'd'.repeat(500) } });
  off();
  dispatchPluginFrame({ type: 'plugin', pluginId: 'waha', name: 'toast', data: { title: 'after off' } });
  assert.deepEqual(got.map((t) => [t.pluginId, t.title.length, t.description?.length]), [['waha', 13, 2], ['waha', 120, 300]]);
  assert.equal(got[0].title, 'WhatsApp: Ana');
});

test('an owner-only install plugin: its nav entry shows only for the user the server says can use it', async () => {
  const { activeContributions } = await import('../../src/plugins/registry.ts');
  const m = { name: 'Inbox', version: '1.0.0', description: 'An owner-only inbox.', contributes: { views: [{ id: 'inbox', label: 'Inbox', icon: 'IconInbox' }] } }; // manifest fields the nav needs; `access: owner` is decided by the server (userEnabled)
  const info = (userEnabled) => ({ id: 'demo', name: m.name, version: m.version, description: m.description, scope: 'install', status: 'enabled', enabled: true, userEnabled, secrets: [], settings: [], contributes: { views: m.contributes.views, taskSources: [], rightSidebarTabs: [], settingsPanel: false } });
  const ui = { demo: { views: { inbox: () => null } } };
  assert.deepEqual(activeContributions([info(true)], ui).views.map((v) => `${v.pluginId}/${v.viewId}`), ['demo/inbox']); // the admin who set it up
  assert.deepEqual(activeContributions([info(false)], ui).views, []); // everyone else: no nav entry
});
