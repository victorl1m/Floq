import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const R = await import('../src/plugins/remote-ui.ts');
const sha = (text) => R.sha256Text(text);
const dataImporter = (source) => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

// A bundle as the floq-plugins build emits it: shared specifiers rewritten to the global, no imports of its own.
const BUNDLE = `
const rt = globalThis.__FLOQ_PLUGIN_RT__;
const React = rt.react;
const { jsx } = rt.jsx;
function View() {
  const [n] = React.useState(5);            // a hook: throws "Invalid hook call" if this React is not the host's
  return jsx(rt.kit.PluginPage, { title: "Remote " + n, children: jsx("p", { children: "from the bundle" }) });
}
export default rt.sdk.defineUiPlugin({ views: { main: View } });
`;

async function withRuntime(fn) {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try { await server.ssrLoadModule('/src/plugins/shared-runtime.ts'); return await fn(server); }
  finally { await server.close(); delete globalThis.__FLOQ_PLUGIN_RT__; }
}

test('a remote bundle uses the host React and kit: hooks work and the kit renders', async () => {
  await withRuntime(async (server) => {
    // The Vite SSR module graph has its own React copy; the shared runtime must carry that same instance into the bundle.
    const hostReact = globalThis.__FLOQ_PLUGIN_RT__.react;
    const def = await R.loadRemoteUi(BUNDLE, await sha(BUNDLE), await sha(BUNDLE), { importer: dataImporter });
    assert.deepEqual(Object.keys(def.views), ['main']);
    assert.equal(typeof def.views.main, 'function');
    const html = renderToStaticMarkup(hostReact.createElement(def.views.main));
    assert.match(html, /Remote 5/); assert.match(html, /from the bundle/); assert.match(html, /data-slot="plugin-page"/);
    // host.tsx loads through exactly this path and nothing else
    const host = fs.readFileSync('src/plugins/host.tsx', 'utf8');
    assert.match(host, /import\("\.\/shared-runtime"\)/); assert.match(host, /loadRemoteUi\(script\.text, p\.ui!\.sha256, script\.sha256\)/);
  });
});

test('the shared runtime exposes react, the jsx runtime, the kit and the sdk (and not tabler)', async () => {
  await withRuntime(async () => {
    const rt = globalThis.__FLOQ_PLUGIN_RT__;
    assert.deepEqual(Object.keys(rt).sort(), ['jsx', 'kit', 'react', 'sdk']);
    for (const name of ['PluginPage', 'PluginState', 'Button', 'resolvePluginIcon', 'usePluginApi', 'usePluginEvent']) assert.ok(rt.kit[name], 'kit.' + name);
    assert.equal(typeof rt.sdk.defineUiPlugin, 'function');
    assert.equal(typeof rt.jsx.jsx, 'function');
    assert.equal(typeof rt.react.useState, 'function');
  });
});

test('a bundle that does not match the listed or reported sha256 is never imported', async () => {
  await withRuntime(async () => {
    let imported = 0;
    const importer = async (s) => { imported++; return dataImporter(s); };
    const good = await sha(BUNDLE);
    await assert.rejects(R.loadRemoteUi(BUNDLE, 'f'.repeat(64), good, { importer }), /checksum/);
    await assert.rejects(R.loadRemoteUi(BUNDLE, good, 'f'.repeat(64), { importer }), /checksum/);
    await assert.rejects(R.loadRemoteUi(BUNDLE + ' ', good, good, { importer }), /checksum/);
    await assert.rejects(R.loadRemoteUi(BUNDLE, '', good, { importer }), /checksum/);
    assert.equal(imported, 0);
    await R.loadRemoteUi(BUNDLE, good, '', { importer }); // the header is optional, the list entry is not
    assert.equal(imported, 1);
  });
});

test('bad bundles fail with a clear error instead of breaking the app', async () => {
  await withRuntime(async () => {
    const load = (src) => R.loadRemoteUi(src, undefined, undefined, { importer: dataImporter, sha256: async () => 'x' }).catch((e) => e);
    const check = async (src) => R.loadRemoteUi(src, 'x', 'x', { importer: dataImporter, sha256: async () => 'x' });
    await assert.rejects(check('export const x = 1;'), /no default export/);
    await assert.rejects(check('export default 5;'), /no default export/);
    await assert.rejects(check('export default {;'), SyntaxError);
    void load;
  });
  // without the shared runtime installed, nothing loads
  delete globalThis.__FLOQ_PLUGIN_RT__;
  await assert.rejects(R.loadRemoteUi('export default {}', 'x', '', { importer: dataImporter, sha256: async () => 'x' }), /not ready/);
});

test('Tauri CSP allows blob: scripts and nothing else new', () => {
  const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const csp = conf.app.security.csp;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' blob:;/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(csp, /script-src[^;]*(https?:|\*)/);
  assert.match(csp, /connect-src[^;]*https:/); // the runtime origin is already reachable
});
