import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 760 } });

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __import: Record<string, unknown>[] }).__import);

async function openDialog(page: Page) {
  await page.goto('/e2e/harness/browser.html?state=running');
  await expect(page.getByTestId('browser-node')).toBeVisible();
  await page.getByRole('button', { name: 'Import cookies and data' }).click();
  await expect(page.getByTestId('browser-import-dialog')).toBeVisible();
}
const file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

test('preview lists domains with checkboxes and the agent warning; commit sends only the chosen domains', async ({ page }) => {
  await openDialog(page);
  await page.getByTestId('browser-import-file').setInputFiles(file('cookies.txt', '.example.com\tTRUE\t/\tTRUE\t0\ta\tb'));
  await expect(page.getByTestId('import-domain')).toHaveCount(2);
  await expect(page.getByTestId('browser-import-dialog')).toContainText('example.com');
  await expect(page.getByTestId('browser-import-dialog')).toContainText('1 expired skipped');
  await expect(page.getByTestId('import-warning')).toContainText('Agents will act as you');
  await page.getByRole('checkbox', { name: 'Import other.org' }).click();
  await page.getByRole('checkbox', { name: 'Import bookmarks' }).click();
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('browser-import-dialog')).toBeHidden();
  const c = (await calls(page)).find((x) => x.commit) as { commit: { domains: string[]; bookmarks: boolean } };
  expect(c.commit.domains).toEqual(['example.com']);
  expect(c.commit.bookmarks).toBe(false);
});

test('Import stays disabled with nothing selected; an unreadable file shows the error and no commit', async ({ page }) => {
  await openDialog(page);
  await page.getByTestId('browser-import-file').setInputFiles(file('x.txt', 'bad data'));
  await expect(page.getByTestId('import-error')).toContainText('Nothing importable');
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  await page.getByTestId('browser-import-file').setInputFiles(file('cookies.txt', 'ok'));
  await page.getByRole('checkbox', { name: 'Import example.com' }).click();
  await page.getByRole('checkbox', { name: 'Import other.org' }).click();
  await page.getByRole('checkbox', { name: 'Import bookmarks' }).click();
  await expect(page.getByTestId('import-commit')).toBeDisabled();
  expect((await calls(page)).some((x) => x.commit)).toBe(false);
});
