import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = { getItem: (k) => values.has(k) ? values.get(k) : null, setItem: (k, v) => values.set(k, String(v)) };
globalThis.window = new EventTarget();
const m = await import('../src/lib/project-folders.ts');

const base = () => m.reconcileLayout(null, ['a', 'b', 'c', 'd'], ['f1', 'f2']);
const flat = (l) => JSON.stringify({ r: l.root.map((e) => `${e.kind[0]}:${e.id}`), f: l.folders });

test('reconcile seeds legacy folders, appends unseen, no duplicates', () => {
  const l = m.reconcileLayout(null, ['a', 'b', 'c'], ['f1'], (id) => id === 'b' ? 'f1' : null);
  assert.equal(flat(l), flat({ root: [{ kind: 'project', id: 'a' }, { kind: 'project', id: 'c' }, { kind: 'folder', id: 'f1' }], folders: { f1: ['b'] } }));
});

test('stale project and folder ids are dropped, new projects appended', () => {
  const saved = { root: [{ kind: 'project', id: 'gone' }, { kind: 'folder', id: 'f1' }, { kind: 'project', id: 'a' }, { kind: 'project', id: 'a' }], folders: { f1: ['b', 'gone', 'a'], dead: ['c'] } };
  const l = m.reconcileLayout(saved, ['a', 'b', 'c'], ['f1']);
  assert.equal(flat(l), flat({ root: [{ kind: 'folder', id: 'f1' }, { kind: 'project', id: 'a' }, { kind: 'project', id: 'c' }], folders: { f1: ['b'] } }));
  const all = [...l.root.filter((e) => e.kind === 'project').map((e) => e.id), ...Object.values(l.folders).flat()];
  assert.equal(new Set(all).size, all.length);
});

test('move into folder, within folder, and back to root', () => {
  let l = base();
  l = m.applyDrop(l, { kind: 'project', id: 'a' }, { type: 'folder', id: 'f1', edge: 'into' });
  l = m.applyDrop(l, { kind: 'project', id: 'b' }, { type: 'folder', id: 'f1', edge: 'into' });
  assert.deepEqual(l.folders.f1, ['b', 'a']);
  l = m.applyDrop(l, { kind: 'project', id: 'b' }, { type: 'project', id: 'a', edge: 'after' });
  assert.deepEqual(l.folders.f1, ['a', 'b']);
  l = m.applyDrop(l, { kind: 'project', id: 'a' }, { type: 'root-end' });
  assert.deepEqual(l.folders.f1, ['b']);
  assert.equal(l.root.at(-1).id, 'a');
  assert.equal(m.containerOf(l, 'a'), null);
  assert.equal(m.containerOf(l, 'b'), 'f1');
});

test('move between folders and into an empty folder', () => {
  let l = m.moveProjectInto(base(), 'a', 'f1');
  l = m.applyDrop(l, { kind: 'project', id: 'a' }, { type: 'empty-folder', id: 'f2' });
  assert.deepEqual(l.folders, { f1: [], f2: ['a'] });
});

test('project before/after root project and folder', () => {
  let l = base();
  l = m.applyDrop(l, { kind: 'project', id: 'd' }, { type: 'project', id: 'a', edge: 'before' });
  assert.equal(l.root[0].id, 'd');
  l = m.applyDrop(l, { kind: 'project', id: 'd' }, { type: 'folder', id: 'f2', edge: 'after' });
  assert.equal(l.root.at(-1).id, 'd');
  assert.equal(l.root.at(-2).id, 'f2');
});

test('folders can reorder inside folders while self, cycles, and invalid drops are no-ops', () => {
  const l = base();
  const r = m.applyDrop(l, { kind: 'folder', id: 'f2' }, { type: 'project', id: 'a', edge: 'before' });
  assert.equal(r.root[0].id, 'f2');
  assert.equal(m.applyDrop(l, { kind: 'folder', id: 'f1' }, { type: 'folder', id: 'f1', edge: 'before' }), l);
  assert.equal(m.applyDrop(l, { kind: 'project', id: 'a' }, { type: 'project', id: 'a', edge: 'after' }), l);
  const inner = m.moveProjectInto(l, 'a', 'f1');
  const nested = m.applyDrop(inner, { kind: 'folder', id: 'f2' }, { type: 'project', id: 'a', edge: 'before' });
  assert.deepEqual(nested.children.f1, [{ kind: 'folder', id: 'f2' }, { kind: 'project', id: 'a' }]);
  const nestedFolder = m.applyDrop(l, { kind: 'folder', id: 'f1' }, { type: 'folder', id: 'f2', edge: 'into' });
  assert.deepEqual(nestedFolder.children.f2, [{ kind: 'folder', id: 'f1' }]);
  assert.equal(m.moveProjectInto(l, 'a', 'missing'), l);
});

test('add and ungroup (remove) folder keeps projects in place order', () => {
  let l = m.reconcileLayout({ root: [{ kind: 'project', id: 'a' }, { kind: 'folder', id: 'f1' }, { kind: 'project', id: 'd' }], folders: { f1: ['b', 'c'] } }, ['a', 'b', 'c', 'd'], ['f1']);
  l = m.removeFolderFromLayout(l, 'f1');
  assert.equal(flat(l), flat({ root: ['a', 'b', 'c', 'd'].map((id) => ({ kind: 'project', id })), folders: {} }));
  l = m.addFolder(l, 'n');
  assert.deepEqual(l.folders.n, []);
  assert.equal(l.root.at(-1).id, 'n');
});

test('persistence round trip, migration and corrupt data', () => {
  const l = m.moveProjectInto(base(), 'c', 'f2');
  m.saveLayout('rt:u', l);
  const loaded = m.parseLayout(m.readLayoutRaw('rt:u'));
  assert.equal(flat(loaded), flat(l));
  assert.equal(m.parseLayout(null), null);
  assert.equal(m.parseLayout('{nope'), null);
  assert.equal(m.parseLayout('{"version":2,"root":[]}'), null);
  const messy = m.parseLayout('{"version":1,"root":[{"kind":"x","id":"a"},{"kind":"project","id":"b"},5],"folders":{"f":["z",3],"g":"no"}}');
  assert.equal(flat(messy), flat({ root: [{ kind: 'project', id: 'b' }], folders: { f: ['z'] } }));
  assert.equal(m.readLayoutRaw('other'), null);
});

test('nested folder moves preserve descendants, reject cycles, and promote children', () => {
  let l = m.reconcileLayout(null, ['p'], ['a', 'b']);
  l = m.applyDrop(l, { kind: 'folder', id: 'b' }, { type: 'folder', id: 'a', edge: 'into' });
  l = m.moveProjectInto(l, 'p', 'b');
  assert.deepEqual(l.children.a, [{ kind: 'folder', id: 'b' }]);
  assert.deepEqual(l.children.b, [{ kind: 'project', id: 'p' }]);
  assert.equal(m.applyDrop(l, { kind: 'folder', id: 'a' }, { type: 'folder', id: 'b', edge: 'into' }), l);
  l = m.removeFolderFromLayout(l, 'a');
  assert.deepEqual(l.root, [{ kind: 'folder', id: 'b' }]);
  assert.deepEqual(l.children.b, [{ kind: 'project', id: 'p' }]);
});
