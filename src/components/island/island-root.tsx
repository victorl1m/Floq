import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { acceptSnapshot, validAnswers, type AttentionItem, type DecisionAnswer, type IslandIntent, type IslandSnapshot } from '@/lib/island-contract';
import { IconShieldQuestion, IconMessageQuestion, IconChevronLeft, IconChevronRight, IconCheck, IconLoader2, IconX } from '@tabler/icons-react';
import { riskLevel, RISK_LABEL, actorLabel } from '@/lib/approval-format';
import type { DecisionView } from '@/lib/runtime/types';

const send = (intent: IslandIntent) => invoke('island_intent', { intent });
/** What the user just answered: shown as a short colored result state instead of falling back to the stale "N waiting" pill. */
type Outcome = { id: string; kind: 'accepted' | 'refused' | 'sent'; title: string };
const OUTCOME_LABEL: Record<Outcome['kind'], string> = { accepted: 'Accepted', refused: 'Refused', sent: 'Sent' };
/** The result is held this long (independent of hover), then fades out over OUTCOME_FADE_MS. Hold + fade must stay under EMPTY_DEFER_AFTER_ANSWER_MS so the OS window is still there. */
const OUTCOME_HOLD_MS = 2600;
const OUTCOME_FADE_MS = 400;
function OutcomeMark({ kind }: { kind: Outcome['kind'] }) {
  return <svg className="island-result-svg" viewBox="0 0 48 48" aria-hidden="true"><circle className="island-result-ring" cx="24" cy="24" r="20"/>{kind === 'refused' ? <path className="island-result-glyph" d="M17 17 L31 31 M31 17 L17 31"/> : <path className="island-result-glyph" d="M15 25 L21.5 31.5 L33 18"/>}</svg>;
}
export default function IslandRoot({ initialSnapshot = null, initialExpanded = false, initialOutcome = null }: { initialSnapshot?: IslandSnapshot | null; initialExpanded?: boolean; initialOutcome?: Outcome | null } = {}) {
  const [snapshot, setSnapshot] = useState<IslandSnapshot | null>(initialSnapshot);
  const [displaySnapshot, setDisplaySnapshot] = useState<IslandSnapshot | null>(initialSnapshot?.items.length ? initialSnapshot : null);
  const [motion, setMotion] = useState<'enter' | 'exit' | 'pulse-a' | 'pulse-b' | 'idle'>(initialSnapshot?.items.length ? 'enter' : 'idle');
  const displayed = useRef(initialSnapshot?.items.length ? initialSnapshot : null);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pulse = useRef(false);
  const [expanded, setExpanded] = useState(initialExpanded);
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [selected, setSelected] = useState<string>();
  const [answers, setAnswers] = useState<DecisionAnswer[]>([]);
  const [localError, setLocalError] = useState<string>();
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const layoutSent = useRef('');
  const submitting = useRef<string | null>(null);
  const sawBusy = useRef(false);
  const [submission, setSubmission] = useState<'busy' | 'success' | null>(null);
  const previous = useRef<IslandSnapshot | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(initialOutcome);
  const [leaving, setLeaving] = useState(false);
  const outcomeRef = useRef<Outcome | null>(initialOutcome);
  outcomeRef.current = outcome;
  const pendingOutcome = useRef<Outcome | null>(null);
  /** Requests answered in this window: never counted or shown again, even while the main window still replays them (empty-queue deferral). */
  const answeredIds = useRef(new Set<string>());
  const oldEpochs = useRef(new Set<string>());
  useEffect(() => {
    if (displayed.current?.items.length) motionTimer.current = setTimeout(() => setMotion('idle'), 420);
    let disposed = false; let retry: ReturnType<typeof setInterval> | undefined; const unlisteners: (() => void)[] = [];
    void (async () => {
      try {
        const snapshotListener = await listen<IslandSnapshot>('island:snapshot', ({payload}) => {
          if (oldEpochs.current.has(payload.epoch) || !acceptSnapshot(previous.current, payload)) return;
          if (previous.current && previous.current.epoch !== payload.epoch) oldEpochs.current.add(previous.current.epoch);
          previous.current = payload; setSnapshot(payload);
          const old = displayed.current;
          if (payload.items.length) {
            clearTimeout(motionTimer.current);
            displayed.current = payload; setDisplaySnapshot(payload);
            if (!old || old.items.length === 0) {
              setMotion('enter');
              motionTimer.current = setTimeout(() => setMotion('idle'), 420);
            } else if (payload.items.some(item => !old.items.some(existing => existing.id === item.id))) {
              pulse.current = !pulse.current;
              setMotion(pulse.current ? 'pulse-a' : 'pulse-b');
              motionTimer.current = setTimeout(() => setMotion('idle'), 420);
            } else {
              setMotion(currentMotion => currentMotion === 'exit' ? 'enter' : currentMotion);
              motionTimer.current = setTimeout(() => setMotion('idle'), 420);
            }
          } else if (old?.items.length) {
            clearTimeout(motionTimer.current);
            // Mark the presentation as exiting while retaining its last contents.
            displayed.current = { ...old, items: [] };
            setMotion('exit');
            motionTimer.current = setTimeout(() => { displayed.current = null; setDisplaySnapshot(null); setMotion('idle'); }, 260);
          }
        });
        if (disposed) { snapshotListener(); return; } unlisteners.push(snapshotListener);
        const hoverListener = await listen<{expanded:boolean}>('island:hover', ({payload}) => { if (payload.expanded || !outcomeRef.current) setExpanded(payload.expanded); });
        if (disposed) { hoverListener(); return; } unlisteners.push(hoverListener);
        await send({type:'ready'});
        retry = setInterval(() => { if (!previous.current) void send({type:'ready'}).catch(() => undefined); }, 1000);
      } catch (e) { if (!disposed) setLocalError(String(e)); }
    })();
    return () => { disposed = true; clearInterval(retry); unlisteners.forEach(fn => fn()); clearTimeout(motionTimer.current); };
  }, []);
  const items = (displaySnapshot?.items ?? []).filter(i => !answeredIds.current.has(i.id));
  const lastCurrent = useRef<AttentionItem | undefined>(undefined);
  const active = items.find(i => i.id === selected) ?? items[0];
  if (active && !submission) lastCurrent.current = active;
  const current = submission && lastCurrent.current ? lastCurrent.current : active;
  useEffect(() => { setAnswers([]); setLocalError(undefined); }, [current?.id]);
  useLayoutEffect(() => {
    // A hidden native window rejects layout commands; resend after activation even
    // when the next card happens to have exactly the same dimensions.
    if (!snapshot?.items.length) { layoutSent.current = ''; return; }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const layout = { expanded, height: expanded ? Math.min(560, Math.ceil(content.current?.scrollHeight ?? 160) + 2) : 40, pinned: pinned || !!submission || (!!current && !!snapshot?.busy.includes(current.id)) };
        const key = JSON.stringify(layout);
        if (layoutSent.current === key) return;
        layoutSent.current = key;
        void invoke('island_set_layout', layout).catch(() => { if (layoutSent.current === key) layoutSent.current = ''; });
      });
    };
    update(); const observer = new ResizeObserver(update); if (body.current) observer.observe(body.current); if (content.current) observer.observe(content.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [expanded, pinned, current?.id, snapshot?.error, snapshot?.busy, submission, displaySnapshot, snapshot?.items.length]);
  useEffect(() => {
    const id = submitting.current;
    if (!id || !snapshot) return;
    if (snapshot.busy.includes(id)) { sawBusy.current = true; return; }
    if (snapshot.error) { submitting.current = null; sawBusy.current = false; pendingOutcome.current = null; setSubmission(null); return; }
    if (sawBusy.current || !snapshot.items.some(item => item.id === id)) {
      submitting.current = null; sawBusy.current = false;
      if (pendingOutcome.current?.id === id) { answeredIds.current.add(id); setLeaving(false); setExpanded(true); setOutcome(pendingOutcome.current); }
      pendingOutcome.current = null;
      setSubmission('success');

    }
  }, [snapshot]);
  useEffect(() => {
    if (submission !== 'success') return;
    const finish = () => {
      setSubmission(null); setPinned(false); setExpanded(false); setOutcome(null); setLeaving(false);
      // Nothing else is waiting: the result already faded out, so drop the island without replaying the slide-out over it.
      if (outcome && !displayed.current?.items.some(item => !answeredIds.current.has(item.id))) {
        clearTimeout(motionTimer.current); displayed.current = null; setDisplaySnapshot(null); setMotion('idle');
      } else if (outcome) { clearTimeout(motionTimer.current); setMotion('enter'); motionTimer.current = setTimeout(() => setMotion('idle'), 420); }
    };
    let fade: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (!outcome) { finish(); return; }
      setLeaving(true); fade = setTimeout(finish, OUTCOME_FADE_MS);
    }, outcome ? OUTCOME_HOLD_MS : 700);
    return () => { clearTimeout(timer); clearTimeout(fade); };
  }, [submission]);
  const disabled = !snapshot?.connected || !!submission || (!!current && snapshot.busy.includes(current.id));
  const act = (intent: IslandIntent) => {
    if (intent.type === 'ready' || submitting.current || disabled) return;
    setLocalError(undefined); submitting.current = intent.id; sawBusy.current = false; setSubmission('busy');
    const item = items.find(i => i.id === intent.id);
    pendingOutcome.current = intent.type === 'approval'
      ? { id: intent.id, kind: intent.decision === 'allow' ? 'accepted' : 'refused', title: item?.kind === 'approval' ? item.approval.action : '' }
      : intent.type === 'decision'
        ? { id: intent.id, kind: 'sent', title: item?.kind === 'decision' ? item.decision.questions[0]?.header || item.decision.sessionName : '' }
        : null;
    void send(intent).catch(e => { submitting.current = null; pendingOutcome.current = null; setSubmission(null); setLocalError(String(e)); });
  };
  const cycle = (delta: number) => { const index = items.findIndex(i => i.id === current?.id); setSelected(items[(index + delta + items.length) % items.length]?.id); };
  const answer = (questionId: string, optionIds: string[], text: string) => setAnswers(old => [...old.filter(a => a.questionId !== questionId), {questionId, optionIds, text}]);
  if ((!displaySnapshot || !items.length) && !outcome) return null;
  // While the result is shown, queue motion (an exit from the emptied queue, or an enter from a new request) must not replay over it.
  const shownMotion = outcome ? 'idle' : motion;
  return <div className={'island island-' + shownMotion + ' ' + (expanded ? 'expanded' : 'collapsed') + (outcome ? ' island-outcome island-outcome-' + outcome.kind + (leaving ? ' island-leaving' : '') : '')} ref={body} onMouseEnter={() => { clearTimeout(leaveTimer.current); setExpanded(true); }} onMouseLeave={() => { clearTimeout(leaveTimer.current); leaveTimer.current = setTimeout(() => { if (!pinnedRef.current && !outcomeRef.current) setExpanded(false); }, 300); }} onKeyDown={e => { if (e.key === 'Escape') { setPinned(false); setExpanded(false); } if (current?.kind === 'decision' && e.key === 'Enter' && e.ctrlKey && !disabled && current.decision.answerMode !== 'terminal' && validAnswers(current.decision.questions, answers)) { e.preventDefault(); act({type:'decision', id:current.id, answers}); } }} onFocusCapture={e => { if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) setPinned(true); }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPinned(false); }}>
    <div className={'island-header island-pill' + (outcome ? ' island-pill-' + outcome.kind : '')}>{outcome ? <><OutcomeMark kind={outcome.kind}/><strong>{OUTCOME_LABEL[outcome.kind]}</strong></> : <><i className="island-dot"/><strong><span className="island-count">{items.length}</span> waiting</strong><span className="island-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span></>}</div>
    {outcome ? <div className="island-content island-result" ref={content} role="status" aria-live="polite" aria-hidden={!expanded} inert={!expanded}>
      <span className="island-result-mark"><OutcomeMark kind={outcome.kind}/></span>
      <strong className="island-result-label">{OUTCOME_LABEL[outcome.kind]}</strong>
      {outcome.title && <span className="island-result-sub">{outcome.title}</span>}
    </div> : current && <div className="island-content" ref={content} aria-hidden={!expanded} inert={!expanded}>
      <div className="island-card-header">
        <span className="island-badge">{current.kind === 'decision' ? <IconMessageQuestion size={20}/> : <IconShieldQuestion size={20}/>} {current.kind === 'approval' && current.approval.irreversible && <i/>}</span>
        <div className="island-heading"><span>{current.kind === 'approval' ? `Needs your OK · ${actorLabel(current.approval.requester)}` : `Direction requested · ${current.decision.sessionName}`}</span><strong className={current.kind === 'approval' ? 'island-title-command' : ''}>{current.kind === 'approval' ? current.approval.action : current.decision.questions[0]?.header || current.decision.questions[0]?.question || 'Agent question'}</strong></div>
        {current.kind === 'approval' && <div className="island-header-actions"><button className="island-circle" aria-label="Decline" disabled={disabled} onClick={() => act({type:'approval', id:current.id, decision:'deny'})}><IconX size={18}/></button><button className="primary" disabled={disabled} onClick={() => act({type:'approval', id:current.id, decision:'allow'})}><IconCheck size={16}/> Accept</button></div>}
      </div>
      {current.kind === 'approval' ? <><div className="island-detail"><div><span className="island-risk">{RISK_LABEL[riskLevel(current.approval.action, current.approval.detail, current.approval.irreversible)]}</span>{current.approval.detail && <p>{current.approval.detail}</p>}<p className="island-meta">From {actorLabel(current.approval.requester)} · Target {actorLabel(current.approval.target)}</p></div></div></> : <DecisionCard decision={current.decision} answers={answers} answer={answer} disabled={disabled} act={act} submission={submission}/>}
      {items.length > 1 && <div className="island-cycle"><button onClick={() => cycle(-1)} aria-label="Previous request"><IconChevronLeft size={15}/></button><div className="island-queue" aria-label={`Request ${items.indexOf(current)+1} of ${items.length}`}>{items.map(item => <span key={item.id} className={item.id === current.id ? 'active' : ''}/>)}</div><button onClick={() => cycle(1)} aria-label="Next request"><IconChevronRight size={15}/></button></div>}
      {!snapshot?.connected && <p role="status">Disconnected. Reconnecting…</p>}{(snapshot?.error || localError) && <p role="alert" className="island-error">{snapshot?.error || localError}</p>}
    </div>}
  </div>;
}
function DecisionCard({decision, answers, answer, disabled, act, submission}: {decision: DecisionView; answers: DecisionAnswer[]; answer:(id:string, options:string[], text:string)=>void; disabled:boolean; act:(intent:IslandIntent)=>void; submission:'busy' | 'success' | null}) {
  return <>{decision.questions.map((q, index) => { const value = answers.find(a => a.questionId === q.id) ?? {questionId:q.id, optionIds:[], text:''}; return <div key={q.id}>{(q.header || index > 0) && <p>{q.header && index > 0 && <strong>{q.header}: </strong>}{q.question}</p>}{decision.answerMode !== 'terminal' && <><div className="island-options">{q.options.map(o => <label key={o.id}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.id} checked={value.optionIds.includes(o.id)} onChange={e => answer(q.id, q.multiSelect ? e.target.checked ? [...value.optionIds,o.id] : value.optionIds.filter(id => id !== o.id) : [o.id], value.text)}/><span>{o.label}{o.description && <small>{o.description}</small>}</span></label>)}</div>{q.allowText && <label className="island-direction">Direction<textarea placeholder="Add direction…" value={value.text} onChange={e => answer(q.id,value.optionIds,e.target.value)} /></label>}</>}</div>; })}<div className="island-actions">{decision.source === 'native' && <button disabled={disabled} onClick={() => act({type:'terminal', id:decision.id})}>Open terminal</button>}{decision.answerMode !== 'terminal' && <button className="primary" disabled={disabled || !validAnswers(decision.questions, answers)} onClick={() => act({type:'decision', id:decision.id, answers})}>{submission === 'busy' ? <><IconLoader2 className="island-spinner" size={15}/> Sending</> : submission === 'success' ? <><IconCheck size={15}/> Sent</> : 'Send'}</button>}</div></>;
}
