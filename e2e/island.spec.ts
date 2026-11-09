import { test, expect, type Page } from '@playwright/test';

const agent = { sessionId: 's', name: 'a', role: 'r', project: 'p' };
const snapshot = (revision = 1) => ({
  epoch: 'e1', revision, connected: true, busy: [],
  items: [{ kind: 'approval', id: 'a1', createdAt: '2026-01-01T00:00:00Z', approval: {
    id: 'a1', requester: agent, target: agent, action: 'git push origin main', detail: 'push', irreversible: true,
    createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', remainingMs: 60000, timeoutMs: 60000 } }],
});

/** Mocks the Tauri bridge; island_set_layout answers like the native command (440/220 wide, requested height). */
async function boot(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__calls = []; const callbacks = new Map<number, (e: unknown) => void>(); const listeners: Record<string, number[]> = {}; let id = 1;
    w.__emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach(h => callbacks.get(h)?.({ event, id: 0, payload }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback(cb: (e: unknown) => void) { const n = id++; callbacks.set(n, cb); return n; },
      unregisterCallback() {},
      convertFileSrc: (s: string) => s,
      async invoke(cmd: string, args: any) {
        if (cmd === 'plugin:event|listen') { (listeners[args.event] ??= []).push(args.handler); return id++; }
        if (cmd === 'plugin:event|unlisten') return;
        w.__calls.push({ cmd, args, t: performance.now() });
        if (cmd === 'island_set_layout') return { width: args.expanded ? 440 : 220, height: args.expanded ? args.height : 40 };
      },
    };
  });
  await page.goto('/?window=island');
  await page.evaluate(s => (window as any).__emit('island:snapshot', s), snapshot());
  await expect(page.locator('.island')).toBeVisible();
}
const layouts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'island_set_layout').map((c: any) => ({ ...c.args, t: c.t })));
const shell = (page: Page) => page.locator('.island').evaluate(e => ({ h: e.getBoundingClientRect().height, cls: e.className }));

test('hover expands, leaving collapses back to the pill and the shell never vanishes', async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(500);
  expect((await shell(page)).h).toBe(40);
  await page.screenshot({ path: '.tmp/island-pw/1-collapsed.png' });
  await page.locator('.island').hover();
  await expect(page.locator('.island.expanded')).toBeVisible();
  await page.waitForTimeout(600);
  expect((await shell(page)).h).toBeGreaterThan(100);
  await page.screenshot({ path: '.tmp/island-pw/2-expanded.png' });
  await page.mouse.move(2000, 2000);
  await page.waitForTimeout(900);
  const after = await shell(page);
  expect(after.cls).toContain('collapsed');
  expect(after.h).toBe(40);
  const last = (await layouts(page)).at(-1);
  expect(last).toMatchObject({ expanded: false, height: 40 });
  await page.screenshot({ path: '.tmp/island-pw/3-collapsed-again.png' });
});

test('expanding sends one growing layout without a second near-identical step', async ({ page }) => {
  await boot(page);
  await page.locator('.island').hover();
  await page.waitForTimeout(800);
  const expanded = (await layouts(page)).filter(l => l.expanded);
  // Content settling may cause one height-only follow-up at most, never two.
  expect(expanded.length).toBeLessThanOrEqual(2);
  for (const l of expanded) expect(l.height).toBeGreaterThan(40);
});

test('the native island:hover event collapses an island expanded by the DOM', async ({ page }) => {
  await boot(page);
  await page.locator('.island').hover();
  await expect(page.locator('.island.expanded')).toBeVisible();
  await page.evaluate(() => (window as any).__emit('island:hover', { expanded: false }));
  await expect(page.locator('.island.collapsed')).toBeVisible({ timeout: 2000 });
  await page.evaluate(() => (window as any).__emit('island:hover', { expanded: true }));
  await expect(page.locator('.island.expanded')).toBeVisible();
});
