import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('renders pill, approval card and decision card states', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { default: Island } = await server.ssrLoadModule('/src/components/island/island-root.tsx');
    const approval = { kind:'approval', id:'a', createdAt:'2026-01-01', approval:{ id:'a', action:'Deploy main', detail:'Ship it', irreversible:true, requester:{name:'Ada'}, target:{name:'app'}, expiresAt:'2027-01-01' } };
    const decision = { kind:'decision', id:'d', createdAt:'2026-01-01', decision:{id:'d', sessionName:'Ada', source:'native', answerMode:'structured', questions:[{id:'q', question:'Choose one', options:[{id:'o', label:'Option'}], allowText:true, multiSelect:false}]} };
    const render = (items, expanded) => renderToStaticMarkup(React.createElement(Island, { initialSnapshot:{epoch:'test', revision:1, connected:true, items, busy:[]}, initialExpanded:expanded }));
    assert.match(render([approval], false), /island-pill/);
    const card = render([approval, decision], true);
    assert.match(card, /Irreversible · affects production/);
    assert.match(card, /island-queue/);
    assert.match(card, /Needs your OK/);
    assert.match(card, /aria-label="Decline"/);
    assert.doesNotMatch(card, /island-expiry/); // requests no longer expire, so no countdown ring
    assert.match(card, /Accept/);
    assert.match(render([decision], true), /Option/);
    assert.match(render([decision], true), /Open terminal/);
  } finally { await server.close(); }
});

test('empty initial snapshot renders no capsule and non-empty snapshot enters', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { default: Island } = await server.ssrLoadModule('/src/components/island/island-root.tsx');
    const snapshot = {epoch:'test', revision:1, connected:true, items:[], busy:[]};
    assert.equal(renderToStaticMarkup(React.createElement(Island, {initialSnapshot:snapshot})), '');
    const item = {kind:'decision', id:'d', createdAt:'2026-01-01', decision:{id:'d', sessionName:'Ada', source:'native', answerMode:'terminal', questions:[]}};
    assert.match(renderToStaticMarkup(React.createElement(Island, {initialSnapshot:{...snapshot, items:[item]}})), /island-enter/);
  } finally { await server.close(); }
});
