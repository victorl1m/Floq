import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { bootstrapTeamName, registerBootstrapAdmin } from "../dist/bootstrapRegistration.js";

interface UserRow { id: string; name: string; email: string }
interface AccountRow { id: string; userId: string; passwordHash: string }
interface TeamRow { id: string; name: string; ownerId: string }
interface MemberRow { teamId: string; userId: string; role: string }
interface Snapshot { users: UserRow[]; accounts: AccountRow[]; teams: TeamRow[]; members: MemberRow[] }

class BootstrapDb {
  users: UserRow[] = [];
  accounts: AccountRow[] = [];
  teams: TeamRow[] = [];
  members: MemberRow[] = [];
  failAt: "account" | "team" | "member" | null = null;
  private snapshot: Snapshot | null = null;
  readonly pool = {
    query: (sql: string, values: unknown[] = []) => this.query(sql, values),
    connect: async () => ({ query: (sql: string, values: unknown[] = []) => this.query(sql, values), release: () => undefined }),
  } as unknown as Pick<pg.Pool, "query" | "connect">;

  private async query(sql: string, values: unknown[]) {
    if (sql === "BEGIN") this.snapshot = structuredClone({ users: this.users, accounts: this.accounts, teams: this.teams, members: this.members });
    else if (sql === "COMMIT") this.snapshot = null;
    else if (sql === "ROLLBACK") {
      if (this.snapshot) Object.assign(this, this.snapshot);
      this.snapshot = null;
    } else if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rowCount: 1 };
    else if (sql.startsWith("SELECT") && sql.includes('public."user"')) {
      const exists = this.users.some((user) => user.email.toLowerCase() === String(values[0]));
      return { rowCount: exists ? 1 : 0 };
    } else if (sql.startsWith('INSERT INTO public."user"')) {
      this.users.push({ id: String(values[0]), name: String(values[1]), email: String(values[2]) });
    } else if (sql.startsWith("INSERT INTO public.account")) {
      if (this.failAt === "account") throw new Error("simulated account failure");
      this.accounts.push({ id: String(values[0]), userId: String(values[2]), passwordHash: String(values[3]) });
    } else if (sql.startsWith("INSERT INTO collaboration.teams")) {
      if (this.failAt === "team") throw new Error("simulated team failure");
      this.teams.push({ id: String(values[0]), name: String(values[1]), ownerId: String(values[2]) });
    } else if (sql.startsWith("INSERT INTO collaboration.team_members")) {
      if (this.failAt === "member") throw new Error("simulated membership failure");
      this.members.push({ teamId: String(values[0]), userId: String(values[1]), role: "owner" });
    }
    return { rowCount: 1 };
  }
}

const input = { email: "victor@example.test", password: "passphrase", name: "Victor Lima" };
const hash = async (password: string) => `hashed:${password}`;

test("bootstrap team name derives first display name or email local part", () => {
  assert.equal(bootstrapTeamName("Victor Lima", input.email), "Victor's Team");
  assert.equal(bootstrapTeamName(undefined, input.email), "victor's Team");
  assert.equal(bootstrapTeamName("", ""), "Admin's Team");
});

test("bootstrap creates a credential account and owner team atomically with derived name", async () => {
  const db = new BootstrapDb();
  assert.equal(await registerBootstrapAdmin(db.pool, input, hash), true);
  assert.equal(db.users.length, 1);
  assert.deepEqual(db.accounts.map((account) => account.passwordHash), ["hashed:passphrase"]);
  assert.equal(db.teams[0].name, "Victor's Team");
  assert.equal(db.members[0].role, "owner");
  assert.equal(db.members[0].userId, db.users[0].id);
});

test("explicit company name is used, while existing account skips hashing and setup", async () => {
  const db = new BootstrapDb();
  assert.equal(await registerBootstrapAdmin(db.pool, { ...input, companyName: "  Acme Studio  " }, hash), true);
  assert.equal(db.teams[0].name, "Acme Studio");
  let hashed = false;
  assert.equal(await registerBootstrapAdmin(db.pool, input, async () => { hashed = true; return "unused"; }), false);
  assert.equal(hashed, false);
});

test("membership creation failure rolls back account, team, and member together", async () => {
  const db = new BootstrapDb();
  db.failAt = "member";
  await assert.rejects(registerBootstrapAdmin(db.pool, input, hash), /simulated membership failure/);
  assert.deepEqual({ users: db.users, accounts: db.accounts, teams: db.teams, members: db.members }, { users: [], accounts: [], teams: [], members: [] });
});

test("company name length is checked before database writes", async () => {
  const db = new BootstrapDb();
  await assert.rejects(registerBootstrapAdmin(db.pool, { ...input, companyName: "x".repeat(81) }, hash), /80 characters/);
  assert.equal(db.users.length, 0);
});
