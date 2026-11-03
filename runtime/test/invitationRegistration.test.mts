import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { registerWithInvitation, type InvitationRegistration } from "../dist/invitationRegistration.js";

interface Invite { id: string; organization_id: string; email: string; token_hash: string; expires: boolean }
interface Account { id: string; email: string; passwordHash: string }
interface Member { organizationId: string; userId: string; role: string }

class TestDatabase {
  invites: Invite[] = [];
  users: Account[] = [];
  members: Member[] = [];
  failAccountInsert = false;
  private lockTail: Promise<void> = Promise.resolve();

  async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith("SELECT") && sql.includes("organization_invitations")) {
      const row = this.invites.find((invite) => invite.token_hash === values[0] && !invite.expires);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT") && sql.includes('public."user"')) {
      const row = this.users.find((user) => user.email.toLowerCase() === values[0]);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error("unexpected query");
  }

  async connect() {
    let releaseLock: (() => void) | undefined;
    let snapshot: { invites: Invite[]; users: Account[]; members: Member[] } | undefined;
    const acquire = async () => {
      const previous = this.lockTail;
      this.lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
      await previous;
      snapshot = { invites: structuredClone(this.invites), users: structuredClone(this.users), members: structuredClone(this.members) };
    };
    const unlock = () => { releaseLock?.(); releaseLock = undefined; };
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN") return { rows: [], rowCount: 0 };
        if (sql.includes("organization_invitations") && sql.includes("FOR UPDATE")) {
          await acquire();
          const invite = this.invites.find((entry) => entry.token_hash === values[0] && !entry.expires);
          return { rows: invite ? [invite] : [], rowCount: invite ? 1 : 0 };
        }
        if (sql.startsWith("SELECT") && sql.includes('public."user"')) {
          const user = this.users.find((entry) => entry.email.toLowerCase() === values[0]);
          return { rows: user ? [{ id: user.id }] : [], rowCount: user ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO public."user"')) {
          this.users.push({ id: String(values[0]), email: String(values[2]), passwordHash: "" });
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO public.account")) {
          if (this.failAccountInsert) throw new Error("simulated account insert failure");
          const user = this.users.find((entry) => entry.id === values[2]);
          assert.ok(user);
          user.passwordHash = String(values[3]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO collaboration.organization_members")) {
          this.members.push({ organizationId: String(values[0]), userId: String(values[1]), role: "member" });
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("DELETE FROM collaboration.organization_invitations")) {
          const index = this.invites.findIndex((entry) => entry.id === values[0] && entry.token_hash === values[1] && !entry.expires);
          if (index < 0) return { rows: [], rowCount: 0 };
          const [deleted] = this.invites.splice(index, 1);
          return { rows: [{ id: deleted.id }], rowCount: 1 };
        }
        if (sql === "COMMIT") { snapshot = undefined; unlock(); return { rows: [], rowCount: 0 }; }
        if (sql === "ROLLBACK") {
          if (snapshot) {
            this.invites = snapshot.invites;
            this.users = snapshot.users;
            this.members = snapshot.members;
          }
          snapshot = undefined;
          unlock();
          return { rows: [], rowCount: 0 };
        }
        throw new Error("unexpected transaction query");
      },
      release: unlock,
    };
  }
}

function setup(email = "new@example.invalid", token = "valid-token") {
  const db = new TestDatabase();
  db.invites.push({ id: "invite-1", organization_id: "organization-1", email, token_hash: createHash("sha256").update(token).digest("hex"), expires: false });
  const input: InvitationRegistration = { token, email, name: "New Member", password: "a-long-password" };
  const hashPassword = async (password: string) => `hashed:${password}`;
  const register = (override: Partial<InvitationRegistration> = {}) => registerWithInvitation(db as unknown as Pool, { ...input, ...override }, hashPassword);
  return { db, input, register };
}

test("registration creates one credential user and consumes the matching invite", async () => {
  const { db, register } = setup("New@Example.invalid");
  const result = await register({ email: "new@example.invalid" });
  assert.equal(result.organizationId, "organization-1");
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].passwordHash, "hashed:a-long-password");
  assert.equal(db.members.length, 1);
  assert.deepEqual(db.members[0], { organizationId: "organization-1", userId: result.userId, role: "member" });
  assert.equal(db.invites.length, 0);
  await assert.rejects(register(), /invalid or has expired/);
});

test("wrong email and expired invitations are rejected before password hashing", async () => {
  const wrong = setup();
  let hashed = false;
  await assert.rejects(registerWithInvitation(wrong.db as unknown as Pool, { ...wrong.input, email: "wrong@example.invalid" }, async () => { hashed = true; return "hash"; }), /details do not match/);
  assert.equal(hashed, false);

  const expired = setup();
  expired.db.invites[0].expires = true;
  await assert.rejects(expired.register(), /invalid or has expired/);
  assert.equal(expired.db.users.length, 0);
});

test("existing accounts are directed to sign in without consuming the invite", async () => {
  const { db, input, register } = setup();
  db.users.push({ id: "existing-user", email: input.email, passwordHash: "existing-hash" });
  await assert.rejects(register(), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "invitation_account_exists");
  assert.equal(db.invites.length, 1);
  assert.equal(db.members.length, 0);
});

test("credential insertion failure rolls back the user and leaves the invite available", async () => {
  const { db, register } = setup();
  db.failAccountInsert = true;
  await assert.rejects(register(), /simulated account insert failure/);
  assert.equal(db.users.length, 0);
  assert.equal(db.members.length, 0);
  assert.equal(db.invites.length, 1);
});

test("password hashing failure does not change account or invite state", async () => {
  const { db, input } = setup();
  await assert.rejects(registerWithInvitation(db as unknown as Pool, input, async () => { throw new Error("hash failed"); }), /hash failed/);
  assert.equal(db.users.length, 0);
  assert.equal(db.invites.length, 1);
});

test("only one concurrent registration can consume an invitation", async () => {
  const { db, register } = setup();
  const outcomes = await Promise.allSettled([register(), register()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(db.users.length, 1);
  assert.equal(db.members.length, 1);
  assert.equal(db.invites.length, 0);
});

test("concurrent invitations for the same address create only one account", async () => {
  const { db, input, register } = setup();
  db.invites.push({ id: "invite-2", organization_id: "organization-2", email: input.email, token_hash: createHash("sha256").update("second-token").digest("hex"), expires: false });
  const outcomes = await Promise.allSettled([register(), register({ token: "second-token" })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(db.users.length, 1);
  assert.equal(db.members.length, 1);
  assert.equal(db.invites.length, 1);
});
