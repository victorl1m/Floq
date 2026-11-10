import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 900 } });

test('toolbar Changes button shows a capped badge and opens the review dialog', async ({ page }) => {
  await page.goto('/e2e/harness/changes.html');
  const button = page.getByRole('button', { name: 'Changes (99+)' }).first();
  await expect(button).toBeVisible();
  await expect(button).toContainText('99+');
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/files? changed/i).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('sidebar no longer has a Changes tab and a stored "changes" tab resolves to Files', async ({ page }) => {
  await page.goto('/e2e/harness/changes.html');
  const tabs = await page.evaluate(() => (window as any).__tabs);
  expect(tabs.core).toEqual(['files', 'conversations', 'app']);
  expect(tabs.resolvedChanges).toBe('files');
});

for (const theme of ['light', 'dark']) {
  test(`Changes dialog list scrolls inside the dialog and screenshots (${theme})`, async ({ page }) => {
    await page.goto('/e2e/harness/changes.html');
    if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('button', { name: /Changes \(/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/files changed/i).first()).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const scroller = dialog.locator('.overflow-y-auto').first();
    const sb = (await scroller.boundingBox())!;
    expect(sb.y + sb.height).toBeLessThanOrEqual(box.y + box.height + 1);
    const metrics = await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; return { client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop }; });
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    expect(metrics.top).toBeGreaterThan(0);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `.tmp/shots/changes-dialog-${theme}.png` });
  });
}

test('titlebar toolbar does not overflow at 820px', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await page.goto('/e2e/harness/changes.html');
  await expect(page.getByRole('button', { name: /Changes \(/ }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: '.tmp/shots/toolbar-820.png', clip: { x: 0, y: 0, width: 820, height: 60 } });
});
