import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};

const prefs = await import('../src/lib/user-preferences.ts');

test('preferences stay isolated by runtime and account', () => {
  prefs.saveUserPreferences('https://one.example', 'user-a', { activeTeamId: 'team-a', sidebarOpen: false });
  prefs.saveUserPreferences('https://one.example', 'user-b', { activeTeamId: 'team-b' });
  prefs.saveUserPreferences('https://two.example', 'user-a', { activeTeamId: 'team-c' });
  assert.equal(prefs.loadUserPreferences('https://one.example', 'user-a').activeTeamId, 'team-a');
  assert.equal(prefs.loadUserPreferences('https://one.example', 'user-b').activeTeamId, 'team-b');
  assert.equal(prefs.loadUserPreferences('https://two.example', 'user-a').activeTeamId, 'team-c');
  assert.equal(prefs.loadUserPreferences('https://one.example', 'user-a').sidebarOpen, false);
});

test('partial patches retain current values even when storage reads and writes fail', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try {
    const first = prefs.saveUserPreferences('https://runtime.example', 'user', { sidebarOpen: false });
    const second = prefs.saveUserPreferences('https://runtime.example', 'user', { activeTeamId: 'team-1' }, first);
    assert.equal(second.sidebarOpen, false);
    assert.equal(second.activeTeamId, 'team-1');
  } finally { globalThis.localStorage = original; }
});

test('malformed preference JSON falls back to defaults without affecting another scope', () => {
  const key = prefs.userPreferenceKey('https://runtime.example', 'broken-user');
  values.set(key, '{');
  assert.deepEqual(prefs.loadUserPreferences('https://runtime.example', 'broken-user'), prefs.USER_PREFERENCE_DEFAULTS);
  assert.notEqual(prefs.loadUserPreferences('https://runtime.example', 'broken-user').activeTeamId, 'team-1');
});
