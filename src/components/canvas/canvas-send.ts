// Shared delivery used by the bottom composer and every node's message bar.
import { toast } from "sonner";
import { shellQuote, uploadTauriPath, type UploadItem } from "@/components/agents/upload-toast";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { SessionSummary } from "@/lib/runtime/types";

export interface Attachment extends UploadItem {
  id: string;
  previewUrl?: string;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CHUNK = 16_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Text plus the saved (shell-quoted) attachment paths, one per line. */
export function withPaths(text: string, paths: string[]): string {
  if (!paths.length) return text;
  return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}Attached files:\n${paths.map(shellQuote).join("\n")}`;
}

/** Bracketed paste so a multi-line message is one input in the Claude/Codex TUI, then Enter to submit it. */
export async function deliverMessage(client: RuntimeClient, sessionId: string, text: string): Promise<void> {
  await client.sendInput(sessionId, PASTE_START);
  for (let i = 0; i < text.length; i += CHUNK) await client.sendInput(sessionId, text.slice(i, i + CHUNK));
  await client.sendInput(sessionId, PASTE_END);
  await sleep(150);
  await client.sendInput(sessionId, "\r");
}

/** Attachments are saved inside the target session's own storage, so they upload per target. */
export async function uploadAttachments(
  client: RuntimeClient,
  sessionId: string,
  items: Attachment[],
  onProgress: (attachmentId: string, fraction: number) => void,
): Promise<string[]> {
  const paths: string[] = [];
  const controller = new AbortController();
  for (const item of items) {
    const report = (loaded: number, total?: number) => onProgress(item.id, Math.min(1, loaded / Math.max(1, total ?? item.size)));
    if (item.path) paths.push(await uploadTauriPath(client, sessionId, item, `composer-${item.id}-${sessionId}`, report, controller.signal));
    else if (item.blob) paths.push((await client.uploadSessionAttachmentStream(sessionId, item.blob, item.name, report)).path);
    onProgress(item.id, 1);
  }
  return paths;
}

export interface SendOptions {
  client: RuntimeClient;
  targets: SessionSummary[];
  text: string;
  attachments?: Attachment[];
  wake: (session: SessionSummary) => Promise<void>;
  getSession: (id: string) => SessionSummary | undefined;
  /** Fraction 0..1 per attachment, averaged over all targets. */
  onProgress?: (attachmentId: string, fraction: number) => void;
}
export interface SendResult { delivered: string[]; failed: { id: string; error: string }[]; skipped: string[] }

async function waitRunning(id: string, getSession: SendOptions["getSession"]) {
  for (let i = 0; i < 20; i += 1) {
    if (getSession(id)?.state === "running") break;
    await sleep(500);
  }
  await sleep(800);
}

/** Wake sleeping targets (after asking), upload attachments per target in parallel, then deliver. Failures are per target. */
export async function sendToTargets(options: SendOptions): Promise<SendResult> {
  const { client, text, attachments = [], wake, getSession, onProgress } = options;
  let targets = options.targets;
  const dormant = targets.filter((session) => session.state !== "running" && session.state !== "starting");
  const skipped: string[] = [];
  if (dormant.length) {
    const names = dormant.map((session) => session.title).join(", ");
    if (!window.confirm(`${dormant.length === 1 ? `${names} is not running` : `${dormant.length} agents are not running (${names})`}. Wake ${dormant.length === 1 ? "it" : "them"} and send?`)) {
      skipped.push(...dormant.map((session) => session.id));
      targets = targets.filter((session) => !skipped.includes(session.id));
    }
  }
  const fractions = new Map<string, Map<string, number>>();
  const report = (targetId: string) => (attachmentId: string, fraction: number) => {
    const per = fractions.get(attachmentId) ?? new Map<string, number>();
    per.set(targetId, fraction);
    fractions.set(attachmentId, per);
    onProgress?.(attachmentId, [...per.values()].reduce((sum, value) => sum + value, 0) / Math.max(1, targets.length));
  };
  const results = await Promise.all(targets.map(async (session) => {
    try {
      if (dormant.some((item) => item.id === session.id)) { await wake(session); await waitRunning(session.id, getSession); }
      const paths = await uploadAttachments(client, session.id, attachments, report(session.id));
      await deliverMessage(client, session.id, withPaths(text, paths));
      return { id: session.id, error: null as string | null };
    } catch (error) {
      toast.error(`Could not send to ${session.title}`, { description: errorMessage(error) });
      return { id: session.id, error: errorMessage(error) };
    }
  }));
  return {
    delivered: results.filter((item) => !item.error).map((item) => item.id),
    failed: results.filter((item) => item.error).map((item) => ({ id: item.id, error: item.error as string })),
    skipped,
  };
}
