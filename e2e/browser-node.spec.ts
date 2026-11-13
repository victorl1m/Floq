import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 760 } });

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Record<string, unknown>[] }).__sent);
const sentOf = async (page: Page, type: string) => (await sent(page)).filter((m) => m.type === type);

async function open(page: Page, state = 'running', extra = '') {
  await page.goto(`/e2e/harness/browser.html?state=${state}${extra}`);
  await expect(page.getByTestId('browser-node')).toBeVisible();
}

test('renders one page, no tab strip, and starts the screencast', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('browser-frame')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByTestId('browser-tab')).toHaveCount(0);
  await expect(page.getByLabel('Address')).toHaveValue('https://example.com/');
  await expect.poll(async () => (await sentOf(page, 'screencast.start')).length).toBeGreaterThan(0);
  const start = (await sentOf(page, 'screencast.start'))[0] as { targetId?: string; maxW: number; maxH: number; quality: number };
  expect(start.targetId).toBeUndefined();
  expect(start.maxW).toBeLessThanOrEqual(1600);
  expect(start.maxH).toBeLessThanOrEqual(1200);
  expect(start.quality).toBe(60);
  const urls = await page.evaluate(() => (window as unknown as { __urls: string[] }).__urls);
  expect(urls[0]).toMatch(/\?node=[a-z0-9]+$/);
  // The viewport follows the live view (debounced), in CSS px.
  await expect.poll(async () => (await sentOf(page, 'viewport')).length).toBeGreaterThan(0);
  const vp = (await sentOf(page, 'viewport'))[0] as { width: number; height: number; dpr: number };
  expect(vp.width).toBeGreaterThanOrEqual(200); expect(vp.height).toBeGreaterThanOrEqual(200); expect(vp.dpr).toBeGreaterThan(0);
});

test('clicks map to page coordinates at two node sizes (letterboxed)', async ({ page }) => {
  await open(page);
  const frame = page.getByTestId('browser-frame');
  const clickAt = async (fx: number, fy: number) => {
    // fx/fy: fraction of the displayed (letterboxed) 400x200 page.
    const b = (await frame.boundingBox())!;
    const k = Math.min(b.width / 400, b.height / 200);
    await page.mouse.click(b.x + (b.width - 400 * k) / 2 + fx * 400 * k, b.y + (b.height - 200 * k) / 2 + fy * 200 * k);
  };
  await clickAt(0.25, 0.5); // -> (100, 100)
  await expect.poll(async () => (await sentOf(page, 'input.mouse')).length).toBeGreaterThan(1);
  let press = (await sentOf(page, 'input.mouse')).find((m) => m.kind === 'mousePressed') as { x: number; y: number; button: string };
  expect(Math.abs(press.x - 100)).toBeLessThanOrEqual(2);
  expect(Math.abs(press.y - 100)).toBeLessThanOrEqual(2);
  expect(press.button).toBe('left');

  // Resize the node (different zoom of the same page) and click the 75% point.
  await page.evaluate(() => ((window as unknown as { __sent: unknown[] }).__sent.length = 0));
  await page.getByTestId('browser-node').click({ position: { x: 100, y: 12 } }); // select -> resizer visible
  const node = page.locator('.react-flow__node').first();
  const handle = page.locator('.react-flow__resize-control.handle.bottom.right');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down(); await page.mouse.move(hb.x - 300, hb.y - 100, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await node.boundingBox())!.width).toBeLessThan(700);
  await page.waitForTimeout(300);
  await page.evaluate(() => ((window as unknown as { __sent: unknown[] }).__sent.length = 0));
  await clickAt(0.75, 0.25); // -> (300, 50)
  await expect.poll(async () => (await sentOf(page, 'input.mouse')).length).toBeGreaterThan(1);
  press = (await sentOf(page, 'input.mouse')).find((m) => m.kind === 'mousePressed') as { x: number; y: number; button: string };
  expect(Math.abs(press.x - 300)).toBeLessThanOrEqual(2);
  expect(Math.abs(press.y - 50)).toBeLessThanOrEqual(2);
});

test('typing sends input.text / input.key and canvas shortcuts do not fire', async ({ page }) => {
  await open(page);
  const frame = page.getByTestId('browser-frame');
  await frame.click({ position: { x: 50, y: 50 } });
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  for (const k of ['l', 'n', 'f', 'Delete']) await page.keyboard.press(k); // canvas shortcut keys
  await expect.poll(async () => (await sentOf(page, 'input.text')).map((m) => m.text).join('')).toBe('hilnf');
  const keys = (await sentOf(page, 'input.key')).filter((m) => m.key === 'Enter');
  expect(keys.map((m) => m.kind)).toEqual(['keyDown', 'keyUp']);
  expect((await sentOf(page, 'input.key')).filter((m) => m.key === 'Delete').map((m) => m.kind)).toEqual(['keyDown', 'keyUp']);
  expect(await page.evaluate(() => (window as unknown as { __kbd: string[] }).__kbd)).toEqual([]);
  // Esc blurs; afterwards keys reach the canvas again.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browser-input')).not.toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __kbd: string[] }).__kbd)).toEqual([]);
});

test('the URL bar sends nav.go and normalizes bare text', async ({ page }) => {
  await open(page);
  const bar = page.getByLabel('Address');
  await bar.fill('example.org/path');
  await bar.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'nav.go')).length).toBe(1);
  expect(await sentOf(page, 'nav.go')).toEqual([{ type: 'nav.go', url: 'https://example.org/path' }]);
  await bar.fill('javascript:alert(1)');
  await bar.press('Enter');
  await page.waitForTimeout(150);
  expect(await sentOf(page, 'nav.go')).toHaveLength(1);
});

test('agent activity pulse and toolbar actions', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('browser-agent-pulse')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __push: (m: unknown) => void }).__push({ type: 'agentActivity', targetId: 't1', at: Date.now() }));
  await expect(page.getByTestId('browser-agent-pulse')).toContainText('Agent is using this page');
  await page.getByRole('button', { name: 'Reload' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  expect((await sentOf(page, 'nav.reload')).length).toBe(1);
  expect((await sentOf(page, 'nav.back')).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Forward' })).toBeDisabled();
});

test('disabled state links to Settings', async ({ page }) => {
  await open(page, 'disabled');
  await expect(page.getByText('Browser is turned off')).toBeVisible();
  await page.getByRole('button', { name: 'Open Settings' }).click();
  expect(await page.evaluate(() => (window as unknown as { __settings: number }).__settings)).toBe(1);
});

test('unavailable and stopped states', async ({ page }) => {
  await open(page, 'unavailable');
  await expect(page.getByText('Browser unavailable')).toBeVisible();
  await open(page, 'stopped');
  await expect(page.getByText('Browser stopped')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();
});

test('closing the node sends page.close, reloading does not', async ({ page }) => {
  await open(page);
  await page.reload();
  await expect(page.getByTestId('browser-node')).toBeVisible();
  expect(await sentOf(page, 'page.close')).toHaveLength(0);
  await page.getByRole('button', { name: 'Close browser' }).click();
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
  expect(await sentOf(page, 'page.close')).toHaveLength(1);
});

test('resize persists across reload and the standard side handles exist', async ({ page }) => {
  await open(page);
  await expect(page.locator('.react-flow__handle')).toHaveCount(4);
  for (const side of ['top', 'right', 'bottom', 'left']) await expect(page.locator(`.react-flow__handle-${side}`)).toHaveCount(1);
  await expect(page.locator('.react-flow__resize-control.handle')).toHaveCount(0); // hidden until selected
  await page.getByTestId('browser-node').click({ position: { x: 100, y: 12 } });
  const handle = page.locator('.react-flow__resize-control.handle.bottom.right');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down(); await page.mouse.move(hb.x - 250, hb.y - 120, { steps: 6 }); await page.mouse.up();
  const node = page.locator('.react-flow__node').first();
  await expect.poll(async () => Math.round((await node.boundingBox())!.width)).toBeLessThan(700);
  const before = (await node.boundingBox())!;
  await page.reload();
  const after = (await page.locator('.react-flow__node').first().boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
});

test('challenge hint appears only for challenge-looking pages', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('browser-challenge-hint')).toHaveCount(0);
  await page.goto('/e2e/harness/browser.html?title=Just%20a%20moment...&url=https%3A%2F%2Fsite.test%2F');
  const hint = page.getByTestId('browser-challenge-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAttribute('role', 'status');
  await expect(hint).toContainText('Verification needed. Complete it here, your clearance is kept for later agent use.');
  await page.screenshot({ path: '.tmp/shots/browser-node-challenge.png' });
});

test('linked agents show as avatars with tooltips', async ({ page }) => {
  await open(page, 'running', '&linked=4');
  const av = page.getByTestId('browser-linked-agent');
  await expect(av).toHaveCount(3);
  await expect(av.first()).toHaveAttribute('title', 'Agent 1');
  await expect(page.getByTestId('browser-node')).toContainText('+1');
  await page.screenshot({ path: '.tmp/shots/browser-node-linked.png' });
  await page.goto('/e2e/harness/browser.html');
  await expect(page.getByTestId('browser-linked-agent')).toHaveCount(0);
  await page.screenshot({ path: '.tmp/shots/browser-node-single-tab.png' });
});

test('the New browser button opens a second node with its own stream', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'New browser' }).first().click();
  await expect(page.getByTestId('browser-node')).toHaveCount(2);
  const urls = await page.evaluate(() => (window as unknown as { __urls: string[] }).__urls);
  expect(new Set(urls).size).toBe(2);
});
