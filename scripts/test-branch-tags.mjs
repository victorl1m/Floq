import test from 'node:test';
import assert from 'node:assert/strict';

const { followBranchChange } = await import('../src/lib/branch-tags.ts');

test('ground sessions of the old branch (and untagged ones) follow a new branch', () => {
  const tags = { a: { branch: 'main' }, b: { branch: 'main', resume: true } };
  const next = followBranchChange(tags, ['a', 'b', 'c'], 'main', 'acessos-rework');
  assert.deepEqual(next, { a: { branch: 'acessos-rework' }, b: { branch: 'acessos-rework' }, c: { branch: 'acessos-rework' } });
  assert.deepEqual(tags, { a: { branch: 'main' }, b: { branch: 'main', resume: true } });
});

test('sessions tagged with another branch stay put, so switching back shows them', () => {
  const tags = { old: { branch: 'release' }, a: { branch: 'main' } };
  const next = followBranchChange(tags, ['old', 'a'], 'main', 'topic');
  assert.deepEqual(next, { old: { branch: 'release' }, a: { branch: 'topic' } });
});

test('no change returns the same object and never duplicates', () => {
  const tags = { a: { branch: 'topic' } };
  assert.equal(followBranchChange(tags, ['a'], 'main', 'topic'), tags);
  assert.equal(followBranchChange(tags, ['a'], 'topic', 'topic'), tags);
});
