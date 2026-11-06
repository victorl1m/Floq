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

const { branchChangeToFollow } = await import('../src/lib/branch-tags.ts');

test('external checkout follows; switcher, first run, other workspace and in-flight do not', () => {
  const last = { workspaceId: 'w', branch: 'main' };
  assert.deepEqual(branchChangeToFollow({ last, workspaceId: 'w', currentBranch: 'x', switching: false }), { from: 'main', to: 'x' });
  assert.equal(branchChangeToFollow({ last: { workspaceId: 'w', branch: 'x' }, workspaceId: 'w', currentBranch: 'x', switching: false }), null);
  assert.equal(branchChangeToFollow({ last, workspaceId: 'w', currentBranch: 'x', switching: true }), null);
  assert.equal(branchChangeToFollow({ last: null, workspaceId: 'w', currentBranch: 'x', switching: false }), null);
  assert.equal(branchChangeToFollow({ last, workspaceId: 'other', currentBranch: 'x', switching: false }), null);
});

test('switcher switch keeps old agents on their branch; a later external checkout retags only the current branch agents', () => {
  let tags = { a: { branch: 'main' } };
  // switcher main -> X: step b tags ground sessions with leaving; switchBranch then records last = target
  let last = { workspaceId: 'w', branch: 'X' };
  assert.equal(branchChangeToFollow({ last, workspaceId: 'w', currentBranch: 'X', switching: false }), null);
  assert.deepEqual(tags, { a: { branch: 'main' } });
  // X now has its own agent b; an agent runs `git checkout -b Y`
  tags = { ...tags, b: { branch: 'X' } };
  const change = branchChangeToFollow({ last, workspaceId: 'w', currentBranch: 'Y', switching: false });
  assert.deepEqual(change, { from: 'X', to: 'Y' });
  assert.deepEqual(followBranchChange(tags, ['a', 'b'], change.from, change.to), { a: { branch: 'main' }, b: { branch: 'Y' } });
});

const { supportsBranchSwitchV2, isOutdatedRuntimeBranchError, OUTDATED_RUNTIME_MESSAGE } = await import('../src/lib/branch-tags.ts');

test('capability gating: only an explicit branch-switch-v2 selects the new flow', () => {
  assert.equal(supportsBranchSwitchV2({ server: { capabilities: ['branch-switch-v2'] } }), true);
  assert.equal(supportsBranchSwitchV2({ server: { capabilities: [] } }), false);
  assert.equal(supportsBranchSwitchV2({ server: {} }), false);
  assert.equal(supportsBranchSwitchV2({}), false);
  assert.equal(supportsBranchSwitchV2(null), false);
  assert.equal(supportsBranchSwitchV2(undefined), false);
});

test('older-runtime refusals are recognised and the message is one plain sentence', () => {
  assert.equal(isOutdatedRuntimeBranchError({ code: 'project_agents_active' }), true);
  assert.equal(isOutdatedRuntimeBranchError({ code: 'project_worktree_dirty' }), true);
  assert.equal(isOutdatedRuntimeBranchError({ code: 'project_branch_switch_conflict' }), false);
  assert.equal(isOutdatedRuntimeBranchError(new Error('x')), false);
  assert.match(OUTDATED_RUNTIME_MESSAGE, /runtime is outdated/);
});
