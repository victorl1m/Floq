import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconChevronRight, IconFile, IconFolder, IconTextWrap } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton, CodeBlockLine } from "@/components/ui/code-block";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { highlightCode } from "@/lib/highlighter";

export interface SkillReaderFile { path: string; size: number }
/** Everything the reader needs; closures keep it independent of where the files come from. */
export interface SkillReaderSource {
  title: string;
  subtitle?: string;
  loadFiles: () => Promise<SkillReaderFile[]>;
  loadFile: (path: string) => Promise<string>;
}

const MAX_FILE_BYTES = 256 * 1024; // Same limit as the runtime.
const MAX_HIGHLIGHT_BYTES = 64 * 1024; // Larger files render as plain text so the dialog stays responsive.
// Values are highlighter languages (src/lib/highlighter.tsx). Anything not listed shows as plain text.
const languageByExtension: Record<string, string> = {
  md: "markdown", markdown: "markdown", mdx: "mdx", json: "json", jsonc: "jsonc", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", xml: "xml", svg: "xml",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", lua: "lua", sql: "sql",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "bat", cmd: "bat", css: "css", scss: "scss", html: "html", htm: "html",
  dockerfile: "docker", diff: "diff", patch: "diff",
};
const languageByName: Record<string, string> = { dockerfile: "docker", makefile: "make", gnumakefile: "make", ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash" };
const languageLabels: Record<string, string> = {
  bash: "Shell", bat: "Batch", csharp: "C#", cpp: "C++", docker: "Dockerfile", make: "Makefile", powershell: "PowerShell", javascript: "JavaScript", typescript: "TypeScript",
  css: "CSS", scss: "SCSS", html: "HTML", json: "JSON", jsonc: "JSON", xml: "XML", yaml: "YAML", toml: "TOML", ini: "INI", sql: "SQL", php: "PHP", mdx: "MDX", jsx: "JSX", tsx: "TSX", text: "Plain text",
};

type FileState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string };

function languageFor(path: string): string {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (languageByName[name]) return languageByName[name];
  if (name.startsWith("dockerfile.")) return "docker";
  return languageByExtension[name.includes(".") ? name.split(".").pop()! : ""] ?? "text";
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function errorFor(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "file_too_large") return `This file is over the ${MAX_FILE_BYTES / 1024} KB preview limit.`;
  if (code === "binary_file") return "This looks like a binary file, so it cannot be previewed.";
  return error instanceof Error ? error.message : "Could not load this file.";
}

interface TreeNode { name: string; path: string; dir: boolean; children: TreeNode[]; file?: SkillReaderFile }

function buildTree(files: SkillReaderFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const file of files) {
    let node = root;
    const parts = file.path.split("/");
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let next = node.children.find((child) => child.path === path);
      if (!next) { next = { name: part, path, dir: index < parts.length - 1, children: [] }; node.children.push(next); }
      node = next;
    });
    node.file = file;
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

function Explorer({ tree, selected, onSelect }: { tree: TreeNode[]; selected: string; onSelect: (path: string) => void }) {
  const rows = (nodes: TreeNode[], depth: number): ReactNode => nodes.map((node) => node.dir
    ? <div key={node.path}>
      <div className="flex h-7 items-center gap-1.5 pr-2 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}><IconChevronRight className="size-3 rotate-90" aria-hidden="true" /><IconFolder className="size-3.5" aria-hidden="true" /><span className="truncate">{node.name}</span></div>
      {rows(node.children, depth + 1)}
    </div>
    : <button key={node.path} type="button" title={node.path} aria-current={node.path === selected ? "true" : undefined} onClick={() => onSelect(node.path)}
      className={`flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${node.path === selected ? "bg-muted text-foreground" : "text-muted-foreground"}`}
      style={{ paddingLeft: 8 + depth * 12 + 16 }}><IconFile className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{node.name}</span></button>);
  return <nav aria-label="Skill files" className="min-h-0 overflow-y-auto py-1">{rows(tree, 0)}</nav>;
}

function Editor({ path, size, text, wrap }: { path: string; size: number; text: string; wrap: boolean }) {
  const lines = useMemo(() => { const all = text.split("\n"); if (all.length > 1 && all[all.length - 1] === "") all.pop(); return all; }, [text]);
  const language = languageFor(path);
  const canHighlight = language !== "text" && text.length <= MAX_HIGHLIGHT_BYTES;
  const [highlighted, setHighlighted] = useState<{ text: string; lines: ReactNode[][] } | null>(null);
  useEffect(() => {
    if (!canHighlight) return;
    let active = true;
    // Defer so the plain text paints first; shiki returns React nodes, never HTML strings.
    const timer = window.setTimeout(() => {
      void highlightCode(text, language).then((result) => { if (active && result) setHighlighted({ text, lines: result as ReactNode[][] }); }).catch(() => undefined);
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [canHighlight, language, text]);
  const colored = canHighlight && highlighted?.text === text ? highlighted.lines : null;
  return <>
    <CodeBlock className="min-h-0 flex-1 rounded-none border-0 text-[13px]">
      <CodeBlockContent lineNumbers wrap={wrap} aria-label={`Contents of ${path}`} className="h-full py-2">
        {lines.map((line, index) => <CodeBlockLine key={index}>{colored?.[index] ?? line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-3 text-[11px] text-muted-foreground">
      <span>Read-only</span><span>{lines.length.toLocaleString()} lines</span><span>{formatSize(size)}</span><span>{languageLabels[language] ?? language.charAt(0).toUpperCase() + language.slice(1)}</span>
      {!canHighlight && language !== "text" && <span>Syntax highlighting skipped for large file</span>}
    </div>
  </>;
}

export function SkillReader({ source, onClose }: { source: SkillReaderSource | null; onClose: () => void }) {
  return <Dialog open={source !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-[900px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(72rem,calc(100vw-2rem))]">
      {source && <ReaderBody key={source.title + (source.subtitle ?? "")} source={source} />}
    </DialogContent>
  </Dialog>;
}

function ReaderBody({ source }: { source: SkillReaderSource }) {
  const [files, setFiles] = useState<SkillReaderFile[] | null>(null);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState("");
  const [contents, setContents] = useState<Record<string, FileState>>({});
  const [wrap, setWrap] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    requested.current.clear(); setFiles(null); setListError(""); setContents({});
    void source.loadFiles().then((list) => {
      if (!active) return;
      const sorted = [...list].sort((a, b) => Number(b.path.toLowerCase() === "skill.md") - Number(a.path.toLowerCase() === "skill.md") || a.path.localeCompare(b.path));
      setFiles(sorted); setSelected(sorted[0]?.path ?? "");
    }).catch((error: unknown) => { if (active) setListError(errorFor(error)); });
    return () => { active = false; };
  }, [source, attempt]);

  const current = files?.find((file) => file.path === selected);
  useEffect(() => {
    if (!current || requested.current.has(current.path)) return;
    const path = current.path;
    requested.current.add(path);
    const set = (value: FileState) => setContents((all) => ({ ...all, [path]: value }));
    if (current.size > MAX_FILE_BYTES) { set({ status: "error", message: errorFor({ code: "file_too_large" }) }); return; }
    set({ status: "loading" });
    void source.loadFile(path).then((text) => set({ status: "ready", text })).catch((error: unknown) => set({ status: "error", message: errorFor(error) }));
  }, [current, source]);

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const state = current ? contents[current.path] : undefined;
  const crumbs = selected ? [source.title, ...selected.split("/")] : [source.title];

  return <>
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-muted/40 pl-3 pr-12">
      <DialogTitle className="truncate text-sm">{source.title}</DialogTitle>
      <DialogDescription className="min-w-0 truncate text-xs">{source.subtitle ?? "Read-only skill files"}</DialogDescription>
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {files && files.length > 1 && <aside className="max-h-36 shrink-0 overflow-hidden border-b border-border bg-sidebar md:max-h-none md:w-60 md:border-b-0 md:border-r"><div className="flex h-full min-h-0 flex-col"><p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[.14em] text-muted-foreground">Explorer</p><Explorer tree={tree} selected={selected} onSelect={setSelected} /></div></aside>}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="Editor">
        {!files && !listError && <div role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading files…</div>}
        {listError && <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground"><p>{listError}</p><Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry</Button></div>}
        {files && files.length === 0 && <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">This skill has no readable files.</div>}
        {current && <>
          <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/30">
            <div className="flex min-w-0 items-center gap-1.5 border-r border-t-2 border-r-border border-t-primary bg-background px-3 text-xs"><IconFile className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{current.path.split("/").pop()}</span></div>
            <div className="ml-auto flex items-center gap-1 pr-2">
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Wrap long lines" aria-pressed={wrap} title="Wrap long lines" className={wrap ? "bg-muted" : undefined} onClick={() => setWrap((value) => !value)}><IconTextWrap /></Button>
              {state?.status === "ready" && <CodeBlockCopyButton value={state.text} />}
            </div>
          </div>
          <div className="flex h-6 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-3 text-[11px] text-muted-foreground" aria-label="File path">{crumbs.map((crumb, index) => <span key={index} className="flex min-w-0 items-center gap-1">{index > 0 && <IconChevronRight className="size-3 shrink-0" aria-hidden="true" />}<span className={index === crumbs.length - 1 ? "truncate text-foreground" : "truncate"}>{crumb}</span></span>)}</div>
          {(!state || state.status === "loading") && <div role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading {current.path}…</div>}
          {state?.status === "error" && <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-sm text-muted-foreground"><p className="font-medium text-foreground">Cannot show {current.path}</p><p>{state.message}</p><p className="text-xs">{formatSize(current.size)}</p></div>}
          {state?.status === "ready" && (state.text === "" ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This file is empty.</div> : <Editor path={current.path} size={current.size} text={state.text} wrap={wrap} />)}
        </>}
      </section>
    </div>
  </>;
}
