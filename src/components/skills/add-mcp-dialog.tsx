import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconPlus, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { ProviderIcon } from "@/components/agents/provider";
import { ProjectMark } from "@/components/projects/project-identity";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  activeRows, codexHttpSecretBlocked, conflictingNewSecrets, describeMcpForm, emptyRow, keepsSensitivePlaintext, newSecretsOf, parseMcpPaste, rowMode, secretNameOf,
  toMcpDraft, validateMcpForm, type McpFormValues, type McpRow, type ValueMode,
} from "@/lib/mcp-paste";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import type { McpProviderChoice, SecretInfo } from "@/lib/runtime/types";

const PROVIDER_TEXT: Record<McpProviderChoice, string> = { claude: "Claude Code", codex: "Codex", both: "Claude Code and Codex" };
const MODE_TEXT: Record<ValueMode, string> = { existing: "Vault secret", new: "New secret", literal: "Plain text" };

function filesFor(providers: McpProviderChoice, scopeKey: string): string[] {
  const global = scopeKey === "global";
  return [
    ...(providers !== "codex" ? [global ? "~/.claude.json" : ".mcp.json in the project"] : []),
    ...(providers !== "claude" ? [global ? "~/.codex/config.toml" : ".codex/config.toml in the project"] : []),
  ];
}

/**
 * One env var or header per row. A value is either read from an existing vault secret, saved as a new vault secret (so it shows up
 * on the Secrets page), or kept as plain text in the config. Typed values are password inputs and are never shown again.
 */
function ValueRows({ label, rows, onChange, secrets, serverName, isHeader, existingNames, idPrefix }: {
  label: string; rows: McpRow[]; onChange: (rows: McpRow[]) => void; secrets: SecretInfo[] | null; serverName: string; isHeader: boolean; existingNames: ReadonlySet<string>; idPrefix: string;
}) {
  const update = (index: number, patch: Partial<McpRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2"><Label>{label}</Label><Button type="button" variant="ghost" size="xs" onClick={() => onChange([...rows, emptyRow()])}><IconPlus />Add</Button></div>
    {rows.length === 0 && <p className="text-[11px] text-muted-foreground">None. Credentials can come from your vault, so they stay out of the config file.</p>}
    {rows.map((row, index) => {
      const mode = rowMode(row);
      const suggested = secretNameOf({ ...row, mode: "new", touched: true, secret: "" }, serverName);
      const name = secretNameOf(row, serverName);
      const taken = mode === "new" && existingNames.has(name);
      return <div key={index} className="flex flex-col gap-1.5 rounded-lg border border-border p-2" data-testid={`${idPrefix}-row-${index}`}>
        <div className="flex gap-2">
          <Input aria-label={`${label} name ${index + 1}`} id={`${idPrefix}-key-${index}`} value={row.key} onChange={(event) => update(index, { key: event.target.value, ...(isHeader && !row.touched && !row.prefix && event.target.value.toLowerCase() === "authorization" ? { prefix: "Bearer " } : {}) })} placeholder={isHeader ? "Authorization" : "API_KEY"} autoComplete="off" spellCheck={false} className="font-mono text-xs" />
          <Select value={mode} onValueChange={(value) => update(index, { mode: value as ValueMode, touched: true, value: "", secret: "" })}>
            <SelectTrigger aria-label={`${label} source ${index + 1}`} id={`${idPrefix}-mode-${index}`} className="w-40 shrink-0"><SelectValue>{MODE_TEXT[mode]}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="existing">Vault secret</SelectItem><SelectItem value="new">New secret</SelectItem><SelectItem value="literal">Plain text</SelectItem></SelectContent>
          </Select>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><IconX /></Button>
        </div>
        {mode === "existing" && <div className="flex gap-2">
          {isHeader && <Input aria-label={`Text before the secret ${index + 1}`} value={row.prefix} onChange={(event) => update(index, { prefix: event.target.value })} placeholder="Bearer " className="w-24 shrink-0 font-mono text-xs" autoComplete="off" />}
          {secrets === null ? <p className="py-1.5 text-[11px] text-muted-foreground">Loading your secrets…</p>
            : secrets.length === 0 ? <p className="py-1.5 text-[11px] text-muted-foreground">Your vault is empty. Choose New secret to save a value.</p>
            : <Select value={row.secret || undefined} onValueChange={(value) => update(index, { secret: value, touched: true })}>
              <SelectTrigger aria-label={`Vault secret for ${row.key || "row " + (index + 1)}`} id={`${idPrefix}-secret-${index}`} className="w-full"><SelectValue placeholder="Choose a secret">{row.secret}</SelectValue></SelectTrigger>
              <SelectContent>{secrets.map((secret) => <SelectItem key={secret.name} value={secret.name}><span className="font-mono text-xs">{secret.name}</span>{secret.description && <span className="ml-2 truncate text-[11px] text-muted-foreground">{secret.description}</span>}</SelectItem>)}</SelectContent>
            </Select>}
        </div>}
        {mode === "new" && <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            {isHeader && <Input aria-label={`Text before the secret ${index + 1}`} value={row.prefix} onChange={(event) => update(index, { prefix: event.target.value })} placeholder="Bearer " className="w-24 shrink-0 font-mono text-xs" autoComplete="off" />}
            <Input aria-label={`New secret name ${index + 1}`} id={`${idPrefix}-secret-name-${index}`} value={row.secret || suggested} onChange={(event) => update(index, { secret: event.target.value.toUpperCase() })} placeholder="SECRET_NAME" autoComplete="off" spellCheck={false} className="font-mono text-xs" />
            <Input aria-label={`${label} value ${index + 1}`} id={`${idPrefix}-value-${index}`} type="password" value={row.value} onChange={(event) => update(index, { value: event.target.value })} placeholder="Value" autoComplete="new-password" spellCheck={false} className="font-mono text-xs" />
          </div>
          {taken && <p role="alert" data-testid={`${idPrefix}-conflict-${index}`} className="flex flex-wrap items-center gap-2 text-[11px] text-destructive">A secret named {name} already exists, and it will not be overwritten.
            <Button type="button" variant="outline" size="xs" onClick={() => update(index, { mode: "existing", secret: name, value: "", touched: true })}>Use the existing one</Button>
            <span className="text-muted-foreground">or edit the name above.</span></p>}
          {!taken && <p className="text-[11px] text-muted-foreground">Saved to your vault as <span className="font-mono">{name}</span> (tool-only, listed on the Secrets page). The config keeps only a reference.</p>}
        </div>}
        {mode === "literal" && <div className="flex flex-col gap-1.5">
          <Input aria-label={`${label} value ${index + 1}`} id={`${idPrefix}-value-${index}`} type="password" value={row.value} onChange={(event) => update(index, { value: event.target.value })} placeholder="Value" autoComplete="new-password" spellCheck={false} className="font-mono text-xs" />
          <p className="text-[11px] text-muted-foreground">Written as plain text in the config file. Fine for settings like NODE_ENV; use a vault secret for credentials.</p>
        </div>}
      </div>;
    })}
  </div>;
}

export function AddMcpDialog({ open, onOpenChange, initialScopeKey, onInstalled }: { open: boolean; onOpenChange: (open: boolean) => void; initialScopeKey: string; onInstalled: () => void }) {
  const client = useClient();
  const { projects } = useRuntime();
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState<McpRow[]>([]);
  const [headers, setHeaders] = useState<McpRow[]>([]);
  const [providers, setProviders] = useState<McpProviderChoice>("claude");
  const [scopeKey, setScopeKey] = useState("global");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
  const [secretsError, setSecretsError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPaste(""); setPasteNote(""); setName(""); setType("stdio"); setCommand(""); setArgsText(""); setUrl(""); setEnv([]); setHeaders([]);
    setProviders("claude"); setScopeKey(initialScopeKey); setStep("edit"); setError(""); setSaving(false); setSecrets(null); setSecretsError("");
    let active = true;
    client.secrets().then((list) => { if (active) setSecrets(list); }).catch((failure) => { if (active) { setSecrets([]); setSecretsError(errorMessage(failure)); } });
    return () => { active = false; };
  }, [open, initialScopeKey, client]);

  const project = projects.find((item) => item.id === scopeKey) ?? null;
  const form: McpFormValues = { name: name.trim(), type, command: command.trim(), args: argsText.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean), url: url.trim(), env, headers };
  const existingNames = useMemo(() => new Set((secrets ?? []).map((secret) => secret.name)), [secrets]);
  const rows = activeRows(type === "http" ? headers : env);
  const blocked = codexHttpSecretBlocked(form, providers);
  const conflicts = conflictingNewSecrets(form, existingNames);

  function applyPaste(text: string) {
    setPaste(text);
    if (!text.trim()) { setPasteNote(""); return; }
    const result = parseMcpPaste(text);
    if ("error" in result) { setPasteNote(result.error); return; }
    const { values } = result;
    setName(values.name); setType(values.type); setCommand(values.command); setArgsText(values.args.join("\n")); setUrl(values.url);
    setEnv(values.env); setHeaders(values.headers); setError("");
    // The pasted text can contain secrets in clear; once it is in the (masked) rows, drop it from the box.
    setPaste("");
    const sensitive = [...values.env, ...values.headers].filter((row) => rowMode(row) === "new").length;
    setPasteNote("Form filled from your paste, and the pasted text was cleared so values stay hidden." + (sensitive ? ` ${sensitive} credential${sensitive === 1 ? "" : "s"} will be saved as new vault secrets; change that per row if you prefer.` : "") + " Check every field, then review.");
  }

  function goReview() {
    if (scopeKey !== "global" && !project) return setError("Choose where to install it.");
    if (secretsError && rows.some((row) => rowMode(row) !== "literal")) return setError("Your vault could not be read, so secrets cannot be used right now: " + secretsError);
    if (blocked) return setError("Codex cannot read vault secrets for HTTP headers. Choose Claude Code only, or set those headers to plain text.");
    const problem = validateMcpForm(form, existingNames);
    if (problem) return setError(problem);
    if (conflicts.length) return setError(`A secret named ${conflicts[0].name} already exists. Use the existing one or rename the new one.`);
    setError(""); setStep("review");
  }

  async function install() {
    setSaving(true); setError("");
    try {
      await client.addMcpServer({
        scope: scopeKey === "global" ? "global" : "project", projectId: scopeKey === "global" ? null : scopeKey, providers, server: toMcpDraft(form),
        newSecrets: newSecretsOf(form), allowPlaintext: keepsSensitivePlaintext(form),
      });
      const created = newSecretsOf(form).length;
      toast.success(`${form.name} installed${created ? ` and ${created} secret${created === 1 ? "" : "s"} saved to your vault` : ""}. Running sessions need a restart or resume to see it.`);
      // Typed values are not needed any more: clear them before the dialog closes.
      setEnv([]); setHeaders([]); setPaste("");
      onOpenChange(false);
      onInstalled();
    } catch (failure) { setError(errorMessage(failure)); setStep("edit"); }
    finally { setSaving(false); }
  }

  const files = filesFor(providers, scopeKey);
  const keptPlain = rows.filter((row) => rowMode(row) === "literal").length;

  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-xl">
      <DialogHeader className="shrink-0"><DialogTitle>Add MCP server</DialogTitle><DialogDescription>{step === "edit" ? "Paste the config from the server's docs, or fill in the form. You review it before anything is installed." : "Check exactly what will be installed."}</DialogDescription></DialogHeader>
      {step === "edit" ? <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mcp-paste">Paste a config</Label>
          <Textarea id="mcp-paste" value={paste} onChange={(event) => applyPaste(event.target.value)} spellCheck={false} placeholder={'{"mcpServers": {"context": {"command": "npx", "args": ["-y", "some-mcp"]}}}'} className="min-h-20 resize-none font-mono text-xs" />
          {pasteNote && <p role="status" className="text-[11px] text-muted-foreground">{pasteNote}</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-name">Name</Label><Input id="mcp-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="my-server" autoComplete="off" spellCheck={false} /></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-type">Type</Label><Select value={type} onValueChange={(value) => setType(value as "stdio" | "http")}><SelectTrigger id="mcp-type" className="w-full"><SelectValue>{type === "stdio" ? "Local command (stdio)" : "Remote URL (HTTP)"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="stdio">Local command (stdio)</SelectItem><SelectItem value="http">Remote URL (HTTP)</SelectItem></SelectContent></Select></div>
        </div>
        {type === "stdio" ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-command">Command</Label><Input id="mcp-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" autoComplete="off" spellCheck={false} className="font-mono text-xs" /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-args">Arguments, one per line</Label><Textarea id="mcp-args" value={argsText} onChange={(event) => setArgsText(event.target.value)} spellCheck={false} placeholder={"-y\n@scope/some-mcp"} className="min-h-16 resize-none font-mono text-xs" /></div>
          </div>
          <ValueRows label="Environment variables" rows={env} onChange={setEnv} secrets={secrets} serverName={form.name} isHeader={false} existingNames={existingNames} idPrefix="mcp-env" />
        </> : <>
          <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-url">URL</Label><Input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" autoComplete="off" spellCheck={false} className="font-mono text-xs" /></div>
          <ValueRows label="Headers" rows={headers} onChange={setHeaders} secrets={secrets} serverName={form.name} isHeader existingNames={existingNames} idPrefix="mcp-header" />
        </>}
        {secretsError && <p role="status" className="text-[11px] text-destructive">Could not load your vault secrets: {secretsError}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-provider">Agent</Label><Select value={providers} onValueChange={(value) => setProviders(value as McpProviderChoice)}><SelectTrigger id="mcp-provider" className="w-full"><SelectValue>{providers === "both" ? "Claude Code and Codex" : <><ProviderIcon provider={providers} />{PROVIDER_TEXT[providers]}</>}</SelectValue></SelectTrigger><SelectContent><SelectItem value="claude"><ProviderIcon provider="claude" />Claude Code</SelectItem><SelectItem value="codex"><ProviderIcon provider="codex" />Codex</SelectItem><SelectItem value="both">Claude Code and Codex</SelectItem></SelectContent></Select></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor="mcp-scope">Install for</Label><Select value={scopeKey} onValueChange={setScopeKey}><SelectTrigger id="mcp-scope" className="w-full"><SelectValue>{project ? <><ProjectMark project={project} className="size-4" /><span className="truncate">{project.displayName?.trim() || project.name}</span></> : "My global config"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="global">My global config</SelectItem>{projects.map((item) => <SelectItem key={item.id} value={item.id}><ProjectMark project={item} className="size-4" /><span className="truncate">{item.displayName?.trim() || item.name}</span></SelectItem>)}</SelectContent></Select></div>
        </div>
        {blocked && <p role="alert" data-testid="mcp-codex-blocked" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">Codex cannot read vault secrets for HTTP headers: its header helper runs without Floq's session credentials, so a reference could not be resolved. Choose Claude Code only, or set these headers to Plain text.</p>}
        <p className="text-[11px] leading-relaxed text-muted-foreground">Vault secrets (existing or new) stay in your vault; the config only holds a reference and fetches the value when the server starts. Only values you keep as Plain text are written to the config file ({files.join(", ")}).{scopeKey !== "global" && " A project's config can be committed to git: references are safe to commit, plain text values are not."}</p>
        {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
      </div> : <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs">
          <dt className="text-muted-foreground">Name</dt><dd className="font-medium">{form.name}</dd>
          <dt className="text-muted-foreground">{type === "stdio" ? "Will run" : "Connects to"}</dt><dd><pre data-testid="mcp-review-command" className="whitespace-pre-wrap break-all font-mono text-[11px]">{describeMcpForm(form)}</pre></dd>
          {rows.length > 0 && <><dt className="text-muted-foreground">{type === "stdio" ? "Environment" : "Headers"}</dt><dd className="font-mono text-[11px]" data-testid="mcp-review-values">{rows.map((row) => {
            const mode = rowMode(row);
            return <div key={row.key}>{row.key} {mode === "literal" ? "= •••••••• (plain text in the config)" : `← vault secret ${secretNameOf(row, form.name)}${mode === "new" ? " (new)" : ""}`}</div>;
          })}</dd></>}
          <dt className="text-muted-foreground">Agent</dt><dd>{PROVIDER_TEXT[providers]}</dd>
          <dt className="text-muted-foreground">Where</dt><dd>{project ? `Project ${project.displayName?.trim() || project.name}` : "My global config"} ({files.join(", ")})</dd>
        </dl>
        {type === "stdio" && <div role="note" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed"><IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" /><p>A stdio MCP server runs this command on your Floq home with the agent's permissions. Only install servers you trust.</p></div>}
        {type === "http" && <div role="note" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed"><IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" /><p>The agent will send its requests to this URL, along with any headers above. Only install servers you trust.</p></div>}
        {rows.some((row) => rowMode(row) !== "literal") && <p className="text-[11px] leading-relaxed text-muted-foreground">Vault secrets keep values out of config files and git. They are still usable by any agent in your sessions through <span className="font-mono">floq-vault</span>, which can run commands with them but does not print them.</p>}
        {keptPlain > 0 && <p className="text-xs text-muted-foreground">{keptPlain} value{keptPlain === 1 ? " is" : "s are"} kept as plain text in {files.join(" and ")}.{scopeKey !== "global" && " That file can be committed to git."}</p>}
        <p className="text-[11px] text-muted-foreground">Sessions that are already running need a restart or resume to see this server.</p>
        {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
      </div>}
      <DialogFooter className="shrink-0">
        {step === "edit" ? <><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" disabled={blocked} onClick={goReview}>Review</Button></>
          : <><Button variant="outline" disabled={saving} onClick={() => setStep("edit")}>Back</Button><Button type="button" disabled={saving} onClick={() => void install()}>{saving ? "Installing…" : "Install MCP server"}</Button></>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
