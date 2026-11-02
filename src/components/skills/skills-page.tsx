import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { IconCode, IconPlus, IconRefresh, IconSearch, IconSparkles, IconTrash, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/agents/provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SkillReader, type SkillReaderSource } from "@/components/skills/skill-reader";
import { AddMcpDialog } from "@/components/skills/add-mcp-dialog";
import { ProjectMark } from "@/components/projects/project-identity";
import { errorMessage, useClient, useRuntime } from "@/lib/runtime/store";
import type { RuntimeMcpServer, RuntimeSkill, RuntimeSkillCatalogItem, RuntimeSkillCatalogPreview } from "@/lib/runtime/types";

type LoadState = "loading" | "ready" | "error";
type Provider = "all" | "claude" | "codex";
const providerLabel: Record<Exclude<Provider, "all">, string> = { claude: "Claude", codex: "Codex" };
const MAX_INSTRUCTIONS_BYTES = 28 * 1024;

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="flex min-h-52 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-5 text-center">
    <IconSparkles className="size-5 text-muted-foreground" aria-hidden="true" />
    <p className="text-sm font-medium">{title}</p>
    <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{detail}</p>
    {action}
  </div>;
}

// Icon-only provider marker; the name stays available as accessible text and a tooltip.
function ProviderMark({ provider }: { provider: string }) {
  const label = provider === "claude" || provider === "codex" ? PROVIDER_LABEL[provider] : null;
  if (!label) return provider ? <span className="text-[10px] text-muted-foreground">{provider}</span> : null;
  return <Tooltip><TooltipTrigger asChild><span role="img" aria-label={label} className="inline-flex shrink-0 items-center"><ProviderIcon provider={provider as "claude" | "codex"} className="size-3.5" /></span></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

// Floq's own skills are always installed; the runtime refuses to delete them too (PROTECTED_SKILLS in runtime/src/skills.ts).
const PROTECTED_SKILLS = ["floq-orchestrate", "floq-vault"];
const canDeleteSkill = (skill: RuntimeSkill) => skill.scope === "global" && !PROTECTED_SKILLS.includes(skill.location.split("/").pop() ?? "");
// "Home" is not useful to the owner; Bundled and Project still tell rows apart.
const sourceBadge = (source: string) => source === "home" ? null : <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{source}</span>;

function SkillRows({ skills, onOpen, onDelete }: { skills: RuntimeSkill[]; onOpen: (skill: RuntimeSkill) => void; onDelete: (skill: RuntimeSkill) => void }) {
  return <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
    {skills.map((skill) => <article key={`${skill.provider}:${skill.name}`} className="flex items-center gap-3 bg-card/30 px-4 py-3">
      <ProviderMark provider={skill.provider} />
      <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{skill.name}</h3><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description || "No description provided."}</p></div>
      <div className="flex shrink-0 flex-col items-end gap-1">{sourceBadge(skill.source)}<div className="flex items-center gap-1">
        <Button type="button" variant="outline" size="xs" aria-label={`Open ${skill.name} in reader`} onClick={() => onOpen(skill)}><IconCode />Open</Button>
        {canDeleteSkill(skill) && <Button type="button" variant="outline" size="xs" aria-label={`Delete ${skill.name}`} onClick={() => onDelete(skill)}><IconTrash /></Button>}
      </div></div>
    </article>)}
  </div>;
}

const canRemoveMcp = (server: RuntimeMcpServer) => server.source !== "bundled" && !server.protected;

function McpRows({ servers, onRemove }: { servers: RuntimeMcpServer[]; onRemove: (server: RuntimeMcpServer) => void }) {
  return <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
    {servers.map((server) => <article key={`${server.provider}:${server.name}`} className="flex items-center gap-3 bg-card/30 px-4 py-3">
      <ProviderMark provider={server.provider} />
      <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{server.name}</h3><p className="mt-1 text-xs text-muted-foreground">{server.transport.toUpperCase()}{server.usesSecrets && <span title={server.secretNames?.length ? `Vault secrets: ${server.secretNames.join(", ")}` : "Uses vault secrets"} className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px]">Uses secrets{server.secretNames?.length ? `: ${server.secretNames.join(", ")}` : ""}</span>}</p>
        {(server.command || server.urlHost) && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{server.command ?? server.urlHost}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{server.protected && server.source !== "bundled" ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Bundled</span> : sourceBadge(server.source)}
        {canRemoveMcp(server) && <Button type="button" variant="outline" size="xs" aria-label={`Remove ${server.name} (${providerLabel[server.provider]})`} onClick={() => onRemove(server)}><IconTrash /></Button>}</div>
    </article>)}
  </div>;
}

export default function SkillsPage() {
  const client = useClient();
  const { projects, activeProjectId } = useRuntime();
  const [scopeKey, setScopeKey] = useState(() => activeProjectId ?? "global");
  const [provider, setProvider] = useState<Provider>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("skills");
  const [skills, setSkills] = useState<RuntimeSkill[]>([]);
  const [servers, setServers] = useState<RuntimeMcpServer[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<LoadState>("loading");
  const [mcpStatus, setMcpStatus] = useState<LoadState>("loading");
  const [homeScanned, setHomeScanned] = useState(true);
  const [mcpHomeScanned, setMcpHomeScanned] = useState(true);
  const [malformedMcpConfigs, setMalformedMcpConfigs] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addProjectId, setAddProjectId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [newProvider, setNewProvider] = useState<"claude" | "codex">("claude");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [addMode, setAddMode] = useState("catalog");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogItems, setCatalogItems] = useState<RuntimeSkillCatalogItem[]>([]);
  const [catalogState, setCatalogState] = useState<LoadState | "idle">("idle");
  const [preview, setPreview] = useState<RuntimeSkillCatalogPreview | null>(null);
  const [previewState, setPreviewState] = useState<LoadState | "idle">("idle");
  const [importUrl, setImportUrl] = useState("");
  const [reader, setReader] = useState<SkillReaderSource | null>(null);
  const [deleting, setDeleting] = useState<RuntimeSkill | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [removingMcp, setRemovingMcp] = useState<RuntimeMcpServer | null>(null);
  const [removeMcpBusy, setRemoveMcpBusy] = useState(false);
  const catalogRequest = useRef(0);

  const scope = scopeKey === "global" ? "global" : "project";
  const projectId = scope === "project" ? scopeKey : null;
  const project = projects.find((item) => item.id === projectId) ?? null;
  const addProject = projects.find((item) => item.id === addProjectId) ?? null;
  const projectAvailable = scope !== "project" || projects.some((item) => item.id === projectId);

  useEffect(() => {
    if (scope === "project" && !project) {
      setSkills([]); setServers([]); setSkillsStatus("ready"); setMcpStatus("ready");
      return;
    }
    let active = true;
    setSkillsStatus("loading"); setMcpStatus("loading");
    const selectedProvider = provider === "all" ? undefined : provider;
    void client.projectSkills(projectId, scope, selectedProvider).then((result) => {
      if (!active) return;
      setSkills(result.skills); setHomeScanned(result.homeScanned ?? true); setSkillsStatus("ready");
    }).catch(() => { if (active) setSkillsStatus("error"); });
    void client.mcpServers(scope, projectId, selectedProvider).then((result) => {
      if (!active) return;
      setServers(result.servers); setMcpHomeScanned(result.homeScanned ?? true); setMalformedMcpConfigs(result.malformedConfigs ?? 0); setMcpStatus("ready");
    }).catch(() => { if (active) setMcpStatus("error"); });
    return () => { active = false; };
  }, [client, projectAvailable, projectId, provider, refresh, scope]);

  const filteredSkills = useMemo(() => skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())), [skills, query]);
  const filteredServers = useMemo(() => servers.filter((server) => `${server.name} ${server.command ?? ""} ${server.urlHost ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())), [servers, query]);
  const instructionBytes = new TextEncoder().encode(instructions).length;

  function clearForm() {
    catalogRequest.current += 1;
    setName(""); setDescription(""); setInstructions(""); setNewProvider("claude"); setFormError("");
    setAddMode("catalog"); setCatalogQuery(""); setCatalogItems([]); setCatalogState("idle"); setPreview(null); setPreviewState("idle"); setImportUrl("");
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await client.deleteSkill(deleting.provider, deleting.location);
      toast.success(`${deleting.name} removed`);
      setSkills((current) => current.filter((item) => !(item.provider === deleting.provider && item.name === deleting.name)));
      setDeleting(null);
      setRefresh((value) => value + 1);
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setDeleteBusy(false); }
  }

  async function confirmRemoveMcp() {
    if (!removingMcp) return;
    setRemoveMcpBusy(true);
    try {
      await client.removeMcpServer({ scope, projectId, provider: removingMcp.provider, name: removingMcp.name });
      toast.success(`${removingMcp.name} removed. Running sessions keep it until they restart or resume.`);
      setServers((current) => current.filter((item) => !(item.provider === removingMcp.provider && item.name === removingMcp.name)));
      setRemovingMcp(null);
      setRefresh((value) => value + 1);
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setRemoveMcpBusy(false); }
  }

  function openInstalledSkill(skill: RuntimeSkill) {
    const target = { scope: skill.scope, projectId, provider: skill.provider, source: skill.source, location: skill.location };
    setReader({
      title: skill.name,
      subtitle: `${providerLabel[skill.provider]} · ${skill.location}`,
      loadFiles: async () => (await client.skillFiles(target)).files,
      loadFile: async (path) => (await client.skillFile(target, path)).content,
    });
  }

  // The catalog preview only carries SKILL.md, so the reader shows that single file.
  function openPreview(item: RuntimeSkillCatalogPreview) {
    const size = item.files.find((file) => file.path.toLowerCase() === "skill.md")?.size ?? new TextEncoder().encode(item.markdown).length;
    setReader({ title: item.skill.name, subtitle: item.skill.source, loadFiles: async () => [{ path: "SKILL.md", size }], loadFile: async () => item.markdown });
  }

  async function searchCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = catalogQuery.trim();
    if (clean.length < 2) return setFormError("Enter at least 2 characters to search the catalog.");
    const requestId = ++catalogRequest.current;
    setCatalogState("loading"); setPreview(null); setPreviewState("idle"); setFormError("");
    try { const result = await client.searchSkillCatalog(clean, 20); if (requestId !== catalogRequest.current) return; setCatalogItems(result.skills); setCatalogState("ready"); }
    catch (error) { if (requestId !== catalogRequest.current) return; setFormError(errorMessage(error)); setCatalogState("error"); }
  }

  async function previewCatalogItem(item: RuntimeSkillCatalogItem) {
    const requestId = ++catalogRequest.current;
    setPreviewState("loading"); setPreview(null); setFormError("");
    try { const result = await client.previewCatalogSkill({ source: item.source, skillId: item.skillId }); if (requestId !== catalogRequest.current) return; setPreview(result); setPreviewState("ready"); }
    catch (error) { if (requestId !== catalogRequest.current) return; setFormError(errorMessage(error)); setPreviewState("error"); }
  }

  async function previewImportUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = importUrl.trim();
    if (!value) return setFormError("Paste a supported skills.sh or GitHub SKILL.md URL.");
    const requestId = ++catalogRequest.current;
    setPreviewState("loading"); setPreview(null); setFormError("");
    try { const result = await client.previewCatalogSkill({ url: value }); if (requestId !== catalogRequest.current) return; setPreview(result); setPreviewState("ready"); }
    catch (error) { if (requestId !== catalogRequest.current) return; setFormError(errorMessage(error)); setPreviewState("error"); }
  }

  async function installPreview() {
    if (!addProject || !preview) return setFormError("Choose a project and preview a skill before installing.");
    setSaving(true); setFormError("");
    try {
      const source = preview.skill;
      if (!source.source || !source.skillId) throw new Error("This preview cannot be installed from the catalog. Use a supported source URL.");
      await client.importProjectSkill(addProject.id, { provider: newProvider, source: source.source, skillId: source.skillId });
      setAddOpen(false); clearForm(); setTab("skills"); setRefresh((value) => value + 1); toast.success("Skill added to project");
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function installUrl() {
    if (!addProject || !importUrl.trim()) return setFormError("Choose a project and enter a supported URL.");
    setSaving(true); setFormError("");
    try {
      await client.importProjectSkill(addProject.id, { provider: newProvider, url: importUrl.trim() });
      setAddOpen(false); clearForm(); setTab("skills"); setRefresh((value) => value + 1); toast.success("Skill added to project");
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function createSkill() {
    if (!addProject) return setFormError("Choose a project before adding a skill.");
    const cleanName = name.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleanName) || cleanName.length > 64) return setFormError("Use a lowercase skill name with letters, numbers, and single hyphens (up to 64 characters).");
    if (!description.trim() || description.trim().length > 500) return setFormError("Add a short description of up to 500 characters.");
    if (!instructions.trim()) return setFormError("Add instructions for the agent.");
    if (instructionBytes > MAX_INSTRUCTIONS_BYTES) return setFormError("Keep instructions under 28 KiB.");
    setSaving(true); setFormError("");
    try {
      await client.createProjectSkill(addProject.id, { provider: newProvider, name: cleanName, description: description.trim(), instructions: instructions.trim() });
      setAddOpen(false); clearForm(); setTab("skills"); setRefresh((value) => value + 1); toast.success("Skill added to project");
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  const refreshButton = <Button type="button" variant="outline" size="icon" aria-label="Refresh skills and MCP servers" disabled={skillsStatus === "loading" || mcpStatus === "loading"} onClick={() => setRefresh((value) => value + 1)}><IconRefresh className={skillsStatus === "loading" || mcpStatus === "loading" ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} /></Button>;

  return <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 p-5 md:gap-6 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="text-[11px] font-medium uppercase tracking-[.16em] text-muted-foreground">Agent toolkit</p><h1 className="mt-1 text-xl font-semibold tracking-tight">Skills</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Review installed skills and MCP servers, add a skill to one project, or install an MCP server.</p></div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{refreshButton}{tab === "mcps"
        ? <Button onClick={() => setMcpAddOpen(true)}><IconPlus />Add MCP server</Button>
        : <Button disabled={projects.length === 0} title={projects.length === 0 ? "Add or import a project first" : undefined} onClick={() => { clearForm(); setAddProjectId(project?.id ?? activeProjectId ?? ""); setAddOpen(true); }}><IconPlus />Add skill</Button>}</div>
    </header>

    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/30 p-3 lg:flex-row lg:items-center">
      <Label htmlFor="skills-project-scope" className="shrink-0 text-xs text-muted-foreground">Installed in</Label>
      <Select value={scopeKey} onValueChange={setScopeKey}>
        <SelectTrigger id="skills-project-scope" className="w-full lg:w-64"><SelectValue placeholder="Choose a project">{project ? <><ProjectMark project={project} className="size-4" /><span className="truncate">{project.displayName?.trim() || project.name}</span></> : "My global skills"}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="global">My global skills</SelectItem>{projects.map((item) => <SelectItem key={item.id} value={item.id}><ProjectMark project={item} className="size-4" /><span className="truncate">{item.displayName?.trim() || item.name}</span></SelectItem>)}</SelectContent>
      </Select>
      <label className="relative min-w-0 flex-1"><IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills and servers" aria-label="Search skills and MCP servers" className="h-9 pl-9 pr-9" />{query && <Button type="button" variant="ghost" size="icon-xs" aria-label="Clear search" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery("")}><IconX /></Button>}</label>
      <Select value={provider} onValueChange={(value) => setProvider(value as Provider)}><SelectTrigger aria-label="Filter by agent" className="w-full lg:w-36"><SelectValue>{provider === "all" ? "All agents" : <><ProviderIcon provider={provider} />{providerLabel[provider]}</>}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all">All agents</SelectItem><SelectItem value="claude"><ProviderIcon provider="claude" />Claude</SelectItem><SelectItem value="codex"><ProviderIcon provider="codex" />Codex</SelectItem></SelectContent></Select>
    </div>
    {project && <p className="-mt-2 text-xs text-muted-foreground">Project skills are saved in this checkout. Commit them to include them in new worktrees.</p>}

    <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 flex-col gap-4">
      <TabsList className="w-full justify-start sm:w-fit"><TabsTrigger value="skills" className="px-4">Skills <span className="ml-1 text-xs text-muted-foreground">{skillsStatus === "loading" ? "—" : skills.length}</span></TabsTrigger><TabsTrigger value="mcps" className="px-4">MCP servers <span className="ml-1 text-xs text-muted-foreground">{mcpStatus === "loading" ? "—" : servers.length}</span></TabsTrigger></TabsList>
      <TabsContent value="skills" className="min-h-0 flex-1">
        {skillsStatus === "loading" && <div role="status" className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">Loading skills…</div>}
        {skillsStatus === "error" && <EmptyState title="Could not load skills" detail="Check the runtime connection and try again." action={<Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>Retry</Button>} />}
        {skillsStatus === "ready" && scope === "project" && !project && <EmptyState title="Choose a project" detail="Select a project above to see its skills and add project-specific instructions." />}
        {skillsStatus === "ready" && scope === "global" && !homeScanned && <p className="mb-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Personal skills are hidden while your home is locked. Start an agent, then refresh to include them.</p>}
        {skillsStatus === "ready" && project && filteredSkills.length === 0 && <EmptyState title={skills.length ? "No skills match this search" : "No project skills yet"} detail={skills.length ? "Try another search." : "Add a skill to give agents project-specific instructions."} action={skills.length ? <Button variant="link" size="sm" onClick={() => setQuery("")}>Clear search</Button> : undefined} />}
        {skillsStatus === "ready" && scope === "global" && filteredSkills.length === 0 && <EmptyState title={skills.length ? "No skills match this search" : homeScanned ? "No installed skills yet" : "Personal skills are locked"} detail={skills.length ? "Try another search." : homeScanned ? "No bundled or personal skills were found." : "No bundled skills were found. Start an agent to unlock your home and check for personal skills."} action={skills.length ? <Button variant="link" size="sm" onClick={() => setQuery("")}>Clear search</Button> : undefined} />}
        {skillsStatus === "ready" && filteredSkills.length > 0 && <SkillRows skills={filteredSkills} onOpen={openInstalledSkill} onDelete={setDeleting} />}
      </TabsContent>
      <TabsContent value="mcps" className="min-h-0 flex-1">
        {mcpStatus === "loading" && <div role="status" className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">Loading MCP servers…</div>}
        {mcpStatus === "error" && <EmptyState title="Could not load MCP servers" detail="Check the runtime connection and try again." action={<Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>Retry</Button>} />}
        {mcpStatus === "ready" && scope === "project" && !project && <EmptyState title="Choose a project" detail="Select a project above to see its installed MCP servers." />}
        {mcpStatus === "ready" && scope === "global" && !mcpHomeScanned && <p className="mb-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Personal MCP settings are hidden while your home is locked. Start an agent, then refresh to include them.</p>}
        {mcpStatus === "ready" && malformedMcpConfigs > 0 && <p role="status" className="mb-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{malformedMcpConfigs} MCP configuration {malformedMcpConfigs === 1 ? "file could not" : "files could not"} be read. Check the source settings and refresh.</p>}
        {mcpStatus === "ready" && filteredServers.length === 0 && <EmptyState title={servers.length ? "No servers match this search" : mcpHomeScanned ? "No installed MCP servers" : "Personal MCP settings are locked"} detail={servers.length ? "Try another search." : mcpHomeScanned ? "Installed MCP servers appear here with their provider and connection type. Use Add MCP server to install one." : "Start an agent to unlock your home and check for personal MCP servers."} action={servers.length ? <Button variant="link" size="sm" onClick={() => setQuery("")}>Clear search</Button> : undefined} />}
        {mcpStatus === "ready" && filteredServers.length > 0 && <McpRows servers={filteredServers} onRemove={setRemovingMcp} />}
      </TabsContent>
    </Tabs>

    <Dialog open={addOpen} onOpenChange={(open) => { if (!saving) { setAddOpen(open); if (!open) clearForm(); } }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-xl">
        <DialogHeader className="shrink-0"><DialogTitle>Add project skill</DialogTitle><DialogDescription>Choose a project and agent, then find an existing skill or write your own. Commit it to include it in new worktrees.</DialogDescription></DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2"><div className="flex flex-col gap-1.5"><Label htmlFor="project-skill-project">Project</Label><Select value={addProjectId} onValueChange={(value) => { setAddProjectId(value); setFormError(""); }}><SelectTrigger id="project-skill-project" className="w-full"><SelectValue placeholder="Choose a project">{addProject ? <><ProjectMark project={addProject} className="size-4" /><span className="truncate">{addProject.displayName?.trim() || addProject.name}</span></> : "Choose a project"}</SelectValue></SelectTrigger><SelectContent>{projects.map((item) => <SelectItem key={item.id} value={item.id}><ProjectMark project={item} className="size-4" /><span className="truncate">{item.displayName?.trim() || item.name}</span></SelectItem>)}</SelectContent></Select></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="project-skill-provider">Agent</Label><Select value={newProvider} onValueChange={(value) => setNewProvider(value as "claude" | "codex")}><SelectTrigger id="project-skill-provider" className="w-full"><SelectValue><ProviderIcon provider={newProvider} />{providerLabel[newProvider]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="claude"><ProviderIcon provider="claude" />Claude</SelectItem><SelectItem value="codex"><ProviderIcon provider="codex" />Codex</SelectItem></SelectContent></Select></div></div>
          <Tabs value={addMode} onValueChange={(value) => { catalogRequest.current += 1; setPreview(null); setPreviewState("idle"); setAddMode(value); setFormError(""); }} className="flex min-h-0 flex-col gap-3">
            <TabsList className="grid h-auto w-full grid-cols-3"><TabsTrigger value="catalog" className="px-2 text-xs sm:text-sm">Search catalog</TabsTrigger><TabsTrigger value="url" className="px-2 text-xs sm:text-sm">Import URL</TabsTrigger><TabsTrigger value="write" className="px-2 text-xs sm:text-sm">Write skill</TabsTrigger></TabsList>
            <TabsContent value="catalog" className="mt-0 flex flex-col gap-3">
              <form noValidate onSubmit={(event) => void searchCatalog(event)} className="flex gap-2"><Input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Search skills, e.g. react" aria-label="Search skills catalog" minLength={2} maxLength={100} /><Button type="submit" variant="outline" disabled={catalogState === "loading"}><IconSearch />Search</Button></form>
              {catalogState === "loading" && <p role="status" className="py-3 text-center text-xs text-muted-foreground">Searching catalog…</p>}
              {catalogState === "error" && !preview && <p className="text-xs text-muted-foreground">Search failed. Check the runtime connection and try again.</p>}
              {catalogState === "ready" && catalogItems.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">No skills found. Try another search or import a supported URL.</p>}
              {catalogItems.length > 0 && !preview && <div className="max-h-52 divide-y divide-border overflow-y-auto rounded-lg border border-border">{catalogItems.map((item) => <button key={item.id} type="button" onClick={() => void previewCatalogItem(item)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block truncate text-[11px] text-muted-foreground">{item.source} · {item.installs.toLocaleString()} installs</span></span><span className="shrink-0 text-xs text-primary">Preview</span></button>)}</div>}
            </TabsContent>
            <TabsContent value="url" className="mt-0 flex flex-col gap-3"><form noValidate onSubmit={(event) => void previewImportUrl(event)} className="flex flex-col gap-2"><Label htmlFor="project-skill-url">Skills.sh or GitHub SKILL.md URL</Label><div className="flex gap-2"><Input id="project-skill-url" value={importUrl} onChange={(event) => { catalogRequest.current += 1; setImportUrl(event.target.value); setPreview(null); setPreviewState("idle"); }} placeholder="https://github.com/.../SKILL.md" /><Button type="submit" variant="outline" disabled={previewState === "loading"}>Preview</Button></div><p className="text-[11px] text-muted-foreground">Only supported HTTPS skill pages and SKILL.md files can be imported.</p></form></TabsContent>
            <TabsContent value="write" className="mt-0 flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2"><div className="flex flex-col gap-1.5"><Label htmlFor="project-skill-name">Skill name</Label><Input id="project-skill-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="review-prs" aria-describedby="project-skill-name-help" /><p id="project-skill-name-help" className="text-[11px] text-muted-foreground">Lowercase letters, numbers, and hyphens.</p></div><div className="flex flex-col gap-1.5"><Label htmlFor="project-skill-description">Description</Label><Input id="project-skill-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="When should the agent use this skill?" /></div></div>
              <div className="flex flex-col gap-1.5"><div className="flex items-center justify-between gap-3"><Label htmlFor="project-skill-instructions">Instructions</Label><span className="text-[11px] tabular-nums text-muted-foreground">{(instructionBytes / 1024).toFixed(1)} / 28 KiB</span></div><Textarea id="project-skill-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} className="min-h-40 resize-none" placeholder="Describe the steps, checks, and expected result for the agent." /></div>
            </TabsContent>
          </Tabs>
          {previewState === "loading" && <p role="status" className="py-2 text-center text-xs text-muted-foreground">Loading safe preview…</p>}
          {preview && <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{preview.skill.name}</p><p className="truncate text-xs text-muted-foreground">{preview.skill.source}</p></div><div className="flex shrink-0 items-center gap-1"><Button type="button" variant="outline" size="xs" aria-label="Open skill in reader" onClick={() => openPreview(preview)}><IconCode />Open</Button><Button type="button" variant="ghost" size="icon-xs" aria-label="Close skill preview" onClick={() => { setPreview(null); setPreviewState("idle"); }}><IconX /></Button></div></div><p className="text-xs text-muted-foreground">{preview.files.length} files · SKILL.md {(preview.files.find((file) => file.path.toLowerCase() === "skill.md")?.size ?? new TextEncoder().encode(preview.markdown).length).toLocaleString()} bytes</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed">{preview.markdown}</pre></div>}
          {formError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{formError}</p>}
        </div>
        <DialogFooter className="shrink-0"><Button variant="outline" disabled={saving} onClick={() => setAddOpen(false)}>Cancel</Button>{addMode === "write" ? <Button type="button" disabled={saving || !addProject} onClick={() => void createSkill()}>{saving ? "Adding…" : "Add skill"}</Button> : <Button type="button" disabled={saving || !addProject || !preview} onClick={() => addMode === "url" ? void installUrl() : void installPreview()}>{saving ? "Installing…" : "Install skill"}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {deleting?.name}?</DialogTitle>
          <DialogDescription>This removes the {deleting ? providerLabel[deleting.provider] : ""} skill {deleting?.name} for your account only. It will not come back when you start new sessions. Other users are not affected.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void confirmDelete()}>{deleteBusy ? "Deleting..." : "Delete skill"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AddMcpDialog open={mcpAddOpen} onOpenChange={setMcpAddOpen} initialScopeKey={scopeKey} onInstalled={() => { setTab("mcps"); setRefresh((value) => value + 1); }} />
    <Dialog open={removingMcp !== null} onOpenChange={(open) => { if (!open && !removeMcpBusy) setRemovingMcp(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {removingMcp?.name}?</DialogTitle>
          <DialogDescription>This removes only the {removingMcp?.name} entry from the {removingMcp ? providerLabel[removingMcp.provider] : ""} {removingMcp?.scope === "project" ? "config in this project" : "config in your home"}. Your other servers and settings stay as they are. Running sessions keep the server until they restart or resume.{removingMcp?.usesSecrets && <> The vault secrets it used{removingMcp.secretNames?.length ? ` (${removingMcp.secretNames.join(", ")})` : ""} are not deleted; remove them on the Secrets page if you no longer need them.</>}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={removeMcpBusy} onClick={() => setRemovingMcp(null)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={removeMcpBusy} onClick={() => void confirmRemoveMcp()}>{removeMcpBusy ? "Removing..." : "Remove server"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <SkillReader source={reader} onClose={() => setReader(null)} />
  </div>;
}
