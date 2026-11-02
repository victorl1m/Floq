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
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS git_coauthor BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS provider_credentials (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      token_enc TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS agent_links (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      a_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      b_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      PRIMARY KEY (a_id, b_id),
      CHECK (a_id < b_id)
    );
    CREATE TABLE IF NOT EXISTS agent_notes (
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, name)
    );
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
  `);
}
