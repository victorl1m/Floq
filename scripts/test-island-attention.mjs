import test from 'node:test';
import assert from 'node:assert/strict';
import { orderAttention, acceptSnapshot, validAnswers } from '../src/lib/island-contract.ts';

test('queue prioritizes approvals and then oldest decisions', () => {
  const items = [{kind:'decision', id:'d2', createdAt:'2026-02-02'}, {kind:'approval', id:'a', createdAt:'2026-03-01'}, {kind:'decision', id:'d1', createdAt:'2026-01-01'}];
  assert.deepEqual(orderAttention(items).map(x => x.id), ['a','d1','d2']);
});
test('snapshot revisions cannot regress within an epoch', () => {
  assert.equal(acceptSnapshot({epoch:'a', revision:3}, {epoch:'a', revision:2}), false);
  assert.equal(acceptSnapshot({epoch:'a', revision:3}, {epoch:'b', revision:1}), true);
});
test('answers need a valid selection or direction and obey single select', () => {
  const questions = [{id:'q', options:[{id:'a'},{id:'b'}], multiSelect:false, allowText:true}];
  assert.equal(validAnswers(questions, [{questionId:'q', optionIds:[], text:''}]), false);
  assert.equal(validAnswers(questions, [{questionId:'q', optionIds:['a','b'], text:''}]), false);
  assert.equal(validAnswers(questions, [{questionId:'q', optionIds:[], text:'direction'}]), true);
});
