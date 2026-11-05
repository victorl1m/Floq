import { useSyncExternalStore } from 'react';
import type { DecisionFrame, DecisionView } from './runtime/types';

let decisions: DecisionView[] = [];
let connected = false;
const listeners = new Set<() => void>();
let state = { decisions, connected };
function emit() { state = { decisions, connected }; listeners.forEach(f => f()); }
export function useAttentionState() { return useSyncExternalStore(subscribeAttention, () => state, () => state); }
export function subscribeAttention(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
export function setAttentionConnected(value: boolean) { connected = value; emit(); }
export function clearAttention() { decisions = []; connected = false; emit(); }
export function replaceDecisions(items: DecisionView[]) { decisions = items.filter(d => d.status === 'pending'); emit(); }
export function applyDecisionFrame(frame: DecisionFrame) {
  if (frame.type === 'decision-resolved') decisions = decisions.filter(d => d.id !== frame.id);
  else { decisions = decisions.filter(d => d.id !== frame.decision.id); if (frame.decision.status === 'pending') decisions.push(frame.decision); }
  emit();
}
