-- Instance-level roles. A user with no row is a regular member.
-- The first administrator is bootstrapped by the runtime (see src/admin.ts); after that roles are managed here.
CREATE TABLE "collaboration"."user_roles" (
  "user_id" TEXT NOT NULL,
  "role" VARCHAR(16) NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" TEXT,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_roles_role_check" CHECK ("role" IN ('admin', 'member'))
);
CREATE INDEX "user_roles_role_idx" ON "collaboration"."user_roles"("role");
