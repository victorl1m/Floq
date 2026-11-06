import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decisions } from '../src/decisions.ts';

test('decision resolves once and remains scoped to its requester', async () => {
  const decisions = new Decisions();
  const r = await decisions.request('user', { sessionId: 'session', projectId: null, sessionName: 'Agent', questions: [{id:'q',question:'Choose',options:[{id:'a',label:'A'}],multiSelect:false,allowText:true}] });
  assert.equal(decisions.list('other').length, 0);
  await assert.rejects(() => decisions.status('user', 'other', r.id, 0));
  await decisions.resolve('user', r.id, [{questionId:'q',optionIds:['a'],text:''}]);
  await assert.rejects(() => decisions.resolve('user', r.id, [{questionId:'q',optionIds:['a'],text:''}]));
  assert.equal((await decisions.status('user', 'session', r.id, 0)).status, 'answered');
});

test('invalid selections cannot answer a decision', async () => {
  const decisions = new Decisions();
  const {id} = await decisions.request('u', {sessionId:'s',projectId:null,sessionName:'Agent',questions:[{id:'q',question:'Choose',options:[{id:'a',label:'A'}],multiSelect:false,allowText:false}]});
  await assert.rejects(() => decisions.resolve('u', id, [{questionId:'q',optionIds:['unknown'],text:''}]));
  await assert.rejects(() => decisions.resolve('u', id, [{questionId:'q',optionIds:[],text:'text'}]));
  assert.equal(decisions.list('u').length, 1);
});

test('a lost waiter expires without granting an answer', async () => {
  let now=0;
  const decisions = new Decisions({now:()=>now});
  const {id} = await decisions.request('u', {sessionId:'s',projectId:null,sessionName:'Agent',wait:true,questions:[{id:'q',question:'Direction?',options:[],multiSelect:false,allowText:true}]});
  now=75000; decisions.sweep();
  assert.equal((await decisions.status('u','s',id,0)).status,'cancelled');
  await assert.rejects(() => decisions.resolve('u',id,[{questionId:'q',optionIds:[],text:'yes'}]));
});

test('two simultaneous answers have one winner', async () => {
  const decisions = new Decisions();
  const {id} = await decisions.request('u', {sessionId:'s',projectId:null,sessionName:'Agent',questions:[{id:'q',question:'Direction?',options:[],multiSelect:false,allowText:true}]});
  const results=await Promise.allSettled(['first','second'].map(text=>decisions.resolve('u',id,[{questionId:'q',optionIds:[],text}])));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});

test('a pending decision never expires on a clock; a gone waiter withdraws it; startup closes persisted pending rows', async () => {
  let now=1000; const sql:string[]=[];
  const pool={query:async (query:string)=>{sql.push(query);return {rows:[],rowCount:1} as any;}} as any;
  const decisions=new Decisions({now:()=>now,pool}); await decisions.init();
  assert.match(sql[0],/UPDATE agent_decisions SET status='expired'.*status='pending'/);
  const {id}=await decisions.request('u',{sessionId:'s',projectId:null,sessionName:'A',ttlMs:30000,questions:[{id:'q',question:'?',options:[],allowText:true}]});
  now+=30*24*3600000; decisions.sweep(); assert.equal((await decisions.status('u','s',id,0)).status,'pending');
  assert.equal((await decisions.resolve('u',id,[{questionId:'q',optionIds:[],text:'x'}])).status,'answered');
  const waited=await decisions.request('u',{sessionId:'s',projectId:null,sessionName:'A',wait:true,questions:[{id:'q',question:'?',options:[],allowText:true}]});
  now+=75000; decisions.sweep(); assert.equal((await decisions.status('u','s',waited.id,0)).status,'cancelled');
});
