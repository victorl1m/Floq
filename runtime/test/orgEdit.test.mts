import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MAX_ORG_IMAGE_BYTES, OrganizationsService, routeOrganizations, type OrganizationLimits } from "../dist/organizations.js";

const A = "u-owner", B = "u-admin", C = "u-member", D = "u-outsider";
const EMAILS: Record<string, string> = { [A]: "owner@example.com", [B]: "admin@example.com", [C]: "member@example.com", [D]: "out@example.com" };

async function setup(limits: Partial<OrganizationLimits> = {}, options: { verified?: boolean; inboxRequiresVerifiedEmail?: boolean } = {}) {
  const db = new PGlite();
  let tail: Promise<void> = Promise.resolve();
  const run = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  const pool = {
    query: run,
    // PGlite is one connection: serialise whole transactions so concurrent callers cannot interleave BEGIN/COMMIT.
    async connect() {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      return { query: run, release };
    },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" BOOLEAN DEFAULT false)`);
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) {
    await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  }
  for (const [id, email] of Object.entries(EMAILS)) {
    await db.query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)`, [id, id.replace("u-", ""), email, options.verified ?? true]);
  }
  const service = new OrganizationsService(pool as never, { limits, inboxRequiresVerifiedEmail: options.inboxRequiresVerifiedEmail });
  return { db, service, pool };
}

async function fixture(limits?: Partial<OrganizationLimits>) {
  const ctx = await setup(limits);
  const org = await ctx.service.create(A, { name: "Acme Inc" });
  const join = async (userId: string, role: "admin" | "member") => {
    const invite = await ctx.service.invite(A, org.id, { email: EMAILS[userId], role });
    await ctx.service.acceptByToken(userId, invite.token);
  };
  return { ...ctx, org, join };
}


const rejects = (promise: Promise<unknown>, status: number, code?: string) =>
  assert.rejects(promise, (error: { status?: number; code?: string }) => error.status === status && (!code || error.code === code));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([32, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(32, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test("update: name, slug, permissions, validation, reserved, taken", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await join(B, "admin");
  await join(C, "member");

  await service.update(A, org.id, { name: "  Acme   Corp " });
  await service.update(B, org.id, { slug: "Acme-Labs" });
  const listed = (await service.list(A)).find((o) => o.id === org.id)!;
  assert.equal(listed.name, "Acme Corp");
  assert.equal(listed.slug, "acme-labs", "slug is lowercased");
  await rejects(service.update(C, org.id, { name: "Nope" }), 403);
  await rejects(service.update(D, org.id, { name: "Nope" }), 404);

  await rejects(service.update(A, org.id, {}), 400, "nothing_to_change");
  await rejects(service.update(A, org.id, { name: "   " }), 400);
  await rejects(service.update(A, org.id, { name: "x".repeat(65) }), 400);
  await service.update(A, org.id, { name: "x".repeat(64) });
  await rejects(service.update(A, org.id, { name: 5 }), 400);
  for (const bad of ["ab", "a".repeat(41), "-abc", "abc-", "a b c", "ab--cd", "ünï", "a/b"]) {
    await rejects(service.update(A, org.id, { slug: bad }), 400, "invalid_slug");
  }
  for (const reserved of ["admin", "api", "settings", "new", "personal-me"]) {
    await rejects(service.update(A, org.id, { slug: reserved }), 400, "reserved_slug");
  }
  const other = await service.create(B, { name: "Other", slug: "other-team" });
  await rejects(service.update(A, org.id, { slug: "other-team" }), 409, "slug_taken");
  await service.update(A, org.id, { slug: "acme-labs" }); // own slug again is fine
  assert.equal((await service.list(B)).find((o) => o.id === other.id)!.slug, "other-team");

  const events = await db.query<{ event: string }>("SELECT event FROM collaboration.organization_audit_events WHERE event = 'org.updated'");
  assert.ok(events.rows.length >= 3);
});

test("update: personal organization takes name and image but never a slug", async (t) => {
  const { db, service } = await setup();
  t.after(() => db.close());
  const id = await service.ensurePersonal(A);
  await service.update(A, id, { name: "My space" });
  const personal = (await service.list(A)).find((o) => o.id === id)!;
  assert.equal(personal.name, "My space");
  assert.equal(personal.slug, "");
  await rejects(service.update(A, id, { slug: "my-space" }), 400, "personal_has_no_slug");
  await rejects(service.update(A, id, { name: "Ok", slug: "my-space" }), 400, "personal_has_no_slug");
  assert.equal((await service.list(A)).find((o) => o.id === id)!.name, "My space", "a rejected patch changes nothing");
  await service.setImage(A, id, "image/png", PNG);
  assert.match((await service.list(A)).find((o) => o.id === id)!.imageUrl ?? "", new RegExp(`^/v1/organizations/${id}/image\\?v=\\d+$`));
  await rejects(service.update(B, id, { name: "Mine" }), 404);
});

test("slug-available: invalid, reserved, taken, own slug via excludeId, rate limit", async (t) => {
  const { db, service, org } = await fixture();
  t.after(() => db.close());
  assert.deepEqual(await service.slugAvailable("  Fresh-Name ", undefined, A), { slug: "fresh-name", normalized: "fresh-name", available: true });
  assert.equal((await service.slugAvailable("a", undefined, A)).reason, "invalid");
  assert.equal((await service.slugAvailable("bad slug", undefined, A)).reason, "invalid");
  assert.equal((await service.slugAvailable("", undefined, A)).reason, "invalid");
  assert.equal((await service.slugAvailable("admin", undefined, A)).reason, "reserved");
  assert.equal((await service.slugAvailable("personal-x1", undefined, A)).reason, "reserved");
  assert.equal((await service.slugAvailable(org.slug, undefined, A)).reason, "taken");
  assert.equal((await service.slugAvailable(org.slug, org.id, A)).available, true, "own slug is available to its organization");
  assert.equal((await service.slugAvailable(org.slug, "not-a-uuid", A)).reason, "taken");
  // Over HTTP routing: same data, query-string based.
  const res = await routeOrganizations({ service, userId: A, method: "GET", pathname: "/v1/organizations/slug-available", query: new URLSearchParams({ slug: "acme-inc", excludeId: org.id }), readJson: async () => ({}) as never });
  assert.deepEqual(res?.body, { slug: "acme-inc", normalized: "acme-inc", available: true });
  for (let i = 0; i < 60; i += 1) await service.slugAvailable("x" + i + "abc", undefined, B);
  await rejects(service.slugAvailable("another", undefined, B), 429, "rate_limited");
  assert.equal((await service.slugAvailable("another", undefined, A)).available, true, "limit is per user");
});

test("image: set, serve metadata, replace, remove, permissions, type/size/magic checks", async (t) => {
  const { db, service, org, join } = await fixture();
  t.after(() => db.close());
  await join(B, "admin");
  await join(C, "member");
  assert.equal((await service.list(A)).find((o) => o.id === org.id)!.imageUrl, null);
  await rejects(service.image(A, org.id), 404);

  await service.setImage(B, org.id, "image/png", PNG);
  const first = await service.image(C, org.id); // members may read
  assert.equal(first.contentType, "image/png");
  assert.ok(first.bytes.equals(PNG));
  await service.setImage(A, org.id, "image/webp; charset=binary", WEBP);
  const second = await service.image(A, org.id);
  assert.equal(second.contentType, "image/webp");
  assert.notEqual(second.etag, first.etag);
  await service.setImage(A, org.id, "IMAGE/JPEG", JPEG);
  assert.equal((await service.image(A, org.id)).contentType, "image/jpeg");

  await rejects(service.setImage(C, org.id, "image/png", PNG), 403);
  await rejects(service.removeImage(C, org.id), 403);
  await rejects(service.setImage(D, org.id, "image/png", PNG), 404);
  await rejects(service.image(D, org.id), 404);

  await rejects(service.setImage(A, org.id, "image/svg+xml", SVG), 415, "unsupported_image_type");
  await rejects(service.setImage(A, org.id, "image/gif", Buffer.from("GIF89a")), 415);
  await rejects(service.setImage(A, org.id, undefined, PNG), 415);
  await rejects(service.setImage(A, org.id, "image/png", SVG), 400, "invalid_image");
  await rejects(service.setImage(A, org.id, "image/png", JPEG), 400, "invalid_image");
  await rejects(service.setImage(A, org.id, "image/jpeg", PNG), 400, "invalid_image");
  await rejects(service.setImage(A, org.id, "image/png", Buffer.alloc(0)), 400, "invalid_image");
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_ORG_IMAGE_BYTES)]);
  await rejects(service.setImage(A, org.id, "image/png", big), 413, "image_too_large");
  assert.equal((await service.image(A, org.id)).contentType, "image/jpeg", "rejected uploads leave the image alone");

  await service.removeImage(A, org.id);
  await rejects(service.image(A, org.id), 404);
  await service.removeImage(A, org.id); // idempotent
  assert.equal((await service.list(A)).find((o) => o.id === org.id)!.imageUrl, null);
});

test("image routes: GET headers, ETag 304, raw PUT, DELETE, deleting the organization drops the image", async (t) => {
  const { db, service, org } = await fixture();
  t.after(() => db.close());
  const call = (userId: string, method: string, headers: { contentType?: string; ifNoneMatch?: string } = {}, raw?: Buffer) =>
    routeOrganizations({ service, userId, method, pathname: `/v1/organizations/${org.id}/image`, headers, readJson: async () => ({}) as never, readRaw: raw ? async (limit) => {
      if (raw.length > limit) { const e = new Error("big") as Error & { status: number }; e.status = 413; throw e; }
      return raw;
    } : undefined });

  assert.equal((await call(A, "PUT", { contentType: "image/png" }, PNG))?.status, 200);
  const got = await call(A, "GET");
  assert.equal(got?.status, 200);
  assert.equal(got?.raw?.contentType, "image/png");
  assert.equal(got?.raw?.headers["X-Content-Type-Options"], "nosniff");
  assert.match(got?.raw?.headers["Cache-Control"] ?? "", /private/);
  assert.ok(got?.raw?.data.equals(PNG));
  const etag = got!.raw!.headers.ETag;
  assert.match(etag, /^"[0-9a-z]+-[0-9a-z]+"$/);
  const cached = await call(A, "GET", { ifNoneMatch: etag });
  assert.equal(cached?.status, 304);
  assert.equal(cached?.raw?.data.length, 0);
  assert.equal((await call(A, "GET", { ifNoneMatch: '"other"' }))?.status, 200);
  await assert.rejects(call(D, "GET"), (e: { status?: number }) => e.status === 404);
  await assert.rejects(call(A, "PUT", { contentType: "image/png" }, Buffer.alloc(MAX_ORG_IMAGE_BYTES + 1)), (e: { status?: number }) => e.status === 413);
  assert.equal((await call(A, "DELETE"))?.status, 200);
  await assert.rejects(call(A, "GET"), (e: { status?: number }) => e.status === 404);

  await call(A, "PUT", { contentType: "image/png" }, PNG);
  await service.remove(A, org.id, "Acme Inc");
  const left = await db.query("SELECT 1 FROM collaboration.organization_images");
  assert.equal(left.rows.length, 0, "image is deleted with the organization (ON DELETE CASCADE)");
});
