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
    if (p.endsWith('wired/get')) res.end(JSON.stringify({block: 'WIRED BLOCK'}));
    else if (p.endsWith('sticky/create')) res.end(JSON.stringify({id: 'n1', color: 'blue', text: 'x'}));
    else if (p.endsWith('memory/add')) res.end(JSON.stringify({id: 'm1', action: 'added'}));
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

test('floq wired and sticky options are accepted (they used to print only "usage: floq --help")', async () => {
  const w = await run(['wired']);
  assert.equal(w.code, 0);
  assert.equal(w.out.trim(), 'WIRED BLOCK');
  const s = await run(['sticky', 'new', 'hi', '--color', 'blue', '--kind', 'note', '--x', '1', '--y', '2']);
  assert.equal(s.code, 0);
  assert.equal(s.calls[0].path, 'sticky/create');
});
