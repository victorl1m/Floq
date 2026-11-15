// Run: node --experimental-strip-types --test e2e/island-notifications.unit.mts
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoDismisses, capAttention, MAX_NOTIFICATIONS, notificationAttention, orderAttention } from '../src/lib/island-contract.ts';

const n = (id: string, createdAt: string, extra: object = {}) => ({ id, userId: 'u', projectId: null, sessionId: null, sessionName: null, level: 'info', category: 'custom', title: id, body: null, action: null, createdAt, readAt: null, ...extra }) as any;

test('only new unread, undismissed notifications, newest first, capped', () => {
  const items = [n('a', '2026-01-01T00:00:01Z'), n('b', '2026-01-01T00:00:03Z'), n('c', '2026-01-01T00:00:02Z', { readAt: 'x' }), n('d', '2026-01-01T00:00:04Z')];
  assert.deepEqual(notificationAttention(items, new Set(['d'])).map(i => i.id), ['b', 'a']);
  const many = Array.from({ length: 12 }, (_, i) => n('n' + i, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`));
  const out = notificationAttention(many, new Set());
  assert.equal(out.length, MAX_NOTIFICATIONS);
  assert.equal(out[0].id, 'n11');
});

test('approvals and decisions outrank notifications, whatever the timestamps', () => {
  const list = [
    { kind: 'notification', id: 'n1', createdAt: '2026-01-03' },
    { kind: 'decision', id: 'd1', createdAt: '2026-01-02' },
    { kind: 'notification', id: 'n2', createdAt: '2026-01-04' },
    { kind: 'approval', id: 'a1', createdAt: '2026-01-05' },
    { kind: 'approval', id: 'a0', createdAt: '2026-01-01' },
  ];
  assert.deepEqual(orderAttention(list).map(i => i.id), ['a0', 'a1', 'd1', 'n2', 'n1']);
});

test('info/success auto-dismiss, warning/error persist', () => {
  assert.deepEqual(['info', 'success', 'warning', 'error'].map(level => autoDismisses({ level } as any)), [true, true, false, false]);
});

test('notification text is capped', () => {
  const [item] = capAttention([{ kind: 'notification', id: 'x', createdAt: '', notification: n('x', '', { title: 't'.repeat(500), body: 'b'.repeat(2000) }) }]) as any[];
  assert.ok(item.notification.title.length <= 120);
  assert.ok(item.notification.body.length <= 240);
});
