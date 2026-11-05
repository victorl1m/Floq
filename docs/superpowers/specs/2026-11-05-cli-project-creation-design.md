# Named projects with optional Git

Approved by the user on 2026-11-05. Users and agents need projects without Git. Names are arbitrary; `test` was only an example.

Create an empty managed project using `floq project create --name NAME`. Optional `--git-url URL` imports a repository using existing clone and URL deduplication behavior. Return the project UUID and workspace location. Both app and agent APIs share creation logic. The agent route derives user identity from its token.

Non-Git projects have a UUID-managed directory and Main workspace, null Git URL and branch, and need no schema migration. Names must be nonempty after trimming and at most 120 characters. Failed creation cleans up unregistered directories. Plain project lifecycle and session startup must work without Git; Git-only isolation must fail clearly. Deletion must preserve existing safeguards and must account for plain project files rather than treating a Git error as unreadable state.

Approaches: Git-required import was rejected because projects need not use Git. Arbitrary existing-directory registration requires a separate storage/lifecycle design. Chosen approach uses managed empty directories alongside the existing Git import model.

No sidebar UI changes, new dependencies, real project creation, remote publication, or unrelated refactoring. Preserve concurrent changes. Work is isolated, then merge only this feature's delta into the shared checkout.
