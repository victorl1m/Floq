import { createContext, useContext } from "react";
import type { SessionSummary } from "@/lib/runtime/types";
import type { CanvasLink } from "./canvas-data";

export interface LiveBubble { key: string; text: string; from: string; to: string }
export interface LivePulse { key: string; reverse: boolean }
export interface LiveWire { pulses: LivePulse[]; bubbles: LiveBubble[] }

/** Mutable canvas state shared with node/edge components so React Flow node data never churns. */
export interface CanvasCtxValue {
  liveIds: Set<string>;
  collapsed: Set<string>;
  linkMode: { from: string | null } | null;
  live: Record<string, LiveWire>;
  reducedMotion: boolean;
  titleOf: (id: string) => string;
  focus: (session: SessionSummary) => void;
  startLink: (id: string) => void;
  toggleCollapse: (id: string) => void;
  activate: (id: string) => void;
  deleteLink: (link: CanvasLink) => void;
  savePlacement: (id: string, rect: { x: number; y: number; width: number; height: number }) => void;
}

export const CanvasCtx = createContext<CanvasCtxValue | null>(null);
export function useCanvasCtx(): CanvasCtxValue {
  const value = useContext(CanvasCtx);
  if (!value) throw new Error("CanvasCtx missing");
  return value;
}
