import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFolderDoc } from '../src/projectFolders.js';
const base = {
  folders: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  root: [{ kind: 'folder', id: 'a' }], membership: { b: ['p'] }, expanded: {},
  children: { a: [{ kind: 'folder', id: 'b' }], b: [{ kind: 'project', id: 'p' }] },
};
test('runtime preserves nested folder ordering and rejects cycles', () => {
  assert.deepEqual((validateFolderDoc(base) as any).children, base.children);
  assert.throws(() => validateFolderDoc({ ...base, root: [], children: { a: [{ kind: 'folder', id: 'b' }], b: [{ kind: 'folder', id: 'a' }] } }));
});

test('pruning a deleted project removes it from nested children', async () => {
  const { pruneProjectFromFolders } = await import('../src/projectFolders.js');
  let saved: any;
  const db = { async query(sql: string, params?: unknown[]) {
    if (sql.startsWith('SELECT')) return { rows: [{ version: 1, doc: base }] };
    saved = JSON.parse(params![1] as string); return { rows: [] };
  } };
  await pruneProjectFromFolders(db as never, 'user', 'p');
  assert.deepEqual(saved.children.b, []);
});
