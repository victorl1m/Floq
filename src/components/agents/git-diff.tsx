import { useMemo, useState, type ReactNode } from "react";
import { useHighlighter } from "@/hooks/use-highlighter";
import { languageForPath } from "@/lib/runtime/language";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import type { GitFileDiff } from "@/lib/runtime/git-review";
import { parseDiff, type DiffLine, type ParsedDiff } from "./right-sidebar/diff-parse";

const PAGE_ROWS = 400;
const MAX_HIGHLIGHT_CHARS = 150_000;
const MAX_HIGHLIGHT_LINE = 1000;

const ROW_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-emerald-500/10",
  del: "bg-destructive/10",
  ctx: "",
  note: "text-muted-foreground italic",
};
const GUTTER_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  del: "bg-destructive/15 text-destructive",
  ctx: "text-muted-foreground/70",
  note: "text-muted-foreground/70",
};
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " ", note: " " };

function Gutter({ value, tone }: { value: number | null; tone: string }) {
  return <span aria-hidden className={cn("w-9 shrink-0 select-none px-1 text-right tabular-nums", tone)}>{value ?? ""}</span>;
}

/** Unified diff of one file with old/new line-number gutters. Long diffs render in pages with a "Show more" control. */
export function DiffView({ parsed, path, wrap }: { parsed: ParsedDiff; path: string; wrap: boolean }) {
  const [limit, setLimit] = useState(PAGE_ROWS);
  let budget = limit;
  const hunks: typeof parsed.hunks = [];
  for (const hunk of parsed.hunks) {
    if (budget <= 0) break;
    const take = hunk.lines.slice(0, Math.max(0, budget - 1));
    hunks.push({ header: hunk.header, lines: take });
    budget -= take.length + 1;
  }
  const hidden = Math.max(0, parsed.rows - limit);

  // Syntax colors per visible hunk (lines tokenized in order, +/- tinting stays on the row). Plain text past the caps.
  const highlighter = useHighlighter(languageForPath(path));
  const colored = useMemo<(ReactNode[] | null)[]>(() => {
    if (!highlighter) return [];
    let chars = 0;
    for (const hunk of hunks) for (const line of hunk.lines) { chars += line.text.length; if (line.text.length > MAX_HIGHLIGHT_LINE) return []; }
    if (chars > MAX_HIGHLIGHT_CHARS) return [];
    try { return hunks.map((hunk) => (hunk.lines.length ? highlighter.highlight(hunk.lines.map((line) => line.text).join("\n")).lines : null)); } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighter, parsed, limit]);

  return (
    <div role="region" aria-label={`Diff for ${path}`} className={cn("font-mono text-[11px] leading-[18px]", !wrap && "overflow-x-auto")}>
      <div className={cn(!wrap && "w-max min-w-full")}>
        {hunks.map((hunk, index) => (
          <div key={index}>
            <div className="flex bg-muted/50 text-muted-foreground">
              <Gutter value={null} tone="" /><Gutter value={null} tone="" />
              <span className={cn("min-w-0 px-2 py-px", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{hunk.header}</span>
            </div>
            {hunk.lines.map((line, lineIndex) => (
              <div key={lineIndex} className={cn("flex", ROW_TONE[line.kind])}>
                <Gutter value={line.oldNo} tone={GUTTER_TONE[line.kind]} />
                <Gutter value={line.newNo} tone={GUTTER_TONE[line.kind]} />
                <span aria-hidden className={cn("w-4 shrink-0 select-none text-center", line.kind === "add" && "text-emerald-600 dark:text-emerald-400", line.kind === "del" && "text-destructive")}>{SIGN[line.kind]}</span>
                <span className={cn("min-w-0 flex-1 pr-2", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{colored[index]?.[lineIndex] ?? (line.text || " ")}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-2 py-1 font-sans text-xs text-muted-foreground">
          <span>{hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"} not shown</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => setLimit((value) => value + PAGE_ROWS)}>Show more</Button>
        </div>
      )}
    </div>
  );
}

/** Body of one file's diff, covering its binary, too-large and empty states. */
export function FileDiffBody({ diff, parsed, wrap }: { diff: GitFileDiff; parsed: ParsedDiff; wrap: boolean }) {
  if (diff.binary) return <p className="px-3 py-2 text-xs text-muted-foreground">Binary file changed. Text preview is not available.</p>;
  if (diff.tooLarge) return <p className="px-3 py-2 text-xs text-muted-foreground">This file's diff is too large to preview here.</p>;
  if (parsed.hunks.length === 0) return <p className="px-3 py-2 text-xs text-muted-foreground">No text changes to display (mode or rename only).</p>;
  return <DiffView parsed={parsed} path={diff.path} wrap={wrap} />;
}

export function useParsedDiff(diff: GitFileDiff | null): ParsedDiff | null {
  return useMemo(() => (diff && !diff.binary && !diff.tooLarge ? parseDiff(diff.patch) : diff ? { hunks: [], added: 0, removed: 0, rows: 0 } : null), [diff]);
}
