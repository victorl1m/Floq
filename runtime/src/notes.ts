import type pg from "pg";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";
import { log } from "./logger.js";

export const NOTE_COLORS = ["yellow", "blue", "green", "pink", "purple", "gray"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface CanvasNote {
  id: string;
  projectId: string | null;
  text: string;
  color: NoteColor;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Agents wired to this note: they read and edit it, and create new notes, through `floq sticky`. */
  linkedSessionIds: string[];
  /** Shown in the header: the `floq note` name for a mirrored card, else the title the user typed; null when none. */
  title: string | null;
  /** Name of the `floq note` this card mirrors; null for plain canvas notes. Renaming such a card renames the agent note. */
  agentNoteName: string | null;
  /** False until the canvas has chosen a spot for a note created by an agent or backfilled; the UI then places and persists it. */
  placed: boolean;
  createdAt: string;
  updatedAt: string;
}

export const NOTE_MAX_TEXT = 20_000;
export const NOTE_MIN_SIZE = 120;
export const NOTE_MAX_SIZE = 2000;
export const NOTE_MAX_COORD = 1e7;
export const MAX_NOTES_PER_PROJECT = 500;

export interface NoteFields { text?: string; color?: NoteColor; x?: number; y?: number; w?: number; h?: number; agentNoteName?: string; title?: string | null }
export const NOTE_MAX_TITLE = 80;
const AGENT_NOTE_NAME = /^[\w .-]{1,80}$/;

export function finite(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw badRequest(name + " must be a number between " + min + " and " + max, "invalid_note");
  return value;
}

/** Validate a create/patch body; only supplied fields are returned. `needPosition` requires x and y (create). */
export function parseNoteFields(body: unknown, needPosition: boolean): NoteFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("JSON object body required", "invalid_note");
  const b = body as Record<string, unknown>;
  const out: NoteFields = {};
  if (b.text !== undefined) {
    if (typeof b.text !== "string" || b.text.length > NOTE_MAX_TEXT) throw badRequest("text must be a string of at most " + NOTE_MAX_TEXT + " characters", "invalid_note");
    if (b.text.includes("\0")) throw badRequest("text must not contain NUL bytes", "invalid_note");
    out.text = b.text;
  }
  if (b.color !== undefined) {
    if (typeof b.color !== "string" || !(NOTE_COLORS as readonly string[]).includes(b.color)) throw badRequest("color must be one of " + NOTE_COLORS.join(", "), "invalid_note");
    out.color = b.color as NoteColor;
  }
  for (const key of ["x", "y"] as const) {
    if (b[key] !== undefined) out[key] = finite(key, b[key], -NOTE_MAX_COORD, NOTE_MAX_COORD);
    else if (needPosition) throw badRequest(key + " is required", "invalid_note");
  }
  for (const key of ["w", "h"] as const) if (b[key] !== undefined) out[key] = finite(key, b[key], NOTE_MIN_SIZE, NOTE_MAX_SIZE);
  if (b.agentNoteName !== undefined) {
    if (typeof b.agentNoteName !== "string" || !AGENT_NOTE_NAME.test(b.agentNoteName)) throw badRequest("agentNoteName must be 1-80 chars of letters, digits, space, . _ -", "invalid_note");
    out.agentNoteName = b.agentNoteName;
  }
  if (b.title !== undefined) {
    if (b.title === null) out.title = null;
    else {
      if (typeof b.title !== "string") throw badRequest("title must be a string or null", "invalid_note");
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(b.title)) throw badRequest("title must not contain control characters", "invalid_note");
      const t = b.title.trim();
      if (t.length > NOTE_MAX_TITLE) throw badRequest("title must be at most " + NOTE_MAX_TITLE + " characters", "invalid_note");
      out.title = t || null;
    }
  }
  return out;
}

const UUID = /^[0-9a-f-]{36}$/i;
const COLS = `n.id, n.project_id, n.text, n.color, n.x, n.y, n.w, n.h, n.agent_note_name, n.user_title, n.placed, n.created_at, n.updated_at,
    COALESCE((SELECT array_agg(l.session_id::text ORDER BY l.created_at) FROM canvas_note_links l WHERE l.note_id = n.id), '{}') AS linked`;

function toNote(r: Record<string, unknown>): CanvasNote {
  return {
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? null,
    text: r.text as string,
    color: r.color as NoteColor,
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
    linkedSessionIds: (r.linked as string[]) ?? [],
    title: (r.agent_note_name as string | null) ?? (r.user_title as string | null) ?? null,
    agentNoteName: (r.agent_note_name as string | null) ?? null,
    placed: r.placed !== false,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export class CanvasNotes {
  constructor(private readonly pool: pg.Pool) {}

  /** "none" addresses the scratch canvas (project_id NULL). A real project must belong to the user. */
  private async scope(userId: string, projectId: string): Promise<string | null> {
    if (projectId === "none") return null;
    if (!UUID.test(projectId)) throw notFound("Project not found");
    const r = await this.pool.query("SELECT 1 FROM floq_projects WHERE id = $1 AND user_id = $2", [projectId, userId]);
    if (!r.rowCount) throw notFound("Project not found");
    return projectId;
  }

  async list(userId: string, projectId: string): Promise<CanvasNote[]> {
    const project = await this.scope(userId, projectId);
    await this.adoptAgentNotes(userId, project);
    const r = await this.pool.query(
      `SELECT ${COLS} FROM canvas_notes n WHERE n.user_id = $1 AND n.project_id IS NOT DISTINCT FROM $2::uuid ORDER BY n.created_at`,
      [userId, project],
    );
    return r.rows.map(toNote);
  }

  /**
   * `floq note` notes written before they were mirrored to the canvas have no project: the first project canvas
   * opened adopts every unmirrored one (unplaced, unlinked; the UI places and persists them). The scratch canvas
   * only adopts when the user has no project at all.
   */
  private async adoptAgentNotes(userId: string, project: string | null): Promise<void> {
    if (!project) {
      const any = await this.pool.query("SELECT 1 FROM floq_projects WHERE user_id = $1 LIMIT 1", [userId]);
      if (any.rowCount) return;
    }
    await this.pool.query(
      `INSERT INTO canvas_notes (user_id, project_id, text, color, x, y, w, h, agent_note_name, placed)
       SELECT a.user_id, $2::uuid, left(a.content, ${NOTE_MAX_TEXT}), 'blue', 0, 0, 280, 200, a.name, false FROM agent_notes a
       WHERE a.user_id = $1 AND NOT EXISTS (SELECT 1 FROM canvas_notes c WHERE c.user_id = a.user_id AND c.agent_note_name = a.name)
       ON CONFLICT DO NOTHING`,
      [userId, project],
    );
  }

  /**
   * Called after `floq note write|append`: makes sure the writing agent's project canvas shows the note
   * (created unplaced and wired to the agent) and refreshes the text of every mirror of that name.
   */
  async mirrorAgentNote(userId: string, sessionId: string, name: string): Promise<CanvasNote | null> {
    const a = (await this.pool.query("SELECT content FROM agent_notes WHERE user_id = $1 AND name = $2", [userId, name])).rows[0] as { content: string } | undefined;
    const s = UUID.test(sessionId) ? (await this.pool.query("SELECT project_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId])).rows[0] as { project_id: string | null } | undefined : undefined;
    if (!a || !s) return null;
    const text = a.content.slice(0, NOTE_MAX_TEXT);
    await this.pool.query("UPDATE canvas_notes SET text = $3, updated_at = now() WHERE user_id = $1 AND agent_note_name = $2 AND text <> $3", [userId, name, text]);
    const project = s.project_id ?? null;
    const find = async () => (await this.pool.query("SELECT id FROM canvas_notes WHERE user_id = $1 AND agent_note_name = $2 AND project_id IS NOT DISTINCT FROM $3::uuid", [userId, name, project])).rows[0] as { id: string } | undefined;
    let row = await find();
    if (!row) {
      const count = await this.pool.query("SELECT count(*)::int AS n FROM canvas_notes WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid", [userId, project]);
      if (count.rows[0].n >= MAX_NOTES_PER_PROJECT) { log.warn("note.mirror.limit", { userId, name }); return null; }
      await this.pool.query(
        "INSERT INTO canvas_notes (user_id, project_id, text, color, x, y, w, h, agent_note_name, placed) VALUES ($1,$2,$3,'blue',0,0,280,200,$4,false) ON CONFLICT DO NOTHING",
        [userId, project, text, name],
      );
      row = await find();
      if (!row) return null;
    }
    await this.pool.query("INSERT INTO canvas_note_links (note_id, session_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [row.id, sessionId, userId]);
    return this.get(userId, row.id);
  }

  async create(userId: string, projectId: string, body: unknown): Promise<CanvasNote> {
    const f = parseNoteFields(body, true);
    const project = await this.scope(userId, projectId);
    const count = await this.pool.query("SELECT count(*)::int AS n FROM canvas_notes WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid", [userId, project]);
    if (count.rows[0].n >= MAX_NOTES_PER_PROJECT) throw badRequest("Note limit reached (" + MAX_NOTES_PER_PROJECT + ")", "too_many_notes");
    const r = await this.pool.query(
      "INSERT INTO canvas_notes (user_id, project_id, text, color, x, y, w, h, agent_note_name, user_title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
      [userId, project, f.text ?? "", f.color ?? "yellow", f.x, f.y, f.w ?? 240, f.h ?? 160, f.agentNoteName ?? null, f.agentNoteName ? null : (f.title ?? null)],
    ).catch((e) => { throw f.agentNoteName && (e as { code?: string }).code === "23505" ? badRequest("A note named " + f.agentNoteName + " is already on this canvas", "duplicate_note") : e; });
    if (f.agentNoteName) await this.pushToAgentNote(userId, f.agentNoteName, f.text ?? "");
    return this.get(userId, r.rows[0].id);
  }

  async get(userId: string, id: string): Promise<CanvasNote> {
    if (!UUID.test(id)) throw notFound("Note not found");
    const r = await this.pool.query(`SELECT ${COLS} FROM canvas_notes n WHERE n.id = $1 AND n.user_id = $2`, [id, userId]);
    if (!r.rows[0]) throw notFound("Note not found");
    return toNote(r.rows[0]);
  }

  async patch(userId: string, id: string, body: unknown): Promise<CanvasNote> {
    if (!UUID.test(id)) throw notFound("Note not found");
    const f = parseNoteFields(body, false);
    if (f.agentNoteName !== undefined) delete f.agentNoteName; // a card never changes which agent note it mirrors
    const current = f.title !== undefined ? await this.get(userId, id) : undefined;
    let renamed = false;
    if (f.title !== undefined && current) {
      if (current.agentNoteName) {
        // The title of a mirrored card IS the `floq note` name: renaming it renames the agent note and every mirror.
        if (!f.title) throw badRequest("A note shared with agents needs a name; type a new name instead of clearing it", "invalid_note");
        if (!AGENT_NOTE_NAME.test(f.title)) throw badRequest("A note shared with agents is named with 1-80 letters, digits, spaces, . _ -", "invalid_note");
        if (f.title !== current.agentNoteName) {
          const taken = await this.pool.query("SELECT 1 FROM agent_notes WHERE user_id = $1 AND name = $2", [userId, f.title]);
          const taken2 = await this.pool.query("SELECT 1 FROM canvas_notes WHERE user_id = $1 AND agent_note_name = $2", [userId, f.title]);
          if (taken.rowCount || taken2.rowCount) throw conflict("A note named " + f.title + " already exists", "duplicate_note");
          renamed = true;
        }
      }
    }
    const cols = { text: "text", color: "color", x: "x", y: "y", w: "w", h: "h" } as const;
    const sets: string[] = [];
    const values: unknown[] = [id, userId];
    for (const key of Object.keys(cols) as (keyof typeof cols)[]) {
      if (f[key] === undefined) continue;
      values.push(f[key]);
      sets.push(cols[key] + " = $" + values.length);
    }
    if (f.x !== undefined || f.y !== undefined) sets.push("placed = true");
    if (f.title !== undefined && current && !current.agentNoteName) { values.push(f.title); sets.push("user_title = $" + values.length); }
    if (renamed && current?.agentNoteName && f.title) {
      await this.pool.query("UPDATE agent_notes SET name = $3, updated_at = now() WHERE user_id = $1 AND name = $2", [userId, current.agentNoteName, f.title]);
      await this.pool.query("UPDATE canvas_notes SET agent_note_name = $3, updated_at = now() WHERE user_id = $1 AND agent_note_name = $2", [userId, current.agentNoteName, f.title]);
    }
    if (sets.length) {
      const r = await this.pool.query(`UPDATE canvas_notes SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, values);
      if (!r.rowCount) throw notFound("Note not found");
    }
    const saved = await this.get(userId, id);
    if (f.text !== undefined && saved.agentNoteName) await this.pushToAgentNote(userId, saved.agentNoteName, saved.text, id);
    return saved;
  }

  /** Keeps `floq note read NAME` and the other canvases' mirrors of the same note in step with a canvas edit. */
  private async pushToAgentNote(userId: string, name: string, text: string, exceptId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_notes (user_id, name, content) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, name) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [userId, name, text],
    );
    await this.pool.query("UPDATE canvas_notes SET text = $3, updated_at = now() WHERE user_id = $1 AND agent_note_name = $2 AND text <> $3 AND ($4::uuid IS NULL OR id <> $4)", [userId, name, text, exceptId ?? null]);
  }

  /** Returns the sessions the note was wired to, so their wired context can be refreshed. */
  async remove(userId: string, id: string): Promise<string[]> {
    if (!UUID.test(id)) throw notFound("Note not found");
    const note = await this.get(userId, id);
    const r = await this.pool.query("DELETE FROM canvas_notes WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!r.rowCount) throw notFound("Note not found");
    if (note.agentNoteName) {
      // Deleting the card deletes the note itself (otherwise it would be adopted again); undo recreates it with its title.
      await this.pool.query("DELETE FROM canvas_notes WHERE user_id = $1 AND agent_note_name = $2", [userId, note.agentNoteName]);
      await this.pool.query("DELETE FROM agent_notes WHERE user_id = $1 AND name = $2", [userId, note.agentNoteName]);
    }
    return note.linkedSessionIds;
  }

  /** Idempotent. The session must be the user's and in the note's project. */
  async link(userId: string, id: string, sessionIdValue: unknown): Promise<CanvasNote> {
    if (typeof sessionIdValue !== "string" || !UUID.test(sessionIdValue)) throw badRequest("sessionId required", "invalid_link");
    const note = await this.get(userId, id);
    const s = (await this.pool.query("SELECT project_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionIdValue, userId])).rows[0] as { project_id: string | null } | undefined;
    if (!s) throw notFound("Session not found");
    if ((s.project_id ?? null) !== note.projectId) throw new HttpError(403, "other_project", "The agent is in a different project than this note");
    await this.pool.query("INSERT INTO canvas_note_links (note_id, session_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, sessionIdValue, userId]);
    log.info("note.link", { userId, noteId: id, sessionId: sessionIdValue });
    return this.get(userId, id);
  }

  async unlink(userId: string, id: string, sessionId: string): Promise<CanvasNote> {
    await this.get(userId, id);
    if (UUID.test(sessionId)) {
      await this.pool.query("DELETE FROM canvas_note_links WHERE note_id = $1 AND session_id = $2 AND user_id = $3", [id, sessionId, userId]);
      log.info("note.unlink", { userId, noteId: id, sessionId });
    }
    return this.get(userId, id);
  }

  // --- agent access (`floq sticky`): only notes wired to the calling session, plus creating new ones ---

  async agentList(userId: string, sessionId: string): Promise<CanvasNote[]> {
    const r = await this.pool.query(
      `SELECT ${COLS} FROM canvas_notes n JOIN canvas_note_links k ON k.note_id = n.id AND k.session_id = $2
       WHERE n.user_id = $1 ORDER BY n.created_at`,
      [userId, sessionId],
    );
    return r.rows.map(toNote);
  }

  async agentRead(userId: string, sessionId: string, id: unknown): Promise<CanvasNote> {
    if (typeof id !== "string" || !UUID.test(id)) throw badRequest("note id required", "invalid_note");
    const note = await this.get(userId, id);
    if (!note.linkedSessionIds.includes(sessionId)) throw new HttpError(403, "not_linked", "This note is not linked to you; the user must wire it to your agent on the canvas");
    return note;
  }

  /** Replaces or appends the text. A concurrent edit by the user is last-writer-wins; the UI polls and picks the change up. */
  async agentWrite(userId: string, sessionId: string, id: unknown, text: unknown, append: boolean): Promise<CanvasNote> {
    const note = await this.agentRead(userId, sessionId, id);
    if (typeof text !== "string") throw badRequest("text required", "invalid_note");
    const next = append && note.text ? note.text + (note.text.endsWith("\n") ? "" : "\n") + text : text;
    return this.patch(userId, note.id, { text: next });
  }

  /** Creates a note in the agent's project, linked to the agent and placed beside its newest linked note. */
  async agentCreate(userId: string, sessionId: string, body: unknown): Promise<CanvasNote> {
    const s = (await this.pool.query("SELECT project_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId])).rows[0] as { project_id: string | null } | undefined;
    if (!s) throw notFound("Calling session not found");
    const input = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const anchor = (await this.agentList(userId, sessionId)).filter((n) => n.projectId === (s.project_id ?? null)).pop();
    const note = await this.create(userId, s.project_id ?? "none", { w: 240, h: 160, ...input, x: input.x ?? (anchor ? anchor.x + anchor.w + 30 : 0), y: input.y ?? (anchor ? anchor.y : 0) });
    return this.link(userId, note.id, sessionId);
  }
}
