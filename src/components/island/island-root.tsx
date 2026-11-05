import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { acceptSnapshot, validAnswers, type DecisionAnswer, type IslandIntent, type IslandSnapshot } from '@/lib/island-contract';
import type { DecisionView } from '@/lib/runtime/types';

const send = (intent: IslandIntent) => invoke('island_intent', { intent });
export default function IslandRoot() {
  const [snapshot, setSnapshot] = useState<IslandSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [answers, setAnswers] = useState<DecisionAnswer[]>([]);
  const [localError, setLocalError] = useState<string>();
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef<IslandSnapshot | null>(null);
  const oldEpochs = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false; let retry: ReturnType<typeof setInterval> | undefined; const unlisteners: (() => void)[] = [];
    void (async () => {
      try {
        const snapshotListener = await listen<IslandSnapshot>('island:snapshot', ({payload}) => {
          if (oldEpochs.current.has(payload.epoch) || !acceptSnapshot(previous.current, payload)) return;
          if (previous.current && previous.current.epoch !== payload.epoch) oldEpochs.current.add(previous.current.epoch);
          previous.current = payload; setSnapshot(payload);
        });
        if (disposed) { snapshotListener(); return; } unlisteners.push(snapshotListener);
        const hoverListener = await listen<{expanded:boolean}>('island:hover', ({payload}) => setExpanded(payload.expanded));
        if (disposed) { hoverListener(); return; } unlisteners.push(hoverListener);
        await send({type:'ready'});
        retry = setInterval(() => { if (!previous.current) void send({type:'ready'}).catch(() => undefined); }, 1000);
      } catch (e) { if (!disposed) setLocalError(String(e)); }
    })();
    return () => { disposed = true; clearInterval(retry); unlisteners.forEach(fn => fn()); };
  }, []);
  const items = snapshot?.items ?? [];
  const current = items.find(i => i.id === selected) ?? items[0];
  useEffect(() => { setAnswers([]); setLocalError(undefined); }, [current?.id]);
  useLayoutEffect(() => {
    const update = () => { void invoke('island_set_layout', { expanded, height: expanded ? Math.ceil(body.current?.scrollHeight ?? 160) : 40, pinned: pinned || !!current && !!snapshot?.busy.includes(current.id) }).catch(() => undefined); };
    update(); const observer = new ResizeObserver(update); if (body.current) observer.observe(body.current); return () => observer.disconnect();
  }, [expanded, pinned, current, snapshot?.error, snapshot?.busy]);
  const disabled = !snapshot?.connected || !!current && snapshot.busy.includes(current.id);
  const act = (intent: IslandIntent) => { setLocalError(undefined); void send(intent).catch(e => setLocalError(String(e))); };
  const cycle = (delta: number) => { const index = items.findIndex(i => i.id === current?.id); setSelected(items[(index + delta + items.length) % items.length]?.id); };
  const answer = (questionId: string, optionIds: string[], text: string) => setAnswers(old => [...old.filter(a => a.questionId !== questionId), {questionId, optionIds, text}]);
  return <div className={'island ' + (expanded ? 'expanded' : 'collapsed')} ref={body} onKeyDown={e => { if (e.key === 'Escape') { setPinned(false); setExpanded(false); } if (current?.kind === 'approval' && (e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement && e.target.closest('.island-actions')) e.preventDefault(); }} onFocusCapture={e => { if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) setPinned(true); }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPinned(false); }}>
    <div className="island-header"><span className="island-dot"/><strong>{items.length} pending</strong><span className="island-session">{current?.kind === 'approval' ? current.approval.requester.name : current?.decision.sessionName ?? 'Floq'}</span></div>
    {expanded && current && <div className="island-content">
      {items.length > 1 && <div className="island-cycle"><button onClick={() => cycle(-1)} aria-label="Previous request">‹</button><span>{items.indexOf(current)+1} of {items.length}</span><button onClick={() => cycle(1)} aria-label="Next request">›</button></div>}
      {current.kind === 'approval' ? <><div className="island-label">Approval requested</div><h2>{current.approval.action}</h2>{current.approval.detail && <p>{current.approval.detail}</p>}<p className="island-meta">From {current.approval.requester.name} · Target {current.approval.target.name}<br/>Expires {new Date(current.approval.expiresAt).toLocaleTimeString()}</p><div className="island-actions"><button disabled={disabled} onClick={() => act({type:'approval', id:current.id, decision:'deny'})}>Decline</button><button className="primary" disabled={disabled} onClick={() => act({type:'approval', id:current.id, decision:'allow'})}>Accept</button></div></> : <DecisionCard decision={current.decision} answers={answers} answer={answer} disabled={disabled} act={act}/>}
      {!snapshot?.connected && <p role="status">Disconnected. Reconnecting…</p>}{(snapshot?.error || localError) && <p role="alert" className="island-error">{snapshot?.error || localError}</p>}
    </div>}
  </div>;
}
function DecisionCard({decision, answers, answer, disabled, act}: {decision: DecisionView; answers: DecisionAnswer[]; answer:(id:string, options:string[], text:string)=>void; disabled:boolean; act:(intent:IslandIntent)=>void}) {
  return <><div className="island-label">{decision.source === 'native' ? 'Agent question' : 'Direction requested'}</div>{decision.questions.map(q => { const value = answers.find(a => a.questionId === q.id) ?? {questionId:q.id, optionIds:[], text:''}; return <div key={q.id}><h2>{q.header || q.question}</h2>{q.header && <p>{q.question}</p>}{decision.answerMode !== 'terminal' && <><div className="island-options">{q.options.map(o => <label key={o.id}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.id} checked={value.optionIds.includes(o.id)} onChange={e => answer(q.id, q.multiSelect ? e.target.checked ? [...value.optionIds,o.id] : value.optionIds.filter(id => id !== o.id) : [o.id], value.text)}/><span>{o.label}{o.description && <small>{o.description}</small>}</span></label>)}</div>{q.allowText && <label className="island-direction">Direction<textarea value={value.text} onChange={e => answer(q.id,value.optionIds,e.target.value)} /></label>}</>}</div>; })}<div className="island-actions">{decision.source === 'native' && <button disabled={disabled} onClick={() => act({type:'terminal', id:decision.id})}>Open terminal</button>}{decision.answerMode !== 'terminal' && <button className="primary" disabled={disabled || !validAnswers(decision.questions, answers)} onClick={() => act({type:'decision', id:decision.id, answers})}>Send</button>}</div></>;
}
