import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog as DialogPrimitive } from "radix-ui";
import { IconAlertTriangle, IconArrowRight, IconCheck, IconChevronLeft, IconChevronRight, IconShieldLock, IconX } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ProjectMark } from "@/components/projects/project-identity";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { providerThemeProps } from "@/lib/provider-theme";
import {
  actorLabel, announceBucket, describeAnnouncement, detailIsLong, RISK_LABEL, riskLevel,
} from "@/lib/approval-format";
import {
  deferApprovals, markApprovalOutcome, pendingCount, removeApproval, reopenApprovals, selectApproval, sortedItems, useApprovalState, useApprovalSync, type ApprovalItem,
} from "@/lib/approvals";
import type { ApprovalAgentRef } from "@/lib/runtime/types";
import { useRuntime, errorMessage } from "@/lib/runtime/store";

/*
 * Why this shows up on any screen: ApprovalHost is mounted once at the app root (App.tsx), outside every view, so it
 * never unmounts on navigation. Its dialog and pill are portaled to <body> with z-indexes above everything else in
 * the app (including toasts at 2147483000), and the dialog is a Radix modal layer: opened over Settings or another
 * dialog it stacks on top without closing it, and traps focus until it is answered or deferred with Esc.
 */
const Z = { pill: 2147483200, overlay: 2147483300, content: 2147483301 } as const;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function useSecondsLeft(deadline: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [deadline, active]);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}


function AgentChip({ agent, projectLookup }: { agent: ApprovalAgentRef; projectLookup: (id: string | null) => { imageUrl: string | null; iconName?: string | null; iconColor?: string | null; gitUrl: string | null } }) {
  const project = projectLookup(agent.projectId);
  return (
    <span {...providerThemeProps(agent.provider)} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-(--provider-rim,var(--border)) bg-(--provider-tint,var(--muted)) px-2 py-1 text-xs">
      <AgentAvatar session={agent} size={18} />
      <span className="truncate font-medium text-foreground">{actorLabel(agent)}</span>
      {agent.projectName && (
        <>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <ProjectMark project={project} className="size-3.5 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{agent.projectName}</span>
        </>
      )}
    </span>
  );
}

/** Announces once at the start, at 60s and at 10s. Never every tick. */
function useAnnouncement(item: ApprovalItem, seconds: number): string {
  const bucket = announceBucket(seconds);
  const key = `${item.approval.id}:${item.state}:${bucket}`;
  const last = useRef({ key: "", text: "" });
  if (last.current.key !== key) {
    const text = item.state === "expired" ? `Approval request expired: ${item.approval.action}.`
      : item.state === "allowed" ? "Approved. The agent was notified."
      : item.state === "denied" ? "Denied. The agent was notified."
      : describeAnnouncement(bucket, actorLabel(item.approval.requester), item.approval.action, seconds);
    last.current = { key, text };
  }
  return last.current.text;
}

/**
 * Focus Deny so a stray Enter or Space never grants anything, but without the keyboard focus ring: a ring on Deny
 * at open read as "Deny is selected / hovered" next to the primary Allow. Tab or arrow keys still show the ring.
 */
/** Enter or Space aimed at the Deny / Allow buttons: swallowed so only a click (or Ctrl/Cmd+Enter for Allow) decides. */
function isDecisionKey(event: React.KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return false;
  if (event.metaKey || event.ctrlKey) return false;
  return !!(event.target as Element | null)?.closest?.("[data-slot=approval-deny], [data-slot=approval-allow]");
}

function focusDenyQuietly(root: HTMLElement | null) {
  root?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
}

export function ApprovalCard({ item, autoFocusDeny, onAnswer, error, busy }: {
  item: ApprovalItem;
  autoFocusDeny: boolean;
  onAnswer: (decision: "allow" | "deny") => void;
  error: string | null;
  busy: "allow" | "deny" | null;
}) {
  const { approval } = item;
  const { projects } = useRuntime();
  const lookup = useMemo(() => (id: string | null) => projects.find((p) => p.id === id) ?? { imageUrl: null, gitUrl: null }, [projects]);
  const pending = item.state === "pending";
  const seconds = useSecondsLeft(item.deadline, pending);
  const live = useAnnouncement(item, seconds);
  const level = riskLevel(approval.action, approval.detail, approval.irreversible);
  const long = detailIsLong(approval.detail);
  const [expanded, setExpanded] = useState(false);
  const onBehalf = approval.requester.id !== approval.target.id;

  if (item.state === "allowed" || item.state === "denied") {
    const ok = item.state === "allowed";
    return (
      <div data-slot="approval-outcome" data-outcome={item.state} className="flex min-h-48 flex-col items-center justify-center gap-3 py-6 text-center">
        <span className={cn("flex size-12 items-center justify-center rounded-full", ok ? "bg-foreground text-background" : "bg-muted text-foreground")}>{ok ? <IconCheck size={24} aria-hidden="true" /> : <IconX size={24} aria-hidden="true" />}</span>
        <p className="text-base font-medium">{ok ? "Approved · agent notified" : "Denied"}</p>
        <p className="max-w-xs text-xs text-pretty text-muted-foreground">{ok ? `${approval.target.name} can act on this once.` : `${approval.target.name} was told not to do it.`}</p>
        <DialogPrimitive.Title className="sr-only">{ok ? "Approved" : "Denied"}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">The approval request was answered.</DialogPrimitive.Description>
        <span role="status" aria-live="polite" className="sr-only">{live}</span>
      </div>
    );
  }

  return (
    <div data-slot="approval-request" data-state={item.state} data-risk={level} className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground"><IconShieldLock size={18} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 space-y-1">
          <DialogPrimitive.Title className="text-base leading-tight font-semibold text-balance">Approval needed</DialogPrimitive.Title>
          <p data-slot="approval-risk" className={cn("inline-flex items-center gap-1 text-xs font-medium", level === "neutral" ? "text-muted-foreground" : "text-destructive")}>
            {level !== "neutral" && <IconAlertTriangle size={13} aria-hidden="true" />}
            {RISK_LABEL[level]}
          </p>
        </div>
        {pending ? null : <span className="shrink-0 text-xs text-muted-foreground">Closed</span>}
      </header>

      <DialogPrimitive.Description asChild>
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <p>{onBehalf ? "This agent asks permission for another agent to:" : "This agent wants to:"}</p>
          <div data-slot="approval-agents" className="flex flex-wrap items-center gap-1.5">
            <AgentChip agent={approval.requester} projectLookup={lookup} />
            {onBehalf && (<><IconArrowRight size={14} aria-label="on behalf of" className="shrink-0" /><AgentChip agent={approval.target} projectLookup={lookup} /></>)}
          </div>
        </div>
      </DialogPrimitive.Description>

      <pre data-slot="approval-action" className={cn("max-h-40 overflow-auto rounded-xl border px-3 py-2.5 font-mono text-[13px] leading-snug break-words whitespace-pre-wrap", level === "neutral" ? "border-border bg-muted/60" : "border-destructive/40 bg-destructive/5")}>{approval.action}</pre>

      {approval.detail && (
        <div data-slot="approval-detail" className="space-y-1">
          <p id={`approval-detail-${approval.id}`} className={cn("text-xs text-pretty whitespace-pre-wrap text-muted-foreground", long && !expanded && "line-clamp-3")}>{approval.detail}</p>
          {long && (
            <button type="button" aria-expanded={expanded} aria-controls={`approval-detail-${approval.id}`} onClick={() => setExpanded((v) => !v)} className="rounded text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none">{expanded ? "Show less" : "Show more"}</button>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <footer className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground"><Kbd>Esc</Kbd> decide later</p>
        <div className="flex items-center gap-2">
          {pending ? (
            <>
              <Button type="button" variant="outline" data-slot="approval-deny" data-autofocus={autoFocusDeny ? "" : undefined} disabled={!!busy} onClick={() => onAnswer("deny")} className="hover:border-destructive/45 hover:bg-destructive/10 hover:text-destructive active:bg-destructive/15 dark:hover:border-destructive/50 dark:hover:bg-destructive/15 dark:hover:text-destructive dark:active:bg-destructive/20">{busy === "deny" ? "Denying..." : "Deny"}</Button>
              <Button type="button" data-slot="approval-allow" disabled={!!busy} onClick={() => onAnswer("allow")} className="hover:-translate-y-px hover:shadow-[0_6px_16px_-6px_color-mix(in_oklch,var(--primary)_70%,transparent)] active:translate-y-px active:bg-primary-hover active:shadow-none motion-reduce:hover:translate-y-0">
                {busy === "allow" ? "Allowing..." : "Allow once"}
                <Kbd aria-hidden="true" className="ml-1 border-white/45 bg-white/15 text-white shadow-none dark:bg-white/15">{isMac ? "⌘↵" : "Ctrl+↵"}</Kbd>
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => removeApproval(approval.id)}>Dismiss</Button>
          )}
        </div>
      </footer>
      <span role="status" aria-live="polite" className="sr-only">{live}</span>
    </div>
  );
}

/** Persistent top-centre pill while the prompt is deferred; also reachable from the footer chip. */
function WaitingPill({ count }: { count: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Radix treats a click outside an open modal (e.g. Settings) as "dismiss". Keep clicks on the pill from doing that.
    const stop = (event: Event) => { if (ref.current?.contains(event.target as Node)) event.stopPropagation(); };
    for (const type of ["pointerdown", "focusin", "mousedown"]) window.addEventListener(type, stop, true);
    return () => { for (const type of ["pointerdown", "focusin", "mousedown"]) window.removeEventListener(type, stop, true); };
  }, []);
  return createPortal(
    <button
      ref={ref}
      type="button"
      data-slot="approval-pill"
      onClick={reopenApprovals}
      style={{ zIndex: Z.pill, pointerEvents: "auto" }}
      className="fixed top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-popover px-3.5 py-1.5 text-xs font-medium text-popover-foreground shadow-(--shadow-elev-2) outline-none transition-colors hover:border-foreground/25 hover:bg-muted active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring/70 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2"
    >
      <IconShieldLock size={14} aria-hidden="true" />
      <span className="tabular-nums">{count} {count === 1 ? "approval" : "approvals"} waiting</span>
      <span className="text-muted-foreground">Review</span>
    </button>,
    document.body,
  );
}

/** Footer chip: the same count, always in reach. */
export function ApprovalChip() {
  const { items } = useApprovalState();
  const count = pendingCount(items);
  if (!count) return null;
  const label = `${count} approval${count === 1 ? "" : "s"} waiting for your answer`;
  return (
    <Button type="button" variant="ghost" size="xs" title={label} aria-label={label} onClick={reopenApprovals} className="-mr-2 ml-2 gap-1.5 px-2 text-[11px] tabular-nums">
      <IconShieldLock size={12} stroke={1.5} aria-hidden="true" />
      <span>Approvals</span>
      <span aria-hidden="true" className="rounded-full bg-destructive px-1 text-[10px] leading-4 text-white">{count}</span>
    </Button>
  );
}

/** Mounted once at the app root. */
export function ApprovalHost({ suppressed = false }: { suppressed?: boolean }) {
  const { client } = useRuntime();
  useApprovalSync(client);
  const { items, deferred, index, manual } = useApprovalState();
  // The island answers approvals while it is up; the footer chip or pill (manual) still opens the dialog on request.
  suppressed = suppressed && !manual;
  const ordered = sortedItems(items);
  const current = ordered[Math.min(index, ordered.length - 1)];
  const pending = pendingCount(items);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const currentId = current?.approval.id;
  useEffect(() => { setError(null); setBusy(null); }, [currentId]);
  const currentState = current?.state;
  const dialogOpen = !deferred && !suppressed;
  useEffect(() => {
    // After an answer the next card replaces the old one: keep focus inside the prompt, on Deny (never on Allow).
    if (!dialogOpen || currentState !== "pending") return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || !active.closest("[data-slot=approval-request], [data-slot=approval-stack]")) focusDenyQuietly(body.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [currentId, currentState, dialogOpen]);

  async function answer(decision: "allow" | "deny") {
    if (!client || !current || current.state !== "pending" || busy) return;
    setBusy(decision);
    setError(null);
    try {
      await client.resolveApproval(current.approval.id, decision);
      markApprovalOutcome(current.approval.id, decision === "allow" ? "allowed" : "denied");
    } catch (failure) {
      setError(/not found|no longer pending|404|409/i.test(errorMessage(failure)) ? "This request already expired or was answered. Nothing was approved." : errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  if (!current || suppressed) return null;
  const open = !deferred;
  return (
    <>
      {!open && pending > 0 && <WaitingPill count={pending} />}
      <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) deferApprovals(); }}>
        <DialogPrimitive.Portal container={typeof document !== "undefined" ? document.body : undefined}>
          <DialogPrimitive.Overlay data-slot="approval-overlay" style={{ zIndex: Z.overlay }} className="fixed inset-0 bg-black/45 duration-150 data-open:animate-in data-open:fade-in-0 motion-reduce:animate-none dark:bg-black/70" />
          <DialogPrimitive.Content
            data-slot="approval-dialog"
            style={{ zIndex: Z.content }}
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              // Deny is the default focus: a stray Enter or Space while typing in the terminal must never grant anything.
              event.preventDefault();
              focusDenyQuietly(body.current);
            }}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter is the only keyboard shortcut: it allows. Plain Enter or Space on Deny / Allow (the dialog
              // can pop up mid-typing, with focus on Deny) must never decide anything, so the decision takes a click.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void answer("allow"); return; }
              if (isDecisionKey(event)) event.preventDefault();
            }}
            onKeyUp={(event) => { if (isDecisionKey(event)) event.preventDefault(); }}
            className="floq-surface floq-frosted-dialog fixed top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[30rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-[22px] p-5 text-sm text-popover-foreground shadow-(--shadow-elev-3) outline-none duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none"
          >
            <>
              {ordered.length > 1 && (
                <div data-slot="approval-stack" className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums" aria-live="polite">{pending} pending · {Math.min(index, ordered.length - 1) + 1} of {ordered.length}</span>
                  <span className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous approval" onClick={() => selectApproval(index - 1)}><IconChevronLeft /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label="Next approval" onClick={() => selectApproval(index + 1)}><IconChevronRight /></Button>
                  </span>
                </div>
              )}
              <div ref={body}>
                <ApprovalCard key={current.approval.id} item={current} autoFocusDeny onAnswer={(d) => void answer(d)} error={error} busy={busy} />
              </div>
            </>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
