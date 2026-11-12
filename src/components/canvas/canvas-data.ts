// Adapter between the canvas UI and the runtime's agent-link / agent-message API.
// Contract-facing calls live here so a runtime-side rename is a one-line fix.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { AgentLink, AgentMessageEvent, CanvasNote, CanvasNoteInput, NoteColor, NoteKind } from "@/lib/runtime/types";

export type { AgentMessageEvent };
export type LinkKind = AgentLink["kind"];
/** A runtime link, or a client-side one (`synthetic`): inferred from parentSessionId or created optimistically. */
export type CanvasLink = AgentLink & { synthetic?: boolean };

export const fetchLinks = (client: RuntimeClient, projectId: string) => client.projectLinks(projectId);
export const createLinkRequest = (client: RuntimeClient, from: string, to: string) => client.createLink(from, to);
export const deleteLinkRequest = (client: RuntimeClient, id: string) => client.deleteLink(id);
const fetchBacklog = (client: RuntimeClient, projectId: string) => client.projectEvents(projectId, 50);
const eventsStreamUrl = (client: RuntimeClient) => client.eventsUrl();

/** Links of a project, polled every 5s and refreshable on demand. `loaded` flips once the first fetch settles. */
export function useProjectLinks(client: RuntimeClient | null, projectId: string | null) {
  const [links, setLinks] = useState<CanvasLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    if (!client || !projectId) return;
    try {
      setLinks(await fetchLinks(client, projectId));
      setLoaded(true);
    } catch { /* keep the last good list; the next poll retries */ }
  }, [client, projectId]);
  useEffect(() => {
    setLinks([]);
    setLoaded(false);
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { links, loaded, refresh };
}

const eventKey = (e: AgentMessageEvent) => `${e.linkId}|${e.at}|${e.kind}|${e.fromSessionId}|${e.preview.slice(0, 40)}`;

/** Recent events (newest first, max 100) seeded from the backlog; `onFresh` fires once for each newly seen recent event. */
export function useAgentEvents(client: RuntimeClient | null, projectId: string | null, onFresh: (event: AgentMessageEvent) => void) {
  const [events, setEvents] = useState<AgentMessageEvent[]>([]);
  const freshRef = useRef(onFresh);
  freshRef.current = onFresh;
  useEffect(() => {
    setEvents([]);
    if (!client || !projectId) return;
    const seen = new Set<string>();
    let primed = false;
    let stopped = false;
    const ingest = (incoming: AgentMessageEvent[]) => {
      const fresh: AgentMessageEvent[] = [];
      for (const event of incoming) {
        if (!event || event.type !== "agent-message" || event.projectId !== projectId) continue;
        const key = eventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(event);
      }
      if (!fresh.length) return;
      setEvents((current) => [...fresh, ...current].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100));
      if (primed) for (const event of fresh) if (Date.now() - Date.parse(event.at) < 20_000) freshRef.current(event);
    };
    const poll = async () => {
      try { ingest(await fetchBacklog(client, projectId)); } catch { /* retry next tick */ }
    };
    void poll().then(() => { primed = true; });

    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      try { ws = new WebSocket(eventsStreamUrl(client)); } catch { return; }
      ws.onopen = () => { attempt = 0; };
      ws.onmessage = (message) => {
        try { ingest([JSON.parse(String(message.data)) as AgentMessageEvent]); } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        ws = null;
        if (!stopped) timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
      };
    };
    connect();
    // The backlog poll doubles as a fallback if the push channel is unavailable.
    const interval = setInterval(() => void poll(), 5000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(interval);
      ws?.close();
    };
  }, [client, projectId]);
  return events;
}

// ---- canvas notes and per-agent secrets (thin wrappers over the runtime client) ----
export type { CanvasNote, NoteColor, NoteKind };
export type NotePatch = CanvasNoteInput;

// A runtime that predates note links omits linkedSessionIds, so default it.
const withLinks = (note: CanvasNote): CanvasNote => ({ ...note, linkedSessionIds: note.linkedSessionIds ?? [] });
export const fetchNotes = async (client: RuntimeClient, projectId: string) => (await client.projectNotes(projectId)).map(withLinks);
export const createNoteRequest = async (client: RuntimeClient, projectId: string, input: CanvasNoteInput & { x: number; y: number }) => withLinks(await client.createNote(projectId, input));
export const updateNoteRequest = (client: RuntimeClient, id: string, patch: NotePatch) => client.updateNote(id, patch);
export const deleteNoteRequest = (client: RuntimeClient, id: string) => client.deleteNote(id);
export const linkNote = (client: RuntimeClient, id: string, sessionId: string) => client.linkNote(id, sessionId);
export const unlinkNote = (client: RuntimeClient, id: string, sessionId: string) => client.unlinkNote(id, sessionId);
