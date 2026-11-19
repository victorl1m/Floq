import assert from "node:assert/strict";
import test from "node:test";
import { assertRoleChangeAllowed, getRole, requireAdmin, requireRoleValue, setUserRole } from "../dist/admin.js";
import { compareVersions, isNewer, isUpdateTarget, parseCommand, parseVersion, UpdateService } from "../dist/updates.js";

/** Minimal in-memory stand-in for the role queries. */
function fakeDb(roles: Record<string, string>, users: string[]) {
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("WHERE role = 'admin' LIMIT 1")) return { rowCount: Object.values(roles).includes("admin") ? 1 : 0, rows: [] };
    if (sql.includes("SELECT role FROM collaboration.user_roles WHERE user_id")) {
      const role = roles[values[0] as string];
      return { rowCount: role ? 1 : 0, rows: role ? [{ role }] : [] };
    }
    if (sql.includes('FROM public."user" WHERE id')) return { rowCount: users.includes(values[0] as string) ? 1 : 0, rows: [] };
    if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: Object.values(roles).filter((r) => r === "admin").length }] };
    if (sql.startsWith("INSERT INTO collaboration.user_roles (user_id, role, updated_by)")) { roles[values[0] as string] = values[1] as string; return { rowCount: 1, rows: [] }; }
    return { rowCount: 0, rows: [] };
  };
  const client = { query, release: () => undefined };
  return { query, connect: async () => client } as never;
}

test("only administrators pass the admin gate", async () => {
  const db = fakeDb({ a: "admin", m: "member" }, ["a", "m", "x"]);
  await requireAdmin(db, null, "a");
  await assert.rejects(requireAdmin(db, null, "m"), { status: 403 });
  await assert.rejects(requireAdmin(db, null, "x"), { status: 403 });
});

test("role values are validated against the allowlist", () => {
  assert.equal(requireRoleValue("admin"), "admin");
  assert.throws(() => requireRoleValue("owner"), { code: "invalid_role" });
  assert.throws(() => requireRoleValue(undefined), { code: "invalid_role" });
});

test("the last administrator cannot be demoted", async () => {
  assert.throws(() => assertRoleChangeAllowed("admin", "member", 1), { code: "last_admin" });
  assertRoleChangeAllowed("admin", "member", 2);
  assertRoleChangeAllowed("member", "admin", 1);
  const roles = { a: "admin", b: "admin" } as Record<string, string>;
  const db = fakeDb(roles, ["a", "b", "c"]);
  await setUserRole(db, "a", "b", "member");
  await assert.rejects(setUserRole(db, "b", "a", "member"), { code: "last_admin" });
  assert.equal(roles.a, "admin");
  await setUserRole(db, "a", "c", "admin");
  assert.equal(roles.c, "admin");
  await assert.rejects(setUserRole(db, "a", "ghost", "admin"), { status: 404 });
});

test("version parsing and comparison", () => {
  assert.equal(parseVersion("2.1.5 (Claude Code)"), "2.1.5");
  assert.equal(parseVersion("codex-cli 0.46.0-alpha.1"), "0.46.0-alpha.1");
  assert.equal(parseVersion("nothing"), null);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.2.3-beta", "1.2.3") < 0);
  assert.ok(Number.isNaN(compareVersions("x", "1.0.0")));
  assert.equal(isNewer("0.2.0", "0.3.0"), true);
  assert.equal(isNewer("0.3.0", "0.2.0"), false);
  assert.equal(isNewer(null, "1.0.0"), false);
});

test("update target allowlist and operator command parsing", () => {
  for (const t of ["runtime", "claude", "codex"]) assert.ok(isUpdateTarget(t));
  for (const t of ["bash", "claude; rm -rf /", "", undefined, 1]) assert.ok(!isUpdateTarget(t));
  assert.deepEqual(parseCommand('["/bin/up","--x"]'), ["/bin/up", "--x"]);
  assert.equal(parseCommand("rm -rf /"), null);
  assert.equal(parseCommand("[1]"), null);
});

const cfg = { version: "0.2.0", providers: { claude: "claude", codex: "codex" }, repo: "o/r", runtimeDir: "/nonexistent/app", runtimeCommand: null };

test("apply rejects bad targets, requires force with live sessions, and uses fixed argv", async () => {
  const svc = new UpdateService(cfg, () => 2, () => undefined);
  await assert.rejects(svc.apply("u", { target: "evil" }), { code: "invalid_target" });
  await assert.rejects(svc.apply("u", { target: "runtime" }), { code: "sessions_active" });
  assert.deepEqual(svc.plan("claude"), [{ file: "npm", args: ["install", "-g", "@anthropic-ai/claude-code@latest"] }]);
  assert.deepEqual(svc.plan("codex")[0].args, ["install", "-g", "@openai/codex@latest"]);
  assert.throws(() => svc.plan("runtime"), { code: "update_unsupported" });
});

test("a configured bootstrap email never lets the earliest other user become admin (RA-04)", async () => {
  const inserted: unknown[][] = [];
  const queries: string[] = [];
  const db = {
    async query(sql: string, values: unknown[] = []) {
      queries.push(sql);
      if (sql.includes("WHERE role = 'admin' LIMIT 1")) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM public."user" WHERE lower(email)')) return { rowCount: 0, rows: [] }; // bootstrap account not registered yet
      if (sql.includes('FROM public."user"')) return { rowCount: 1, rows: [{ id: "attacker" }] };
      if (sql.startsWith("INSERT INTO collaboration.user_roles")) { inserted.push(values); return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    },
  } as never;
  assert.equal(await getRole(db, "owner@example.com", "attacker"), "member");
  assert.equal(inserted.length, 0);
  await getRole(db, null, "attacker"); // no bootstrap email configured: legacy earliest-user behaviour
  assert.equal(inserted.length, 1);
});

test("Dokploy redeploy: configured only when URL, key and compose id are all valid; the key never reaches argv", async () => {
  const { dokployFromEnv, DOKPLOY_DEPLOY_SCRIPT } = await import("../dist/updates.js");
  const ok = { FLOQ_DOKPLOY_URL: "http://dokploy:3000/", FLOQ_DOKPLOY_API_KEY: "k_secret_value", FLOQ_DOKPLOY_COMPOSE_ID: "abc_DEF-123" };
  assert.deepEqual(dokployFromEnv(ok), { url: "http://dokploy:3000", composeId: "abc_DEF-123" });
  assert.equal(dokployFromEnv({ ...ok, FLOQ_DOKPLOY_API_KEY: "" }), null);
  assert.equal(dokployFromEnv({ ...ok, FLOQ_DOKPLOY_URL: "ftp://x" }), null);
  assert.equal(dokployFromEnv({ ...ok, FLOQ_DOKPLOY_URL: "https://u:p@host" }), null);
  assert.equal(dokployFromEnv({ ...ok, FLOQ_DOKPLOY_COMPOSE_ID: "a b;rm" }), null);
  const service = new UpdateService({ version: "0.2.0", providers: { claude: "claude", codex: "codex" }, repo: "o/r", runtimeDir: "/nonexistent/app", runtimeCommand: null, dokploy: dokployFromEnv(ok) }, () => 0, () => undefined);
  const [step] = service.plan("runtime");
  assert.equal(step.file, process.execPath);
  assert.deepEqual(step.args, ["-e", DOKPLOY_DEPLOY_SCRIPT]);
  assert.ok(!step.args.join(" ").includes("k_secret_value"), "the API key is read from the environment, not argv");
  assert.match(DOKPLOY_DEPLOY_SCRIPT, /\/api\/compose\.deploy/);
});
