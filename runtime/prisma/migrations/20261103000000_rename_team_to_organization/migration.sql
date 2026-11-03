-- Rename the team concept to organization.
ALTER TABLE "collaboration"."teams" RENAME TO "organizations";
ALTER TABLE "collaboration"."team_members" RENAME TO "organization_members";
ALTER TABLE "collaboration"."team_invitations" RENAME TO "organization_invitations";

ALTER TABLE "collaboration"."organization_members" RENAME COLUMN "team_id" TO "organization_id";
ALTER TABLE "collaboration"."organization_invitations" RENAME COLUMN "team_id" TO "organization_id";
ALTER TABLE "collaboration"."task_boards" RENAME COLUMN "team_id" TO "organization_id";

ALTER TABLE "collaboration"."organizations" RENAME CONSTRAINT "teams_pkey" TO "organizations_pkey";
ALTER TABLE "collaboration"."organizations" RENAME CONSTRAINT "teams_name_check" TO "organizations_name_check";

ALTER TABLE "collaboration"."organization_members" RENAME CONSTRAINT "team_members_pkey" TO "organization_members_pkey";
ALTER TABLE "collaboration"."organization_members" RENAME CONSTRAINT "team_members_role_check" TO "organization_members_role_check";
ALTER TABLE "collaboration"."organization_members" RENAME CONSTRAINT "team_members_team_id_fkey" TO "organization_members_organization_id_fkey";
ALTER INDEX "collaboration"."team_members_user_idx" RENAME TO "organization_members_user_idx";

ALTER TABLE "collaboration"."organization_invitations" RENAME CONSTRAINT "team_invitations_pkey" TO "organization_invitations_pkey";
ALTER TABLE "collaboration"."organization_invitations" RENAME CONSTRAINT "team_invitations_token_hash_key" TO "organization_invitations_token_hash_key";
ALTER TABLE "collaboration"."organization_invitations" RENAME CONSTRAINT "team_invitations_team_id_email_key" TO "organization_invitations_organization_id_email_key";
ALTER TABLE "collaboration"."organization_invitations" RENAME CONSTRAINT "team_invitations_team_id_fkey" TO "organization_invitations_organization_id_fkey";

ALTER TABLE "collaboration"."task_boards" RENAME CONSTRAINT "task_boards_team_id_fkey" TO "task_boards_organization_id_fkey";
ALTER INDEX "collaboration"."task_boards_team_idx" RENAME TO "task_boards_organization_idx";
