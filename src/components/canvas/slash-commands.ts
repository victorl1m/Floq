// Built-in slash commands of the agent CLIs, offered as autocomplete in the per-agent message bar.
export interface SlashCommand { name: string; hint: string }

const CLAUDE: SlashCommand[] = [
  { name: "clear", hint: "Start a new conversation with empty context" },
  { name: "compact", hint: "Summarize the conversation to free up context" },
  { name: "context", hint: "Show how much context is in use" },
  { name: "cost", hint: "Show token usage and cost" },
  { name: "usage", hint: "Show plan usage limits" },
  { name: "model", hint: "Switch the model" },
  { name: "resume", hint: "Resume an earlier conversation" },
  { name: "rewind", hint: "Rewind the conversation or code to an earlier point" },
  { name: "review", hint: "Review a pull request or the current changes" },
  { name: "init", hint: "Create a CLAUDE.md for this project" },
  { name: "memory", hint: "Edit memory files" },
  { name: "mcp", hint: "Manage MCP servers" },
  { name: "agents", hint: "Manage subagents" },
  { name: "permissions", hint: "View or change tool permissions" },
  { name: "config", hint: "Open settings" },
  { name: "status", hint: "Show version, model and account status" },
  { name: "export", hint: "Export the conversation" },
  { name: "todos", hint: "List the current to-do items" },
  { name: "add-dir", hint: "Add a working directory" },
  { name: "doctor", hint: "Check the installation" },
  { name: "help", hint: "Show help and commands" },
];

const CODEX: SlashCommand[] = [
  { name: "new", hint: "Start a new conversation" },
  { name: "compact", hint: "Summarize the conversation to free up context" },
  { name: "model", hint: "Choose the model and reasoning effort" },
  { name: "approvals", hint: "Choose what Codex may do without asking" },
  { name: "review", hint: "Review the working tree" },
  { name: "diff", hint: "Show the git diff" },
  { name: "init", hint: "Create an AGENTS.md for this project" },
  { name: "mention", hint: "Mention a file" },
  { name: "status", hint: "Show session configuration and token usage" },
  { name: "undo", hint: "Undo the last turn" },
  { name: "mcp", hint: "List configured MCP tools" },
  { name: "feedback", hint: "Send logs to the maintainers" },
  { name: "logout", hint: "Sign out" },
  { name: "quit", hint: "Exit Codex" },
];

export function slashCommandsFor(provider: string): SlashCommand[] {
  return provider === "codex" ? CODEX : provider === "claude" ? CLAUDE : [];
}

/** The commands matching what is typed after "/" (only while it is still the first word). Prefix matches first. */
export function matchSlash(provider: string, text: string): SlashCommand[] {
  const m = /^\/([\w:-]*)$/.exec(text);
  if (!m) return [];
  const query = m[1].toLowerCase();
  const all = slashCommandsFor(provider);
  return [...all.filter((c) => c.name.startsWith(query)), ...all.filter((c) => !c.name.startsWith(query) && c.name.includes(query))];
}
