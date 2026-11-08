import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

async function run(args: string[], stdin?: string) {
  const calls: {path: string; body: any}[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    calls.push({path: req.url!.replace('/internal/', ''), body: JSON.parse(raw || '{}')});
    const p = req.url!;
    if (p.endsWith('memory/add')) res.end(JSON.stringify({id: 'm1', action: 'added'}));
    else if (p.endsWith('memory/search')) res.end(JSON.stringify({mode: 'fulltext', results: [{id: 'm1', type: 'fact', title: 'T', text: 'x', score: 0.5}]}));
    else if (p.endsWith('memory/get')) res.end(JSON.stringify({id: 'm1', type: 'fact', scope: 'project', pinned: true, title: 'T', text: 'body'}));
    else res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../image/floq.mts', import.meta.url).pathname, ...args], {env: {...process.env, FLOQ_API_URL: `http://127.0.0.1:${port}`, FLOQ_AGENT_TOKEN: 'test'}});
  let out = ''; child.stdout.on('data', d => out += d);
  if (stdin !== undefined) child.stdin.end(stdin);
  const code = await new Promise<number | null>(r => child.on('close', r));
  server.closeAllConnections(); server.close();
  return {calls, out, code};
}

test('memory add maps flags and reads stdin', async () => {
  const r = await run(['memory', 'add', '-', '--title', 'T', '--type', 'decision', '--user', '--pin'], 'from stdin\n');
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0], {path: 'memory/add', body: {text: 'from stdin', title: 'T', type: 'decision', scope: 'user', pinned: true}});
  assert.equal(r.out.trim(), 'm1  added');
});

test('memory search prints id type score title', async () => {
  const r = await run(['memory', 'search', 'hello', 'world', '--k', '3']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0].body, {query: 'hello world', k: 3});
  assert.equal(r.out.trim(), 'm1  fact  0.500  T');
});

test('memory update and forget', async () => {
  const u = await run(['memory', 'update', 'm1', '--unpin', '--title', 'N']);
  assert.deepEqual(u.calls[0].body, {id: 'm1', title: 'N', pinned: false});
  const f = await run(['memory', 'forget', 'm1', '--reason', 'old']);
  assert.deepEqual(f.calls[0], {path: 'memory/forget', body: {id: 'm1', reason: 'old'}});
});

test('memory update without changes fails', async () => {
  assert.notEqual((await run(['memory', 'update', 'm1'])).code, 0);
});

async function cliWith503(code: string) {
  const server = createServer(async (req, res) => { for await (const _ of req) {} res.statusCode = 503; res.end(JSON.stringify({error: {code, message: 'x'}})); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../image/floq.mts', import.meta.url).pathname, 'memory', 'list'], {env: {...process.env, FLOQ_API_URL: `http://127.0.0.1:${port}`, FLOQ_AGENT_TOKEN: 'test'}});
  let err = ''; child.stderr.on('data', d => err += d);
  const exit = await new Promise<number | null>(r => child.on('close', r));
  server.closeAllConnections(); server.close();
  return {exit, err};
}

test('memory_disabled exits 3: disabled on this server', async () => {
  const r = await cliWith503('memory_disabled');
  assert.equal(r.exit, 3); assert.match(r.err, /memory is disabled on this Floq server \(set FLOQ_REDIS_URL\)/);
});

test('memory_unavailable exits 3: store unreachable, not "disabled"', async () => {
  const r = await cliWith503('memory_unavailable');
  assert.equal(r.exit, 3); assert.match(r.err, /not reachable right now/); assert.doesNotMatch(r.err, /disabled/);
});
