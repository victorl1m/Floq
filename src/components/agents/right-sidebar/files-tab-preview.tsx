import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { IconDownload, IconExternalLink, IconFileOff } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { PanelEmpty, PanelError, RowSkeletons } from "./panel-states";

export type DocKind = "docx" | "sheet" | "pdf" | "nopreview";

const KINDS: Record<string, DocKind> = {
  docx: "docx", xlsx: "sheet", xls: "sheet", csv: "sheet", pdf: "pdf",
  pptx: "nopreview", ppt: "nopreview", doc: "nopreview", odt: "nopreview", ods: "nopreview", odp: "nopreview", rtf: "nopreview", pages: "nopreview", numbers: "nopreview", key: "nopreview",
};

/** How a path is previewed when it is a document; null for text/image/other files, which the dialog handles itself. */
export function docKindForPath(path: string): DocKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? KINDS[ext] ?? null : null;
}

const MAX_DOC_BYTES = 50 * 1024 * 1024;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 100;

async function fetchBlob(url: string, type?: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The file could not be loaded (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) throw new Error("This file is too large to preview. Download it instead.");
  const blob = await response.blob();
  if (blob.size > MAX_DOC_BYTES) throw new Error("This file is too large to preview. Download it instead.");
  return type ? blob.slice(0, blob.size, type) : blob;
}

/** Word document to sanitized HTML. mammoth and DOMPurify are loaded on first use. */
async function docxToHtml(blob: Blob): Promise<string> {
  const [mammoth, purify] = await Promise.all([import("mammoth"), import("dompurify")]);
  const result = await (mammoth.default ?? mammoth).convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  const clean = purify.default(window); // own instance: the hook must not leak into other sanitize calls
  clean.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLImageElement && !/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(node.getAttribute("src") ?? "")) node.remove(); // no remote images: they would leak that the file was opened
    if (node instanceof HTMLAnchorElement) {
      if (node.hasAttribute("href") && !/^(?:https?:|mailto:)/i.test(node.getAttribute("href")!)) node.removeAttribute("href");
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("target", "_blank");
    }
  });
  return clean.sanitize(result.value, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"], FORBID_ATTR: ["style", "srcset"], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i });
}

/** Docx links never navigate the app webview: they open in the system browser. */
function openDocLink(event: React.MouseEvent<HTMLElement>) {
  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href");
  if (!href || !/^(?:https?:|mailto:)/i.test(href)) return;
  if (isTauri()) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
  else window.open(href, "_blank", "noopener,noreferrer");
}

interface Sheet { name: string; rows: string[][]; truncated: boolean }

async function readSheets(blob: Blob, csv: boolean): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  // sheetRows stops the parser early so a sheet declaring a huge range cannot exhaust memory; one extra row detects truncation.
  const options = { cellDates: true, sheetRows: MAX_SHEET_ROWS + 1 };
  const workbook = csv ? XLSX.read(await blob.text(), { type: "string", ...options }) : XLSX.read(await blob.arrayBuffer(), { type: "array", ...options });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const ref = sheet?.["!ref"];
    let wideSheet = false;
    const full = (sheet as { "!fullref"?: string } | undefined)?.["!fullref"]; // the declared range, kept by SheetJS when sheetRows cuts the parse short
    if (full) {
      const declared = XLSX.utils.decode_range(full);
      wideSheet = declared.e.r - declared.s.r >= MAX_SHEET_ROWS || declared.e.c - declared.s.c >= MAX_SHEET_COLS;
    }
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      if (range.e.c - range.s.c >= MAX_SHEET_COLS) wideSheet = true;
      range.e.r = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS); // clamp before expanding to rows
      range.e.c = Math.min(range.e.c, range.s.c + MAX_SHEET_COLS - 1);
      sheet["!ref"] = XLSX.utils.encode_range(range);
    }
    const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
    const rows = all.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLS).map((cell) => String(cell ?? "")));
    return { name, rows, truncated: wideSheet || all.length > MAX_SHEET_ROWS };
  });
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { value: T | null; error: string | null; retry: () => void } {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({ value: null, error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ value: null, error: null });
    load().then((value) => { if (!cancelled) setState({ value, error: null }); }, (cause) => { if (!cancelled) setState({ value: null, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { ...state, retry: () => setVersion((v) => v + 1) };
}

function Failed({ error, retry }: { error: string; retry: () => void }) { return <PanelError message={error} onRetry={retry} />; }

function DocxPreview({ getUrl }: { getUrl: () => Promise<string> }) {
  const { value, error, retry } = useAsync(async () => docxToHtml(await fetchBlob(await getUrl())), [getUrl]);
  if (error) return <Failed error={`Preview failed: ${error}`} retry={retry} />;
  if (value === null) return <RowSkeletons count={10} rowClass="h-3.5" />;
  return <article aria-label="Document preview" data-testid="docx-preview" className="docx-preview mx-auto max-w-3xl space-y-3 bg-background p-8 text-sm leading-6 [&_a]:text-primary [&_a]:underline [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_ol]:list-decimal [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_ul]:list-disc" onClick={openDocLink} dangerouslySetInnerHTML={{ __html: value }} />;
}

function SheetPreview({ getUrl, path }: { getUrl: () => Promise<string>; path: string }) {
  const { value, error, retry } = useAsync(async () => readSheets(await fetchBlob(await getUrl()), /\.csv$/i.test(path)), [getUrl, path]);
  const [active, setActive] = useState(0);
  if (error) return <Failed error={`Preview failed: ${error}`} retry={retry} />;
  if (value === null) return <RowSkeletons count={10} rowClass="h-3.5" />;
  const sheet = value[Math.min(active, value.length - 1)];
  if (!sheet) return <PanelEmpty icon={<IconFileOff />} title="Empty workbook" hint="This file has no sheets." />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sheet-preview">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-xs">
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r} className={r === 0 ? "sticky top-0 bg-muted font-medium" : undefined}>
                <th scope="row" className="sticky left-0 border border-border bg-muted px-2 py-0.5 text-right font-normal text-muted-foreground tabular-nums">{r + 1}</th>
                {row.map((cell, c) => <td key={c} className="max-w-80 truncate border border-border px-2 py-0.5" title={cell}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length === 0 && <div className="p-4 text-xs text-muted-foreground">This sheet is empty.</div>}
        {sheet.truncated && <div className="p-2 text-[11px] text-muted-foreground">Showing the first {MAX_SHEET_ROWS.toLocaleString()} rows and {MAX_SHEET_COLS} columns. Download the file for everything.</div>}
      </div>
      {value.length > 1 && (
        <div role="tablist" aria-label="Sheets" className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-background px-2 py-1">
          {value.map((item, index) => <button key={item.name} role="tab" type="button" aria-selected={index === active} onClick={() => setActive(index)} className={`rounded px-2 py-0.5 text-xs whitespace-nowrap ${index === active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}>{item.name}</button>)}
        </div>
      )}
    </div>
  );
}

const MAX_PDF_PAGES = 50;
const MAX_PDF_PIXELS = 4096;
/** Render scale 1.5, reduced so neither canvas side passes MAX_PDF_PIXELS (a huge page size must not OOM the webview). */
export function pdfScale(width: number, height: number): number {
  const longest = Math.max(width, height, 1);
  return Math.min(1.5, MAX_PDF_PIXELS / longest);
}

/** PDF rendered with pdf.js into canvases: WebKitGTK has no built-in PDF viewer and this keeps CSP frame-src tight. */
function PdfPreview({ getUrl }: { getUrl: () => Promise<string> }) {
  const host = useRef<HTMLDivElement>(null);
  const { value, error, retry } = useAsync(async () => {
    const data = new Uint8Array(await (await fetchBlob(await getUrl())).arrayBuffer());
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
    return doc;
  }, [getUrl]);
  const [pageError, setPageError] = useState<string | null>(null);
  useEffect(() => {
    if (!value || !host.current) return;
    let cancelled = false;
    const el = host.current;
    el.replaceChildren();
    setPageError(null);
    (async () => {
      const count = Math.min(value.numPages, MAX_PDF_PAGES);
      for (let n = 1; n <= count && !cancelled; n++) {
        const page = await value.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = pdfScale(base.width, base.height);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.className = "mx-auto mb-2 max-w-full bg-white shadow";
        canvas.setAttribute("aria-label", `Page ${n}`);
        el.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      if (!cancelled && value.numPages > count) setPageError(`Showing the first ${count} of ${value.numPages} pages. Download the file for everything.`);
    })().catch((cause) => { if (!cancelled) setPageError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; void value.destroy(); };
  }, [value]);
  if (error) return <Failed error={`Preview failed: ${error}`} retry={retry} />;
  if (value === null) return <RowSkeletons count={10} rowClass="h-3.5" />;
  return (
    <div className="size-full overflow-auto bg-muted p-2" data-testid="pdf-preview">
      <div ref={host} />
      {pageError && <div className="p-2 text-[11px] text-muted-foreground">{pageError}</div>}
    </div>
  );
}

/** Preview for office-style documents; the dialog hands in how to get the signed download URL and what to do for "no preview". */
export function DocumentPreview({ kind, path, getUrl, onDownload, onOpenExternally }: { kind: DocKind; path: string; getUrl: () => Promise<string>; onDownload: () => void; onOpenExternally: () => void }): ReactNode {
  if (kind === "docx") return <DocxPreview getUrl={getUrl} />;
  if (kind === "sheet") return <SheetPreview getUrl={getUrl} path={path} />;
  if (kind === "pdf") return <PdfPreview getUrl={getUrl} />;
  return (
    <div className="flex flex-col items-center" data-testid="no-preview">
      <PanelEmpty icon={<IconFileOff />} title="No preview for this file type" hint="Download it or open it in another app." className="pb-3" />
      <div className="flex justify-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onDownload}><IconDownload />Download</Button>
        <Button type="button" size="sm" variant="outline" onClick={onOpenExternally}><IconExternalLink />Open externally</Button>
      </div>
    </div>
  );
}
