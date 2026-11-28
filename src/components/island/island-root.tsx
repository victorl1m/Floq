import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { acceptSnapshot, validAnswers, initials, safeAvatar, MAX_REPLY_CHARS, type AttentionItem, type DecisionAnswer, type IslandAudioOp, type IslandAudioState, type IslandIntent, type IslandSnapshot } from '@/lib/island-contract';
import { IconShieldQuestion, IconMessageQuestion, IconChevronLeft, IconChevronRight, IconCheck, IconLoader2, IconX, IconSend2 } from '@tabler/icons-react';
import { riskLevel, RISK_LABEL, actorLabel } from '@/lib/approval-format';
import type { DecisionView } from '@/lib/runtime/types';
import { levelMeta } from '@/components/notifications/level';
import type { AppNotification } from '@/lib/notifications';
import { useIslandLayout } from './use-island-layout';
import { IslandAudio } from './island-audio';
import { islandLog } from './island-log';

const send = (intent: IslandIntent) => invoke('island_intent', { intent });
/** What the user just answered: shown as a short colored result state instead of falling back to the stale "N waiting" pill. */
type Outcome = { id: string; kind: 'accepted' | 'refused' | 'sent'; title: string; label?: string };
const OUTCOME_LABEL: Record<Outcome['kind'], string> = { accepted: 'Accepted', refused: 'Refused', sent: 'Sent' };
/** The result is held this long (independent of hover), then fades out over OUTCOME_FADE_MS. Hold + fade must stay under EMPTY_DEFER_AFTER_ANSWER_MS so the OS window is still there. */
const OUTCOME_HOLD_MS = 2600;
const OUTCOME_FADE_MS = 400;
function OutcomeMark({ kind }: { kind: Outcome['kind'] }) {
  return <svg className="island-result-svg" viewBox="0 0 48 48" aria-hidden="true"><circle className="island-result-ring" cx="24" cy="24" r="20"/>{kind === 'refused' ? <path className="island-result-glyph" d="M17 17 L31 31 M31 17 L17 31"/> : <path className="island-result-glyph" d="M15 25 L21.5 31.5 L33 18"/>}</svg>;
}
function NotificationCard({ notification, send: dispatch }: { notification: AppNotification; send: (action: 'dismiss' | 'open') => void }) {
  const { Icon, label } = levelMeta[notification.level];
  return <div className="island-notification" data-level={notification.level}>
    <div className="island-card-header">
      <span className="island-badge island-level-badge" aria-hidden="true"><Icon size={20}/></span>
      <button type="button" className="island-notification-main" onClick={() => dispatch('open')} aria-label={`${label}: ${notification.title}. Open in Floq`}>
        <span className="island-notification-kind">{label}{notification.sessionName ? ` · ${notification.sessionName}` : ''}</span>
        <strong className="island-notification-title">{notification.title}</strong>
        {notification.body && <span className="island-notification-body">{notification.body}</span>}
      </button>
      <div className="island-header-actions">
        {notification.action && <button type="button" className="primary island-notification-action" onClick={() => dispatch('open')}>{notification.action.label}</button>}
        <button type="button" className="island-circle" aria-label="Dismiss notification" onClick={() => dispatch('dismiss')}><IconX size={18}/></button>
      </div>
    </div>
  </div>;
}
function Avatar({ src, name, small }: { src: string | null; name: string; small?: boolean }) {
  const safe = safeAvatar(src);
  return <span className={'island-avatar' + (small ? ' island-avatar-small' : '')} aria-hidden="true">{safe ? <img src={safe} alt="" draggable={false}/> : initials(name)}</span>;
}
/** A message from a plugin (WhatsApp): who wrote, where, a preview, and the plugin's own actions. An action with `input` is an inline reply. */
function MessageCard({ notification, disabled, busy, draft, setDraft, send: dispatch, act, audio, sendAudio }: { notification: AppNotification; disabled: boolean; busy: boolean; draft: string; setDraft: (text: string) => void; send: (action: 'dismiss' | 'open' | 'hold') => void; act: (actionId: string, input?: string) => void; audio: IslandAudioState | null; sendAudio: (op: IslandAudioOp, value?: number) => Promise<unknown> }) {
  const plugin = notification.plugin!;
  const reply = plugin.actions.find(a => a.input);
  const others = plugin.actions.filter(a => a !== reply);
  const text = draft.trim();
  const submit = () => { if (reply && text && !disabled) act(reply.id, text); };
  return <div className="island-notification island-message" data-kind="message">
    <div className="island-card-header">
      <Avatar src={plugin.avatar} name={notification.title}/>
      <button type="button" className="island-notification-main" disabled={!plugin.target} onClick={() => dispatch('open')} aria-label={`${plugin.name}: message from ${notification.title}${plugin.target ? '. Open chat in Floq' : ''}`}>
        <span className="island-notification-kind">{plugin.name}{plugin.subtitle ? ` · ${plugin.subtitle}` : ''}</span>
        <strong className="island-notification-title">{notification.title}</strong>
        {notification.body && <span className="island-notification-body">{notification.body}</span>}
      </button>
      <div className="island-header-actions"><button type="button" className="island-circle" aria-label="Dismiss notification" onClick={() => dispatch('dismiss')}><IconX size={18}/></button></div>
    </div>
    {plugin.audio && <IslandAudio id={notification.id} label={notification.body && notification.body.length <= 40 ? notification.body : 'Audio'} meta={plugin.audio} state={audio} send={sendAudio}/>}
    {reply && <form className="island-reply" onSubmit={e => { e.preventDefault(); submit(); }}>
      <input type="text" value={draft} maxLength={MAX_REPLY_CHARS} disabled={disabled} placeholder={reply.input?.placeholder || reply.label} aria-label={`${reply.label} to ${notification.title}`} autoComplete="off" spellCheck onFocus={() => dispatch('hold')} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); } }}/>
      <button type="submit" className="primary island-circle" disabled={disabled || !text} aria-label={`Send ${reply.label.toLowerCase()}`}>{busy ? <IconLoader2 className="island-spinner" size={16}/> : <IconSend2 size={16}/>}</button>
    </form>}
    {(others.length > 0 || plugin.target) && <div className="island-actions island-message-actions">
      {others.map(a => <button key={a.id} type="button" disabled={disabled} onClick={() => act(a.id)}>{a.label}</button>)}
      {plugin.target && <button type="button" onClick={() => dispatch('open')}>Open chat</button>}
    </div>}
  </div>;
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
  /** True while the pointer is really over the DOM island: a native "collapse" must not close it under the cursor. */
  const hovered = useRef(false);
  const [selected, setSelected] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, DecisionAnswer[]>>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string>();
  const [, rerender] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
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
    const onError = (e: ErrorEvent) => islandLog('window error: ' + String(e.message).slice(0, 200));
    const onRejection = (e: PromiseRejectionEvent) => islandLog('unhandled rejection: ' + String(e.reason).slice(0, 200));
    // Re-sync when the window comes back (focus, visible): the main window republishes its latest snapshot on 'ready'.
    const resync = () => { if (document.visibilityState === 'visible') void send({type:'ready'}).catch(() => undefined); };
    const onVisibility = () => { islandLog('visibility ' + document.visibilityState); resync(); };
    window.addEventListener('focus', resync);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    document.addEventListener('visibilitychange', onVisibility);
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
        const hoverListener = await listen<{expanded:boolean}>('island:hover', ({payload}) => {
          if (payload.expanded) { clearTimeout(leaveTimer.current); setExpanded(true); }
          else if (!outcomeRef.current && !hovered.current && !pinnedRef.current) setExpanded(false);
        });
        if (disposed) { hoverListener(); return; } unlisteners.push(hoverListener);
        await send({type:'ready'});
        retry = setInterval(() => { if (!previous.current) void send({type:'ready'}).catch(() => undefined); }, 1000);
      } catch (e) { if (!disposed) setLocalError(String(e)); }
    })();
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', resync); disposed = true; clearInterval(retry); unlisteners.forEach(fn => fn()); clearTimeout(motionTimer.current); };
  }, []);
  const items = (displaySnapshot?.items ?? []).filter(i => !answeredIds.current.has(i.id));
  const lastCurrent = useRef<AttentionItem | undefined>(undefined);
  const active = items.find(i => i.id === selected) ?? items[0];
  if (active && !submission) lastCurrent.current = active;
  const current = submission && lastCurrent.current ? lastCurrent.current : active;
  const answers = current ? drafts[current.id] ?? [] : [];
  useEffect(() => { setLocalError(undefined); }, [current?.id]);
  // The "next card" reveal plays only when the displayed card changes while the island is open, never on every expand.
  const [cardEnter, setCardEnter] = useState(false);
  const shownCard = useRef<string | undefined>(undefined);
  const shellLayout = useIslandLayout({
    active: !!snapshot?.items.length && (!!displaySnapshot || !!outcome),
    expanded,
    pinned: pinned || !!submission || (!!current && !!snapshot?.busy.includes(current.id)),
    requestKey: outcome ? `result:${outcome.id}` : current?.id,
    content,
  });
  useLayoutEffect(() => {
    const changed = shownCard.current !== undefined && current?.id !== undefined && shownCard.current !== current.id;
    shownCard.current = current?.id ?? shownCard.current;
    if (changed && shellLayout.expanded) setCardEnter(true);
  }, [current?.id]);
  useLayoutEffect(() => { if (!shellLayout.expanded) setCardEnter(false); }, [shellLayout.expanded]);
  useEffect(() => {
    const id = submitting.current;
    if (!id || !snapshot) return;
    if (snapshot.busy.includes(id)) { sawBusy.current = true; return; }
    if (snapshot.error) { submitting.current = null; sawBusy.current = false; pendingOutcome.current = null; setSubmission(null); return; }
    if (sawBusy.current || !snapshot.items.some(item => item.id === id)) {
      submitting.current = null; sawBusy.current = false;
      const completed = pendingOutcome.current;
      pendingOutcome.current = null;
      if (completed?.id === id) {
        // The API acknowledgement, not the native dispatch promise, completes this request.
        answeredIds.current.add(id);
        setDrafts(old => { const next = { ...old }; delete next[id]; return next; });
        setReplies(old => { const next = { ...old }; delete next[id]; return next; });
        const remaining = (displayed.current?.items ?? []).filter(item => !answeredIds.current.has(item.id));
        clearTimeout(leaveTimer.current);
        setLeaving(false); setExpanded(true);
        if (remaining.length) {
          const index = Math.max(0, items.findIndex(item => item.id === id));
          setSelected(remaining[index % remaining.length].id);
          setOutcome(null); setSubmission(null);
        } else {
          setOutcome(completed); setSubmission('success');
        }
      } else {
        // Opening a native terminal keeps its existing short completion behaviour.
        setSubmission('success');
      }
    }
  }, [snapshot]);
  // New work takes priority over a final confirmation that is still fading out.
  useEffect(() => {
    if (!outcome || submission !== 'success' || !items.length) return;
    clearTimeout(leaveTimer.current);
    setOutcome(null); setLeaving(false); setSubmission(null); setExpanded(true);
    setSelected(items[0].id);
  }, [items.length, outcome, submission]);
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
  const cycleDisabled = !!submission || (!!current && !!snapshot?.busy.includes(current.id));
  const act = (intent: IslandIntent) => {
    if (intent.type === 'ready' || submitting.current || disabled) return;
    setLocalError(undefined); submitting.current = intent.id; sawBusy.current = false; setSubmission('busy');
    const item = items.find(i => i.id === intent.id);
    pendingOutcome.current = intent.type === 'approval'
      ? { id: intent.id, kind: intent.decision === 'allow' ? 'accepted' : 'refused', title: item?.kind === 'approval' ? item.approval.action : '' }
      : intent.type === 'decision'
        ? { id: intent.id, kind: 'sent', title: item?.kind === 'decision' ? item.decision.questions[0]?.header || item.decision.sessionName : '' }
        : intent.type === 'notification-action'
          ? { id: intent.id, kind: intent.input !== undefined ? 'sent' : 'accepted', title: item?.kind === 'notification' ? (intent.input !== undefined ? `To ${item.notification.title}` : item.notification.title) : '', label: intent.input !== undefined ? undefined : 'Done' }
          : null;
    void send(intent).catch(e => { submitting.current = null; pendingOutcome.current = null; setSubmission(null); setLocalError(String(e)); });
  };
  const actNotification = (id: string, action: 'dismiss' | 'open' | 'hold') => {
    if (action === 'hold') { void send({ type: 'notification', id, action }).catch(() => undefined); return; }
    answeredIds.current.add(id); rerender(n => n + 1);
    void send({ type: 'notification', id, action }).catch(e => { answeredIds.current.delete(id); rerender(n => n + 1); setLocalError(String(e)); });
  };
  const cycle = (delta: number) => { if (submitting.current || cycleDisabled || !items.length) return; const index = items.findIndex(i => i.id === current?.id); setSelected(items[(index + delta + items.length) % items.length]?.id); };
  const answer = (questionId: string, optionIds: string[], text: string) => {
    if (!current || disabled) return;
    const id = current.id;
    setDrafts(old => ({ ...old, [id]: [...(old[id] ?? []).filter(a => a.questionId !== questionId), { questionId, optionIds, text }] }));
  };
  if ((!displaySnapshot || !items.length) && !outcome) { hovered.current = false; return null; }
  // While the result is shown, queue motion (an exit from the emptied queue, or an enter from a new request) must not replay over it.
  const topNote = items.every(i => i.kind === 'notification') && current?.kind === 'notification' ? current.notification : undefined;
  const notePill = topNote ? { n: topNote, Icon: levelMeta[topNote.level].Icon } : undefined;
  const shownMotion = outcome ? 'idle' : motion;
  return <div className={'island island-' + shownMotion + ' ' + (shellLayout.expanded ? 'expanded' : 'collapsed') + (outcome ? ' island-outcome island-outcome-' + outcome.kind + (leaving ? ' island-leaving' : '') : '')} ref={body} style={{ height: shellLayout.height, '--island-width': `${shellLayout.width}px`, '--island-content-max-height': `${shellLayout.contentMaxHeight}px` } as CSSProperties} onMouseEnter={() => { islandLog('dom enter'); hovered.current = true; clearTimeout(leaveTimer.current); setExpanded(true); }} onMouseLeave={() => { islandLog('dom leave'); hovered.current = false; clearTimeout(leaveTimer.current); leaveTimer.current = setTimeout(() => { if (!pinnedRef.current && !outcomeRef.current) setExpanded(false); }, 300); }} onKeyDown={e => { if (e.key === 'Escape') { setPinned(false); setExpanded(false); } if (current?.kind === 'decision' && e.key === 'Enter' && e.ctrlKey && !disabled && current.decision.answerMode !== 'terminal' && validAnswers(current.decision.questions, answers)) { e.preventDefault(); act({type:'decision', id:current.id, answers}); } }} onFocusCapture={e => { if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) setPinned(true); }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPinned(false); }}>
    <div aria-hidden={shellLayout.expanded} className={'island-header island-pill' + (outcome ? ' island-pill-' + outcome.kind : '')}>{outcome ? <><OutcomeMark kind={outcome.kind}/><strong>{outcome.label ?? OUTCOME_LABEL[outcome.kind]}</strong></> : notePill ? <>{notePill.n.plugin ? <Avatar small src={notePill.n.plugin.avatar} name={notePill.n.title}/> : <notePill.Icon className="island-pill-level" data-level={notePill.n.level} size={16}/>}<strong className="island-pill-title">{notePill.n.title}</strong>{snapshot?.audio?.status === 'playing' && snapshot.audio.id === notePill.n.id && <span className="island-pill-playing" role="img" aria-label="Playing"><i/><i/><i/></span>}{items.length > 1 && <span className="island-pill-more">+{items.length - 1}</span>}</> : <><i className="island-dot"/><strong><span className="island-count">{items.length}</span> waiting</strong><span className="island-typing" aria-hidden="true"><i/><i/><i/></span></>}</div>
    {outcome ? <div className="island-content island-result" ref={content} role="status" aria-live="polite" aria-hidden={!shellLayout.expanded} inert={!shellLayout.expanded}>
      <span className="island-result-mark"><OutcomeMark kind={outcome.kind}/></span>
      <strong className="island-result-label">{outcome.label ?? OUTCOME_LABEL[outcome.kind]}</strong>
      {outcome.title && <span className="island-result-sub">{outcome.title}</span>}
    </div> : current && (current.kind === 'notification' ? <div key={current.id} className={'island-content' + (cardEnter ? ' island-card-enter' : '')} onAnimationEnd={e => { if (e.animationName === 'island-request-enter') setCardEnter(false); }} ref={content} aria-hidden={!shellLayout.expanded} inert={!shellLayout.expanded}>
      {current.notification.plugin
        ? <MessageCard notification={current.notification} disabled={disabled} busy={submission === 'busy'} draft={replies[current.id] ?? ''} setDraft={text => setReplies(old => ({ ...old, [current.id]: text }))} send={action => actNotification(current.id, action)} act={(actionId, input) => act({ type: 'notification-action', id: current.id, actionId, ...(input !== undefined ? { input } : {}) })} audio={snapshot?.audio?.id === current.id ? snapshot.audio : null} sendAudio={(op, value) => send({ type: 'notification-audio', id: current.id, op, ...(value !== undefined ? { value } : {}) })}/>
        : <NotificationCard notification={current.notification} send={action => actNotification(current.id, action)}/>}
      {items.length > 1 && <div className="island-cycle"><button disabled={cycleDisabled} onClick={() => cycle(-1)} aria-label="Previous request"><IconChevronLeft size={15}/></button><div className="island-queue" aria-label={`Item ${items.indexOf(current)+1} of ${items.length}`}>{items.map(item => <span key={item.id} className={item.id === current.id ? 'active' : ''}/>)}</div><button disabled={cycleDisabled} onClick={() => cycle(1)} aria-label="Next request"><IconChevronRight size={15}/></button></div>}
      {(localError || (current.notification.plugin && snapshot?.error)) && <p role="alert" className="island-error">{localError || snapshot?.error}</p>}
    </div> : <div key={current.id} className={'island-content' + (cardEnter ? ' island-card-enter' : '')} onAnimationEnd={e => { if (e.animationName === 'island-request-enter') setCardEnter(false); }} ref={content} aria-hidden={!shellLayout.expanded} inert={!shellLayout.expanded}>
      <div className="island-card-header">
        <span className="island-badge">{current.kind === 'decision' ? <IconMessageQuestion size={20}/> : <IconShieldQuestion size={20}/>} {current.kind === 'approval' && current.approval.irreversible && <i/>}</span>
        <div className="island-heading"><span>{current.kind === 'approval' ? `Needs your OK · ${actorLabel(current.approval.requester)}` : `Direction requested · ${current.decision.sessionName}`}</span><strong className={current.kind === 'approval' ? 'island-title-command' : ''}>{current.kind === 'approval' ? current.approval.action : current.decision.questions[0]?.header || current.decision.questions[0]?.question || 'Agent question'}</strong></div>
        {current.kind === 'approval' && <div className="island-header-actions"><button className="island-circle" aria-label="Decline" disabled={disabled} onClick={() => act({type:'approval', id:current.id, decision:'deny'})}><IconX size={18}/></button><button className="primary" disabled={disabled} onClick={() => act({type:'approval', id:current.id, decision:'allow'})}><IconCheck size={16}/> Accept</button></div>}
      </div>
      {current.kind === 'approval' ? <><div className="island-detail"><div><span className="island-risk">{RISK_LABEL[riskLevel(current.approval.action, current.approval.detail, current.approval.irreversible)]}</span>{current.approval.detail && <p>{current.approval.detail}</p>}<p className="island-meta">From {actorLabel(current.approval.requester)} · Target {actorLabel(current.approval.target)}</p></div></div></> : <DecisionCard decision={current.decision} answers={answers} answer={answer} disabled={disabled} act={act} submission={submission}/>}
      {items.length > 1 && <div className="island-cycle"><button disabled={cycleDisabled} onClick={() => cycle(-1)} aria-label="Previous request"><IconChevronLeft size={15}/></button><div className="island-queue" aria-label={`Request ${items.indexOf(current)+1} of ${items.length}`}>{items.map(item => <span key={item.id} className={item.id === current.id ? 'active' : ''}/>)}</div><button disabled={cycleDisabled} onClick={() => cycle(1)} aria-label="Next request"><IconChevronRight size={15}/></button></div>}
      {!snapshot?.connected && <p role="status">Disconnected. Reconnecting…</p>}{(snapshot?.error || localError) && <p role="alert" className="island-error">{snapshot?.error || localError}</p>}
    </div>)}
  </div>;
}
function DecisionCard({decision, answers, answer, disabled, act, submission}: {decision: DecisionView; answers: DecisionAnswer[]; answer:(id:string, options:string[], text:string)=>void; disabled:boolean; act:(intent:IslandIntent)=>void; submission:'busy' | 'success' | null}) {
  return <>{decision.questions.map((q, index) => { const value = answers.find(a => a.questionId === q.id) ?? {questionId:q.id, optionIds:[], text:''}; return <div key={q.id}>{(q.header || index > 0) && <p>{q.header && index > 0 && <strong>{q.header}: </strong>}{q.question}</p>}{decision.answerMode !== 'terminal' && <><div className="island-options">{q.options.map(o => <label key={o.id}><input disabled={disabled} type={q.multiSelect ? 'checkbox' : 'radio'} name={q.id} checked={value.optionIds.includes(o.id)} onChange={e => answer(q.id, q.multiSelect ? e.target.checked ? [...value.optionIds,o.id] : value.optionIds.filter(id => id !== o.id) : [o.id], value.text)}/><span>{o.label}{o.description && <small>{o.description}</small>}</span></label>)}</div>{q.allowText && <label className="island-direction">Direction<textarea disabled={disabled} placeholder="Add direction…" value={value.text} onChange={e => answer(q.id,value.optionIds,e.target.value)} /></label>}</>}</div>; })}<div className="island-actions">{decision.source === 'native' && <button disabled={disabled} onClick={() => act({type:'terminal', id:decision.id})}>Open terminal</button>}{decision.answerMode !== 'terminal' && <button className="primary" disabled={disabled || !validAnswers(decision.questions, answers)} onClick={() => act({type:'decision', id:decision.id, answers})}>{submission === 'busy' ? <><IconLoader2 className="island-spinner" size={15}/> Sending</> : submission === 'success' ? <><IconCheck size={15}/> Sent</> : 'Send'}</button>}</div></>;
}
