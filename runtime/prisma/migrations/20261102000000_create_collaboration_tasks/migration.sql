CREATE SCHEMA IF NOT EXISTS "collaboration";

CREATE TABLE "collaboration"."teams" (
  "id" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "teams_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "teams_name_check" CHECK (length("name") BETWEEN 1 AND 80)
);

CREATE TABLE "collaboration"."team_members" (
  "team_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" VARCHAR(16) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id", "user_id"),
  CONSTRAINT "team_members_role_check" CHECK ("role" IN ('owner', 'member')),
  CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "collaboration"."teams"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "team_members_user_idx" ON "collaboration"."team_members"("user_id", "team_id");

CREATE TABLE "collaboration"."team_invitations" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "invited_by" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_invitations_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "team_invitations_team_id_email_key" UNIQUE ("team_id", "email"),
  CONSTRAINT "team_invitations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "collaboration"."teams"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "collaboration"."task_boards" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_boards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_boards_title_check" CHECK (length("title") BETWEEN 1 AND 120),
  CONSTRAINT "task_boards_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "collaboration"."teams"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_boards_team_idx" ON "collaboration"."task_boards"("team_id", "created_at" DESC);

CREATE TABLE "collaboration"."task_lists" (
  "id" UUID NOT NULL,
  "board_id" UUID NOT NULL,
  "title" VARCHAR(80) NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_lists_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_lists_title_check" CHECK (length("title") BETWEEN 1 AND 80),
  CONSTRAINT "task_lists_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "collaboration"."task_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_lists_board_idx" ON "collaboration"."task_lists"("board_id", "position");

CREATE TABLE "collaboration"."task_cards" (
  "id" UUID NOT NULL,
  "list_id" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "position" INTEGER NOT NULL DEFAULT 0,
  "assignee_id" TEXT,
  "due_at" TIMESTAMPTZ,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_cards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_cards_title_check" CHECK (length("title") BETWEEN 1 AND 200),
  CONSTRAINT "task_cards_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "collaboration"."task_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_cards_list_idx" ON "collaboration"."task_cards"("list_id", "position", "created_at");
