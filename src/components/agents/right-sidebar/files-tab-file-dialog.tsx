import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCheck, IconChevronRight, IconCopy, IconDownload, IconFiles, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { FloqSurface } from "@/components/ui/floq-surface";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { downloadWorkspacePath } from "@/lib/file-download";
import { cn } from "cn";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { FileContent } from "@/lib/runtime/workspace-files";
import { errorMessage } from "@/lib/runtime/store";
import { useHighlighter } from "@/hooks/use-highlighter";
import { languageForPath } from "@/lib/runtime/language";
import { DocumentPreview, docKindForPath } from "./files-tab-preview";
import { IMAGE_EXT, isTextDocument } from "@/lib/file-kinds";
import { toast } from "sonner";
import { isTauri } from "@tauri-apps/api/core";
import { PanelEmpty, PanelError, RowSkeletons } from "./panel-states";

const MAX_PREVIEW_LINES = 5000;
const MAX_HIGHLIGHT_BYTES = 300 * 1024;
const MAX_HIGHLIGHT_LINE = 2000;

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Hand the signed link to the system browser / default handler (a plain browser opens a new tab). */
async function openExternally(getUrl: () => Promise<string>): Promise<void> {
  try {
    const url = await getUrl();
    if (isTauri()) { const { openUrl } = await import("@tauri-apps/plugin-opener"); await openUrl(url); }
    else window.open(url, "_blank", "noopener");
  } catch { /* the link could not be issued; Download surfaces the error */ }
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <ol aria-label="File path" className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-xs text-muted-foreground" title={path}>
      {parts.map((part, index) => {
        const last = index === parts.length - 1;
        return (
          <li key={index} className={cn("flex items-center", last ? "min-w-0 shrink-0 text-foreground" : "min-w-0 shrink")}>
            {index > 0 && <IconChevronRight aria-hidden className="mx-0.5 size-3 shrink-0 opacity-60" />}
            <span className={cn("truncate", last && "font-medium")}>{part}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Modal read-only viewer for a file picked in the Files tab (text with highlighting, or an image). */
export default function FileDialog({ client, sessionId, path, label, source = "workspace", onClose }: { client: RuntimeClient; sessionId: string; path: string; label?: string; source?: "workspace" | "artifacts"; onClose: () => void }) {
  const isImage = IMAGE_EXT.test(path);
  const [file, setFile] = useState<FileContent | null>(null);
  const docKind = docKindForPath(path);
  const linkUrl = useCallback(() => (source === "artifacts" ? client.artifactDownloadUrl(sessionId, path) : client.fileDownloadUrl(sessionId, path)), [client, sessionId, path, source]);
  const getDocUrl = linkUrl;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setImageUrl(null);
    setError(null);
    // Images load through the signed download link (an <img> cannot carry auth headers); everything else is read as text.
    if (docKind) return; // documents load themselves in DocumentPreview
    let objectUrl: string | null = null;
    // The runtime never serves SVG as image/svg+xml (it is active content), so an <img> refuses the link. Fetch the bytes and show them
    // as an SVG blob: inside <img> an SVG cannot run scripts or load anything.
    const request = isImage && /\.svg$/i.test(path)
      ? linkUrl().then((url) => fetch(url)).then(async (response) => {
          if (!response.ok) throw new Error(`The image could not be loaded (${response.status}).`);
          const blob = new Blob([await response.arrayBuffer()], { type: "image/svg+xml" });
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
        })
      : isImage
      ? linkUrl().then((url) => { if (!cancelled) setImageUrl(url); })
      : (source === "artifacts" ? client.readArtifact(sessionId, path) : client.readFile(sessionId, path)).then((result) => { if (!cancelled) setFile(result); });
    request.catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, sessionId, path, version, isImage, docKind, linkUrl, source]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const lines = useMemo(() => (file && !file.binary && !file.tooLarge ? file.content.replace(/\n$/, "").split("\n") : null), [file]);
  const shown = lines && lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

  const highlightable = !!shown && !!file && file.size <= MAX_HIGHLIGHT_BYTES && shown.every((line) => line.length <= MAX_HIGHLIGHT_LINE);
  const highlighter = useHighlighter(languageForPath(path), highlightable);
  const colored = useMemo(() => {
    if (!highlighter || !shown) return null;
    try { return highlighter.highlight(shown.join("\n")).lines; } catch { return null; }
  }, [highlighter, shown]);

  // Text files copy their contents; binaries (images, pdf, office, media) copy the path.
  const plainText = !!file && !file.binary && !file.tooLarge;
  const copiesContent = plainText || isTextDocument(path);
  const [copyLabel, setCopyLabel] = useState<"contents" | "path">("contents");
  async function copyItem() {
    let text = path;
    let what: "contents" | "path" = "path";
    if (plainText && file) { text = file.content; what = "contents"; }
    else if (isTextDocument(path)) {
      try {
        const read = await (source === "artifacts" ? client.readArtifact(sessionId, path) : client.readFile(sessionId, path));
        if (!read.binary && !read.tooLarge) { text = read.content; what = "contents"; }
        else toast.info("Too large to copy as text: copied the path instead");
      } catch (cause) { toast.error(errorMessage(cause)); return; }
    }
    try { await navigator.clipboard.writeText(text); setCopyLabel(what); setCopied(true); } catch { toast.error("Could not copy to the clipboard"); }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(860px,90vh)] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
      >
        <FloqSurface className="flex h-12 shrink-0 items-center gap-1 rounded-t-[inherit] rounded-b-none border-b border-border/70 px-3">
          <DialogTitle asChild><div className="flex min-w-0 flex-1"><Breadcrumb path={label ? `${label}/${path}` : path} /></div></DialogTitle>
          <DialogDescription className="sr-only">Read-only contents of {path}</DialogDescription>
          {file && !error && <span className="shrink-0 pr-1 text-[11px] text-muted-foreground tabular-nums">{formatSize(file.size)}</span>}
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Download file" title="Download file" onClick={() => void downloadWorkspacePath(client, sessionId, path, "file", path.split("/").pop() ?? path, source)}><IconDownload size={16} /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={copied ? (copyLabel === "contents" ? "Contents copied" : "Path copied") : copiesContent ? "Copy contents" : "Copy path"} title={copiesContent ? "Copy contents" : "Copy path"} onClick={() => void copyItem()}>{copied ? <IconCheck size={16} className="text-emerald-600 dark:text-emerald-400" /> : <IconCopy size={16} />}</Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)" onClick={onClose}><IconX size={16} /></Button>
        </FloqSurface>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
          {docKind ? <DocumentPreview kind={docKind} path={path} getUrl={getDocUrl} onDownload={() => void downloadWorkspacePath(client, sessionId, path, "file", path.split("/").pop() ?? path, source)} onOpenExternally={() => void openExternally(getDocUrl)} />
            : error ? <PanelError message={error} onRetry={() => setVersion((value) => value + 1)} />
            : isImage ? (imageUrl
              ? <div className="flex min-h-full items-center justify-center p-4"><img src={imageUrl} alt={path} className="max-h-full max-w-full object-contain" onError={() => setError("The image could not be loaded.")} /></div>
              : <RowSkeletons count={10} rowClass="h-3.5" />)
            : !file ? <RowSkeletons count={10} rowClass="h-3.5" />
            : file.binary ? <PanelEmpty icon={<IconFiles />} title="Binary file" hint="Text preview is not available." />
            : file.tooLarge ? <PanelEmpty icon={<IconFiles />} title="File too large to preview" hint={`This file is ${formatSize(file.size)}.`} />
            : shown && (
              <div className="flex w-max min-w-full font-mono text-[11px] leading-[18px]">
                <pre aria-hidden className="sticky left-0 shrink-0 select-none border-r border-border bg-background px-2 text-right text-muted-foreground/70 tabular-nums">{shown.map((_, index) => index + 1).join("\n")}</pre>
                <pre aria-label={`Contents of ${file.path}`} className="min-w-0 flex-1 px-3 whitespace-pre">{colored ? colored.map((line, index) => <span key={index}>{line}{"\n"}</span>) : (shown.join("\n") || " ")}{lines && lines.length > shown.length ? `\n\n… ${(lines.length - shown.length).toLocaleString()} more lines not shown` : ""}</pre>
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
