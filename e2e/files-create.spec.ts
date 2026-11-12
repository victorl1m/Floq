import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 420, height: 640 } });

const created = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __created: unknown[] }).__created);

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/harness/files-tab.html');
  await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
});

test('toolbar New file creates in the root, selects it and opens the dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'New file' }).click();
  const input = page.getByLabel('New file name');
  await expect(input).toBeFocused();
  await input.fill('notes.md');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-tree-path$="notes.md"]')).toHaveAttribute('aria-selected', 'true');
  expect(await created(page)).toEqual([{ parent: '', name: 'notes.md', kind: 'file' }]);
  await page.screenshot({ path: '.tmp/shots/files-create.png' });
});

test('toolbar New folder uses the selected folder, expands it and selects the new folder', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('New folder name').fill('components');
  await page.getByLabel('New folder name').press('Enter');
  const item = page.getByRole('treeitem', { name: 'components' });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await created(page)).toEqual([{ parent: 'src', name: 'components', kind: 'dir' }]);
  await expect(page.getByLabel('Workspace files')).toBeFocused();
});

test('context menu on a folder creates inside it; on a file creates next to it', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'empty', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file…' }).click();
  const input = page.getByLabel('New file name');
  await expect(input).toBeFocused();
  await input.fill('a.txt');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'index.ts' })).toBeVisible();
  await page.getByRole('treeitem', { name: 'index.ts' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder…' }).click();
  await page.getByLabel('New folder name').fill('sibling');
  await page.getByLabel('New folder name').press('Enter');
  await expect(page.getByRole('treeitem', { name: 'sibling' })).toBeVisible();
  expect(await created(page)).toEqual([{ parent: 'empty', name: 'a.txt', kind: 'file' }, { parent: 'src', name: 'sibling', kind: 'dir' }]);
});

test('validation: empty, separators, dot names and duplicates stay inline; Escape and empty blur cancel', async ({ page }) => {
  await page.getByRole('button', { name: 'New file' }).click();
  const input = page.getByLabel('New file name');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Enter a name.');
  for (const [value, message] of [['a/b', /cannot contain/], ['a\\b', /cannot contain/], ['..', /not allowed/], ['.', /not allowed/], ['README.md', /already exists/]] as const) {
    await input.fill(value);
    await expect(page.getByRole('alert')).toHaveText(message);
    await input.press('Enter');
    await expect(input).toBeVisible();
  }
  expect(await created(page)).toEqual([]);
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByLabel('Workspace files')).toBeFocused();
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByLabel('New folder name')).toBeFocused();
  await page.getByLabel('Filter loaded files').focus();
  await expect(page.getByLabel('New folder name')).toHaveCount(0);
});

test('a server error is shown inline and the field stays editable', async ({ page }) => {
  await page.getByRole('button', { name: 'New file' }).click();
  const input = page.getByLabel('New file name');
  await input.fill('boom');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Permission denied by the server');
  await expect(input).toBeEnabled();
  await input.fill('fine.txt');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('typing in the name field does not trigger tree navigation', async ({ page }) => {
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'New file' }).click();
  const input = page.getByLabel('New file name');
  await input.pressSequentially('a b');
  await expect(input).toHaveValue('a b');
  await input.press('ArrowDown');
  await expect(input).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
