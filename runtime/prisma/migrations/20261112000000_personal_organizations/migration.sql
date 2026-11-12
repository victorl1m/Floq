-- Personal organizations: every user owns exactly one, created lazily by the runtime. Additive and idempotent.
-- Intentionally no foreign key to "user": Prisma deploy runs before better-auth creates its tables.
ALTER TABLE "collaboration"."organizations" ADD COLUMN IF NOT EXISTS "personal_owner_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_personal_owner_id_key" ON "collaboration"."organizations"("personal_owner_id");
