import { createContext, useContext } from "react";
import type { SessionSummary } from "@/lib/runtime/types";
import type { CanvasLink } from "./canvas-data";
import type { Attachment } from "./canvas-send";

export interface LiveBubble { key: string; text: string; from: string; to: string }
export interface LivePulse { key: string; reverse: boolean }
export interface LiveWire { pulses: LivePulse[]; bubbles: LiveBubble[] }

/** Mutable canvas state shared with node/edge components so React Flow node data never churns. */
export interface CanvasCtxValue {
  /** Orchestrator id -> number of agents it recruited. */
  recruits: Map<string, number>;
  liveIds: Set<string>;
  collapsed: Set<string>;
  linkMode: { from: string | null } | null;
  live: Record<string, LiveWire>;
  reducedMotion: boolean;
  titleOf: (id: string) => string;
  /** Opens the session's terminal in the canvas dialog (does not navigate). */
  focus: (session: SessionSummary) => void;
  /** Session whose terminal dialog is open; its mirror pauses meanwhile. */
  terminalId: string | null;
  /** Ids that just received a composer message (transient highlight). */
  sentIds: Set<string>;
  /** Node flashed after a sidebar focus request. */
  highlightId: string | null;
  startLink: (id: string) => void;
  toggleCollapse: (id: string) => void;
  activate: (id: string) => void;
  wake: (session: SessionSummary) => void;
  /** Delivers a message (and attachments) to one agent through the shared composer path; true when delivered. */
  sendMessage: (session: SessionSummary, text: string, attachments: Attachment[], onProgress: (id: string, fraction: number) => void) => Promise<boolean>;
  waking: Set<string>;
  /** Link count and the node sides wires leave from, per session. */
  linkInfo: Record<string, { count: number; sides: Set<string> }>;
  deleteLink: (link: CanvasLink) => void;
  /** Number of keychains linked to each agent. */
  keychainCounts: Record<string, number>;
  savePlacement: (id: string, rect: { x: number; y: number; width: number; height: number }) => void;
}

export const CanvasCtx = createContext<CanvasCtxValue | null>(null);
export function useCanvasCtx(): CanvasCtxValue {
  const value = useContext(CanvasCtx);
  if (!value) throw new Error("CanvasCtx missing");
  return value;
}
