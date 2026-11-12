import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 900, height: 700 } });

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/harness/files-tab.html');
  await expect(page.getByRole('treeitem', { name: 'report.docx', exact: true })).toBeVisible();
});

test('docx opens in the dialog as sanitized HTML', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'report.docx', exact: true }).click();
  await expect(page.getByTestId('docx-preview')).toContainText('Hello from the docx fixture');
});

test('xlsx shows a table with sheet tabs', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'data.xlsx', exact: true }).click();
  const table = page.getByTestId('sheet-preview');
  await expect(table.getByRole('cell', { name: 'Apples' })).toBeVisible();
  await page.getByRole('tab', { name: 'Cities' }).click();
  await expect(table.getByRole('cell', { name: 'Lisbon' })).toBeVisible();
});

test('csv shows a table', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'table.csv', exact: true }).click();
  await expect(page.getByTestId('sheet-preview').getByRole('cell', { name: '2' })).toBeVisible();
});

test('pdf renders pages into canvases (no iframe, no blob frame)', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'paper.pdf', exact: true }).click();
  await expect(page.getByTestId('pdf-preview').locator('canvas').first()).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('pdf with a huge page size is clamped to 4096 px per side', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'huge.pdf', exact: true }).click();
  const canvas = page.getByTestId('pdf-preview').locator('canvas').first();
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  expect(Math.max(...size)).toBeLessThanOrEqual(4096);
  expect(Math.max(...size)).toBeGreaterThan(1000);
});

test('docx links open externally in a new window with noopener and never navigate the app', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__opened = []; window.open = ((...args: unknown[]) => { (window as any).__opened.push(args); return null; }) as typeof window.open; });
  await page.reload();
  await page.getByRole('treeitem', { name: 'links.docx', exact: true }).click();
  const link = page.getByTestId('docx-preview').getByRole('link', { name: 'Visit example' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  const before = page.url();
  await link.click();
  expect(page.url()).toBe(before);
  const opened = await page.evaluate(() => (window as any).__opened);
  expect(opened).toEqual([['https://example.com/page', '_blank', 'noopener,noreferrer']]);
});

test('xlsx declaring a huge range stays bounded and shows the truncation note', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'huge.xlsx', exact: true }).click();
  const table = page.getByTestId('sheet-preview');
  await expect(table.getByRole('cell', { name: 'first' })).toBeVisible();
  await expect(table.getByText(/Showing the first 2,000 rows and 100 columns/)).toBeVisible();
  expect(await table.getByRole('row').count()).toBeLessThanOrEqual(2001);
});

test('pptx falls back to no-preview with Download and Open externally', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'deck.pptx', exact: true }).click();
  const box = page.getByTestId('no-preview');
  await expect(box).toContainText('No preview for this file type');
  await expect(box.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Open externally' })).toBeVisible();
});
