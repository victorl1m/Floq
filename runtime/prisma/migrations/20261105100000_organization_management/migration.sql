-- Organization management: slugs, admin role, invitation roles and an audit trail. Additive and idempotent.
ALTER TABLE "collaboration"."organizations" ADD COLUMN IF NOT EXISTS "slug" VARCHAR(48);
UPDATE "collaboration"."organizations"
SET "slug" = left(
  coalesce(nullif(trim(both '-' from lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'org'), 41
) || '-' || substr(replace("id"::text, '-', ''), 1, 6)
WHERE "slug" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key" ON "collaboration"."organizations"("slug");

ALTER TABLE "collaboration"."organization_members" DROP CONSTRAINT IF EXISTS "organization_members_role_check";
ALTER TABLE "collaboration"."organization_members" ADD CONSTRAINT "organization_members_role_check" CHECK ("role" IN ('owner', 'admin', 'member'));

ALTER TABLE "collaboration"."organization_invitations" ADD COLUMN IF NOT EXISTS "role" VARCHAR(16) NOT NULL DEFAULT 'member';
ALTER TABLE "collaboration"."organization_invitations" DROP CONSTRAINT IF EXISTS "organization_invitations_role_check";
ALTER TABLE "collaboration"."organization_invitations" ADD CONSTRAINT "organization_invitations_role_check" CHECK ("role" IN ('admin', 'member'));
CREATE INDEX IF NOT EXISTS "organization_invitations_email_idx" ON "collaboration"."organization_invitations"(lower("email"));

-- Intentionally no foreign key: the trail outlives a deleted organization.
CREATE TABLE IF NOT EXISTS "collaboration"."organization_audit_events" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "actor_id" TEXT NOT NULL,
  "event" VARCHAR(40) NOT NULL,
  "target" TEXT,
  "meta" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "organization_audit_events_org_idx" ON "collaboration"."organization_audit_events"("organization_id", "event", "created_at" DESC);
