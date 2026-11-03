#!/usr/bin/env node
// floq: agent-to-agent orchestration from inside a Floq terminal.
//   floq list                              agents you can talk to
//   floq session restart                    restart this agent after replying to reload its configuration
//   floq ask <UUID|Name> "prompt" [--timeout S] [--no-wait] [--chars N|--full]   message another agent, wait until it finishes, print its full reply
//   floq wait <UUID|Name> [--timeout S] [--chars N|--full]   block until the agent is idle, print its last reply
//   floq check <UUID|Name> [--chars N|--full]   status line plus the agent's last full reply (terminal tail while it works)
//   floq note list | read N | write N TEXT | append N TEXT
//   floq recruit "Name" [--provider claude|codex] [--model ID] [--cwd DIR] [--role ID|TEXT] [--isolated]   (orchestrator only)
//   floq connect <UUID|Name> <UUID|Name>       (lead agents only)
//   floq dismiss <UUID|Name>                   (lead agents only)
//   floq skills list|search|preview|add|create|remove   find, install and author skills (add/create/remove: lead agents only)
//   floq mcp list|add|remove                     install MCP servers (add/remove: lead agents only)
//   floq secret list|get NAME                    secrets available to this agent (linked keychains + global env vault); list prints names only; never print or commit values
//   floq secrets list|add                        list secret names; create a new tool-only secret (add: lead only)
import { readdirSync, readFileSync } from "node:fs";
import { buildRecruitPayload, checkProvider, cleanSecretInput, formatAgentListEntry, formatAgentReply, formatMcpReview, formatMcpServer, formatModel, formatRecruitment, formatRoleLine, type RoleEntry, formatSkill, parseArgs, parseSecretsAdd, readSkillDirectory, scopeFields, scopeLabel, splitDashDash, type AgentEntry, type AgentReply, type McpReview, type McpServer, type ModelEntry, type NamedArgs, type ScopeResult, type SkillSummary } from "./floq-args.mjs";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
type SkillResponse = { skill: { source: string; skillId: string; name: string; provider: string; location: string; description: string }; files: { path: string; size: number }[]; markdown?: string; dryRun?: boolean; scope?: string; projectId?: string };
type ScopeResponse = ScopeResult & { scope: "project" | "global"; projectId?: string };

const help = `Floq agent coordination

Commands:
  floq list
  floq session restart                   restart this agent to reload its current configuration
  floq models [--provider claude|codex]
  floq roles                             one line per agent role preset (compare, then pick)
  floq role ID                           full description of a role: when to use, handoffs, model advice
  floq ask <UUID|Name> "prompt" [--timeout SECONDS] [--no-wait] [--chars N | --full]
  floq wait <UUID|Name> [--timeout SECONDS] [--chars N | --full]
  floq check <UUID|Name> [--chars N | --full]
  floq recruit "Name" [--provider claude|codex] [--model ID] [--cwd DIR] [--role ID|TEXT] [--isolated]   (orchestrator only; other agents ask the orchestrator with "floq ask")
  floq connect <UUID|Name> <UUID|Name>
  floq dismiss <UUID|Name>
  floq note list | read NAME | write NAME TEXT | append NAME TEXT
  floq skills list [--project [UUID] | --global]
  floq skills search QUERY
  floq skills preview OWNER/REPO SKILL_ID   |   floq skills preview URL
  floq skills add OWNER/REPO SKILL_ID | URL [--provider claude|codex] [--project [UUID] | --global]
  floq skills create NAME --description TEXT (--from DIR | --instructions FILE | -) [--provider claude|codex] [--project [UUID] | --global] [--dry-run]
  floq skills remove NAME [--provider claude|codex]
  floq mcp list [--provider claude|codex] [--project [UUID] | --global]
  floq mcp add NAME --url URL [options]   |   floq mcp add NAME [options] -- COMMAND [ARGS...]
  floq mcp add --json FILE|- [--name NAME] [options]       (JSON from docs; "-" reads stdin; the only way to set env/headers; a value of "\${vault:NAME}" reads that vault secret)
      options: [--provider claude|codex|both] [--project [UUID] | --global] [--dry-run] [--allow-plaintext]
  floq mcp remove NAME [--provider claude|codex] [--project [UUID] | --global]
  floq secret list                       names (and scope: keychain|global) of the secrets available to this agent
  floq secret get NAME                   print one value (prefer the NAME environment variable; never echo or commit it)
  floq secrets list
  floq secrets add NAME [--description TEXT]     (value from stdin or a hidden prompt; create only)

Use immutable Floq UUIDs printed by list/recruit for agent references. Names are accepted
for compatibility, but duplicate names are ambiguous. --isolated recruits into a managed
Git worktree in a registered Git project; --cwd selects an allowed directory in this project.
Check models with "floq models" before recruiting with --model. The name/role do not select a model: read "floq roles" / "floq role ID", then choose a provider and a --model matching the role's capability. --role ID applies a preset prompt; other --role text is a free-form first message.
Only the orchestrator can recruit. Connect/dismiss require a lead session and user authorization. If you are not the orchestrator and need another agent, message the orchestrator ("floq ask <orchestrator> \"Please recruit a <role> agent to <task>\"") instead of recruiting.

Skills, MCP servers and secrets: list/search/preview and "mcp add --dry-run" work in any agent session. Installing or removing
skills and MCP servers, and creating secrets, require a lead session. ALWAYS show the user what you are about to install
(run "mcp add --dry-run" or "skills preview" first) and get their go-ahead, unless they asked for that exact install.
This is a rule for you; the CLI cannot enforce it. Skills and MCP servers default to this session's project, or your home (--global) when it has none. MCP defaults: this session's provider, and its
project (else global); --global writes to your whole home. A stdio MCP server runs its command with the agent's permissions.
Secret values are never taken as arguments: "floq secrets add NAME" reads the value from stdin or prompts without echo.
Secrets added this way are tool-only (usable through floq-vault run, not readable) and cannot be changed or deleted by agents.
New MCP servers and skills load when a session starts or resumes. After the change is approved and your current work is saved, run "floq session restart" to reload this agent; it resumes the same conversation after replying. Authentication is separate: a restart does not complete MCP OAuth or prove that tools loaded.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
  console.log(help);
  process.exit(0);
}
const [command, ...allRest] = argv;
// Everything after a bare "--" in "mcp add" is the server command; it is never parsed as options.
const [rest, dashed] = command === "mcp" ? splitDashDash(allRest) : [allRest, null];
const { positional, named } = parseArgs(rest);

const url = process.env.FLOQ_API_URL;
const token = process.env.FLOQ_AGENT_TOKEN;
if (!url || !token) {
  console.error("floq: not available in this session");
  process.exit(2);
}

async function call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(url + "/internal/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let data: { error?: { message?: string } };
  try {
    data = JSON.parse(text) as { error?: { message?: string } };
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (!response.ok) {
    console.error("floq: " + (data.error?.message ?? "request failed (" + response.status + ")"));
    process.exit(1);
  }
  return data as unknown as T;
}

function scopeOrExit(options: NamedArgs): ScopeResult {
  try { return scopeFields(options); } catch (error) { console.error("floq: " + errorMessage(error)); process.exit(2); }
}
function providerOrExit(value: string | boolean | undefined, allowBoth: boolean) {
  try { return checkProvider(value, allowBoth); } catch (error) { console.error("floq: " + errorMessage(error)); process.exit(2); }
}

async function readSecretValue(name: string): Promise<string> {
  if (process.stdin.isTTY) {
    // Hidden prompt: nothing is echoed and nothing is kept in shell history.
    process.stderr.write("Value for " + name + " (input hidden, press Enter to finish): ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    await new Promise<void>((resolve) => {
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") { process.stdin.off("data", onData); return resolve(); }
          if (ch === "\u0003") { process.stderr.write("\n"); process.exit(130); }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      process.stdin.on("data", onData);
    });
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
    return value;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32 * 1024) { console.error("floq: value is too large"); process.exit(1); }
    chunks.push(chunk);
  }
  return cleanSecretInput(Buffer.concat(chunks).toString("utf8"));
}

// Node's fetch gives up on a response after ~300s of silence, so long waits are split into shorter requests.
const WAIT_CHUNK_SEC = 240;
async function waitChunked(first: AgentReply, firstSec: number, total: number, name: string, extra: Record<string, unknown>): Promise<AgentReply> {
  let reply = first;
  let remaining = total - firstSec;
  while (reply.status === "timeout" && remaining > 0) {
    const chunk = Math.min(WAIT_CHUNK_SEC, remaining);
    remaining -= chunk;
    reply = await call<AgentReply>("agents/wait", { name, timeoutSec: Math.max(chunk, 10), ...extra });
  }
  return reply;
}

const usage = (): never => {
  console.error('usage: floq --help');
  process.exit(2);
};

const allowedOptions: Record<string, string[]> = {
  list: [], roles: [], role: [], models: ["provider"], ask: ["timeout", "wait", "no-wait", "chars", "full"], wait: ["timeout", "chars", "full"], check: ["chars", "full"],
  session: [],
  recruit: ["provider", "model", "cwd", "role", "isolated"], connect: [], dismiss: [], note: [],
  skills: ["provider", "project", "global", "description", "from", "instructions", "dry-run"],
  mcp: ["provider", "project", "global", "json", "name", "dry-run", "url", "allow-plaintext"],
  secrets: ["description", "value", "expose"],
  secret: [],
};
if (!allowedOptions[command]) usage();
for (const option of Object.keys(named)) {
  if (!allowedOptions[command].includes(option)) {
    console.error("floq: unknown option --" + option);
    usage();
  }
}

switch (command) {
  case "help": {
    console.log(help);
    break;
  }
  case "list": {
    const { agents } = await call<{ agents: AgentEntry[] }>("agents/list");
    for (const a of agents) console.log(formatAgentListEntry(a));
    break;
  }
  case "session": {
    const [sub, ...args] = positional;
    if (sub !== "restart" || args.length) usage();
    const result = await call<{ scheduled: boolean; restartDelayMs: number }>("agents/restart");
    console.log(`Restart scheduled in about ${result.restartDelayMs} ms. Floq will resume this same session and conversation with current configuration.`);
    console.log("A restart reloads configuration; it does not authenticate an MCP server or prove its tools are available.");
    break;
  }
  case "models": {
    if (named.provider !== undefined && typeof named.provider !== "string") usage();
    const requestedProvider = typeof named.provider === "string" ? named.provider : undefined;
    const providers = requestedProvider ? [requestedProvider] : ["claude", "codex"];
    if (providers.some((provider) => provider !== "claude" && provider !== "codex")) usage();
    const { models } = await call<{ models: Record<string, ModelEntry[]> }>("agents/models", { provider: requestedProvider });
    for (const provider of providers) for (const model of models[provider] ?? []) console.log(formatModel(provider, model));
    break;
  }
  case "roles": {
    const { roles } = await call<{ roles: RoleEntry[] }>("agents/roles");
    console.log("generalist    (no preset)       read-write  Default agent with no role prompt");
    for (const role of roles) console.log(formatRoleLine(role));
    break;
  }
  case "role": {
    if (positional.length !== 1) usage();
    console.log((await call<{ text: string }>("agents/role", { id: positional[0] })).text);
    break;
  }
  case "ask": {
    if (positional.length < 2) usage();
    const timeoutSec = typeof named.timeout === "string" ? Number(named.timeout) : undefined;
    const total = timeoutSec ?? 300;
    const extra = { chars: typeof named.chars === "string" ? Number(named.chars) : undefined, full: named.full === true };
    const first = Math.min(total, WAIT_CHUNK_SEC);
    const r = await waitChunked(await call<AgentReply>("agents/ask", { name: positional[0], prompt: positional.slice(1).join(" "), timeoutSec: first, wait: named["no-wait"] !== true, ...extra }), first, total, positional[0], extra);
    const out = formatAgentReply("ask", positional[0], r, total);
    console.log(out.text);
    process.exitCode = out.code;
    break;
  }
  case "wait": {
    if (positional.length !== 1) usage();
    const timeoutSec = typeof named.timeout === "string" ? Number(named.timeout) : undefined;
    const total = timeoutSec ?? 300;
    const extra = { chars: typeof named.chars === "string" ? Number(named.chars) : undefined, full: named.full === true };
    const first = Math.min(total, WAIT_CHUNK_SEC);
    const r = await waitChunked(await call<AgentReply>("agents/wait", { name: positional[0], timeoutSec: first, ...extra }), first, total, positional[0], extra);
    const out = formatAgentReply("wait", positional[0], r, total);
    console.log(out.text);
    process.exitCode = out.code;
    break;
  }
  case "check": {
    if (positional.length < 1) usage();
    const r = await call<AgentReply>("agents/check", { name: positional[0], chars: typeof named.chars === "string" ? Number(named.chars) : undefined, full: named.full === true });
    console.log(formatAgentReply("check", positional[0], r).text);
    break;
  }
  case "note": {
    const [sub, name, ...text] = positional;
    if (sub === "list") {
      const { notes } = await call<{ notes: { name: string }[] }>("notes/list");
      for (const n of notes) console.log(n.name);
    } else if (sub === "read" && name) {
      console.log((await call<{ content: string }>("notes/read", { name })).content);
    } else if ((sub === "write" || sub === "append") && name) {
      await call("notes/write", { name, content: text.join(" "), append: sub === "append" });
    } else usage();
    break;
  }
  case "recruit": {
    if (positional.length < 1) usage();
    const r = await call<Pick<AgentEntry, "name" | "id" | "provider" | "model">>("agents/recruit", buildRecruitPayload(positional, named));
    console.log(formatRecruitment(r));
    break;
  }
  case "connect": {
    if (positional.length < 2) usage();
    await call("agents/connect", { from: positional[0], to: positional[1] });
    console.log("connected");
    break;
  }
  case "dismiss": {
    if (positional.length < 1) usage();
    await call("agents/dismiss", { name: positional[0] });
    console.log("dismissed");
    break;
  }
  case "skills": {
    const [sub, ...args] = positional;
    const scope = scopeOrExit(named);
    if (sub === "list") {
      const r = await call<ScopeResponse & { skills: SkillSummary[] }>("skills/list", scope);
      console.log("skills in " + scopeLabel(r));
      for (const skill of r.skills) console.log(formatSkill(skill));
    } else if (sub === "search" && args.length) {
      const { skills } = await call<{ skills: { source: string; skillId: string; installs: number }[] }>("skills/search", { query: args.join(" ") });
      if (!skills.length) console.log("no results");
      for (const item of skills) console.log(item.source + "\t" + item.skillId + "\t" + item.installs + " installs");
    } else if ((sub === "preview" || sub === "add") && (args.length === 2 || (args.length === 1 && /^https:\/\//.test(args[0])))) {
      const ref = args.length === 2 ? { source: args[0], skillId: args[1] } : { url: args[0] };
      if (sub === "preview") {
        const r = await call<SkillResponse>("skills/preview", ref);
        console.log(r.skill.source + " / " + r.skill.skillId + "\nfiles: " + r.files.map((file) => file.path + " (" + file.size + " bytes)").join(", ") + "\n\n" + r.markdown);
      } else {
        const provider = providerOrExit(named.provider, false);
        const r = await call<SkillResponse>("skills/add", { ...ref, provider, scope: scope.scope, projectId: scope.projectId });
        console.log("installed skill \"" + r.skill.name + "\" for " + r.skill.provider + (r.scope === "project" ? " in project " + r.projectId : " in your home") + " (" + r.skill.location + ")");
        console.log("files: " + r.files.map((file) => file.path).join(", "));
        console.log("It loads when a session starts or resumes; run `floq session restart` after saving your work to reload this agent.");
      }
    } else if (sub === "create" && (args.length === 1 || (args.length === 2 && args[1] === "-"))) {
      // The content comes from exactly one place: a directory, an instructions file, or stdin ("-").
      const sources = [named.from !== undefined, named.instructions !== undefined, args[1] === "-"].filter(Boolean).length;
      if (sources !== 1 || named.from === true || named.instructions === true) { console.error("floq: give exactly one of --from DIR, --instructions FILE, or - (stdin)"); process.exit(2); }
      const body: { name: string; description?: string; provider?: string; scope?: string; projectId?: string; dryRun: boolean; files?: Record<string, string>; instructions?: string } = { name: args[0], description: typeof named.description === "string" ? named.description : undefined, provider: providerOrExit(named.provider, false), scope: scope.scope, projectId: scope.projectId, dryRun: named["dry-run"] === true };
      try {
        if (typeof named.from === "string") body.files = readSkillDirectory(named.from);
        else if (typeof named.instructions === "string") body.instructions = named.instructions === "-" || args[1] === "-" ? readFileSync(0, "utf8") : readFileSync(named.instructions, "utf8");
        else body.instructions = readFileSync(0, "utf8");
      } catch (error) { const message = errorMessage(error); console.error("floq: " + (message.startsWith("--from") ? message : "could not read the skill content")); process.exit(2); }
      if (body.instructions !== undefined && !body.description) { console.error("floq: --description is required when the skill is written from instructions"); process.exit(2); }
      const r = await call<SkillResponse>("skills/create", body);
      console.log((r.dryRun ? "Would create" : "Created") + " skill \"" + r.skill.name + "\" for " + r.skill.provider + (r.scope === "project" ? " in project " + r.projectId : " in your home") + " at " + r.skill.location);
      console.log("description: " + r.skill.description);
      console.log("files: " + r.files.map((file) => file.path + " (" + file.size + " bytes)").join(", "));
      console.log(r.dryRun ? "dry run: nothing was written" : "It loads when a session starts or resumes; run `floq session restart` after saving your work to reload this agent.");
    } else if (sub === "remove" && args.length === 1) {
      const r = await call<{ matched: number }>("skills/remove", { name: args[0], provider: providerOrExit(named.provider, false) });
      console.log("removed " + args[0] + " (" + r.matched + " match" + (r.matched === 1 ? "" : "es") + ")");
    } else usage();
    break;
  }
  case "mcp": {
    const [sub, ...args] = positional;
    const scope = scopeOrExit(named);
    if (sub === "list") {
      const r = await call<ScopeResponse & { servers: McpServer[]; malformedConfigs?: number }>("mcp/list", { ...scope, provider: providerOrExit(named.provider, false) });
      console.log("MCP servers, scope: " + scopeLabel(r));
      for (const server of r.servers) console.log(formatMcpServer(server));
      if (r.malformedConfigs) console.log(r.malformedConfigs + " config file(s) could not be read");
    } else if (sub === "add") {
      const providers = providerOrExit(named.provider, true);
      let body;
      if (named.json !== undefined) {
        if (named.json === true || args.length || dashed) usage();
        let text;
        try { text = named.json === "-" ? readFileSync(0, "utf8") : readFileSync(String(named.json), "utf8"); }
        catch { console.error("floq: could not read the JSON config"); process.exit(1); }
        body = { config: text, name: named.name };
      } else {
        if (args.length !== 1 || (named.url !== undefined && dashed)) usage();
        const server = named.url !== undefined
          ? { type: "http", url: named.url }
          : dashed && dashed.length ? { type: "stdio", command: dashed[0], args: dashed.slice(1) } : null;
        if (!server) usage();
        body = { config: { ...server, name: args[0] } };
      }
      const r = await call<ScopeResponse & { dryRun: boolean; installed: McpReview; servers: { provider: string }[] }>("mcp/add", { ...body, ...scope, providers, dryRun: named["dry-run"] === true, allowPlaintext: named["allow-plaintext"] === true });
      console.log(formatMcpReview(r.installed, r));
      if (r.dryRun) console.log("dry run: nothing was changed");
      else {
        console.log("installed for: " + r.servers.map((server) => server.provider).join(", "));
        console.log("Run `floq session restart` after saving your work to reload this agent; authentication and tool availability must be checked separately.");
      }
    } else if (sub === "remove" && args.length === 1) {
      const r = await call<ScopeResponse>("mcp/remove", { ...scope, provider: providerOrExit(named.provider, false), name: args[0] });
      console.log("removed MCP server \"" + args[0] + "\" (" + scopeLabel(r) + ")");
      console.log("Run `floq session restart` after saving your work to reload this agent; authentication and tool availability must be checked separately.");
    } else usage();
    break;
  }
  case "secret": {
    const globalSecrets = async (): Promise<Record<string, string>> => {
      try { return (await call<{ secrets: Record<string, string> }>("secrets/global")).secrets; } catch { return {}; }
    };
    const [sub, secretName] = positional;
    const dir = (process.env.HOME ?? "/home/agent") + "/.floq/secrets/" + (process.env.FLOQ_SESSION_ID ?? "");
    if (sub === "list") {
      let names: string[] = [];
      try { names = readdirSync(dir).filter((n) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(n)).sort(); } catch { /* no keychain linked */ }
      const global = await globalSecrets();
      for (const n of names) console.log(n + "\tkeychain");
      for (const n of Object.keys(global).sort()) if (!names.includes(n)) console.log(n + "\tglobal");
      if (!names.length && !Object.keys(global).length) console.log("no secrets");
    } else if (sub === "get" && secretName && /^[A-Z_][A-Z0-9_]{0,63}$/.test(secretName) && positional.length === 2) {
      // Keychain files (linked wallets) win over global vault entries.
      try { process.stdout.write(readFileSync(dir + "/" + secretName, "utf8")); break; } catch { /* fall through to the global vault */ }
      const global = await globalSecrets();
      if (secretName in global) process.stdout.write(global[secretName]);
      else { console.error("floq: no secret named " + secretName + " is available to this agent"); process.exit(1); }
    } else usage();
    break;
  }
  case "secrets": {
    const [sub] = positional;
    if (sub === "list") {
      const { secrets } = await call<{ secrets: { name: string; description?: string }[] }>("vault/secrets");
      if (!secrets.length) console.log("no secrets");
      for (const secret of secrets) console.log(secret.name + (secret.description ? "\t" + secret.description : ""));
    } else if (sub === "add") {
      let request;
      try { request = parseSecretsAdd(positional.slice(1), named); } catch (error) { console.error("floq: " + errorMessage(error)); process.exit(2); }
      const value = await readSecretValue(request.name);
      await call("secrets/add", { name: request.name, value, description: request.description });
      console.log("created secret " + request.name + " (tool-only: use it with floq-vault run; agents cannot read, change or delete it)");
    } else usage();
    break;
  }
  default:
    usage();
}
