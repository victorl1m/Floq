import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 900 } });

test('Changes is its own toolbar button, identity sits left and the toolbar is window-centred, and it opens the review dialog', async ({ page }) => {
  await page.goto('/e2e/harness/changes.html');
  const button = page.getByRole('button', { name: /^Changes on .* \(99\+\)$/ });
  await expect(button).toBeVisible();
  await expect(button).toContainText('99+');
  await expect(button.locator('svg')).toBeVisible();
  await expect(button.locator('svg.tabler-icon-git-branch')).toHaveCount(0);
  await expect(page.locator('svg.tabler-icon-git-branch')).toHaveCount(0);
  const identity = page.locator('.canvas-titlebar-identity');
  await expect(identity).toContainText('Proj');
  await expect(identity).toContainText('feature/very-long-branch-name-here');
  const id = (await identity.boundingBox())!;
  const tb = (await page.locator('.canvas-titlebar-center').boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(Math.abs(tb.x + tb.width / 2 - vw / 2)).toBeLessThan(2);
  expect(id.x + id.width).toBeLessThanOrEqual(tb.x);
  expect(id.x).toBeLessThan(vw / 4);
  await expect(identity).toHaveAttribute('data-tauri-drag-region', 'true');
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
  expect(tabs.core).toEqual(['files', 'conversations', 'artifacts']);
  expect(tabs.resolvedChanges).toBe('files');
});

for (const theme of ['light', 'dark']) {
  test(`Changes dialog list scrolls inside the dialog and screenshots (${theme})`, async ({ page }) => {
    await page.goto('/e2e/harness/changes.html');
    if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.getByRole('button', { name: /^Changes on / }).click();
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
  await expect(page.getByRole('button', { name: /^Changes on / })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: '.tmp/shots/toolbar-820.png', clip: { x: 0, y: 0, width: 820, height: 60 } });
});

for (const width of [1280, 820]) {
  test(`toolbar is window-centred and never overlaps the identity at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto('/e2e/harness/changes.html');
    await expect(page.getByRole('button', { name: /^Changes on / })).toBeVisible();
    await page.waitForTimeout(200);
    const tb = (await page.locator('.canvas-titlebar-center').boundingBox())!;
    const id = (await page.locator('.canvas-titlebar-identity').boundingBox())!;
    expect(Math.abs(tb.x + tb.width / 2 - width / 2)).toBeLessThan(2);
    expect(id.x + id.width).toBeLessThanOrEqual(tb.x + 0.5);
  });
}
