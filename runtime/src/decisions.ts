import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { badRequest, conflict, notFound, HttpError } from './errors.js';
import { neutralizeApprovalMarker, foldLookalikes } from './approvalText.js';

type Option = { id: string; label: string; description?: string };
type Question = { id: string; question: string; header?: string; options: Option[]; multiSelect: boolean; allowText: boolean };
type Answer = { questionId: string; optionIds: string[]; text: string };
type Status = 'pending' | 'answered' | 'cancelled' | 'expired';
export type DecisionView = { id: string; source: 'cli' | 'native'; sessionId: string; projectId: string | null; sessionName: string; provider: 'claude' | 'codex' | null; questions: Question[]; status: Status; createdAt: string; expiresAt: string; answerMode: 'direction' | 'hook' | 'terminal'; response?: {answers: Answer[]}; deliveryStatus?: 'pending' | 'delivered' | 'failed' };
type RecordEntry = { userId: string; view: DecisionView; waiter: boolean; polled: number; providerRequestId?: string; notified?: boolean };
type Frame = {type:'decision-request'|'decision-updated'; decision:DecisionView} | {type:'decision-resolved'; id:string; sessionId:string; status:Exclude<Status,'pending'>; response?:{answers:Answer[]}; deliveryStatus?:DecisionView['deliveryStatus']};
type Input = {sessionId:string; projectId:string|null; sessionName:string; questions:unknown; ttlMs?:unknown; wait?:boolean; source?:'cli'|'native'; provider?:'claude'|'codex'|null; providerRequestId?:string; answerMode?:DecisionView['answerMode']};

const WAITER_GONE_MS = 75000;
/** One short line: no control characters or line breaks, no brackets (cannot forge a marker), no approval look-alikes. */
export function cleanDecisionText(text: string, max: number): string {
  const one = neutralizeApprovalMarker(foldLookalikes(text)).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026' : one;
}
/** The line the runtime types into the requesting agent's terminal once its CLI decision was answered or withdrawn. */
export function formatDecisionLine(view: DecisionView, status: 'answered' | 'cancelled' | 'expired'): string {
  const head = `[FLOQ DECISION ${view.id} ${status.toUpperCase()}]`;
  const q = cleanDecisionText(view.questions[0]?.question ?? '', 100);
  if (status !== 'answered') return `${head} ${q} -> no answer. Check with: floq decision status ${view.id}`;
  const parts: string[] = [];
  for (const a of view.response?.answers ?? []) {
    const question = view.questions.find(x => x.id === a.questionId);
    const labels = a.optionIds.map(id => question?.options.find(o => o.id === id)?.label ?? id);
    if (a.text.trim()) labels.push(a.text);
    parts.push(labels.join(' + '));
  }
  const answer = cleanDecisionText(parts.join(' | '), 240);
  return `${head} ${q} -> ${answer || '(empty)'} (full text: floq decision status ${view.id})`;
}
export class Decisions {
  private records = new Map<string,RecordEntry>();
  private subs = new Set<{userId:string; fn:(frame:Frame)=>void}>();
  private changes = new Set<()=>void>();
  private requests = new Map<string,number[]>();
  private nativeRequests = new Map<string,Promise<{id:string;decision:DecisionView;deduped:boolean}>>();
  constructor(private options: {pool?:Pick<pg.Pool,'query'>; now?:()=>number; scrub?:(userId:string, ids:string[], text:string)=>Promise<string>; deliver?:(userId:string, sessionId:string, text:string)=>Promise<boolean>} = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  async init() { await this.options.pool?.query("UPDATE agent_decisions SET status='expired', decided_at=now() WHERE status='pending'"); }
  subscribe(userId:string, fn:(frame:Frame)=>void) { const sub={userId,fn}; this.subs.add(sub); return ()=>{this.subs.delete(sub);}; }
  private emit(userId:string, frame:Frame) { for (const s of this.subs) if(s.userId===userId) { try { s.fn(frame); } catch {} } for(const fn of this.changes) fn(); }
  private async clean(userId:string, sessionId:string, s:string, limit:number) { const value = this.options.scrub ? await this.options.scrub(userId,[sessionId],s) : s; return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim().slice(0,limit); }
  async request(userId:string, input:Input):Promise<{id:string; decision:DecisionView; deduped:boolean}> {
    if (!input.providerRequestId) return this.requestOnce(userId, input);
    const key = JSON.stringify([userId, input.sessionId, input.providerRequestId]);
    const running = this.nativeRequests.get(key);
    if (running) { const result = await running; return {...result, deduped:true}; }
    const pending = this.requestOnce(userId,input);
    this.nativeRequests.set(key,pending);
    try { return await pending; } finally { this.nativeRequests.delete(key); }
  }
  private async requestOnce(userId:string, input:Input):Promise<{id:string; decision:DecisionView; deduped:boolean}> {
    if(!Array.isArray(input.questions) || input.questions.length<1 || input.questions.length>4) throw badRequest('one to four questions required');
    const questions:Question[]=[]; const ids=new Set<string>();
    for(const raw of input.questions) {
      if(!raw || typeof raw!=='object') throw badRequest('invalid question');
      const q=raw as Record<string,unknown>;
      if(typeof q.id!=='string'||!q.id||q.id.length>128||ids.has(q.id)||typeof q.question!=='string'||!q.question.trim()||q.question.length>2000||!Array.isArray(q.options)||q.options.length>8) throw badRequest('invalid question');
      ids.add(q.id); const options:Option[]=[]; const oids=new Set<string>();
      for(const v of q.options) { const o=v as Record<string,unknown>; if(!o||typeof o.id!=='string'||!o.id||o.id.length>128||oids.has(o.id)||typeof o.label!=='string'||!o.label.trim()||o.label.length>1000||(o.description!==undefined&&(typeof o.description!=='string'||o.description.length>1000))) throw badRequest('invalid option'); oids.add(o.id); options.push({id:o.id,label:await this.clean(userId,input.sessionId,o.label,1000),...(typeof o.description==='string'?{description:await this.clean(userId,input.sessionId,o.description,1000)}:{})}); }
      if(q.header!==undefined&&(typeof q.header!=='string'||q.header.length>1000)) throw badRequest('invalid header');
      questions.push({id:q.id,question:await this.clean(userId,input.sessionId,q.question,2000),...(typeof q.header==='string'?{header:await this.clean(userId,input.sessionId,q.header,1000)}:{}),options,multiSelect:q.multiSelect===true,allowText:q.allowText!==false});
    }
    this.sweep();
    if(input.providerRequestId) for(const e of this.records.values()) if(e.userId===userId&&e.view.sessionId===input.sessionId&&e.providerRequestId===input.providerRequestId) return {id:e.view.id,decision:e.view,deduped:true};
    const pending=[...this.records.values()].filter(e=>e.userId===userId&&e.view.status==='pending');
    const recent=(this.requests.get(userId)??[]).filter(t=>this.now()-t<600000); if(pending.length>=12||pending.filter(e=>e.view.sessionId===input.sessionId).length>=3||recent.length>=10) throw new HttpError(429,'rate_limited','Too many decisions');
    const ttl=input.ttlMs===undefined?600000:Number(input.ttlMs); if(!Number.isFinite(ttl)||ttl<=0) throw badRequest('invalid ttl');
    const now=this.now(); const view:DecisionView={id:randomUUID(),source:input.source??'cli',sessionId:input.sessionId,projectId:input.projectId,sessionName:input.sessionName,provider:input.provider??null,questions,status:'pending',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+10*365*24*3600000).toISOString(),answerMode:input.answerMode??'direction'};
    const entry:RecordEntry={userId,view,waiter:input.wait===true,polled:now,providerRequestId:input.providerRequestId};
    await this.options.pool?.query(`INSERT INTO agent_decisions (id,user_id,requester_session_id,requester_project_id,source,provider,provider_request_id,questions,status,created_at,expires_at,meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending',$9,$10,$11::jsonb)`,[view.id,userId,input.sessionId,input.projectId,view.source,view.provider,input.providerRequestId??null,JSON.stringify(questions),view.createdAt,view.expiresAt,JSON.stringify({sessionName:input.sessionName,answerMode:view.answerMode,waiter:entry.waiter})]);
    this.records.set(view.id,entry); const timer = setInterval(() => { this.sweep(); if (entry.view.status !== "pending") clearInterval(timer); }, 1000); timer.unref(); recent.push(now); this.requests.set(userId,recent); this.emit(userId,{type:'decision-request',decision:view}); return {id:view.id,decision:view,deduped:false};
  }
  /** Types one line into the requester's terminal (CLI decisions only, once, never while a --wait is still attached). */
  private announce(e:RecordEntry, silent=false) {
    const deliver=this.options.deliver; const status=e.view.status;
    if(!deliver||silent||e.notified||e.view.source!=='cli'||status==='pending') return;
    if(e.waiter&&this.now()-e.polled<WAITER_GONE_MS) return;
    e.notified=true;
    void Promise.resolve().then(()=>deliver(e.userId,e.view.sessionId,formatDecisionLine(e.view,status))).catch(()=>{});
  }
  private async settle(e:RecordEntry,status:Exclude<Status,'pending'>,response?:{answers:Answer[]},silent=false) {
    if(e.view.status!=='pending') throw conflict('Decision already resolved');
    if(this.options.pool) { const result=await this.options.pool.query("UPDATE agent_decisions SET status=$3,response=$4::jsonb,decided_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at>now() RETURNING id",[e.view.id,e.userId,status,response?JSON.stringify(response):null]); if(!result.rowCount) throw conflict('Decision already resolved or expired'); }
    if(e.view.status!=='pending') throw conflict('Decision already resolved');
    e.view={...e.view,status,...(response?{response}:{})}; this.announce(e,silent); this.emit(e.userId,{type:'decision-resolved',id:e.view.id,sessionId:e.view.sessionId,status,...(response?{response}:{})}); return e.view;
  }
  sweep() { const now=this.now(); for(const e of this.records.values()) if(e.view.status==='pending'&&e.waiter&&now-e.polled>=75000) { const status='cancelled' as const; e.view={...e.view,status}; this.announce(e); void this.options.pool?.query("UPDATE agent_decisions SET status=$2,decided_at=now() WHERE id=$1 AND status='pending'",[e.view.id,status]).catch(()=>{}); this.emit(e.userId,{type:'decision-resolved',id:e.view.id,sessionId:e.view.sessionId,status}); } }
  list(userId:string) { this.sweep(); return [...this.records.values()].filter(e=>e.userId===userId&&e.view.status==='pending').map(e=>e.view); }
  private get(userId:string,id:string) { this.sweep(); const e=this.records.get(id); if(!e||e.userId!==userId) throw notFound('Decision not found'); return e; }
  async status(userId:string,sessionId:string,id:unknown,waitMs:number) { const e=this.get(userId,String(id)); if(e.view.sessionId!==sessionId) throw notFound('Decision not found'); e.polled=this.now(); if(e.view.status==='pending'&&waitMs>0) await new Promise<void>(resolve=>{const timer=setTimeout(done,Math.min(55000,waitMs)); const changes=this.changes; function done(){clearTimeout(timer);changes.delete(done);resolve();} changes.add(done);}); this.sweep(); return e.view; }
  async cancel(userId:string,sessionId:string,id:unknown) {const e=this.get(userId,String(id)); if(e.view.sessionId!==sessionId) throw notFound('Decision not found'); return this.settle(e,'cancelled',undefined,true);}
  async terminal(userId:string,id:string) { const e=this.get(userId,id); if(e.view.source!=='native') throw badRequest('Native decision required'); return this.settle(e,'cancelled'); }
  async resolve(userId:string,id:string,raw:unknown) {const e=this.get(userId,id); if(e.view.status!=='pending') throw conflict('Decision already resolved'); if(!Array.isArray(raw)||raw.length<1||raw.length>4) throw badRequest('answers required'); let total=0; const seen=new Set<string>(); const answers:Answer[]=[]; for(const a of raw) { if(!a||typeof a.questionId!=='string'||seen.has(a.questionId)||!Array.isArray(a.optionIds)||typeof a.text!=='string') throw badRequest('invalid answer'); const q=e.view.questions.find(q=>q.id===a.questionId); if(!q||a.optionIds.some((id:unknown)=>typeof id!=='string'||!q.options.some(o=>o.id===id))||new Set(a.optionIds).size!==a.optionIds.length||(!q.multiSelect&&a.optionIds.length>1)||(!q.allowText&&a.text)||(!a.optionIds.length&&!a.text.trim())) throw badRequest('invalid answer'); total+=a.text.length; if(total>8000) throw badRequest('answer too long'); seen.add(a.questionId); answers.push({questionId:a.questionId,optionIds:a.optionIds,text:a.text}); } return this.settle(e,'answered',{answers}); }
}
