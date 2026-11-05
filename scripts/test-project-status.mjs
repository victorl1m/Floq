import test from 'node:test';
import assert from 'node:assert/strict';

const s = await import('../src/lib/project-status.ts');
const mk = (projectId, state, activity, exitCode = null) => ({ projectId, state, activity, exitCode });

test('counts working and failed agents per project', () => {
  const m = s.countByProject([
    mk('a', 'running', 'working'), mk('a', 'running', 'working'), mk('a', 'running', 'idle'),
    mk('a', 'running', 'waiting-for-input'), mk('a', 'sleeping'), mk('b', 'failed'),
    mk('b', 'exited', undefined, 1), mk('b', 'exited', undefined, 0), mk(null, 'failed'),
  ]);
  assert.deepEqual(m.get('a'), { working: 2, failed: 0 });
  assert.deepEqual(m.get('b'), { working: 0, failed: 2 });
  assert.equal(m.size, 2);
});

test('precedence: errored beats running beats finished', () => {
  const mem = { wasWorking: false, finished: true };
  assert.equal(s.projectStatus({ working: 1, failed: 1 }, mem).kind, 'errored');
  assert.equal(s.projectStatus({ working: 2, failed: 0 }, mem).label, '2 agents working');
  assert.equal(s.projectStatus({ working: 1, failed: 0 }, mem).label, '1 agent working');
  assert.equal(s.projectStatus({ working: 0, failed: 0 }, mem).label, 'Agents finished');
  assert.equal(s.projectStatus({ working: 0, failed: 1 }, mem).label, 'An agent failed');
  assert.equal(s.projectStatus(undefined, undefined), null);
});

test('finished appears after work stops and clears when the project is viewed', () => {
  let mem = s.advanceMemory(undefined, { working: 1, failed: 0 }, false);
  assert.deepEqual(mem, { wasWorking: true, finished: false });
  mem = s.advanceMemory(mem, { working: 0, failed: 0 }, false);
  assert.deepEqual(mem, { wasWorking: false, finished: true });
  mem = s.advanceMemory(mem, { working: 0, failed: 0 }, false);
  assert.equal(mem.finished, true);
  mem = s.advanceMemory(mem, { working: 0, failed: 0 }, true);
  assert.equal(mem.finished, false);
});

test('work that ends while the project is open never flags finished; idle projects stay quiet', () => {
  let mem = s.advanceMemory(undefined, { working: 1, failed: 0 }, true);
  mem = s.advanceMemory(mem, { working: 0, failed: 0 }, true);
  assert.equal(mem.finished, false);
  mem = s.advanceMemory(mem, { working: 0, failed: 0 }, false);
  assert.equal(mem.finished, false);
});
