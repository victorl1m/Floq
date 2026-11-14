import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 420, height: 640 } });

const list = (page: Page) => page.getByRole('list', { name: 'Artifacts' });
const header = (page: Page, name: string | RegExp) => list(page).getByRole('button', { name });

test('day headers start collapsed, newest day first', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  const headers = list(page).locator('button[aria-expanded]');
  await expect(headers).toHaveCount(3);
  await expect(headers.nth(0)).toContainText('Today');
  await expect(headers.nth(0)).toContainText('1');
  await expect(headers.nth(1)).toContainText('Yesterday');
  await expect(headers.nth(1)).toContainText('2');
  for (let i = 0; i < 3; i++) await expect(headers.nth(i)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('report.md')).toHaveCount(0);
  await expect(page.getByText('/home/user/Artifacts/p1')).toBeVisible();
  await page.screenshot({ path: '.tmp/shots/artifacts-collapsed.png' });
});

test('expanding a day lists its files; opening one shows the viewer', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  await header(page, /Today/).click();
  await expect(header(page, /Today/)).toHaveAttribute('aria-expanded', 'true');
  const today = page.getByRole('list', { name: 'Artifacts from Today' });
  await expect(today.getByRole('listitem')).toHaveCount(1);
  await expect(today).toContainText('report.md');
  await expect(today).toContainText('2.0 KB');
  await expect(today).toContainText('5m ago');
  await page.screenshot({ path: '.tmp/shots/artifacts-expanded.png' });
  await today.getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Contents of report.md')).toContainText('Hello report');
});

test('an opened day stays open across a refresh and closes again on click', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  await header(page, /Yesterday/).click();
  await page.getByRole('button', { name: 'Refresh artifacts' }).click();
  await expect(page.getByRole('list', { name: 'Artifacts from Yesterday' }).getByRole('listitem')).toHaveCount(2);
  await header(page, /Yesterday/).click();
  await expect(page.getByRole('list', { name: 'Artifacts from Yesterday' })).toHaveCount(0);
});

test('download action requests a link from the artifacts endpoint', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  await header(page, /Yesterday/).click();
  await page.getByRole('button', { name: 'Download chart.png' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __links: string[] }).__links)).toEqual(['charts/chart.png']);
});

test('search shows matching days already open; clearing it collapses them again', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  const search = page.getByRole('textbox', { name: 'Search artifacts' });
  await search.fill('Q3');
  await expect(list(page).locator('button[aria-expanded]')).toHaveCount(1);
  await expect(header(page, /Yesterday/)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('list', { name: 'Artifacts from Yesterday' })).toContainText('notes/q3-summary.pdf');
  await expect(page.getByText('charts/chart.png')).toHaveCount(0);
  await page.screenshot({ path: '.tmp/shots/artifacts-search.png' });
  await header(page, /Yesterday/).click();
  await expect(header(page, /Yesterday/)).toHaveAttribute('aria-expanded', 'false');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  const headers = list(page).locator('button[aria-expanded]');
  await expect(headers).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(headers.nth(i)).toHaveAttribute('aria-expanded', 'false');
});

test('search with no match and the clear button', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html');
  const search = page.getByRole('textbox', { name: 'Search artifacts' });
  await search.fill('nothing-like-this');
  await expect(page.getByText('No matching artifacts')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(list(page).locator('button[aria-expanded]')).toHaveCount(3);
});

test('empty state', async ({ page }) => {
  await page.goto('/e2e/harness/artifacts.html?empty=1');
  await expect(page.getByText('No artifacts yet')).toBeVisible();
});
