import pg from "pg";
import type { Config } from "./config.js";

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
}

/** App tables. Auth tables are created by better-auth's migrator. */
export async function migrateApp(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      claude_auto_approve BOOLEAN NOT NULL DEFAULT TRUE,
      codex_auto_approve BOOLEAN NOT NULL DEFAULT TRUE,
      git_name TEXT,
      git_email TEXT,
      anthropic_api_key_enc TEXT,
      openai_api_key_enc TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE SEQUENCE IF NOT EXISTS shard_uid_seq START 20000;
    CREATE TABLE IF NOT EXISTS shards (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      uid INTEGER NOT NULL UNIQUE DEFAULT nextval('shard_uid_seq'),
      data_key_enc TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'sleeping' CHECK (state IN ('awake','sleeping')),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_url TEXT,
      state TEXT NOT NULL CHECK (state IN ('running','sleeping','exited','failed')),
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      last_seq BIGINT NOT NULL DEFAULT 0,
      resume_count INTEGER NOT NULL DEFAULT 0,
      sleep_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      slept_at TIMESTAMPTZ
    );
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS provider_session_id TEXT;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS agent_sessions_user_idx ON agent_sessions (user_id, last_active_at DESC);
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS lead BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS model TEXT;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS project_cwd TEXT;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS project_id UUID;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS workspace_id UUID;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS branch TEXT;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS role TEXT;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS parent_session_id UUID;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS recruit_skills TEXT[];
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS resume_on_boot BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS interrupted_turn BOOLEAN NOT NULL DEFAULT FALSE;
    -- Pointer history: every provider conversation an agent has had; only deleted together with the agent.
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_reason TEXT,
      UNIQUE (session_id, provider, provider_session_id)
    );
    INSERT INTO agent_conversations (session_id, provider, provider_session_id, started_at)
      SELECT id, provider, id::text, created_at FROM agent_sessions WHERE provider = 'claude'
      ON CONFLICT DO NOTHING;
    INSERT INTO agent_conversations (session_id, provider, provider_session_id, started_at)
      SELECT id, provider, provider_session_id, created_at FROM agent_sessions WHERE provider <> 'claude' AND provider_session_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    -- Removing an agent archives its conversation (kept, restorable from the Conversations tab) instead of deleting it.
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    UPDATE agent_sessions AS child SET project_cwd = child.cwd
      WHERE child.project_cwd IS NULL AND EXISTS (
        SELECT 1 FROM agent_sessions AS repo
        WHERE repo.user_id = child.user_id AND repo.git_url IS NOT NULL AND repo.cwd = child.cwd
      );
    CREATE TABLE IF NOT EXISTS floq_projects (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      display_name TEXT,
      image_url TEXT,
      git_url TEXT,
      normalized_git_url TEXT,
      cwd TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, cwd)
    );
    -- Catalog icon chosen as the project mark; takes precedence over image_url when icon_name is set.
    ALTER TABLE floq_projects ADD COLUMN IF NOT EXISTS icon_name TEXT;
    ALTER TABLE floq_projects ADD COLUMN IF NOT EXISTS icon_color TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS floq_projects_user_git_url_idx
      ON floq_projects(user_id, normalized_git_url) WHERE normalized_git_url IS NOT NULL;
    CREATE TABLE IF NOT EXISTS floq_project_workspaces (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES floq_projects(id) ON DELETE CASCADE,
      cwd TEXT NOT NULL,
      name TEXT NOT NULL,
      branch TEXT,
      is_worktree BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, cwd)
    );
    ALTER TABLE floq_project_workspaces ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE floq_project_workspaces ADD COLUMN IF NOT EXISTS nav_expanded BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE INDEX IF NOT EXISTS floq_project_workspaces_project_idx ON floq_project_workspaces(project_id);
    CREATE OR REPLACE FUNCTION floq_normalize_git_url(repo_url TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE AS $fn$
      WITH parsed AS (
        SELECT
          CASE WHEN repo_url ~ '^git@' THEN substring(repo_url FROM '^git@([^:]+):')
               ELSE substring(repo_url FROM '^[A-Za-z]+://([^/]+)') END AS host,
          CASE WHEN repo_url ~ '^git@' THEN substring(repo_url FROM '^git@[^:]+:(.*)$')
               ELSE substring(repo_url FROM '^[A-Za-z]+://[^/]+/(.*)$') END AS repo_path
      )
      SELECT CASE WHEN lower(host)='github.com' THEN lower(host || '/' || regexp_replace(regexp_replace(repo_path, '/+$', ''), '\\.git$', '', 'i'))
                  ELSE lower(host) || '/' || regexp_replace(regexp_replace(repo_path, '/+$', ''), '\\.git$', '', 'i') END
      FROM parsed
    $fn$;
    INSERT INTO floq_projects(id,user_id,name,git_url,normalized_git_url,cwd,created_at)
      SELECT DISTINCT ON (s.user_id, floq_normalize_git_url(s.git_url))
        gen_random_uuid(), s.user_id,
        COALESCE(NULLIF(regexp_replace(regexp_replace(s.git_url, '^.*[:/]', ''), '\\.git$', ''), ''), 'Imported project'),
        s.git_url, floq_normalize_git_url(s.git_url),
        COALESCE(s.project_cwd,s.cwd), s.created_at
      FROM agent_sessions s WHERE s.git_url IS NOT NULL AND s.git_url <> ''
      ORDER BY s.user_id, floq_normalize_git_url(s.git_url), s.created_at
      ON CONFLICT (user_id,normalized_git_url) WHERE normalized_git_url IS NOT NULL DO NOTHING;
    INSERT INTO floq_project_workspaces(id,user_id,project_id,cwd,name,branch,is_worktree)
      SELECT DISTINCT ON (s.user_id,s.cwd) gen_random_uuid(), p.user_id, p.id, s.cwd,
        CASE WHEN s.cwd=p.cwd THEN 'Main' ELSE COALESCE(s.branch,'Workspace') END, s.branch,
        s.cwd LIKE '.floq/worktrees/%'
      FROM agent_sessions s JOIN floq_projects p ON p.user_id=s.user_id
        AND ((s.git_url IS NOT NULL AND p.normalized_git_url=floq_normalize_git_url(s.git_url)) OR s.project_cwd=p.cwd OR EXISTS (
          SELECT 1 FROM agent_sessions repo WHERE repo.user_id=s.user_id AND repo.git_url IS NOT NULL
            AND p.normalized_git_url=floq_normalize_git_url(repo.git_url) AND repo.cwd=s.project_cwd
        ))
      WHERE s.cwd IS NOT NULL
      ORDER BY s.user_id,s.cwd,p.created_at
      ON CONFLICT (user_id,cwd) DO NOTHING;
    UPDATE agent_sessions s SET project_id=p.id, workspace_id=w.id, project_cwd=p.cwd
      FROM floq_projects p JOIN floq_project_workspaces w ON w.project_id=p.id
      WHERE s.project_id IS NULL AND s.user_id=p.user_id AND w.user_id=s.user_id AND w.cwd=s.cwd
        AND ((s.git_url IS NOT NULL AND p.normalized_git_url=floq_normalize_git_url(s.git_url)) OR s.project_cwd=p.cwd OR EXISTS (
          SELECT 1 FROM agent_sessions repo WHERE repo.user_id=s.user_id AND repo.git_url IS NOT NULL
            AND p.normalized_git_url=floq_normalize_git_url(repo.git_url) AND repo.cwd=s.project_cwd
        ));
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS opencode_auto_approve BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS antigravity_auto_approve BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS git_coauthor BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS always_recruit_subagents BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS allow_cross_project_agents BOOLEAN NOT NULL DEFAULT TRUE;
    -- User-raised subagent limits; NULL = the built-in default (6 direct, 24 total).
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subagent_max_children INTEGER;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subagent_max_total INTEGER;
    -- Set when the user answered the one-time auto-approve confirmation before their first agent session.
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_approve_ack_at TIMESTAMPTZ;
    -- Claude usage-limit fallback: user chain (NULL = defaults) and per-agent override/state (docs/design/claude-swap-fallback.md).
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS usage_fallback JSONB;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS fallback_override JSONB;
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS fallback_state JSONB;
    -- uuid of the last usage-limit record acted on: survives a cleared fallback_state so the same record is never handled twice.
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS fallback_last_event TEXT;
    -- Extra Claude accounts. provider_credentials(claude) always holds the ACTIVE slot's credential (so refresh, syncBack
    -- and usage are unchanged); the credentials of the other slots are kept here, encrypted with a per-slot AAD.
    -- The active slot has a metadata row with data_enc NULL.
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS active_claude_slot TEXT NOT NULL DEFAULT 'primary';
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS active_claude_since TIMESTAMPTZ;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS claude_account_return JSONB;
    CREATE TABLE IF NOT EXISTS claude_accounts (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      label TEXT NOT NULL,
      account_uuid TEXT,
      plan TEXT,
      data_enc TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      expires_at TIMESTAMPTZ,
      fail_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, slot)
    );
    -- claude.ai connectors in Claude sessions (NULL = on, the default).
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS claude_ai_connectors BOOLEAN;
    -- Shared agent browser for this user's agents (NULL = on, the default; docs/design/agent-browser.md).
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_browser BOOLEAN;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_browser_egress TEXT;
    CREATE TABLE IF NOT EXISTS provider_credentials (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      token_enc TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, provider)
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_links' AND column_name = 'a_id') THEN
        DROP TABLE agent_links; -- legacy unused undirected schema
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS agent_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID,
      from_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      to_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('recruit','message','manual')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_message_at TIMESTAMPTZ,
      message_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (from_session_id, to_session_id)
    );
    CREATE TABLE IF NOT EXISTS agent_notes (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS agent_inbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      from_session_id UUID NOT NULL,
      from_title TEXT NOT NULL DEFAULT '',
      to_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      chars INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS agent_inbox_to_idx ON agent_inbox (to_session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      to_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('message','approval')),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      delivered_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      expired_at TIMESTAMPTZ
    );
    ALTER TABLE agent_outbox ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS agent_outbox_pending_idx ON agent_outbox (to_session_id, created_at) WHERE delivered_at IS NULL AND expired_at IS NULL;
    CREATE TABLE IF NOT EXISTS agent_progress (
      seq BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('progress','question')),
      status TEXT NOT NULL CHECK (status IN ('working','blocked','done')),
      percent INTEGER CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS agent_progress_session_idx ON agent_progress (session_id, seq);
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      requester_session_id UUID NOT NULL,
      target_session_id UUID NOT NULL,
      requester_project_id UUID,
      target_project_id UUID,
      action TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending','granted','denied','expired','cancelled','consumed')),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ,
      decided_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS agent_approvals_user_idx ON agent_approvals (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS setup_token (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS agent_decisions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      requester_session_id UUID NOT NULL, requester_project_id UUID,
      source TEXT NOT NULL CHECK (source IN ('cli','native')), provider TEXT,
      provider_request_id TEXT, questions JSONB NOT NULL, response JSONB,
      status TEXT NOT NULL CHECK (status IN ('pending','answered','cancelled','expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
      decided_at TIMESTAMPTZ, meta JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_decisions_provider_request_idx ON agent_decisions (requester_session_id, provider_request_id) WHERE provider_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS agent_decisions_user_idx ON agent_decisions (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      project_id UUID, session_id UUID, session_name TEXT,
      level TEXT NOT NULL CHECK (level IN ('info','success','warning','error')),
      category TEXT NOT NULL CHECK (category IN ('release','build','agent','cost','security','message','system','custom')),
      title TEXT NOT NULL, body TEXT, action JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS agent_notifications_user_idx ON agent_notifications (user_id, created_at DESC);
    ALTER TABLE agent_notifications ADD COLUMN IF NOT EXISTS extra JSONB;
    CREATE TABLE IF NOT EXISTS vault_secrets (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      expose TEXT NOT NULL DEFAULT 'tool' CHECK (expose IN ('tool','env')),
      value_enc TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS vault_audit (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      session_id TEXT,
      secret_name TEXT NOT NULL,
      action TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS github_credentials (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      login TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      scope TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS skill_removals (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('claude','codex')),
      name TEXT NOT NULL,
      removed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, provider, name)
    );
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS data_enc TEXT;
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'connected';
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS detail TEXT;
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS fail_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS plan TEXT;
    ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE github_credentials ADD COLUMN IF NOT EXISTS gh_id BIGINT;
    ALTER TABLE github_credentials ADD COLUMN IF NOT EXISTS gh_name TEXT;
    CREATE TABLE IF NOT EXISTS canvas_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      project_id UUID,
      text TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'yellow',
      x REAL NOT NULL,
      y REAL NOT NULL,
      w REAL NOT NULL DEFAULT 240,
      h REAL NOT NULL DEFAULT 160,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS canvas_notes_user_project_idx ON canvas_notes(user_id, project_id);
    -- UNUSED: the canvas keychain feature was removed. These tables are kept so existing installs lose no data (nothing reads or writes them
    -- except the legacy per-project cleanup in manager.deleteProject).
    CREATE TABLE IF NOT EXISTS keychains (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      project_id UUID,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'yellow',
      x REAL NOT NULL,
      y REAL NOT NULL,
      w REAL NOT NULL DEFAULT 240,
      h REAL NOT NULL DEFAULT 160,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS keychains_user_project_idx ON keychains(user_id, project_id);
    CREATE TABLE IF NOT EXISTS keychain_secrets (
      keychain_id UUID NOT NULL REFERENCES keychains(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value_enc BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (keychain_id, name)
    );
    ALTER TABLE keychain_secrets ADD COLUMN IF NOT EXISTS created_by UUID;
    ALTER TABLE keychain_secrets ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
    ALTER TABLE keychain_secrets ADD COLUMN IF NOT EXISTS last_used_by UUID;
    ALTER TABLE keychain_secrets ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS keychain_secret_uses (
      id BIGSERIAL PRIMARY KEY,
      keychain_id UUID NOT NULL REFERENCES keychains(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      session_id UUID,
      used_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS keychain_secret_uses_kc_idx ON keychain_secret_uses(keychain_id, used_at DESC);
    CREATE TABLE IF NOT EXISTS keychain_links (
      keychain_id UUID NOT NULL REFERENCES keychains(id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (keychain_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS keychain_links_session_idx ON keychain_links(session_id);
    CREATE TABLE IF NOT EXISTS canvas_note_links (
      note_id UUID NOT NULL REFERENCES canvas_notes(id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (note_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS canvas_note_links_session_idx ON canvas_note_links(session_id);
    CREATE TABLE IF NOT EXISTS browser_links (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      project_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, node_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS browser_links_session_idx ON browser_links(session_id);
    -- Browser nodes belong to the project (canvas) they were created on; the browser itself stays one per user.
    CREATE TABLE IF NOT EXISTS browser_nodes (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      project_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, node_id)
    );
    -- Existing nodes stay on the project of their oldest wire (the one place the runtime knows them from). Never deletes anything.
    INSERT INTO browser_nodes (user_id, node_id, project_id)
      SELECT DISTINCT ON (user_id, node_id) user_id, node_id, project_id FROM browser_links ORDER BY user_id, node_id, created_at
      ON CONFLICT DO NOTHING;
    ALTER TABLE canvas_notes ADD COLUMN IF NOT EXISTS agent_note_name TEXT;
    ALTER TABLE canvas_notes ADD COLUMN IF NOT EXISTS placed BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE canvas_notes ADD COLUMN IF NOT EXISTS user_title TEXT;
    ALTER TABLE canvas_notes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'note';
    ALTER TABLE canvas_notes DROP CONSTRAINT IF EXISTS canvas_notes_kind_check;
    ALTER TABLE canvas_notes ADD CONSTRAINT canvas_notes_kind_check CHECK (kind IN ('note','memory','system'));
    ALTER TABLE canvas_notes ADD COLUMN IF NOT EXISTS author TEXT;
    CREATE INDEX IF NOT EXISTS canvas_notes_kind_idx ON canvas_notes(user_id, project_id) WHERE kind <> 'note';
    CREATE UNIQUE INDEX IF NOT EXISTS canvas_notes_agent_name_idx ON canvas_notes(user_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), agent_note_name) WHERE agent_note_name IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_wired_memory (
      session_id UUID PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      block TEXT NOT NULL,
      digest TEXT NOT NULL,
      items JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_project_folders (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      doc JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS floq_plugins (
      id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      version TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      config JSONB NOT NULL DEFAULT '{}',
      config_owner TEXT REFERENCES "user"(id) ON DELETE SET NULL,
      webhook_token_hash TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE floq_plugins ADD COLUMN IF NOT EXISTS webhook_auto_hash TEXT;
    ALTER TABLE floq_plugins ADD COLUMN IF NOT EXISTS webhook_auto_enc TEXT;
    CREATE TABLE IF NOT EXISTS floq_plugin_user_settings (
      plugin_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      settings JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS floq_plugin_packages (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      manifest JSONB NOT NULL,
      runtime TEXT NOT NULL,
      ui TEXT,
      skills JSONB NOT NULL DEFAULT '{}',
      installed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE floq_plugin_packages ADD COLUMN IF NOT EXISTS source_repo TEXT;
    CREATE TABLE IF NOT EXISTS floq_plugin_migrations (
      plugin_id TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin_id, migration_id)
    );
    CREATE TABLE IF NOT EXISTS plugin_secrets (
      plugin_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin_id, owner_id, name)
    );
    CREATE TABLE IF NOT EXISTS plugin_secret_audit (
      id BIGSERIAL PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS plugin_secret_migrations (
      plugin_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      moved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      kept_in_vault BOOLEAN NOT NULL DEFAULT FALSE,
      dismissed_at TIMESTAMPTZ,
      PRIMARY KEY (plugin_id, owner_id, name)
    );
  `);
  await migrateOrganizations(pool);
}

/**
 * Projects belong to one of the owner's organizations. Needs collaboration.* (Prisma deploy runs first in
 * production); skipped when that schema is absent (unit tests that only exercise app tables). Idempotent.
 * Personal organizations have a NULL slug, so they can neither collide with nor be squatted by team slugs.
 */
async function migrateOrganizations(pool: pg.Pool): Promise<void> {
  const present = await pool.query("SELECT to_regclass('collaboration.organizations') IS NOT NULL AS ok");
  if (!present.rows[0]?.ok) {
    // No collaboration schema: org-aware queries still select organization_id, so keep a plain nullable column (no FK, always NULL).
    await pool.query(`
      ALTER TABLE floq_projects ADD COLUMN IF NOT EXISTS organization_id UUID;
      ALTER TABLE user_project_folders ADD COLUMN IF NOT EXISTS organization_id UUID;
    `);
    return;
  }
  await pool.query(`
    ALTER TABLE floq_projects ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES collaboration.organizations(id) ON DELETE RESTRICT;
    ALTER TABLE user_project_folders ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES collaboration.organizations(id) ON DELETE CASCADE;
    -- A column added earlier without collaboration.* (plain UUID) gets its foreign key once the schema exists.
    DO $fk$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'floq_projects'::regclass AND contype = 'f' AND confrelid = 'collaboration.organizations'::regclass) THEN
        ALTER TABLE floq_projects ADD FOREIGN KEY (organization_id) REFERENCES collaboration.organizations(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'user_project_folders'::regclass AND contype = 'f' AND confrelid = 'collaboration.organizations'::regclass) THEN
        ALTER TABLE user_project_folders ADD FOREIGN KEY (organization_id) REFERENCES collaboration.organizations(id) ON DELETE CASCADE;
      END IF;
    END
    $fk$;
    INSERT INTO collaboration.organizations (id, name, slug, created_by, personal_owner_id)
      SELECT gen_random_uuid(), 'Personal', NULL, x.uid, x.uid
      FROM (SELECT user_id AS uid FROM floq_projects WHERE organization_id IS NULL
            UNION SELECT user_id FROM user_project_folders WHERE organization_id IS NULL) x
      ON CONFLICT (personal_owner_id) DO NOTHING;
    UPDATE collaboration.organizations SET slug = NULL WHERE personal_owner_id IS NOT NULL AND slug LIKE 'personal-%';
    INSERT INTO collaboration.organization_members (organization_id, user_id, role)
      SELECT o.id, o.personal_owner_id, 'owner' FROM collaboration.organizations o
      WHERE o.personal_owner_id IN (SELECT user_id FROM floq_projects WHERE organization_id IS NULL
                                    UNION SELECT user_id FROM user_project_folders WHERE organization_id IS NULL)
      ON CONFLICT DO NOTHING;
    UPDATE floq_projects p SET organization_id = o.id FROM collaboration.organizations o
      WHERE p.organization_id IS NULL AND o.personal_owner_id = p.user_id;
    UPDATE user_project_folders f SET organization_id = o.id FROM collaboration.organizations o
      WHERE f.organization_id IS NULL AND o.personal_owner_id = f.user_id;
    -- Guarded: skip the (locking) ALTER once the column is already NOT NULL.
    DO $nn$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'floq_projects'::regclass AND attname = 'organization_id' AND NOT attnotnull) THEN
        ALTER TABLE floq_projects ALTER COLUMN organization_id SET NOT NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'user_project_folders'::regclass AND attname = 'organization_id' AND NOT attnotnull) THEN
        ALTER TABLE user_project_folders ALTER COLUMN organization_id SET NOT NULL;
      END IF;
    END
    $nn$;
    CREATE INDEX IF NOT EXISTS floq_projects_user_org_idx ON floq_projects(user_id, organization_id, created_at DESC);
    DO $do$
    DECLARE pk TEXT;
    BEGIN
      SELECT conname INTO pk FROM pg_constraint
        WHERE conrelid = 'user_project_folders'::regclass AND contype = 'p' AND array_length(conkey, 1) = 1;
      IF pk IS NOT NULL THEN
        EXECUTE format('ALTER TABLE user_project_folders DROP CONSTRAINT %I', pk);
        ALTER TABLE user_project_folders ADD PRIMARY KEY (user_id, organization_id);
      END IF;
    END
    $do$;
    -- Any insert path that does not name an organization (older code, tools) lands in the owner's personal organization.
    -- floq_personal_org() creates it on demand. Personal organizations have a NULL slug, so nothing can collide.
    CREATE OR REPLACE FUNCTION floq_personal_org(uid TEXT) RETURNS UUID LANGUAGE plpgsql AS $fn$
    DECLARE oid UUID;
    BEGIN
      INSERT INTO collaboration.organizations (id, name, slug, created_by, personal_owner_id)
        VALUES (gen_random_uuid(), 'Personal', NULL, uid, uid) ON CONFLICT (personal_owner_id) DO NOTHING;
      SELECT id INTO oid FROM collaboration.organizations WHERE personal_owner_id = uid;
      INSERT INTO collaboration.organization_members (organization_id, user_id, role) VALUES (oid, uid, 'owner') ON CONFLICT DO NOTHING;
      RETURN oid;
    END
    $fn$;
    CREATE OR REPLACE FUNCTION floq_projects_default_org() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.organization_id IS NULL THEN NEW.organization_id := floq_personal_org(NEW.user_id); END IF;
      RETURN NEW;
    END
    $fn$;
    -- An older runtime inserts folder docs by (user_id) alone: fill the personal org so it does not hit a NOT NULL violation.
    -- (Its ON CONFLICT (user_id) still has no matching constraint; downgrading needs manual SQL for folders, see docs/DESIGN.md.)
    CREATE OR REPLACE FUNCTION user_project_folders_default_org() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.organization_id IS NULL THEN NEW.organization_id := floq_personal_org(NEW.user_id); END IF;
      RETURN NEW;
    END
    $fn$;
    DO $tg$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'floq_projects'::regclass AND tgname = 'floq_projects_default_org' AND NOT tgisinternal) THEN
        CREATE TRIGGER floq_projects_default_org BEFORE INSERT ON floq_projects FOR EACH ROW EXECUTE FUNCTION floq_projects_default_org();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'user_project_folders'::regclass AND tgname = 'user_project_folders_default_org' AND NOT tgisinternal) THEN
        CREATE TRIGGER user_project_folders_default_org BEFORE INSERT ON user_project_folders FOR EACH ROW EXECUTE FUNCTION user_project_folders_default_org();
      END IF;
    END
    $tg$;
  `);
  // Project tasks + automations (additive; org boards in collaboration.* are untouched).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automations (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES floq_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      schedule JSONB NOT NULL,
      catch_up TEXT NOT NULL DEFAULT 'once' CHECK (catch_up IN ('skip','once')),
      next_run_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      last_status TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS automations_project_idx ON automations (project_id, created_at);
    CREATE INDEX IF NOT EXISTS automations_due_idx ON automations (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS project_tasks (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES floq_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      assignee_session_id UUID,
      created_by TEXT NOT NULL DEFAULT 'user',
      due_at TIMESTAMPTZ,
      run_at TIMESTAMPTZ,
      automation_id UUID REFERENCES automations(id) ON DELETE SET NULL,
      position DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS project_tasks_project_idx ON project_tasks (project_id, status, position);
    CREATE INDEX IF NOT EXISTS project_tasks_user_idx ON project_tasks (user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS project_tasks_dispatch_idx ON project_tasks (project_id, run_at) WHERE status = 'todo';
    CREATE TABLE IF NOT EXISTS task_events (
      id BIGSERIAL PRIMARY KEY,
      task_id UUID NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('created','status','update','comment','dispatched','run_failed')),
      text TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, id);
    CREATE TABLE IF NOT EXISTS project_task_settings (
      project_id UUID PRIMARY KEY REFERENCES floq_projects(id) ON DELETE CASCADE,
      auto_agent BOOLEAN NOT NULL DEFAULT FALSE,
      agent_session_id UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
