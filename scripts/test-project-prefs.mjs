import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.window = new EventTarget();

const prefs = await import('../src/lib/prefs.ts');
const { composeProjectEntries, sessionsForWorkspace } = await import('../src/lib/runtime/projects.ts');
const { normalizeProjectImageUrl, projectFaviconUrl } = await import('../src/lib/runtime/project-appearance.ts');
const { legacyPrefsForProject, canonicalProjectPrefsMigrationKey } = prefs;

const cloneUrl = 'https://github.com/example/demo-repo.git';
const clonedSession = (id, cwd, gitUrl = cloneUrl) => ({ id, provider: 'codex', title: id, state: 'running', cwd, gitUrl });

test('imported projects persist by runtime and account with stable snapshots', () => {
  const one = prefs.projectScope('https://runtime-a.test', 'user-a');
  const two = prefs.projectScope('https://runtime-b.test', 'user-a');
  const repo = { label: 'example/demo-repo', url: 'https://github.com/example/demo-repo.git' };
  prefs.addRecentRepo(repo, one);
  assert.equal(prefs.loadRecentRepos(one)[0].label, repo.label);
  assert.deepEqual(prefs.loadRecentRepos(two), []);
  assert.equal(prefs.loadRecentRepos(one), prefs.loadRecentRepos(one));

  prefs.linkRepoWorkspace(repo.url, 'workspace/abcd1234', one);
  prefs.renameRecentRepo(repo.url, 'Demo Repo', one);
  prefs.saveProjectFolders(one, [{ id: 'folder-a', name: 'Client work' }]);
  prefs.moveRecentRepo(repo.url, 'folder-a', one);
  assert.equal(prefs.loadRecentRepos(one)[0].workspaceCwds[0], 'workspace/abcd1234');
  assert.equal(prefs.loadRecentRepos(one)[0].displayLabel, 'Demo Repo');
  assert.equal(prefs.loadRecentRepos(one)[0].folderId, 'folder-a');
  assert.equal(prefs.loadProjectFolders(one), prefs.loadProjectFolders(one));

  prefs.updateWorkspaceProject('src/project', { displayLabel: 'Project name', folderId: 'folder-a' }, one);
  assert.equal(prefs.loadWorkspaceProjectMeta(one), prefs.loadWorkspaceProjectMeta(one));
  assert.deepEqual(prefs.loadWorkspaceProjectMeta(one), [{ cwd: 'src/project', displayLabel: 'Project name', folderId: 'folder-a' }]);

  prefs.removeProjectFolder(one, 'folder-a');
  assert.deepEqual(prefs.loadProjectFolders(one), []);
  assert.equal(prefs.loadRecentRepos(one)[0].folderId, null);
  assert.equal(prefs.loadWorkspaceProjectMeta(one)[0].folderId, null);
  prefs.removeRecentRepo(repo.url, one);
  assert.deepEqual(prefs.loadRecentRepos(one), []);
});

test('legacy repo recents migrate to only the first signed-in scope', () => {
  localStorage.setItem('floq.recentRepos', JSON.stringify([{ label: 'old/repo', url: 'https://example.com/old/repo.git' }]));
  assert.equal(prefs.loadRecentRepos('runtime:user-one')[0].label, 'old/repo');
  assert.deepEqual(prefs.loadRecentRepos('runtime:user-two'), []);
  assert.equal(localStorage.getItem('floq.recentRepos'), '[]');
});

test('project images accept only credential-free HTTP(S) URLs and resolve same-site favicons', () => {
  assert.equal(normalizeProjectImageUrl(' https://images.example.test/project.png '), 'https://images.example.test/project.png');
  assert.equal(normalizeProjectImageUrl('javascript:alert(1)'), null);
  assert.equal(normalizeProjectImageUrl('data:image/png;base64,abc'), null);
  assert.equal(normalizeProjectImageUrl('https://user:pass@example.test/image.png'), null);
  assert.equal(normalizeProjectImageUrl('/relative/image.png'), null);
  assert.equal(projectFaviconUrl('https://example.test/team/project'), 'https://example.test/favicon.ico');
  assert.equal(projectFaviconUrl('file:///etc/passwd'), null);
});

test('canonical project folder assignments are scoped and cleared when a folder is removed', () => {
  const one = prefs.projectScope('https://runtime-a.test', 'user-a');
  const two = prefs.projectScope('https://runtime-a.test', 'user-b');
  prefs.saveProjectFolders(one, [{ id: 'folder-canonical', name: 'Team' }]);
  prefs.updateCanonicalProjectMeta('project-1', { folderId: 'folder-canonical' }, one);
  prefs.updateCanonicalProjectMeta('project-2', { folderId: null }, one);
  assert.deepEqual(prefs.loadCanonicalProjectMeta(one), [
    { projectId: 'project-1', folderId: 'folder-canonical' },
    { projectId: 'project-2', folderId: null },
  ]);
  assert.deepEqual(prefs.loadCanonicalProjectMeta(two), []);
  prefs.removeProjectFolder(one, 'folder-canonical');
  assert.deepEqual(prefs.loadCanonicalProjectMeta(one), [
    { projectId: 'project-1', folderId: null },
    { projectId: 'project-2', folderId: null },
  ]);
});

test('canonical migration maps old repo names and folder IDs through git URL or workspace cwd', () => {
  const project = { cwd: 'workspace/project-root', gitUrl: cloneUrl, workspaces: [{ cwd: 'workspace/feature-worktree' }] };
  const repoPrefs = legacyPrefsForProject(project, [{ label: 'old label', url: cloneUrl, displayLabel: 'Demo', folderId: 'personal' }], []);
  assert.deepEqual(repoPrefs, { displayName: 'Demo', folderId: 'personal' });
  const cwdPrefs = legacyPrefsForProject(
    { ...project, gitUrl: null },
    [],
    [{ cwd: 'workspace/feature-worktree', displayLabel: 'Feature work', folderId: 'personal' }],
  );
  assert.deepEqual(cwdPrefs, { displayName: 'Feature work', folderId: 'personal' });
  assert.notEqual(canonicalProjectPrefsMigrationKey('runtime-a:user-a'), canonicalProjectPrefsMigrationKey('runtime-a:user-b'));
  assert.notEqual(canonicalProjectPrefsMigrationKey('runtime-a:user-a'), canonicalProjectPrefsMigrationKey('runtime-b:user-a'));
});

test('canonical sidebar workspace rows resolve only their own project sessions', () => {
  const sessions = [
    { id: 'main', projectId: 'project-1', worktreeId: 'workspace-main', cwd: '/repo', provider: 'codex' },
    { id: 'worktree', projectId: 'project-1', worktreeId: 'workspace-feature', cwd: '/repo/.floq/worktrees/feature', provider: 'claude' },
    { id: 'other-project', projectId: 'project-2', worktreeId: 'workspace-feature', cwd: '/repo/.floq/worktrees/feature', provider: 'claude' },
    { id: 'legacy-linked', projectId: null, cwd: '/repo', provider: 'codex' },
  ];
  const main = sessionsForWorkspace('project-1', { id: 'workspace-main', cwd: '/repo', sessionIds: ['legacy-linked'] }, sessions);
  const feature = sessionsForWorkspace('project-1', { id: 'workspace-feature', cwd: '/repo/.floq/worktrees/feature', sessionIds: [] }, sessions);
  assert.deepEqual(main.map((session) => session.id), ['main', 'legacy-linked']);
  assert.deepEqual(feature.map((session) => session.id), ['worktree']);
});

test('sidebar project grouping keeps empty imports and cloned workspace IDs out of Scratch', () => {
  const repo = { label: 'example/demo-repo', url: cloneUrl };
  const empty = composeProjectEntries([], [repo], [], []);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].label, repo.label);
  assert.deepEqual(empty[0].sessions, []);

  const entries = composeProjectEntries(
    [clonedSession('clone-1', 'workspace/deadbeef'), clonedSession('personal', 'workspace/abc12345', null)],
    [repo],
    [],
    [],
  );
  assert.equal(entries.length, 2);
  const cloned = entries.find((entry) => entry.repo?.url === cloneUrl);
  assert.equal(cloned.label, repo.label);
  assert.equal(cloned.cwd, 'workspace/deadbeef');
  assert.deepEqual(cloned.sessions.map((session) => session.id), ['clone-1']);
  assert.equal(entries.find((entry) => entry.id === 'scratch').label, 'Scratch');

  const invalidFolder = composeProjectEntries([], [{ ...repo, folderId: 'deleted-folder' }], [], []);
  assert.equal(invalidFolder[0].folderId, null);
});
