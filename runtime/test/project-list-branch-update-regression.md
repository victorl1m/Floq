# Project list branch update regression

`SessionManager.listProjects` refreshes cached branch names when the user's shard is already awake. The original update failed in PostgreSQL/PGlite with SQLSTATE `42P08` (`could not determine data type of parameter $1`): `$1` was assigned to a text column and also tested with `WHEN $1 IS NULL`.

The list and workspace SELECTs succeeded. The failure reproduced by creating `floq_projects`, `floq_project_workspaces`, and `agent_sessions` tables, inserting one project and workspace, then executing the original statement with `['feature/fix', workspaceId, 'user-a']`:

```sql
UPDATE floq_project_workspaces AS w
SET branch=$1,
    name=CASE WHEN $1 IS NULL THEN 'Detached HEAD'
              ELSE CASE WHEN w.cwd=(SELECT p.cwd FROM floq_projects p WHERE p.id=w.project_id)
                        THEN 'Main' ELSE 'Worktree' END
         END
WHERE w.id=$2 AND w.user_id=$3;
```

Casting the ambiguous parameter resolves it. PGlite accepted the corrected statement with both `['feature/fix', workspaceId, 'user-a']` and `[null, workspaceId, 'user-a']`; the former retains the appropriate `Main`/`Worktree` name and the latter produces `Detached HEAD`:

```sql
UPDATE floq_project_workspaces AS w
SET branch=$1::text,
    name=CASE WHEN $1::text IS NULL THEN 'Detached HEAD'
              ELSE CASE WHEN w.cwd=(SELECT p.cwd FROM floq_projects p WHERE p.id=w.project_id)
                        THEN 'Main' ELSE 'Worktree' END
         END
WHERE w.id=$2 AND w.user_id=$3;
```

The focused runtime regression test exercises both changed-branch cases against an awake shard. It checks that project listing completes and that branch labels are refreshed.
