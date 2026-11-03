import type pg from "pg";
import { badRequest, notFound } from "./errors.js";

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
  createdAt: string;
  updatedAt: string;
}

export const NOTE_MAX_TEXT = 20_000;
export const NOTE_MIN_SIZE = 120;
export const NOTE_MAX_SIZE = 2000;
export const NOTE_MAX_COORD = 1e7;
export const MAX_NOTES_PER_PROJECT = 500;

export interface NoteFields { text?: string; color?: NoteColor; x?: number; y?: number; w?: number; h?: number }

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
  return out;
}

const UUID = /^[0-9a-f-]{36}$/i;
const COLS = "id, project_id, text, color, x, y, w, h, created_at, updated_at";

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
    const r = await this.pool.query(
      `SELECT ${COLS} FROM canvas_notes WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at`,
      [userId, project],
    );
    return r.rows.map(toNote);
  }

  async create(userId: string, projectId: string, body: unknown): Promise<CanvasNote> {
    const f = parseNoteFields(body, true);
    const project = await this.scope(userId, projectId);
    const count = await this.pool.query("SELECT count(*)::int AS n FROM canvas_notes WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid", [userId, project]);
    if (count.rows[0].n >= MAX_NOTES_PER_PROJECT) throw badRequest("Note limit reached (" + MAX_NOTES_PER_PROJECT + ")", "too_many_notes");
    const r = await this.pool.query(
      `INSERT INTO canvas_notes (user_id, project_id, text, color, x, y, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
      [userId, project, f.text ?? "", f.color ?? "yellow", f.x, f.y, f.w ?? 240, f.h ?? 160],
    );
    return toNote(r.rows[0]);
  }

  async patch(userId: string, id: string, body: unknown): Promise<CanvasNote> {
    if (!UUID.test(id)) throw notFound("Note not found");
    const f = parseNoteFields(body, false);
    const cols = { text: "text", color: "color", x: "x", y: "y", w: "w", h: "h" } as const;
    const sets: string[] = [];
    const values: unknown[] = [id, userId];
    for (const key of Object.keys(cols) as (keyof typeof cols)[]) {
      if (f[key] === undefined) continue;
      values.push(f[key]);
      sets.push(cols[key] + " = $" + values.length);
    }
    const sql = sets.length
      ? `UPDATE canvas_notes SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`
      : `SELECT ${COLS} FROM canvas_notes WHERE id = $1 AND user_id = $2`;
    const r = await this.pool.query(sql, values);
    if (!r.rows[0]) throw notFound("Note not found");
    return toNote(r.rows[0]);
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw notFound("Note not found");
    const r = await this.pool.query("DELETE FROM canvas_notes WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!r.rowCount) throw notFound("Note not found");
  }
}
