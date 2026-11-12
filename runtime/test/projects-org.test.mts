import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createRuntimeServer } from "../dist/server.js";
import { migrateApp } from "../dist/db.js";
import { SessionManager } from "../dist/manager.js";
import { CanvasNotes } from "../dist/notes.js";
import { Keychains } from "../dist/keychains.js";
import { OrganizationsService } from "../dist/organizations.js";

const TOKENS: Record<string, string> = { ta: "u-a", tb: "u-b" };
const PA = "a0000000-0000-4000-8000-00000000000a", PB = "b0000000-0000-4000-8000-00000000000b", PC = "c0000000-0000-4000-8000-00000000000c";
const SA = "d0000000-0000-4000-8000-00000000000a", SB = "d0000000-0000-4000-8000-00000000000b", SS = "d0000000-0000-4000-8000-00000000000c";

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
}

async function harness(t: test.TestContext) {
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  let tail: Promise<void> = Promise.resolve();
  const pool = {
    query,
    async connect() { let release!: () => void; const prev = tail; tail = new Promise<void>((r) => { release = r; }); await prev; return { query, release }; },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" BOOLEAN DEFAULT false)`);
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id, name, email) VALUES ('u-a','a','a@x.io'), ('u-b','b','b@x.io')`);

  const orgs = new OrganizationsService(pool as never);
  const personalA = await orgs.ensurePersonal("u-a");
  const teamA = (await orgs.create("u-a", { name: "Team A" })).id;
  const teamB = (await orgs.create("u-b", { name: "Team B" })).id;
  const proj = (id: string, user: string, org: string, name: string) => db.query(`INSERT INTO floq_projects (id, user_id, name, cwd, organization_id) VALUES ($1,$2,$3,$4,$5)`, [id, user, name, "/" + name, org]);
  await proj(PA, "u-a", personalA, "alpha");
  await proj(PB, "u-a", teamA, "bravo");
  await proj(PC, "u-b", teamB, "charlie");
  const session = (id: string, project: string | null) => db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,'u-a','claude','t','/w','sleeping',80,24,$2)`, [id, project]);
  await session(SA, PA); await session(SB, PB); await session(SS, null);

  const manager = Object.create(SessionManager.prototype) as any;
  Object.assign(manager, { pool, live: new Map(), shards: { awakeHandle: () => null } });
  const auth = { handler() {}, api: { getSession: async ({ headers }: any) => { const u = TOKENS[String(headers.get("authorization") ?? "").replace("Bearer ", "")]; return u ? { user: { id: u }, session: { id: "s" } } : null; } } };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", encryptionKey: Buffer.alloc(32, 7) };
  const server = createRuntimeServer({
    config, manager, auth, settings: { async profile() { return {}; } }, github: {}, vault: {}, orchestrator: {}, pool,
    notes: new CanvasNotes(pool as never), keychains: new Keychains(pool as never, config as never),
    credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {},
  } as never);
  await server.listen();
  t.after(async () => { await server.close(); await db.close(); });
  const call = async (token: string, method: string, path: string, body?: unknown, org?: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(org ? { "X-Floq-Organization": org } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : {} };
  };
  return { db, call, personalA, teamA, teamB };
}

const ids = (list: Array<{ id: string }>) => list.map((x) => x.id).sort();

test("projects and sessions are partitioned by the X-Floq-Organization header; no header means personal", async (t) => {
  const { call, personalA, teamA } = await harness(t);
  const none = await call("ta", "GET", "/v1/projects");
  assert.equal(none.status, 200);
  assert.deepEqual(ids(none.json.projects), [PA], "no header = personal");
  assert.equal(none.json.projects[0].organizationId, personalA);
  const team = await call("ta", "GET", "/v1/projects", undefined, teamA);
  assert.deepEqual(ids(team.json.projects), [PB]);
  assert.equal(team.json.projects[0].organizationId, teamA);

  const personalSessions = (await call("ta", "GET", "/v1/sessions", undefined, personalA)).json.sessions;
  assert.deepEqual(ids(personalSessions), [SA, SS].sort(), "scratch sessions belong to the personal org");
  assert.ok(personalSessions.every((s: any) => s.organizationId === personalA));
  const teamSessions = (await call("ta", "GET", "/v1/sessions", undefined, teamA)).json.sessions;
  assert.deepEqual(ids(teamSessions), [SB]);
  assert.equal(teamSessions[0].organizationId, teamA);
  assert.deepEqual(ids((await call("ta", "GET", "/v1/sessions")).json.sessions), [SA, SS].sort());
});

test("a header for an organization the user is not in is 404 organization_not_found; organization routes still work", async (t) => {
  const { call, teamB, teamA } = await harness(t);
  for (const path of ["/v1/projects", "/v1/sessions", "/v1/project-folders"]) {
    const r = await call("ta", "GET", path, undefined, teamB);
    assert.equal(r.status, 404, path);
    assert.equal(r.json.error.code, "organization_not_found");
  }
  assert.equal((await call("ta", "GET", "/v1/projects", undefined, "not-a-uuid")).status, 404);
  // a stale header must not lock the client out of refreshing organizations
  const list = await call("ta", "GET", "/v1/organizations", undefined, teamB);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.organizations.map((o: any) => [o.personal, o.id === teamA]), [[true, false], [false, true]]);
  // another user cannot reach project ids at all
  assert.equal((await call("tb", "GET", `/v1/projects/${PA}/notes`)).status, 404);
});

test("a projectId from another organization is 404 on notes, keychains, workspaces and skills; the right org works", async (t) => {
  const { call, personalA, teamA } = await harness(t);
  const routes: Array<[string, string]> = [["GET", `/v1/projects/${PB}/notes`], ["GET", `/v1/projects/${PB}/keychains`], ["PATCH", `/v1/projects/${PB}/workspaces`], ["GET", `/v1/projects/${PB}/delete-status`], ["GET", `/v1/projects/${PB}/skills`], ["DELETE", `/v1/projects/${PB}`], ["GET", `/v1/mcp?scope=project&projectId=${PB}`]];
  for (const [method, path] of routes) {
    const wrong = await call("ta", method, path, method === "PATCH" ? { navExpanded: true } : undefined, personalA);
    assert.equal(wrong.status, 404, `${method} ${path} with the wrong org`);
    assert.equal(wrong.json.error.code, "not_found");
    const none = await call("ta", method, path, method === "PATCH" ? { navExpanded: true } : undefined);
    assert.equal(none.status, 404, `${method} ${path} with no header (personal)`);
  }
  assert.equal((await call("ta", "GET", `/v1/projects/${PB}/notes`, undefined, teamA)).status, 200);
  assert.equal((await call("ta", "GET", `/v1/projects/${PB}/keychains`, undefined, teamA)).status, 200);
  assert.equal((await call("ta", "PATCH", `/v1/projects/${PB}/workspaces`, { navExpanded: true }, teamA)).status, 200);
  // the project still exists afterwards (the wrong-org DELETE did nothing)
  assert.deepEqual(ids((await call("ta", "GET", "/v1/projects", undefined, teamA)).json.projects), [PB]);
  // the scratch canvas is not tied to a project
  assert.equal((await call("ta", "GET", `/v1/projects/none/notes`, undefined, teamA)).status, 200);
});

test("PATCH /v1/projects/:id { organizationId } moves a project between the user's organizations", async (t) => {
  const { call, personalA, teamA, teamB } = await harness(t);
  // from the personal org's perspective, pull a team project in ("Move here" after a 409)
  const moved = await call("ta", "PATCH", `/v1/projects/${PB}`, { organizationId: personalA }, personalA);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.project.organizationId, personalA);
  assert.deepEqual(ids((await call("ta", "GET", "/v1/projects", undefined, personalA)).json.projects), [PA, PB].sort());
  assert.deepEqual((await call("ta", "GET", "/v1/projects", undefined, teamA)).json.projects, []);
  // sessions follow their project
  assert.ok((await call("ta", "GET", "/v1/sessions", undefined, personalA)).json.sessions.some((s: any) => s.id === SB));
  // not a member of the target: 404, nothing changes
  const denied = await call("ta", "PATCH", `/v1/projects/${PA}`, { organizationId: teamB }, personalA);
  assert.equal(denied.status, 404);
  assert.equal(denied.json.error.code, "organization_not_found");
  assert.equal((await call("ta", "GET", "/v1/projects", undefined, personalA)).json.projects.length, 2);
  // someone else's project cannot be moved
  assert.equal((await call("tb", "PATCH", `/v1/projects/${PA}`, { organizationId: teamB }, teamB)).status, 404);
  // plain edits still go through the org guard
  assert.equal((await call("ta", "PATCH", `/v1/projects/${PA}`, { displayName: "Alpha" }, teamA)).status, 404);
  assert.equal((await call("ta", "PATCH", `/v1/projects/${PA}`, { displayName: "Alpha" }, personalA)).status, 200);
});

test("project folder layouts are stored per organization", async (t) => {
  const { call, personalA, teamA } = await harness(t);
  const doc = (name: string) => ({ folders: [{ id: "f1", name }], root: [{ kind: "folder", id: "f1" }], membership: { f1: [] }, expanded: {} });
  assert.equal((await call("ta", "PUT", "/v1/project-folders", { version: 0, doc: doc("Personal stuff") })).status, 200);
  assert.equal((await call("ta", "PUT", "/v1/project-folders", { version: 0, doc: doc("Team stuff") }, teamA)).status, 200);
  assert.equal((await call("ta", "GET", "/v1/project-folders", undefined, personalA)).json.doc.folders[0].name, "Personal stuff");
  assert.equal((await call("ta", "GET", "/v1/project-folders", undefined, teamA)).json.doc.folders[0].name, "Team stuff");
  assert.equal((await call("ta", "GET", "/v1/project-folders")).json.doc.folders[0].name, "Personal stuff", "no header = personal");
});
