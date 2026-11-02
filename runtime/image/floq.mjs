#!/usr/bin/env node
// floq: agent-to-agent orchestration from inside a Floq terminal.
//   floq list                              agents you can talk to
//   floq ask <UUID|Name> "prompt" [--timeout S] send a message to another agent and wait for its reply
//   floq check <UUID|Name> [--chars N]          read another agent's recent terminal output
//   floq note list | read N | write N TEXT | append N TEXT
//   floq recruit "Name" [--provider claude|codex] [--model ID] [--cwd DIR] [--role TEXT] [--isolated]   (lead agents only)
//   floq connect <UUID|Name> <UUID|Name>       (lead agents only)
//   floq dismiss <UUID|Name>                   (lead agents only)
//   floq skills list|search|preview|add|create|remove   find, install and author skills (add/create/remove: lead agents only)
//   floq mcp list|add|remove                     install MCP servers (add/remove: lead agents only)
//   floq secrets list|add                        list secret names; create a new tool-only secret (add: lead only)
import { readFileSync } from "node:fs";
import { buildRecruitPayload, checkProvider, cleanSecretInput, formatAgentListEntry, formatMcpReview, formatMcpServer, formatModel, formatRecruitment, formatSkill, parseArgs, parseSecretsAdd, readSkillDirectory, scopeFields, scopeLabel, splitDashDash } from "./floq-args.mjs";

const help = `Floq agent coordination

Commands:
  floq list
  floq models [--provider claude|codex]
  floq ask <UUID|Name> "prompt" [--timeout SECONDS]
  floq check <UUID|Name> [--chars N]
  floq recruit "Name" [--provider claude|codex] [--model ID] [--cwd DIR] [--role TEXT] [--isolated]
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
  floq secrets list
  floq secrets add NAME [--description TEXT]     (value from stdin or a hidden prompt; create only)

Use immutable Floq UUIDs printed by list/recruit for agent references. Names are accepted
for compatibility, but duplicate names are ambiguous. --isolated recruits into a managed
Git worktree in a registered Git project; --cwd selects an allowed directory in this project.
Check models with "floq models" before recruiting with --model. The name/role do not select a model.
Recruit/connect/dismiss require a lead session and user authorization.

Skills, MCP servers and secrets: list/search/preview and "mcp add --dry-run" work in any agent session. Installing or removing
skills and MCP servers, and creating secrets, require a lead session. ALWAYS show the user what you are about to install
(run "mcp add --dry-run" or "skills preview" first) and get their go-ahead, unless they asked for that exact install.
This is a rule for you; the CLI cannot enforce it. Skills and MCP servers default to this session's project, or your home (--global) when it has none. MCP defaults: this session's provider, and its
project (else global); --global writes to your whole home. A stdio MCP server runs its command with the agent's permissions.
Secret values are never taken as arguments: "floq secrets add NAME" reads the value from stdin or prompts without echo.
Secrets added this way are tool-only (usable through floq-vault run, not readable) and cannot be changed or deleted by agents.
New MCP servers and skills load when a session starts or resumes; running sessions need a restart or resume.`;

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

async function call(path, body) {
  const response = await fetch(url + "/internal/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (!response.ok) {
    console.error("floq: " + (data.error?.message ?? "request failed (" + response.status + ")"));
    process.exit(1);
  }
  return data;
}

function scopeOrExit(options) {
  try { return scopeFields(options); } catch (error) { console.error("floq: " + error.message); process.exit(2); }
}
function providerOrExit(value, allowBoth) {
  try { return checkProvider(value, allowBoth); } catch (error) { console.error("floq: " + error.message); process.exit(2); }
}

async function readSecretValue(name) {
  if (process.stdin.isTTY) {
    // Hidden prompt: nothing is echoed and nothing is kept in shell history.
    process.stderr.write("Value for " + name + " (input hidden, press Enter to finish): ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    await new Promise((resolve) => {
      const onData = (chunk) => {
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

const usage = () => {
  console.error('usage: floq --help');
  process.exit(2);
};

const allowedOptions = {
  list: [], models: ["provider"], ask: ["timeout"], check: ["chars"],
  recruit: ["provider", "model", "cwd", "role", "isolated"], connect: [], dismiss: [], note: [],
  skills: ["provider", "project", "global", "description", "from", "instructions", "dry-run"],
  mcp: ["provider", "project", "global", "json", "name", "dry-run", "url", "allow-plaintext"],
  secrets: ["description", "value", "expose"],
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
    const { agents } = await call("agents/list");
    for (const a of agents) console.log(formatAgentListEntry(a));
    break;
  }
  case "models": {
    const providers = named.provider ? [named.provider] : ["claude", "codex"];
    if (providers.some((provider) => provider !== "claude" && provider !== "codex")) usage();
    const { models } = await call("agents/models", { provider: named.provider });
    for (const provider of providers) for (const model of models[provider]) console.log(formatModel(provider, model));
    break;
  }
  case "ask": {
    if (positional.length < 2) usage();
    const r = await call("agents/ask", { name: positional[0], prompt: positional.slice(1).join(" "), timeoutSec: named.timeout ? Number(named.timeout) : undefined });
    if (r.status !== "quiet") console.error("floq: reply " + (r.status === "timeout" ? "timed out; output so far:" : "ended early:"));
    console.log(r.output || "(no output)");
    break;
  }
  case "check": {
    if (positional.length < 1) usage();
    const r = await call("agents/check", { name: positional[0], chars: named.chars ? Number(named.chars) : undefined });
    console.log(r.output || "(no output)");
    break;
  }
  case "note": {
    const [sub, name, ...text] = positional;
    if (sub === "list") {
      const { notes } = await call("notes/list");
      for (const n of notes) console.log(n.name);
    } else if (sub === "read" && name) {
      console.log((await call("notes/read", { name })).content);
    } else if ((sub === "write" || sub === "append") && name) {
      await call("notes/write", { name, content: text.join(" "), append: sub === "append" });
    } else usage();
    break;
  }
  case "recruit": {
    if (positional.length < 1) usage();
    const r = await call("agents/recruit", buildRecruitPayload(positional, named));
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
      const r = await call("skills/list", scope);
      console.log("skills in " + scopeLabel(r));
      for (const skill of r.skills) console.log(formatSkill(skill));
    } else if (sub === "search" && args.length) {
      const { skills } = await call("skills/search", { query: args.join(" ") });
      if (!skills.length) console.log("no results");
      for (const item of skills) console.log(item.source + "\t" + item.skillId + "\t" + item.installs + " installs");
    } else if ((sub === "preview" || sub === "add") && (args.length === 2 || (args.length === 1 && /^https:\/\//.test(args[0])))) {
      const ref = args.length === 2 ? { source: args[0], skillId: args[1] } : { url: args[0] };
      if (sub === "preview") {
        const r = await call("skills/preview", ref);
        console.log(r.skill.source + " / " + r.skill.skillId + "\nfiles: " + r.files.map((file) => file.path + " (" + file.size + " bytes)").join(", ") + "\n\n" + r.markdown);
      } else {
        const provider = providerOrExit(named.provider, false);
        const r = await call("skills/add", { ...ref, provider, scope: scope.scope, projectId: scope.projectId });
        console.log("installed skill \"" + r.skill.name + "\" for " + r.skill.provider + (r.scope === "project" ? " in project " + r.projectId : " in your home") + " (" + r.skill.location + ")");
        console.log("files: " + r.files.map((file) => file.path).join(", "));
        console.log("It loads when a session starts or resumes; running sessions need a restart or resume.");
      }
    } else if (sub === "create" && (args.length === 1 || (args.length === 2 && args[1] === "-"))) {
      // The content comes from exactly one place: a directory, an instructions file, or stdin ("-").
      const sources = [named.from !== undefined, named.instructions !== undefined, args[1] === "-"].filter(Boolean).length;
      if (sources !== 1 || named.from === true || named.instructions === true) { console.error("floq: give exactly one of --from DIR, --instructions FILE, or - (stdin)"); process.exit(2); }
      const body = { name: args[0], description: typeof named.description === "string" ? named.description : undefined, provider: providerOrExit(named.provider, false), scope: scope.scope, projectId: scope.projectId, dryRun: named["dry-run"] === true };
      try {
        if (named.from !== undefined) body.files = readSkillDirectory(named.from);
        else body.instructions = named.instructions === "-" || args[1] === "-" ? readFileSync(0, "utf8") : readFileSync(named.instructions, "utf8");
      } catch (error) { console.error("floq: " + (error.message.startsWith("--from") ? error.message : "could not read the skill content")); process.exit(2); }
      if (body.instructions !== undefined && !body.description) { console.error("floq: --description is required when the skill is written from instructions"); process.exit(2); }
      const r = await call("skills/create", body);
      console.log((r.dryRun ? "Would create" : "Created") + " skill \"" + r.skill.name + "\" for " + r.skill.provider + (r.scope === "project" ? " in project " + r.projectId : " in your home") + " at " + r.skill.location);
      console.log("description: " + r.skill.description);
      console.log("files: " + r.files.map((file) => file.path + " (" + file.size + " bytes)").join(", "));
      console.log(r.dryRun ? "dry run: nothing was written" : "It loads when a session starts or resumes; running sessions need a restart or resume.");
    } else if (sub === "remove" && args.length === 1) {
      const r = await call("skills/remove", { name: args[0], provider: providerOrExit(named.provider, false) });
      console.log("removed " + args[0] + " (" + r.matched + " match" + (r.matched === 1 ? "" : "es") + ")");
    } else usage();
    break;
  }
  case "mcp": {
    const [sub, ...args] = positional;
    const scope = scopeOrExit(named);
    if (sub === "list") {
      const r = await call("mcp/list", { ...scope, provider: providerOrExit(named.provider, false) });
      console.log("MCP servers, scope: " + scopeLabel(r));
      for (const server of r.servers) console.log(formatMcpServer(server));
      if (r.malformedConfigs) console.log(r.malformedConfigs + " config file(s) could not be read");
    } else if (sub === "add") {
      const providers = providerOrExit(named.provider, true);
      let body;
      if (named.json !== undefined) {
        if (named.json === true || args.length || dashed) usage();
        let text;
        try { text = named.json === "-" ? readFileSync(0, "utf8") : readFileSync(named.json, "utf8"); }
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
      const r = await call("mcp/add", { ...body, ...scope, providers, dryRun: named["dry-run"] === true, allowPlaintext: named["allow-plaintext"] === true });
      console.log(formatMcpReview(r.installed, r));
      if (r.dryRun) console.log("dry run: nothing was changed");
      else {
        console.log("installed for: " + r.servers.map((server) => server.provider).join(", "));
        console.log("It loads when a session starts or resumes; running sessions need a restart or resume.");
      }
    } else if (sub === "remove" && args.length === 1) {
      const r = await call("mcp/remove", { ...scope, provider: providerOrExit(named.provider, false), name: args[0] });
      console.log("removed MCP server \"" + args[0] + "\" (" + scopeLabel(r) + ")");
      console.log("Running sessions keep it until they restart or resume.");
    } else usage();
    break;
  }
  case "secrets": {
    const [sub] = positional;
    if (sub === "list") {
      const { secrets } = await call("vault/secrets");
      if (!secrets.length) console.log("no secrets");
      for (const secret of secrets) console.log(secret.name + (secret.description ? "\t" + secret.description : ""));
    } else if (sub === "add") {
      let request;
      try { request = parseSecretsAdd(positional.slice(1), named); } catch (error) { console.error("floq: " + error.message); process.exit(2); }
      const value = await readSecretValue(request.name);
      await call("secrets/add", { name: request.name, value, description: request.description });
      console.log("created secret " + request.name + " (tool-only: use it with floq-vault run; agents cannot read, change or delete it)");
    } else usage();
    break;
  }
  default:
    usage();
}
