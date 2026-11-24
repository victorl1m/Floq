import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 760 } });
const ART = process.env.FLOQ_ARTIFACTS_DIR ?? '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f';
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Record<string, unknown>[] }).__sent);
const sentOf = async (page: Page, type: string) => (await sent(page)).filter((m) => m.type === type);
const clear = (page: Page) => page.evaluate(() => ((window as unknown as { __sent: unknown[] }).__sent.length = 0));
const menu = (page: Page) => page.getByTestId('browser-menu');
const item = (page: Page, name: string | RegExp) => menu(page).getByRole('menuitem', { name });

async function open(page: Page, extra = '') {
  await page.goto(`/e2e/harness/browser.html?state=running${extra}`);
  await expect(page.getByTestId('browser-frame')).toBeVisible();
}
async function rightClickPage(page: Page) {
  await expect(menu(page)).toHaveCount(0); // the previous menu finished closing
  const b = (await page.getByTestId('browser-frame').boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await expect(menu(page)).toBeVisible();
}

test('right-click on the page opens the menu with every item, and is not sent to the page', async ({ page }) => {
  await open(page, '&linked=2');
  await clear(page);
  await rightClickPage(page);
  for (const name of ['Back', 'Forward', 'Reload', 'Copy page address', 'Open in your browser', 'Open in new browser node', 'Duplicate node', 'Copy screenshot', 'Save screenshot…', 'Zoom in', 'Zoom out', /Reset zoom/, 'Take control', 'Link to an agent…', 'Unlink agent', 'Close browser']) {
    await expect(item(page, name)).toBeVisible();
  }
  await expect(item(page, 'Forward')).toHaveAttribute('aria-disabled', 'true'); // canForward=false in the harness
  await expect(item(page, 'Back')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(item(page, /Reset zoom/)).toHaveAttribute('aria-disabled', 'true');
  expect((await sentOf(page, 'input.mouse')).filter((m) => m.button === 'right')).toEqual([]);
  await page.screenshot({ path: `${ART}/browser-menu-open.png` });
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
});

test('Shift+right-click goes to the page instead', async ({ page }) => {
  await open(page);
  await clear(page);
  const b = (await page.getByTestId('browser-frame').boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await page.keyboard.up('Shift');
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(async () => (await sentOf(page, 'input.mouse')).filter((m) => m.button === 'right').length).toBeGreaterThan(0);
});

test('navigation and control items send their stream messages', async ({ page }) => {
  await open(page);
  for (const [name, type] of [['Back', 'nav.back'], ['Reload', 'nav.reload']] as const) {
    await clear(page);
    await rightClickPage(page);
    await item(page, name).click();
    await expect.poll(async () => (await sentOf(page, type)).length).toBe(1);
  }
  await clear(page);
  await rightClickPage(page);
  await item(page, 'Take control').click();
  await expect.poll(async () => sentOf(page, 'control.set')).toEqual([{ type: 'control.set', held: true }]);
});

test('zoom in/out/reset change the page viewport (CSS size / zoom, device scale x zoom)', async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await sentOf(page, 'viewport')).length).toBeGreaterThan(0);
  const base = (await sentOf(page, 'viewport')).at(-1) as { width: number; height: number; dpr: number };
  await clear(page);
  await rightClickPage(page);
  await item(page, 'Zoom in').click();
  // Zoom in keeps the menu open so it can be pressed again.
  await expect(menu(page).getByTestId('browser-menu-zoom')).toHaveText('110%');
  await item(page, 'Zoom in').click();
  await expect(menu(page).getByTestId('browser-menu-zoom')).toHaveText('125%');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browser-node')).toHaveAttribute('data-zoom', '1.25');
  await expect.poll(async () => ((await sentOf(page, 'viewport')).at(-1) as { width: number } | undefined)?.width).toBe(Math.round(base.width / 1.25));
  const z = (await sentOf(page, 'viewport')).at(-1) as { width: number; height: number; dpr: number };
  expect(Math.abs(z.dpr - base.dpr * 1.25)).toBeLessThan(0.01);
  await rightClickPage(page);
  await item(page, /Reset zoom/).click();
  await expect(page.getByTestId('browser-node')).toHaveAttribute('data-zoom', '1');
  await expect.poll(async () => ((await sentOf(page, 'viewport')).at(-1) as { width: number }).width).toBe(base.width);
});

test('copy address and copy screenshot use the clipboard; save screenshot downloads a PNG', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(test.info().project.use.baseURL ?? 'http://localhost:1420').origin });
  await open(page);
  await rightClickPage(page);
  await item(page, 'Copy page address').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/');

  await rightClickPage(page);
  await item(page, 'Copy screenshot').click();
  const png = () => page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    if (!items[0]?.types.includes('image/png')) return null;
    const bmp = await createImageBitmap(await items[0].getType('image/png'));
    return { w: bmp.width, h: bmp.height };
  });
  await expect.poll(png).toEqual({ w: 800, h: 400 }); // the frame's full resolution

  await rightClickPage(page);
  const download = page.waitForEvent('download');
  await item(page, 'Save screenshot…').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^example\.com \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
});

test('open in new node, duplicate, link/unlink, close', async ({ page }) => {
  await open(page, '&linked=1');
  await rightClickPage(page);
  await item(page, 'Open in new browser node').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(2);
  // The new node loads the page once its page is bound.
  await expect.poll(async () => (await sentOf(page, 'nav.go')).map((m) => m.url)).toEqual(['https://example.com/']);
  const firstId = await page.getByTestId('browser-node').first().getAttribute('data-node-id');

  const b = (await page.getByTestId('browser-frame').first().boundingBox())!;
  await page.mouse.click(b.x + 20, b.y + 20, { button: 'right' });
  await item(page, 'Duplicate node').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(3);
  const opened = await page.evaluate(() => (window as any).__opened);
  expect(opened[1]).toMatchObject({ url: 'https://example.com/', near: firstId });

  await page.mouse.click(b.x + 20, b.y + 20, { button: 'right' });
  await item(page, 'Link to an agent…').click();
  expect(await page.evaluate(() => (window as any).__startLink)).toEqual([firstId]);

  await page.mouse.click(b.x + 20, b.y + 20, { button: 'right' });
  await item(page, 'Unlink Agent 1').click();
  expect(await page.evaluate(() => (window as any).__unlinks)).toEqual([{ nodeId: firstId!.replace('browser:', ''), sessionId: '00000000-0000-4000-8000-000000000000' }]);

  await clear(page);
  await page.mouse.click(b.x + 20, b.y + 20, { button: 'right' });
  await item(page, 'Close browser').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(2);
  expect((await sentOf(page, 'page.close')).length).toBe(1);
});

test('right-click on the header opens the menu too; the address bar keeps its own menu', async ({ page }) => {
  await open(page);
  await page.locator('.browser-drag').click({ button: 'right', position: { x: 120, y: 12 } });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('Address').click({ button: 'right' });
  await expect(menu(page)).toHaveCount(0);
});
