// Static sanity check for src-tauri/windows/installer-hooks.nsh (no makensis on Linux CI).
// Run: node scripts/check-installer-hooks.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src-tauri/windows/installer-hooks.nsh', import.meta.url), 'utf8');
const code = src.split('\n').map((l) => l.replace(/;.*$/, '')).join('\n');
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const count = (re) => (code.match(re) || []).length;

if (count(/^\s*!macro\s/gm) !== count(/^\s*!macroend/gm)) fail('!macro / !macroend unbalanced');
if (count(/\$\{If\b/g) !== count(/\$\{EndIf\}/g)) fail('If / EndIf unbalanced');
for (const m of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_POSTINSTALL', 'NSIS_HOOK_PREUNINSTALL', 'FLOQ_STOP_APP'])
  if (!new RegExp(`!macro\\s+${m}\\b`).test(code)) fail(`missing macro ${m}`);
// Pushes and plain "Pop $var" must balance per macro, ignoring the Pop that reads a plugin result.
for (const body of code.split(/!macroend/)) {
  const pushes = (body.match(/^\s*Push\s/gm) || []).length;
  const pops = (body.match(/^\s*Pop\s/gm) || []).length;
  const results = (body.match(/^\s*(nsExec::Exec|nsProcess::_FindProcess)\b/gm) || []).length;
  if (pushes !== pops - results) fail('Push/Pop unbalanced in a macro');
}
// Every Goto target must be a defined label.
const labels = new Set([...code.matchAll(/^\s*([A-Za-z_]\w*):\s*$/gm)].map((m) => m[1]));
for (const m of code.matchAll(/(?:Goto|IfFileExists\s+"[^"]*")\s+([A-Za-z_]\w*)/g))
  if (!labels.has(m[1])) fail(`undefined label ${m[1]}`);
if (!/DeleteRegValue HKCU .*"Floq"/.test(code)) fail('autostart Run-key removal missing');
if (!/FLOQ_UPGRADE_MARKER/.test(code)) fail('upgrade marker missing');
console.log('installer-hooks.nsh static checks passed');
