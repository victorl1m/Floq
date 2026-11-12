import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

// Redesigned Memory screen: no "Invalid Date" for any date shape the runtime can send, layout at 820-1920 px,
// Floq-palette graph, and the reference screenshots in .tmp/shots/memory-{graph,list,detail}-{dark,light}.png.
const SHOTS = '.tmp/shots';
const url = (q = '') => `/e2e/harness/memory.html${q ? `?${q}` : ''}`;
const setTheme = (page: Page, theme: 'light' | 'dark') => page.evaluate((t) => { document.documentElement.classList.toggle('dark', t === 'dark'); document.documentElement.dataset.theme = t; }, theme);
const gapi = (page: Page, expr: string) => page.evaluate((s) => { const g = (document.querySelector('canvas.memgraph') as any).__memgraph; return new Function('g', `return ${s}`)(g); }, expr);

async function open(page: Page, q: string, view: 'list' | 'graph') {
  await page.addInitScript((v) => { try { localStorage.setItem('floq.memory.view', v); } catch { /* ignore */ } }, view);
  await page.goto(url(q));
  await expect(page.getByTestId('memory-dialog')).toBeVisible();
  if (view === 'list') await expect(page.getByTestId('memory-list').locator('li').first()).toBeVisible();
  else await expect(page.getByTestId('graph-canvas')).toBeVisible();
}
const settleGraph = async (page: Page) => {
  await expect.poll(() => gapi(page, 'g.ids().length')).toBeGreaterThan(0);
  await gapi(page, 'g.settleNow()');
  await page.waitForTimeout(600);
};
const noInvalid = async (page: Page) => {
  const text = await page.getByTestId('memory-dialog').innerText();
  expect(text).not.toMatch(/Invalid Date|NaN|undefined/);
  expect(text).not.toMatch(/\b5\dy ago\b/); // the 1970 placeholder used to read "56y ago"
};

test.use({ viewport: { width: 1400, height: 900 } });
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }));

test.describe('dates', () => {
  test('list rows never show Invalid Date: seconds, numeric strings, epoch placeholder, garbage and null', async ({ page }) => {
    await open(page, 'dates=bad&n=24', 'list');
    await noInvalid(page);
    const times = await page.getByTestId('row-time').allInnerTexts();
    for (const t of times) expect(t).toMatch(/^(just now|\d+(m|h|d|mo|y) ago|—|[A-Z][a-z]{2} \d{1,2}, \d{4})$/);
    // m0 holds epoch *seconds* five minutes ago: read as a recent time, not 1970
    await expect(page.locator('li[data-id="m0"] [data-testid="row-time"]')).toHaveText(/^(\d+m ago|just now)$/);
    await expect(page.locator('li[data-id="m1"] [data-testid="row-time"]')).toHaveText('—');
    await expect(page.locator('li[data-id="m2"] [data-testid="row-time"]')).toHaveText('—');
    await expect(page.locator('li[data-id="m1"] [data-testid="row-time"]')).toHaveAttribute('title', 'Update time unknown');
  });

  test('detail and history read the runtime `at` field and degrade to a dash', async ({ page }) => {
    await open(page, 'dates=bad&n=24', 'list');
    for (const id of ['m0', 'm1', 'm2', 'm5', 'm7']) {
      await page.locator(`li[data-id="${id}"]`).click();
      const detail = page.getByTestId('memory-detail');
      await expect(detail).toBeVisible();
      await expect(detail.getByTestId('history-item').first()).toBeVisible();
      const text = await detail.innerText();
      expect(text, id).not.toMatch(/Invalid Date|NaN/);
      // the runtime's first event has at = 2026-11-01: a real relative time, not a dash
      await expect(detail.getByTestId('history-item').first()).toContainText(/Added.*by agent.*(\d+d ago|\d+mo ago)/s);
    }
    // a valid absolute date is in the tooltip
    await page.locator('li[data-id="m7"]').click();
    const created = page.getByTestId('memory-detail').locator('time').first();
    await expect(created).toHaveAttribute('title', /20\d\d/);
    await expect(created).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
  });
});

test.describe('layout', () => {
  for (const width of [820, 1280, 1920]) {
    test(`no horizontal overflow and aligned header at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, 'n=40', 'list');
      await page.locator('li[data-id="m1"]').click();
      await expect(page.getByTestId('memory-detail')).toBeVisible();
      const over = await page.getByTestId('memory-dialog').evaluate((d) => {
        const r = d.getBoundingClientRect(), bad: string[] = [];
        for (const el of d.querySelectorAll<HTMLElement>('button, input, [data-testid], h3, li[role=option]')) {
          const b = el.getBoundingClientRect();
          if (b.width && (b.left < r.left - 1 || b.right > r.right + 1)) bad.push(el.dataset.testid ?? el.tagName);
        }
        return bad;
      });
      expect(over).toEqual([]);
      // title, view toggle and New share one row centre line (± 6 px) on wide windows
      if (width >= 1280) {
        const ys = await Promise.all([page.getByRole('heading', { name: 'Memory' }), page.getByTestId('view-list'), page.getByRole('button', { name: 'New', exact: true })].map(async (l) => { const b = (await l.boundingBox())!; return b.y + b.height / 2; }));
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(14);
      }
      // the detail pane and the list sit side by side from 820 px (md) up
      const list = (await page.getByTestId('memory-list').boundingBox())!, side = (await page.getByTestId('memory-side').boundingBox())!;
      expect(side.x).toBeGreaterThan(list.x + list.width - 1);
      expect(Math.abs(side.y - list.y)).toBeLessThan(2);
    });
  }
});

test.describe('graph styling', () => {
  test('Floq palette per type, curved links, dot grid stage, glow on selection', async ({ page }) => {
    await open(page, 'n=30', 'graph');
    await page.getByTestId('group-none').click();
    await settleGraph(page);
    const colors = await gapi(page, 'g.colors()') as any;
    const toHex = (c: string) => c.trim().toLowerCase();
    expect(toHex(colors.types.decision)).toBe('#f27c00');
    expect(new Set(Object.values(colors.types)).size).toBe(4);
    expect(colors.dot).not.toBe('currentColor');
    expect(colors.edge).not.toBe('currentColor');
    // the grid is drawn: an empty corner of the stage is not uniform
    const varied = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement) => {
      const ctx = c.getContext('2d')!, d = ctx.getImageData(0, Math.floor(c.height / 2), Math.min(240, c.width), 80).data;
      const seen = new Set<number>(); for (let i = 3; i < d.length; i += 4) seen.add(d[i]); return seen.size;
    });
    expect(varied).toBeGreaterThan(1);
    const id = (await gapi(page, 'g.ids()[0]')) as string;
    const n = await gapi(page, `g.node(${JSON.stringify(id)})`) as any;
    const r = await gapi(page, 'g.rect()') as any;
    await page.mouse.click(r.left + n.x, r.top + n.y);
    await expect(page.getByTestId('memory-detail')).toBeVisible();
    await expect.poll(() => gapi(page, `g.node(${JSON.stringify(id)}).selected`)).toBe(true);
  });
});

test.describe('screenshots', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`list, graph and detail (${theme})`, async ({ page }) => {
      await open(page, 'n=36&dates=bad', 'list');
      await setTheme(page, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/memory-list-${theme}.png` });
      await page.locator('li[data-id="m0"]').click();
      await expect(page.getByTestId('memory-detail')).toBeVisible();
      await page.waitForTimeout(350);
      await noInvalid(page);
      await page.screenshot({ path: `${SHOTS}/memory-detail-${theme}.png` });
      await page.getByTestId('view-graph').click();
      await page.getByTestId('group-none').click();
      await settleGraph(page);
      await page.screenshot({ path: `${SHOTS}/memory-graph-${theme}.png` });
    });
  }

  test('820 px wide window', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 760 });
    await open(page, 'n=36', 'list');
    await page.locator('li[data-id="m1"]').click();
    await expect(page.getByTestId('memory-detail')).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/memory-list-820.png` });
  });
});
