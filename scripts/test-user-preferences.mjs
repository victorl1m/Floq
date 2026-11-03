import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};

const prefs = await import('../src/lib/user-preferences.ts');

test('preferences stay isolated by runtime and account', () => {
  prefs.saveUserPreferences('https://one.example', 'user-a', { activeOrganizationId: 'organization-a', sidebarOpen: false });
  prefs.saveUserPreferences('https://one.example', 'user-b', { activeOrganizationId: 'organization-b' });
  prefs.saveUserPreferences('https://two.example', 'user-a', { activeOrganizationId: 'organization-c' });
  assert.equal(prefs.loadUserPreferences('https://one.example', 'user-a').activeOrganizationId, 'organization-a');
  assert.equal(prefs.loadUserPreferences('https://one.example', 'user-b').activeOrganizationId, 'organization-b');
  assert.equal(prefs.loadUserPreferences('https://two.example', 'user-a').activeOrganizationId, 'organization-c');
  assert.equal(prefs.loadUserPreferences('https://one.example', 'user-a').sidebarOpen, false);
});

test('partial patches retain current values even when storage reads and writes fail', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try {
    const first = prefs.saveUserPreferences('https://runtime.example', 'user', { sidebarOpen: false });
    const second = prefs.saveUserPreferences('https://runtime.example', 'user', { activeOrganizationId: 'organization-1' }, first);
    assert.equal(second.sidebarOpen, false);
    assert.equal(second.activeOrganizationId, 'organization-1');
  } finally { globalThis.localStorage = original; }
});

test('navigation expansion patches retain runtime/user scope and ignore malformed map entries', () => {
  const baseUrl = 'https://runtime.example';
  const userId = 'nav-user';
  const first = prefs.saveUserPreferences(baseUrl, userId, {
    projectNavExpanded: { 'project-a': false },
    workspaceNavExpanded: { 'project-a:branch-a': false },
  });
  const next = prefs.saveUserPreferences(baseUrl, userId, {
    folderNavExpanded: { 'folder-a': false },
  }, first);
  assert.deepEqual(next.projectNavExpanded, { 'project-a': false });
  assert.deepEqual(next.workspaceNavExpanded, { 'project-a:branch-a': false });
  assert.equal(prefs.loadUserPreferences(baseUrl, userId).folderNavExpanded['folder-a'], false);
  const key = prefs.userPreferenceKey(baseUrl, userId);
  values.set(key, JSON.stringify({ version: 1, projectNavExpanded: { valid: false, invalid: 'no' } }));
  assert.deepEqual(prefs.loadUserPreferences(baseUrl, userId).projectNavExpanded, { valid: false });
});

test('malformed preference JSON falls back to defaults without affecting another scope', () => {
  const key = prefs.userPreferenceKey('https://runtime.example', 'broken-user');
  values.set(key, '{');
  assert.deepEqual(prefs.loadUserPreferences('https://runtime.example', 'broken-user'), prefs.USER_PREFERENCE_DEFAULTS);
  assert.notEqual(prefs.loadUserPreferences('https://runtime.example', 'broken-user').activeOrganizationId, 'organization-1');
});
