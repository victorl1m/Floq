import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { PLUGIN_COLOR_TOKENS, PLUGIN_SHARED_TOKENS } = await import('../src/plugins/tokens.ts');
const css = fs.readFileSync('src/index.css', 'utf8');

/** Custom properties declared directly inside every top-level block whose selector is exactly `selector`. */
function declared(selector) {
  const names = new Set();
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'gm');
  for (const m of css.matchAll(re)) {
    let i = m.index + m[0].length, depth = 1, body = '';
    for (; depth > 0 && i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      if (depth > 0) body += css[i];
    }
    for (const d of body.matchAll(/^\s*--([a-z0-9-]+)\s*:/gm)) names.add(d[1]);
  }
  return names;
}

const light = declared(':root');
const dark = declared('.dark');

test('the parser finds the theme blocks', () => {
  assert.ok(light.size > 40 && dark.size > 40, `light ${light.size}, dark ${dark.size}`);
  assert.ok(light.has('background') && dark.has('background'));
});

test('every plugin color token is defined for the light and the dark theme', () => {
  const missing = [];
  for (const t of PLUGIN_COLOR_TOKENS) {
    if (!light.has(t)) missing.push(`${t} (light :root)`);
    if (!dark.has(t)) missing.push(`${t} (dark .dark)`);
  }
  assert.deepEqual(missing, []);
});

test('shared tokens exist in the base theme (:root or @theme inline)', () => {
  const theme = declared('@theme inline');
  assert.deepEqual(PLUGIN_SHARED_TOKENS.filter((t) => !light.has(t) && !theme.has(t)), []);
});

test('every color token has its Tailwind mapping in @theme inline (so utilities like bg-card work)', () => {
  const theme = css.slice(css.indexOf('@theme inline'), css.indexOf('}', css.indexOf('@theme inline')));
  const mapped = (t) => new RegExp(`--color-${t}\\s*:\\s*var\\(--${t}\\)`).test(theme);
  // sidebar-* map as --color-sidebar-*; the rest as --color-*
  assert.deepEqual(PLUGIN_COLOR_TOKENS.filter((t) => !mapped(t)), []);
});

test('the check fails when a token disappears (self-test)', () => {
  assert.ok(!light.has('definitely-not-a-token'));
});
