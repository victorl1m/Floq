// Deleted messages (Show original), edited messages (Edited -> edit history) and stickers in the WhatsApp conversation log, light and dark,
// through the ?demo=bubbles harness. Screenshots: waha-edits-*.png in the Artifacts folder (WAHA_SHOTS overrides).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.WAHA_SHOTS ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const WIDE = { width: 1000, height: 760 };

async function open(page: Page, theme: string, extra = '') {
  await page.setViewportSize(WIDE);
  await page.goto('/e2e/harness/waha-bubbles.html?demo=bubbles' + (theme === 'dark' ? '&theme=dark' : '') + extra);
  await expect(page.locator('.wa-msg').first()).toBeAttached({ timeout: 20_000 });
}
async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>) {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  if (target) await target.screenshot({ path: path.join(shots, `waha-edits-${name}.png`) });
  else await page.screenshot({ path: path.join(shots, `waha-edits-${name}.png`) });
}
const deleted = (page: Page) => page.locator('.wa-msg[data-kind="deleted"]');
/** A row pinned by its message id (its button text changes once clicked). */
const pin = async (page: Page, loc: ReturnType<Page['locator']>) => page.locator(`.wa-msg[data-mid="${await loc.getAttribute('data-mid')}"]`);
const opaque = (c: string) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c);

for (const theme of ['light', 'dark']) {
  test.describe(theme, () => {
    test('a deleted message shows WhatsApp\'s placeholder and reveals the original Floq kept', async ({ page }) => {
      await open(page, theme);
      const row = await pin(page, deleted(page).filter({ has: page.getByRole('button', { name: 'Show original' }) }).first());
      await row.scrollIntoViewIfNeeded();
      await expect(row).toContainText('This message was deleted');
      await expect(row.locator('.wa-del em, .wa-del')).toHaveCSS('font-style', 'italic');
      await expect(row.locator('.wa-orig')).toHaveCount(0);
      await row.getByRole('button', { name: 'Show original' }).click();
      const orig = row.locator('.wa-orig');
      await expect(orig).toBeVisible();
      await expect(orig).toContainText(/Deleted .+/);
      await expect(orig).toContainText('Preço especial só hoje');
      await expect(orig.locator('.wa-quote')).toContainText('Chegaram');
      // The kept photo loads from Floq's copy.
      await expect(orig.locator('img')).toBeVisible();
      expect(await orig.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await row.scrollIntoViewIfNeeded();
      await shot(page, theme + '-deleted-original');
      await row.getByRole('button', { name: 'Hide original' }).click();
      await expect(orig).toHaveCount(0);
      // Never received: says so.
      const lost = await pin(page, deleted(page).filter({ has: page.getByRole('button', { name: 'Original not received' }) }).first());
      await lost.getByRole('button', { name: 'Original not received' }).click();
      await expect(lost.locator('.wa-orig')).toContainText('Floq did not receive this message');
      // Mine.
      const mine = await pin(page, deleted(page).filter({ hasText: 'You deleted this message' }).filter({ has: page.getByRole('button', { name: 'Show original' }) }).first());
      await mine.getByRole('button', { name: 'Show original' }).click();
      await expect(mine.locator('.wa-orig')).toContainText('Mandei o endereço errado');
      await mine.scrollIntoViewIfNeeded();
      await shot(page, theme + '-deleted-states');
      // Message info of a deleted message: when and by whom.
      await mine.locator('.wa-bubble').hover();
      await mine.locator('.wa-chev').click();
      await page.getByRole('menuitem', { name: /info/i }).click();
      const dlg = page.getByRole('dialog');
      await expect(dlg).toContainText('Deleted');
      await expect(dlg).toContainText('by you');
      await shot(page, theme + '-deleted-info');
    });

    test('group: deleted by an admin names the admin', async ({ page }) => {
      await open(page, theme, '&chat=group');
      const row = deleted(page).filter({ hasText: 'deleted by admin Bia Nogueira' });
      await expect(row).toHaveCount(1);
      await row.scrollIntoViewIfNeeded();
      await row.getByRole('button', { name: 'Show original' }).click();
      await expect(row.locator('.wa-orig')).toContainText('Link de grupo de ofertas');
      await shot(page, theme + '-deleted-admin');
    });

    test('an edited message says Edited next to the time and opens its edit history', async ({ page }) => {
      await open(page, theme);
      const row = page.locator('.wa-msg', { hasText: 'Chegamos às' });
      await row.scrollIntoViewIfNeeded();
      const label = row.getByRole('button', { name: /Edited/ });
      await expect(label).toBeVisible();
      await expect(row.locator('.wa-stamp')).toContainText('Edited');
      await shot(page, theme + '-edited-bubble', page.locator('.wa-log'));
      await label.click();
      const dlg = page.getByRole('dialog');
      await expect(dlg).toContainText('Edit history');
      const items = dlg.locator('.wa-vers li');
      await expect(items).toHaveCount(3);
      await expect(items.nth(0)).toContainText('Original');
      await expect(items.nth(0)).toContainText('Chegamos às 15h na loja');
      await expect(items.nth(2)).toContainText('Current');
      await expect(items.nth(2)).toContainText('Chegamos às *15h30* na loja');
      await shot(page, theme + '-edit-history');
    });

    test('stickers: no bubble, about 160px, transparent, lazy loaded, tap to enlarge; a lottie one is a still', async ({ page }) => {
      await open(page, theme);
      const stickers = page.locator('.wa-msg[data-kind="sticker"]');
      await expect(stickers).toHaveCount(4);
      const anim = stickers.nth(1);
      await anim.scrollIntoViewIfNeeded();
      const img = anim.locator('.wa-sticker img');
      await expect(img).toBeVisible();
      expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      const box = await anim.locator('.wa-sticker').boundingBox();
      expect(Math.round(box!.width)).toBe(160);
      expect(Math.round(box!.height)).toBe(160);
      expect(opaque(await anim.locator('.wa-bubble').evaluate((e) => getComputedStyle(e).backgroundColor))).toBe(false);
      expect(opaque(await anim.locator('.wa-sticker').evaluate((e) => getComputedStyle(e).backgroundColor))).toBe(false);
      await expect(stickers.nth(3).locator('.wa-sticker-still')).toBeVisible();
      await expect(stickers.nth(3).getByRole('img', { name: /Animated sticker/ })).toBeVisible();
      await stickers.nth(3).scrollIntoViewIfNeeded();
      await shot(page, theme + '-stickers');
      // Tap to enlarge.
      await anim.locator('.wa-img-btn').click();
      await expect(page.locator('.wa-lb, [class*="wa-lb"]').first()).toBeVisible();
      await shot(page, theme + '-sticker-enlarged');
    });
  });
}
