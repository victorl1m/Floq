import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { PERMISSION_HOOK_PATH, claudeBlockSettings, nativeSubagentBlockArgs } from '../src/nativeSubagentBlock.ts';

const hook = new URL('../image/floq-permission-request.mts', import.meta.url).pathname;
const payload = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf "$DIR"/build', description: 'Clean' } };
function run(url: string, input: unknown = payload, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, ['--import', 'tsx', hook], { env: { ...process.env, FLOQ_API_URL: url, FLOQ_AGENT_TOKEN: 'test', ...env } });
    let out = ''; c.stdout.on('data', (d) => out += d); c.on('close', (code) => resolve({ code, out }));
    c.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
async function serve(t: any, final: Record<string, unknown>) {
  const seen: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => { let s = ''; for await (const d of req) s += d; const body = JSON.parse(s || '{}'); seen.push({ path: req.url!, body });
    if (req.url!.endsWith('/native-request')) res.end(JSON.stringify({ id: 'A1', deduped: false })); else if (req.url!.endsWith('/status')) res.end(JSON.stringify(final)); else res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, url: `http://127.0.0.1:${(server.address() as any).port}` };
}

test('granted approval allows the tool and consumes the grant', async (t) => {
  const s = await serve(t, { status: 'granted' });
  const r = await run(s.url); assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const req = s.seen.find((x) => x.path.endsWith('/native-request'))!.body;
  assert.match(req.action, /^Claude Code asks to run Bash: rm -rf/); assert.match(req.detail, /Clean/);
  assert.ok(s.seen.some((x) => x.path.endsWith('/verify') && x.body.consume === true));
});
test('denied approval denies with a reason', async (t) => {
  const s = await serve(t, { status: 'denied' });
  const r = await run(s.url); const d = JSON.parse(r.out).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'deny'); assert.match(d.message, /denied/);
});
test('no answer before the wait ends is an explicit deny and withdraws the request', async (t) => {
  const s = await serve(t, { status: 'pending' });
  const r = await run(s.url, payload, { FLOQ_PERMISSION_WAIT_SEC: '1' });
  assert.equal(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'deny');
  assert.ok(s.seen.some((x) => x.path.endsWith('/cancel')));
});
test('long commands are clipped and marked; cancelled falls through', async (t) => {
  const s = await serve(t, { status: 'cancelled' });
  const r = await run(s.url, { ...payload, tool_input: { command: 'echo ' + 'x'.repeat(5000) } });
  assert.equal(r.out, '');
  const req = s.seen.find((x) => x.path.endsWith('/native-request'))!.body;
  assert.ok(req.action.length <= 170 && req.action.endsWith('…[clipped]')); assert.ok(req.detail.length <= 900 && req.detail.endsWith('…[clipped]'));
});
test('offline, malformed, other event or question tools fall through silently, never allow', async () => {
  for (const input of [payload, '{bad', {}, { ...payload, hook_event_name: 'PreToolUse' }, { ...payload, tool_name: 'AskUserQuestion' }]) {
    const r = await run('http://127.0.0.1:1', input); assert.equal(r.code, 0); assert.equal(r.out, '');
  }
  const noEnv = await new Promise<string>((res) => { const c = spawn(process.execPath, ['--import', 'tsx', hook], { env: { PATH: process.env.PATH } }); let o = ''; c.stdout.on('data', (d) => o += d); c.on('close', () => res(o)); c.stdin.end(JSON.stringify(payload)); });
  assert.equal(noEnv, '');
});
test('settings install the hook for claude sessions only when the file exists and the version supports it', () => {
  const on = JSON.parse(nativeSubagentBlockArgs('claude', { hookExists: () => true, version: '2.1.319' }).at(-1)!);
  assert.equal(on.hooks.PermissionRequest[0].hooks[0].command, `node ${PERMISSION_HOOK_PATH}`);
  assert.deepEqual(on, claudeBlockSettings(undefined, '/usr/local/bin/floq-native-question.mjs', PERMISSION_HOOK_PATH));
  const old = JSON.parse(nativeSubagentBlockArgs('claude', { hookExists: () => true, version: '2.0.10' }).at(-1)!);
  assert.equal(old.hooks.PermissionRequest, undefined);
});
