import type { ApprovalRequest, DecisionView } from './runtime/types';

export type AttentionItem = { kind: 'approval'; id: string; createdAt: string; approval: ApprovalRequest } | { kind: 'decision'; id: string; createdAt: string; decision: DecisionView };
export interface IslandSnapshot { epoch: string; revision: number; connected: boolean; items: AttentionItem[]; busy: string[]; error?: string }
export type IslandIntent = { type: 'ready' } | { type: 'approval'; id: string; decision: 'allow' | 'deny' } | { type: 'decision'; id: string; answers: DecisionAnswer[] } | { type: 'terminal'; id: string };
export interface DecisionAnswer { questionId: string; optionIds: string[]; text: string }
export function orderAttention<T extends {kind: string; createdAt: string; id: string}>(items: T[]): T[] {
  return [...items].sort((a,b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function acceptSnapshot(current: {epoch:string; revision:number} | null, next: {epoch:string; revision:number}): boolean {
  return !current || current.epoch !== next.epoch || next.revision > current.revision;
}
export function validAnswers(questions: {id:string; options:{id:string}[]; multiSelect:boolean; allowText:boolean}[], answers: DecisionAnswer[]): boolean {
  return answers.some(a => a.optionIds.length > 0 || !!a.text.trim()) && answers.every(a => {
    const q = questions.find(q => q.id === a.questionId);
    return !!q && (q.multiSelect || a.optionIds.length <= 1) && new Set(a.optionIds).size === a.optionIds.length && a.optionIds.every(id => q.options.some(o => o.id === id)) && (q.allowText || !a.text.trim());
  }) && new Set(answers.map(a => a.questionId)).size === answers.length && answers.reduce((n,a) => n+a.text.length,0) <= 8000;
}

export const MAX_ACTION_CHARS = 240;
export const MAX_DETAIL_CHARS = 1200;

/** Cap agent-written text: keep the start and the tail (the end of a long command is where it hides), with an ellipsis between. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${text.slice(0, max - tail - 1)}…${text.slice(text.length - tail)}`;
}

/** The island shows agent-written approval text in a topmost overlay: bound its length (start and tail kept) so it cannot push the real command out of view. */
export function capAttention<T extends { kind: string }>(items: T[]): T[] {
  return items.map((item) => {
    const approval = (item as unknown as { approval?: ApprovalRequest }).approval;
    if (item.kind !== 'approval' || !approval) return item;
    return { ...item, approval: { ...approval, action: capText(approval.action, MAX_ACTION_CHARS), detail: capText(approval.detail, MAX_DETAIL_CHARS) } };
  });
}

export function sameSnapshotContent(a: IslandSnapshot, b: IslandSnapshot): boolean {
  return JSON.stringify({ ...a, revision: 0 }) === JSON.stringify({ ...b, revision: 0 });
}

/** Keep the last queue through brief sync/client teardown gaps. */
export const EMPTY_DEFER_MS = 1500;
/** The island's colored result stays on screen (hold + fade) about 3s; keep the OS window alive a little longer than that after an in-island answer. */
export const EMPTY_DEFER_AFTER_ANSWER_MS = 3300;
export function deferEmptySnapshot(previous: IslandSnapshot | null, next: IslandSnapshot, emptySince: number | null, now: number, holdMs = EMPTY_DEFER_MS): { snapshot: IslandSnapshot; emptySince: number | null } {
  if (next.items.length || !previous?.items.length) return { snapshot: next, emptySince: null };
  const since = emptySince ?? now;
  return { snapshot: now - since < holdMs ? { ...next, items: previous.items } : next, emptySince: since };
}
