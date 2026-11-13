import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 760 } });

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: unknown[] }).__calls);

async function open(page: Page) {
  await page.goto('/e2e/harness/browser-link.html');
  await expect(page.getByTestId('browser-node')).toBeVisible();
  await expect(page.getByTestId('agent-node')).toBeVisible();
}
/** Drags from the agent's right connection strip onto the browser's left strip (the same handles agents use to link to each other). */
async function wire(page: Page) {
  const from = (await page.locator('[data-testid="agent-node"] .react-flow__handle-right').first().boundingBox())!;
  const to = (await page.locator('.react-flow__node-browser .react-flow__handle-left').first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2 - 30, to.y + to.height / 2, { steps: 8 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
  await page.mouse.up();
}

test('the browser node has the same four connection strips as agents', async ({ page }) => {
  await open(page);
  for (const side of ['top', 'right', 'bottom', 'left']) await expect(page.locator(`.react-flow__node-browser .react-flow__handle-${side}`)).toHaveCount(1);
  await expect(page.locator('.react-flow__node-browser .react-flow__handle.canvas-side-strip')).toHaveCount(4);
});

test('dragging from an agent handle to a browser handle creates the standard wire, shows the avatar, persists across reload and can be deleted', async ({ page }) => {
  await open(page);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await wire(page);
  const edge = page.locator('.react-flow__edge');
  await expect(edge).toHaveCount(1);
  await expect(edge).toHaveClass(/react-flow__edge-wire/); // the standard wire edge type, not a bespoke one
  await expect(edge.locator('path.react-flow__edge-path')).toHaveCSS('stroke-dasharray', /6/); // manual-link dashes
  expect((await calls(page))[0]).toEqual(['link', expect.any(String), '11111111-1111-4111-8111-111111111111']);
  await expect(page.getByTestId('browser-linked-agent')).toHaveCount(1);
  await page.screenshot({ path: '.tmp/shots/browser-node-link-wire.png' });

  await page.reload();
  await expect(page.getByTestId('browser-node')).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1); // persisted like other wires
  await expect(page.getByTestId('browser-linked-agent')).toHaveCount(1);

  // Re-linking the same pair is a no-op; deleting through the wire's own button unlinks.
  await wire(page);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.locator('.react-flow__edge').click({ force: true, position: { x: 5, y: 5 } });
  await page.locator('.react-flow__edge').evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.getByRole('button', { name: 'Delete link' }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  expect((await calls(page)).some((c) => (c as string[])[0] === 'unlink')).toBe(true);
  await expect(page.getByTestId('browser-linked-agent')).toHaveCount(0);
});

test('closing a node drops its wires', async ({ page }) => {
  await open(page);
  await wire(page);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close browser' }).click();
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  expect((await calls(page)).some((c) => (c as string[])[0] === 'removeNode')).toBe(true);
});

test('resize handles are the agent ones and the size persists', async ({ page }) => {
  await open(page);
  const node = page.locator('.react-flow__node-browser');
  await page.getByTestId('browser-node').click({ position: { x: 120, y: 12 } }); // select via the header
  await expect(page.locator('.react-flow__node-browser .react-flow__resize-control.handle')).toHaveCount(4);
  await expect(page.locator('.react-flow__node-browser .react-flow__resize-control.line')).toHaveCount(4);
  const before = (await node.boundingBox())!;
  const h = (await page.locator('.react-flow__node-browser .react-flow__resize-control.handle.bottom.right').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down(); await page.mouse.move(h.x - 150, h.y - 90, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await node.boundingBox())!.width).toBeLessThan(before.width - 100);
  const after = (await node.boundingBox())!;
  await page.reload();
  await expect(page.getByTestId('browser-node')).toBeVisible();
  const again = (await node.boundingBox())!;
  expect(Math.abs(again.width - after.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(again.height - after.height)).toBeLessThanOrEqual(2);
});
