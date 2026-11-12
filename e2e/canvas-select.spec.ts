import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 800, height: 600 } });
const sel = (page: Page) => page.evaluate(() => (window as unknown as { __nodes: Array<{ id: string; selected?: boolean }> }).__nodes.filter((n) => n.selected).map((n) => n.id).sort());
const pos = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { __nodes: Array<{ id: string; position: { x: number; y: number } }> }).__nodes.find((n) => n.id === i)!.position, id);

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/harness/canvas-select.html');
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
});

async function marquee(page: Page, x1: number, y1: number, x2: number, y2: number, shot?: string) {
  await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 8 });
  if (shot) await page.screenshot({ path: shot });
  await page.mouse.up();
}

test('marquee partly overlapping two nodes selects both; shift adds; Esc and pane click clear', async ({ page }) => {
  // box from empty space overlaps only the right half of A and left edge of B
  await marquee(page, 250, 60, 380, 160, '.tmp/shots/canvas-marquee.png');
  expect(await sel(page)).toEqual(['a', 'b']);
  await expect(page.locator('.canvas-node-wrap[data-selected="true"]')).toHaveCount(2);
  await page.keyboard.down('Shift'); await marquee(page, 420, 300, 500, 380); await page.keyboard.up('Shift');
  expect(await sel(page)).toEqual(['a', 'b', 'c']);
  await page.locator('[tabindex="0"]').first().focus(); await page.keyboard.press('Escape');
  expect(await sel(page)).toEqual([]);
  await marquee(page, 250, 60, 380, 160);
  expect(await sel(page)).toEqual(['a', 'b']);
  await page.mouse.click(40, 560);
  expect(await sel(page)).toEqual([]);
});

test('dragging a selected node moves the whole multi-selection', async ({ page }) => {
  await marquee(page, 250, 60, 380, 160);
  const [a0, b0, c0] = [await pos(page, 'a'), await pos(page, 'b'), await pos(page, 'c')];
  await page.mouse.move(450, 160); await page.mouse.down(); await page.mouse.move(500, 200, { steps: 6 }); await page.mouse.up();
  const [a1, b1, c1] = [await pos(page, 'a'), await pos(page, 'b'), await pos(page, 'c')];
  expect(a1.x - a0.x).toBeGreaterThan(30); expect(b1.y - b0.y).toBeGreaterThan(25); expect(a1.y - a0.y).toBeCloseTo(b1.y - b0.y, 0);
  expect(a1.x - a0.x).toBeCloseTo(b1.x - b0.x, 0);
  expect(c1).toEqual(c0);
});

test('selection halo and marquee use neutral foreground tokens, not orange', async ({ page }) => {
  await page.mouse.move(250, 60); await page.mouse.down(); await page.mouse.move(380, 160, { steps: 8 });
  const rect = await page.locator('.react-flow__selection').evaluate((el) => {
    const probe = document.createElement('i'); probe.style.color = 'var(--foreground)'; document.body.append(probe);
    const fg = getComputedStyle(probe).color; probe.remove();
    return { border: getComputedStyle(el).borderTopColor, fg };
  });
  await page.mouse.up();
  const nums = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const [r, g, b] = nums(rect.border);
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40); // grey-ish, not orange (#f97316 / #c2410c)
  const halo = await page.locator('.canvas-node-wrap[data-selected="true"]').first().evaluate((el) => {
    const probe = document.createElement('i'); probe.style.color = 'var(--foreground)'; document.body.append(probe);
    const fg = getComputedStyle(probe).color; probe.remove();
    return { accent: getComputedStyle(el).getPropertyValue('--halo-accent').trim(), fg };
  });
  expect(halo.accent.length).toBeGreaterThan(0);
  expect(halo.accent).not.toMatch(/f97316|c2410c|fb923c|ff9f0a/i);
});
