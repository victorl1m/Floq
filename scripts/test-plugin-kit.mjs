import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const KIT = 'src/plugins/kit';
const files = fs.readdirSync(KIT).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => path.join(KIT, f));

test('the kit hard-codes no colors: no hex, rgb(), hsl(), oklch() or named color utilities', () => {
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, file + ' has a hex color');
    assert.doesNotMatch(src, /\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/, file + ' has a color function');
    assert.doesNotMatch(src, /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)(?:-\d+)?\b/, file + ' uses a palette color utility');
    assert.doesNotMatch(src, /backdrop-blur|backdrop-filter|@keyframes|animate-/, file + ' adds blur or ambient motion');
  }
});

test('kit components render every state with semantic token classes only', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const kit = await server.ssrLoadModule('/src/plugins/kit/index.ts');
    const h = React.createElement;
    const page = renderToStaticMarkup(h(kit.PluginPage, { title: 'Echo', description: 'About', actions: h('button', null, 'Act') }, h('p', null, 'body')));
    assert.match(page, /data-slot="plugin-page"/);
    assert.match(page, /<h1[^>]*>Echo<\/h1>/);
    assert.match(page, /absolute inset-0/);
    const state = (props) => renderToStaticMarkup(h(kit.PluginState, props));
    assert.match(state({ state: 'loading', label: 'tickets' }), /role="status"[^>]*aria-label="Loading tickets"/);
    assert.match(state({ state: 'empty' }), /Nothing here yet/);
    const err = state({ state: 'error', onRetry: () => {} });
    assert.match(err, /role="alert"/); assert.match(err, /Retry/);
    assert.doesNotMatch(state({ state: 'error' }), /Retry/);
    const nc = state({ state: 'not-configured', missingSecrets: ['MOVIDESK_TOKEN'], missingSettings: ['baseUrl'] });
    assert.match(nc, /MOVIDESK_TOKEN/); assert.match(nc, /baseUrl/); assert.match(nc, /Open Secrets/); assert.match(nc, /Plugin settings/);
    assert.doesNotMatch(state({ state: 'not-configured', missingSettings: ['baseUrl'] }), /Open Secrets/);
    assert.match(state({ state: 'disabled' }), /turned off/);
    const task = { sourceId: 'p/s', externalId: 'T-1042', title: 'Fix login', status: 'Open', statusCategory: 'doing', url: 'https://x.test/1', updatedAt: '2026-01-01T00:00:00.000Z', fields: [], assignee: 'Ann' };
    const row = renderToStaticMarkup(h(kit.ExternalTaskRow, { task, sourceLabel: 'Movidesk' }));
    assert.match(row, /T-1042/); assert.match(row, /Fix login/); assert.match(row, /aria-label="Open in Movidesk"/); assert.match(row, /data-category="doing"/); assert.match(row, /font-mono/);
    for (const cat of ['todo', 'doing', 'done']) assert.match(renderToStaticMarkup(h(kit.StatusCategoryBadge, { category: cat, status: '' })), new RegExp(`data-category="${cat}"`));
    for (const html of [page, err, nc, row]) assert.doesNotMatch(html, /style="[^"]*(color|background)/);
    // the curated surface the design system promises
    for (const name of ['Button', 'Badge', 'Card', 'Table', 'Empty', 'Field', 'Input', 'Textarea', 'Select', 'Switch', 'Checkbox', 'Tabs', 'Tooltip', 'Dialog', 'AlertDialog', 'Sheet', 'DropdownMenu', 'Skeleton', 'Kbd', 'toast', 'PluginPage', 'PluginState', 'ExternalTaskRow', 'PluginBoundary', 'usePluginEvent']) assert.ok(kit[name], 'kit exports ' + name);
  } finally { await server.close(); }
});
