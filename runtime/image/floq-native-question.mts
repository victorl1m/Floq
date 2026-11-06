#!/usr/bin/env node
// Best-effort Claude PreToolUse bridge. On any uncertainty, preserve the provider's terminal prompt.
import { readFileSync } from 'node:fs';

type ClaudeOption = { label: string; description?: string };
type ClaudeQuestion = { question: string; header?: string; options: ClaudeOption[]; multiSelect?: boolean };
type HookInput = { tool_name?: string; tool_use_id?: string; tool_input?: { questions?: ClaudeQuestion[]; [key:string]: unknown } };
type Decision = {status:string; response?:{answers:{questionId:string;optionIds:string[];text:string}[]}};

async function main() {
  const base=process.env.FLOQ_API_URL, token=process.env.FLOQ_AGENT_TOKEN;
  if(!base||!token) return;
  let input:HookInput;
  try { input=JSON.parse(readFileSync(0,'utf8')); } catch { return; }
  const questions=input.tool_input?.questions;
  if(input.tool_name!=='AskUserQuestion'||typeof input.tool_use_id!=='string'||!input.tool_use_id||input.tool_use_id.length>256||!Array.isArray(questions)||!questions.length||questions.length>4) return;
  const seen=new Set<string>();
  for(const q of questions) {
    if(!q||typeof q.question!=='string'||!q.question.trim()||q.question.length>2000||seen.has(q.question)||!Array.isArray(q.options)||q.options.length>8||q.options.some(o=>!o||typeof o.label!=='string'||!o.label.trim()||o.label.length>1000||(o.description!==undefined&&(typeof o.description!=='string'||o.description.length>1000)))||(q.header!==undefined&&(typeof q.header!=='string'||q.header.length>1000))) return;
    seen.add(q.question);
  }
  const call=async(path:string,body:unknown,timeout:number)=>{const r=await fetch(base+'/internal/decisions/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});if(!r.ok) throw new Error('unavailable');return await r.json() as Record<string,unknown>;};
  let id:string|undefined; let answered=false;
  const deadline=Date.now()+86_300_000;
  try {
    const created=await call('native-request',{providerRequestId:input.tool_use_id,questions:questions.map((q,i)=>({id:'q'+i,question:q.question,header:q.header,options:q.options.map((o,j)=>({id:'o'+j,label:o.label,description:o.description})),multiSelect:q.multiSelect===true,allowText:true})),ttlMs:55000,wait:true},5000);
    if(typeof created.id!=='string') return; id=created.id;
    let state=created.decision as Decision;
    while(state?.status==='pending'&&Date.now()<deadline) state=await call('status',{id,waitSec:Math.min(40,Math.max(1,Math.floor((deadline-Date.now())/1000)))},Math.max(1,deadline-Date.now())) as Decision;
    if(state?.status!=='answered'||!Array.isArray(state.response?.answers)||state.response.answers.length!==questions.length) return;
    const answers:Record<string,string>={};
    for(let i=0;i<questions.length;i++) { const q=questions[i],a=state.response.answers.find(x=>x.questionId==='q'+i); if(!a||!Array.isArray(a.optionIds)||typeof a.text!=='string'||(!q.multiSelect&&a.optionIds.length>1)) return; const selected:string[]=[]; for(const optionId of a.optionIds){const match=/^o(\d+)$/.exec(optionId);const option=match&&q.options[Number(match[1])];if(!option) return;selected.push(option.label);} if(a.text.trim())selected.push(a.text);if(!selected.length)return; answers[q.question]=selected.join(', '); }
    answered=true;
    process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...input.tool_input,questions,answers}}}));
  } catch { /* provider's terminal prompt remains available */ }
  finally { if(id&&!answered) await call('cancel',{id},1500).catch(()=>undefined); }
}
await main().catch(()=>undefined);
