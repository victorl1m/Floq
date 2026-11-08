#!/usr/bin/env node
// Best-effort Claude PermissionRequest bridge. Claude Code still raises native permission prompts that
// --dangerously-skip-permissions does not skip (e.g. "Dangerous rm operation not ruled out"), and auto-blocks them
// after ~45 s. This hook shows them to the user as a Floq approval on the island and answers the prompt.
// Never auto-allows: unreachable runtime, malformed input, cancelled or unanswered => no output (terminal prompt stays),
// except a timeout, which is an explicit deny (Claude would auto-block the same moment).
import { readFileSync } from 'node:fs';

type HookInput = { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown> };
type Status = { status?: string; message?: string };

export const ACTION_MAX = 170;
export const DETAIL_CHUNK = 900;
const CLIP = ' …[clipped]';

function clip(text: string, max: number): string { return text.length > max ? text.slice(0, max - CLIP.length) + CLIP : text; }
function oneLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

export function describe(input: HookInput): { action: string; detail: string } | null {
  const tool = input.tool_name;
  if (typeof tool !== 'string' || !tool || tool.length > 200 || !input.tool_input || typeof input.tool_input !== 'object') return null;
  const ti = input.tool_input;
  const main = typeof ti.command === 'string' ? ti.command : typeof ti.file_path === 'string' ? ti.file_path : typeof ti.url === 'string' ? ti.url : typeof ti.pattern === 'string' ? ti.pattern : JSON.stringify(ti);
  const desc = typeof ti.description === 'string' ? oneLine(ti.description) : '';
  return {
    action: clip(`Claude Code asks to run ${tool}: ${oneLine(main)}`, ACTION_MAX),
    detail: clip(`Claude Code is asking permission (a safety check that bypass mode does not skip) for ${tool}.\n${desc ? desc + '\n' : ''}${main}`, DETAIL_CHUNK),
  };
}

async function main() {
  const base = process.env.FLOQ_API_URL, token = process.env.FLOQ_AGENT_TOKEN;
  if (!base || !token) return;
  let input: HookInput;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'PermissionRequest') return;
  // Interactive question/plan UIs are handled by their own flows; never answer those here.
  if (input.tool_name === 'AskUserQuestion' || input.tool_name === 'ExitPlanMode') return;
  const what = describe(input);
  if (!what) return;
  const waitSec = Math.max(1, Math.min(43, Number(process.env.FLOQ_PERMISSION_WAIT_SEC) || 40));
  const deadline = Date.now() + waitSec * 1000;
  const call = async (path: string, body: unknown, timeout: number) => {
    const r = await fetch(base + '/internal/approvals/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, timeout)) });
    if (!r.ok) throw new Error('unavailable');
    return await r.json() as Record<string, unknown>;
  };
  const out = (behavior: 'allow' | 'deny', message?: string) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: behavior === 'allow' ? { behavior } : { behavior, message } } }));
  let id: string | undefined; let settled = false;
  try {
    const created = await call('native-request', what, 5000);
    if (typeof created.id !== 'string') return;
    id = created.id;
    let st: Status = { status: 'pending' };
    while (st.status === 'pending' && Date.now() < deadline) st = await call('status', { id, waitSec: Math.min(40, Math.max(1, Math.floor((deadline - Date.now()) / 1000))) }, deadline - Date.now() + 2000) as Status;
    if (st.status === 'granted') {
      // Retire the single-use grant so it cannot be replayed; the user's answer is already known either way.
      await call('verify', { id, consume: true, action: what.action }, 1500).catch(() => undefined);
      settled = true; out('allow'); return;
    }
    if (st.status === 'denied') { settled = true; out('deny', 'The user denied this in Floq.'); return; }
    if (st.status === 'pending') { out('deny', 'No answer from the user in Floq before the permission prompt timed out. Nothing was approved; ask the user or choose another way.'); return; }
    // cancelled / expired / unknown: leave the native prompt alone.
    settled = true;
  } catch { /* runtime unreachable: the terminal prompt remains */ }
  finally { if (id && !settled) await call('cancel', { id }, 1500).catch(() => undefined); }
}
await main().catch(() => undefined);
