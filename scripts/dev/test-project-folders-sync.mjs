import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../../src/lib/project-folders-sync.ts');
const P = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const doc = (over = {}) => ({ folders: [{ id: 'f1', name: 'Work' }], root: [{ kind: 'folder', id: 'f1' }, { kind: 'project', id: P(1) }], membership: { f1: [P(2)] }, expanded: {}, ...over });

/** In-memory server with the same optimistic-concurrency contract as PUT /v1/project-folders. */
function server(initial = null) {
  const s = { version: initial ? 1 : 0, doc: initial, puts: 0, fail: 0, failWith: Object.assign(new Error('Runtime unreachable'), { status: 0 }) };
  s.api = {
    async get() { return { version: s.version, doc: s.doc ? structuredClone(s.doc) : null }; },
    async put(version, d) {
      if (s.fail > 0) { s.fail--; throw s.failWith; }
      s.puts++;
      if (version !== s.version) throw Object.assign(new Error('conflict'), { status: 409, code: 'version_conflict' });
      s.version++; s.doc = structuredClone(d);
      return { version: s.version, doc: structuredClone(s.doc) };
    },
  };
  return s;
}

function device(srv, { local = m.EMPTY_DOC, meta = null } = {}) {
  const timers = []; let now = 0;
  const d = { local: structuredClone(local), meta, backups: [], failures: [], remoteApplied: 0, timers };
  const sync = new m.FolderSync({
    api: srv.api,
    local: { read: () => structuredClone(d.local), write: (v) => { d.local = structuredClone(v); sync.notifyLocalChange(); /* the UI event fires synchronously */ } },
    meta: { load: () => d.meta, save: (v) => { d.meta = structuredClone(v); } },
    timers: { set: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; }, clear: (t) => { if (t) t.live = false; } },
    backup: (v) => d.backups.push(v),
    onRepeatedFailure: (e) => d.failures.push(e),
    onRemoteApplied: () => { d.remoteApplied++; },
  });
  d.sync = sync;
  d.edit = (fn) => { d.local = fn(structuredClone(d.local)); sync.notifyLocalChange(); };
  /** Fire the next pending timer (debounce or backoff) and wait for the work it starts. */
  d.tick = async () => { const t = timers.find((x) => x.live); assert.ok(t, 'a timer is pending'); t.live = false; now = t.at; t.fn(); await new Promise((r) => setImmediate(r)); await sync.chain; await new Promise((r) => setImmediate(r)); };
  d.pending = () => timers.filter((x) => x.live).length;
  return d;
}

test('migration: server empty + local folders -> pushed once, idempotent on the next load', async () => {
  const srv = server();
  const a = device(srv, { local: doc() });
  await a.sync.pull();
  assert.equal(srv.version, 1);
  assert.ok(m.docsEqual(srv.doc, doc()));
  assert.equal(a.meta.dirty, false);
  assert.equal(a.meta.version, 1);
  await a.sync.pull(); // second load: nothing to do
  assert.equal(srv.puts, 1);
});

test('empty server + empty local: nothing is written', async () => {
  const srv = server();
  const a = device(srv);
  await a.sync.pull();
  assert.equal(srv.puts, 0);
  assert.equal(srv.version, 0);
});

test('a fresh device (cleared storage / reinstall) receives the server layout', async () => {
  const srv = server(doc());
  const a = device(srv);
  await a.sync.pull();
  assert.ok(m.docsEqual(a.local, doc()));
  assert.equal(a.backups.length, 0);
  assert.equal(srv.puts, 0, 'applying the server state must not echo back');
  assert.equal(a.pending(), 0);
});

test('a device with its own never-synced layout is backed up, then adopts the server layout', async () => {
  const srv = server(doc());
  const mine = doc({ folders: [{ id: 'old', name: 'Legacy' }], root: [{ kind: 'folder', id: 'old' }], membership: {} });
  const a = device(srv, { local: mine });
  await a.sync.pull();
  assert.equal(a.backups.length, 1);
  assert.ok(m.docsEqual(a.backups[0], mine));
  assert.ok(m.docsEqual(a.local, doc()));
  assert.equal(srv.puts, 0);
});

test('edits are debounced into one save', async () => {
  const srv = server(doc());
  const a = device(srv);
  await a.sync.pull();
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'W1' }] }));
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'W2' }] }));
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'W3' }] }));
  assert.equal(srv.puts, 0);
  assert.equal(a.meta.dirty, true);
  await a.tick();
  assert.equal(srv.puts, 1);
  assert.equal(srv.doc.folders[0].name, 'W3');
  assert.equal(a.meta.dirty, false);
  assert.equal(a.meta.version, 2);
});

test('flush(keepalive) sends pending edits immediately without waiting for the debounce', async () => {
  const srv = server(doc());
  const a = device(srv);
  await a.sync.pull();
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'Quick' }] }));
  await a.sync.flush({ keepalive: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(srv.doc.folders[0].name, 'Quick');
});

test('conflict: two devices edit different things; both survive', async () => {
  const srv = server(doc());
  const a = device(srv);
  const b = device(srv);
  await a.sync.pull(); await b.sync.pull();
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'Renamed on A' }] }));
  await a.tick();
  // B is stale (version 1) and adds a folder + moves a project.
  b.edit((d) => ({ ...d, folders: [...d.folders, { id: 'f2', name: 'New on B' }], root: [...d.root, { kind: 'folder', id: 'f2' }], membership: { f1: [] , f2: [P(2)] } }));
  await b.tick();
  assert.equal(srv.version, 3);
  assert.equal(srv.doc.folders.find((f) => f.id === 'f1').name, 'Renamed on A');
  assert.ok(srv.doc.folders.some((f) => f.id === 'f2'));
  assert.deepEqual(srv.doc.membership.f2, [P(2)]);
  assert.ok(m.docsEqual(b.local, srv.doc), 'B converged on the merged result');
  // A picks the merge up on its next pull without pushing anything.
  const puts = srv.puts;
  await a.sync.pull();
  assert.ok(m.docsEqual(a.local, srv.doc));
  assert.equal(srv.puts, puts);
});

test('conflict on the same folder: the device that saves last keeps its name; unchanged local never clobbers the server', async () => {
  const srv = server(doc());
  const a = device(srv);
  const b = device(srv);
  await a.sync.pull(); await b.sync.pull();
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'A' }] }));
  await a.tick();
  b.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'B' }] }));
  await b.tick();
  assert.equal(srv.doc.folders[0].name, 'B');
  // C never edited: pulling the server wins, no put.
  const c = device(srv, { local: doc(), meta: { version: 1, base: doc(), dirty: false } });
  const puts = srv.puts;
  await c.sync.pull();
  assert.equal(c.local.folders[0].name, 'B');
  assert.equal(srv.puts, puts);
});

test('a folder deleted on another device stays deleted; a folder added here is kept', async () => {
  const srv = server(doc({ folders: [{ id: 'f1', name: 'Work' }, { id: 'f2', name: 'Play' }], root: [{ kind: 'folder', id: 'f1' }, { kind: 'folder', id: 'f2' }], membership: {} }));
  const a = device(srv); const b = device(srv);
  await a.sync.pull(); await b.sync.pull();
  a.edit((d) => ({ ...d, folders: d.folders.filter((f) => f.id !== 'f2'), root: d.root.filter((e) => e.id !== 'f2') }));
  await a.tick();
  b.edit((d) => ({ ...d, folders: [...d.folders, { id: 'f3', name: 'Added on B' }], root: [...d.root, { kind: 'folder', id: 'f3' }] }));
  await b.tick();
  assert.deepEqual(srv.doc.folders.map((f) => f.id).sort(), ['f1', 'f3']);
  assert.ok(srv.doc.root.every((e) => e.kind !== 'folder' || ['f1', 'f3'].includes(e.id)));
});

test('unsaved edits survive a reload and are merged and pushed on the next load', async () => {
  const srv = server(doc());
  const a = device(srv);
  await a.sync.pull();
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'Offline edit' }] }));
  assert.equal(a.meta.dirty, true);
  // The tab closes before the debounce fires; the next load starts from the persisted meta + cache.
  const other = device(srv);
  await other.sync.pull();
  other.edit((d) => ({ ...d, expanded: { f1: false } }));
  await other.tick();
  const reloaded = device(srv, { local: a.local, meta: a.meta });
  await reloaded.sync.pull();
  assert.equal(srv.doc.folders[0].name, 'Offline edit');
  assert.equal(srv.doc.expanded.f1, false, "the other device's change is preserved");
  assert.equal(reloaded.meta.dirty, false);
});

test('failed saves retry with backoff; the failure is reported once after 3 in a row, then recovers', async () => {
  const srv = server(doc());
  const a = device(srv);
  await a.sync.pull();
  srv.fail = 3;
  a.edit((d) => ({ ...d, folders: [{ id: 'f1', name: 'Flaky' }] }));
  await a.tick();              // debounce -> failure 1, schedules retry at 1s
  assert.equal(a.failures.length, 0);
  await a.tick();              // retry -> failure 2 (2s)
  assert.equal(a.failures.length, 0);
  await a.tick();              // retry -> failure 3 -> reported
  assert.equal(a.failures.length, 1);
  assert.equal(a.meta.dirty, true);
  await a.tick();              // retry succeeds
  assert.equal(a.failures.length, 1, 'reported once per streak');
  assert.equal(srv.doc.folders[0].name, 'Flaky');
  assert.equal(a.meta.dirty, false);
  assert.deepEqual([1, 2, 3, 7].map(m.BACKOFF_MS), [1000, 2000, 4000, 60000]);
});

test('server-side deletion of a project pruned from the layout does not resurrect it', async () => {
  const srv = server(doc({ root: [{ kind: 'folder', id: 'f1' }], membership: {} }));
  const a = device(srv, { local: doc(), meta: { version: 1, base: doc(), dirty: false } });
  await a.sync.pull();
  assert.deepEqual(a.local.root.map((e) => e.id), ['f1']);
  assert.equal(srv.puts, 0);
});

test('normalizeDoc enforces ids, name length, caps and uniqueness before anything is sent', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `f${i}`, name: 'x'.repeat(200) }));
  const n = m.normalizeDoc({ folders: [...many, { id: 'bad id', name: 'x' }, { id: 'f0', name: 'dup' }, { id: 'e', name: '   ' }], root: [{ kind: 'project', id: 'p' }, { kind: 'project', id: 'p' }, { kind: 'folder', id: 'ghost' }], membership: { f1: ['p', 'q'], ghost: ['z'] }, expanded: { f1: false, ghost: true } });
  assert.equal(n.folders.length, 200);
  assert.ok(n.folders.every((f) => f.name.length === 80));
  assert.deepEqual(n.root.filter((e) => e.kind === 'project').map((e) => e.id), ['p']);
  assert.deepEqual(n.membership, { f1: ['q'] });
  assert.deepEqual(n.expanded, { f1: false });
  assert.ok(!n.root.some((e) => e.id === 'ghost'));
});

test('different users never share state: each device engine only talks to its own server document', async () => {
  const s1 = server(doc()); const s2 = server(doc({ folders: [{ id: 'f9', name: 'Other user' }], root: [{ kind: 'folder', id: 'f9' }], membership: {} }));
  const a = device(s1); const b = device(s2);
  await a.sync.pull(); await b.sync.pull();
  assert.equal(a.local.folders[0].name, 'Work');
  assert.equal(b.local.folders[0].name, 'Other user');
});

test('nested hierarchy survives normalization and a sync round trip', async () => {
  const nested = doc({ folders: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], root: [{ kind: 'folder', id: 'a' }], membership: { b: [P(1)] }, children: { a: [{ kind: 'folder', id: 'b' }], b: [{ kind: 'project', id: P(1) }] } });
  const srv = server();
  const a = device(srv, { local: nested });
  await a.sync.pull();
  const b = device(srv);
  await b.sync.pull();
  assert.deepEqual(b.local.children, nested.children);
  assert.deepEqual(b.local.root, nested.root);
});

test('concurrent layout edit preserves a remotely added nested subtree', () => {
  const base = { folders: [{ id: 'a', name: 'A' }], root: [{ kind: 'folder', id: 'a' }], membership: {}, expanded: {}, children: { a: [] } };
  const local = { ...base, root: [{ kind: 'project', id: P(1) }, ...base.root] };
  const remote = { ...base, folders: [...base.folders, { id: 'b', name: 'B' }], membership: { b: [P(2)] }, children: { a: [{ kind: 'folder', id: 'b' }], b: [{ kind: 'project', id: P(2) }] } };
  const merged = m.mergeDocs(base, local, remote);
  assert.deepEqual(merged.children.a, [{ kind: 'folder', id: 'b' }]);
  assert.deepEqual(merged.children.b, [{ kind: 'project', id: P(2) }]);
});
