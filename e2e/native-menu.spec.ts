// The webview's native context menu never shows in the app UI (event is default-prevented) except in editable fields and over selected text;
// and right-click / long-press on a WhatsApp chat row opens that chat's menu at the pointer.
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const ART = process.env.FLOQ_ARTIFACTS_DIR ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
type Call = { path: string; method: string; body?: any };

/** Right-clicks the element and tells whether the page left the default (native menu) alone. */
async function prevented(page: Page, sel: string): Promise<boolean> {
  return page.evaluate((s) => new Promise<boolean>((resolve) => {
    const el = document.querySelector(s)!;
    // runs after the app's document listener (registered earlier, same phase)
    document.addEventListener('contextmenu', (e) => resolve(e.defaultPrevented), { once: true });
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true }));
  }), sel);
}

test('native menu: suppressed on app UI, kept in fields and over a selection', async ({ page }) => {
  await page.goto('/e2e/harness/native-menu.html');
  expect(await prevented(page, '#empty')).toBe(true);
  expect(await prevented(page, '#btn')).toBe(true);
  expect(await prevented(page, '#txt')).toBe(true);
  expect(await prevented(page, '#field')).toBe(false);
  expect(await prevented(page, '#area')).toBe(false);
  expect(await prevented(page, '#ce')).toBe(false);
  await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#txt')!); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); });
  expect(await prevented(page, '#txt')).toBe(false); // copy is useful
  expect(await prevented(page, '#empty')).toBe(false); // selection exists
});

test('WhatsApp chat row: right-click opens the chat menu at the pointer', async ({ page }) => {
  mkdirSync(ART, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/e2e/harness/waha.html');
  const row = page.locator('.wa-row', { hasText: 'Marina Costa' });
  await expect(row).toBeVisible();
  const b = (await row.boundingBox())!;
  const x = b.x + 120, y = b.y + 20;
  await page.mouse.click(x, y, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  for (const t of ['Archive chat', 'Unpin chat', 'Mute notifications', 'Clear chat', 'Delete chat']) await expect(page.getByRole('menuitem', { name: t })).toBeVisible();
  const m = (await menu.boundingBox())!;
  expect(Math.abs(m.x - x)).toBeLessThan(6);
  expect(Math.abs(m.y - y)).toBeLessThan(6);
  await page.screenshot({ path: `${ART}/ctxmenu-wa-row.png` });
  await page.getByRole('menuitem', { name: 'Unpin chat' }).click();
  const calls = await page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls.filter((c) => c.path === '/chat/pin'));
  expect(calls.at(-1)!.body).toMatchObject({ pinned: false });
  // the same menu still opens from the "⋮" button, under it
  await page.locator('.wa-rowwrap', { hasText: 'Papelaria Aurora' }).hover();
  await page.getByRole('button', { name: /^Menu of Papelaria/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Archive chat' })).toBeVisible();
});
