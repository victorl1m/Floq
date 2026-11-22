import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Plugin UI code (src/plugins/<id>/**) may import only these; everything else must go through the kit. */
const ALLOWED = new Set(['react', 'react/jsx-runtime', '@tabler/icons-react', '@/plugins/kit', '@/plugins/sdk']);
/** The built-in WhatsApp integration shares pure code (formatting, phone numbers, chat types) with its runtime half: only that folder may import it. */
const SHARED = { whatsapp: '@whatsapp-shared/' };
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

/** Returns the violations in one source file as `file: "specifier"` strings. `ownDir` is the plugin's folder. */
export function violations(source, file, ownDir) {
  const out = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const m of stripped.matchAll(SPECIFIER)) {
    const spec = m[2];
    if (ALLOWED.has(spec)) continue;
    if (/\s/.test(spec)) continue; // text such as "Quoted message from " + name + ": ", not a module specifier
    const shared = SHARED[path.basename(ownDir)];
    if (shared && spec.startsWith(shared) && /^[a-z-]+$/.test(spec.slice(shared.length))) continue;
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(file), spec);
      if (target === ownDir || target.startsWith(ownDir + path.sep)) continue;
    }
    out.push(`${path.relative('.', file)}: "${spec}"`);
  }
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|jsx?|mjs|css)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

/** Plugin folders: every directory under `root` except the host's own `kit`. */
export function pluginDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'kit').map((e) => path.resolve(root, e.name));
}

export function checkAll(root) {
  const bad = [];
  for (const dir of pluginDirs(root)) {
    for (const file of walk(dir)) {
      if (file.endsWith('.css')) { bad.push(`${path.relative('.', file)}: plugins cannot ship CSS files`); continue; }
      bad.push(...violations(fs.readFileSync(file, 'utf8'), path.resolve(file), dir));
    }
  }
  return bad;
}

test('every plugin folder under src/plugins imports only react, tabler icons, the kit, the sdk or its own files', () => {
  assert.deepEqual(checkAll('src/plugins'), []);
});

test('the check fails on violations (fixture)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-imports-'));
  const dir = path.join(root, 'evil');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ok.tsx'), `import React from 'react';\nimport { IconPlug } from '@tabler/icons-react';\nimport { PluginPage } from '@/plugins/kit';\nimport type { UiPluginDefinition } from '@/plugins/sdk';\nimport x from './sub/x';\nexport * from "./sub/x";\n// import bad from 'lodash'\n/* import bad2 from 'axios' */\n`);
  fs.writeFileSync(path.join(dir, 'sub', 'x.ts'), 'export default 1;\n');
  assert.deepEqual(checkAll(root), []);
  for (const bad of [
    `import { Button } from '@/components/ui/button';`,
    `import { useRuntime } from '@/lib/runtime/store';`,
    `import lodash from 'lodash';`,
    `import '../../other/style';`,
    `import x from '../../lib/runtime/client';`,
    `const m = await import('@/lib/secrets');`,
    `const r = require('node:fs');`,
    `export { y } from '@/plugins/host';`,
    `import { Button } from '@/plugins/kit/../../components/ui/button';`,
  ]) {
    fs.writeFileSync(path.join(dir, 'sub', 'bad.tsx'), bad + '\n');
    assert.equal(checkAll(root).length, 1, bad);
  }
  fs.rmSync(path.join(dir, 'sub', 'bad.tsx'));
  fs.writeFileSync(path.join(dir, 'style.css'), 'a{}');
  assert.equal(checkAll(root).length, 1);
  fs.rmSync(root, { recursive: true });
});

test('the kit and host files are exempt, but plugin folders next to them are not', () => {
  assert.ok(!pluginDirs('src/plugins').some((d) => d.endsWith(path.sep + 'kit')));
});
