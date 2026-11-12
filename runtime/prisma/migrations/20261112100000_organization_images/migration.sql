-- Organization images: one small (<= 512 KB, PNG/JPEG/WebP) picture per organization, stored in the database so it
-- follows the account to every runtime instance. Additive and idempotent. Removed with the organization.
CREATE TABLE IF NOT EXISTS "collaboration"."organization_images" (
  "organization_id" UUID NOT NULL PRIMARY KEY REFERENCES "collaboration"."organizations"("id") ON DELETE CASCADE,
  "content_type" VARCHAR(32) NOT NULL,
  "bytes" BYTEA NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
