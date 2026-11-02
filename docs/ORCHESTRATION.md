# Floq orchestration: LangChain on top of the Claude Code / Codex harnesses

Status: architecture proposal for automated orchestration. The manual `floq recruit --isolated` Git worktree flow described below is implemented; automated graphs and review workflows remain proposals. Facts taken from the web are marked with their source; everything else is a recommendation.

## Implemented manual isolation

Lead agents can opt in to a separate branch and worktree for a recruited agent with `floq recruit "Builder" --isolated`. The default recruit still shares the lead's working directory. Isolated workers remain in the same logical project for `floq list`, `ask`, `connect`, and `dismiss`. Worktrees start from committed `HEAD`; the source's uncommitted changes are left in place and are not copied. Floq does not commit, push, prune, or remove a worktree when its agent is dismissed. Isolation requires a Git repository in the user's shard.

## 1. What we are competing with

[Orca](https://onorca.dev/) (Stably AI, MIT) is a desktop "agent IDE". From its [directory listing](https://landscape.jimmysong.io/projects/orca/) and site: one git worktree per task, one prompt fanned out to several agents and the winner merged, inline diff review, GitHub and Linear task import, SSH to remote machines, a phone companion for notifications and follow-ups, usage and rate-limit display, an embedded browser with a design mode. It is bring-your-own-subscription and runs on the user's machine. (Feature claims are from marketing pages, not verified docs.)

Where Floq can be structurally different:

| Orca | Floq |
| --- | --- |
| Local app; work stops when the laptop closes | Cloud shards that keep working server-side and sleep/resume durably |
| Single user | Multi-user, encrypted per-user homes |
| Human drives each agent | A control plane drives agents toward a goal and asks the human only at gates |
| Fan-out then pick a winner by eye | Fan-out, automatic verification (tests/lint), cross-agent review, then a human gate |

## 2. Principle: do not replace the harnesses

Claude Code and Codex are already complete coding harnesses (tools, sandboxing, context management). Re-implementing them in LangChain would be worse. LangChain/LangGraph goes **above** them as the control plane, and treats each harness as a worker.

```
 Floq UI  <--WS-->  runtime
                     |-- Interactive workers: PTY terminals (today)
                     |-- Headless workers: structured adapters (new)
                     '-- Control plane: LangGraph graphs (new)
                            |- state + checkpoints in the existing Postgres
                            |- supervisor model via LangChain (any provider)
                            '- tools: run_agent, run_tests, git, GitHub, Context7 (MCP)
```

## 3. Worker adapters (how the control plane talks to Claude/Codex)

PTY screen-scraping is fine for humans but poor for automation. Add a second, structured adapter per harness:

- **Codex**: `codex app-server` is a JSON-RPC 2.0 protocol over stdio (newline-delimited JSON) that powers Codex's own CLI, VS Code and desktop surfaces; it can send requests back to the client (approvals for commands and file changes) and typed bindings can be generated with `codex app-server generate-ts` ([InfoQ](https://www.infoq.com/news/2026/02/opanai-codex-app-server), [guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/)). OpenAI reportedly recommends it over MCP mode for full-fidelity integrations. Method names must be verified against the installed version.
- **Claude Code**: headless print mode with streaming JSON output, or the Claude Agent SDK. I did not verify exact flags; check `claude --help` on the image's version.
- Both adapters expose the same internal interface: `start(task, worktree) -> events stream`, `approve(id)`, `interrupt()`, `result() -> {summary, diff, testsRun}`. The existing session id, shard and sleep/resume machinery is reused, so a headless worker can also sleep and resume.

## 4. Control plane: LangGraph

Use LangGraph JS (`@langchain/langgraph`) so it lives in the same Node process. Reasons it fits:

- **Durable state in Postgres.** `interrupt()` pauses a run and persists state in a checkpointer; with the Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`) paused runs survive restarts and can be approved hours later, keyed by `thread_id` ([overview](https://www.markaicode.com/langgraph-human-in-the-loop-approval-gates/)). This matches Floq's sleep/resume model exactly: workflow id = `thread_id`.
- **Human gates map to UI.** An `interrupt()` becomes an approval card in Floq; `Command(resume=...)` is the user's answer.
- Caveat from the same source: on resume the interrupted node re-runs from its start, so side effects before `interrupt()` must be idempotent (create the worktree/PR only if absent).

Reference workflow ("ship a feature"):

1. **spec** - run Spec Kit (`/speckit.*` commands, already installed) to produce spec and plan; gate: human approves the plan.
2. **fan-out** - N workers (e.g. Claude, Codex, or two Claude variants) each in its own git worktree under the user's home.
3. **verify** - run tests/lint/typecheck per worktree in the sandbox; score results.
4. **cross-review** - give each diff to a different harness ("Codex reviews Claude's diff") plus the supervisor model.
5. **select** - rank by tests + review; gate: human picks or accepts the suggestion.
6. **ship** - push branch, open PR with the user's linked GitHub credential, attach the review summary.

Other graphs: issue triage (GitHub webhook -> plan -> PR), "fix failing CI", scheduled maintenance.

## 5. Supervisor and tools through LangChain

- A supervisor model chosen through LangChain's model abstraction decomposes goals and routes to workers. Because LangChain is provider-agnostic, the supervisor can be a cheaper model than the workers.
- Workers appear to the supervisor as tools: `run_coding_agent(provider, task, worktree)`, `run_tests`, `git_diff`, `open_pr`.
- MCP tools (Context7 etc.) can be given to the supervisor through LangChain's MCP adapters, so docs lookups are available above the harness level too.
- Long-term memory (project conventions, past decisions, user preferences) in a Postgres-backed LangGraph store, scoped per user and encrypted with the same key hierarchy as the rest of Floq's data.
- [`langchain-acp`](https://pypi.org/project/langchain-acp/) shows LangGraph/DeepAgents graphs can be exposed over the Agent Client Protocol, which is a path for editors to talk to a Floq graph later.

## 6. Where this beats Orca

1. **Always-on**: workflows continue and checkpoint while the user is offline; resume exactly.
2. **Verified fan-out**: tests and cross-agent review pick the winner, not eyeballing N diffs.
3. **Spec-driven**: Spec Kit artifacts are first-class graph inputs, so plans are reviewed before code is written.
4. **Policy and budgets**: per-user auto-approve policy per harness (already a setting), spend caps per workflow, allowed-path rules enforced by the sandbox.
5. **Event-driven**: GitHub webhooks and schedules start graphs, not just a human typing.
6. **Team-ready**: server-side identity and isolated shards allow shared workflows later.
7. Keep parity features: diff review UI, GitHub PR/issues, usage display, push/mobile notifications when a gate needs a human.

## 7. Risks

- Harness protocols change quickly; wrap them behind the adapter interface and pin CLI versions in the image.
- Using a consumer subscription login for unattended server-side automation may violate provider terms. Prefer API keys (the current per-user key model) for automated workflows.
- LangGraph resume semantics (re-run from node start) need idempotent nodes.
- Cost: fan-out multiplies spend; budgets must exist before fan-out ships.
- Prompt injection: repo content and tool output are untrusted input for the supervisor; keep approval gates before push/merge and never let supervisor text widen sandbox permissions.

## 8. Suggested phases

1. Structured worker adapter for Codex (app-server) and Claude (headless), behind one interface, with event streaming to the UI.
2. Automated worktree manager + `run_tests`; single-worker graph with a human gate. Manual recruited-agent isolation is already available.
3. Fan-out, verification, cross-review, selection.
4. Spec Kit-driven front half, GitHub webhook triggers, budgets/policy, notifications.

## 9. Preinstalled in the image today

| Item | How |
| --- | --- |
| Superpowers | `obra/superpowers` skills copied into `~/.claude/skills` and `$CODEX_HOME/skills` |
| Humanizer | `blader/humanizer` `SKILL.md` copied to both agents' skills |
| Context7 | MCP server in `~/.claude.json` and Codex `config.toml` (`npx -y @upstash/context7-mcp`) |
| GitHub Spec Kit | `specify` CLI installed with `uv`; `specKit: true` on session create runs `specify init --here` |

Skills and MCP config are copied into each user's home on first wake and never overwrite user edits. Superpowers also ships as a Claude Code plugin ([install notes](https://www.mintlify.com/obra/superpowers/installation/claude-code)); I preinstall its skills only, so plugin-level hooks are not active. Refs are build args (`SUPERPOWERS_REF`, `HUMANIZER_REF`, `SPECKIT_REF`) and should be pinned to tags.

Sources: [Orca](https://onorca.dev/), [Orca listing](https://landscape.jimmysong.io/projects/orca/), [Codex app-server (InfoQ)](https://www.infoq.com/news/2026/02/opanai-codex-app-server), [Codex app-server guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/), [LangGraph interrupts](https://www.markaicode.com/langgraph-human-in-the-loop-approval-gates/), [langchain-acp](https://pypi.org/project/langchain-acp/), [Superpowers install](https://www.mintlify.com/obra/superpowers/installation/claude-code), [Humanizer install](https://instagit.com/blader/humanizer/how-to-install-humanizer-readme-md/), [Context7 in Codex](https://developers.openai.com/codex/mcp), [Spec Kit forks/docs](https://scrapbox.io/entropy/GitHub_Spec_Kit).
