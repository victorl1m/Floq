import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query = '') => {
  await page.goto(`/e2e/harness/home.html${query}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Victor');
};
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Array<{ name: string; args: unknown }> }).__calls);
const noHorizontalScroll = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('.home-root') as HTMLElement;
  return root.scrollWidth <= root.clientWidth + 1;
});

for (const width of [1280, 820]) {
  for (const theme of ['dark', 'light']) {
    test(`screenshot: home ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 860 });
      await open(page, `?theme=${theme}`);
      await expect(page.getByText('Add your first project')).toBeVisible();
      expect(await noHorizontalScroll(page)).toBe(true);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `.tmp/shots/home-${theme}-${width}.png` });
    });
  }
}

test('screenshot: home filled with projects and recent agents (dark + light, solid)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, '?theme=dark&data=filled');
  await expect(page.locator('[data-agent-avatar]')).toHaveCount(4);
  await page.waitForTimeout(200);
  await page.screenshot({ path: '.tmp/shots/home-filled-dark-1280.png' });
  await open(page, '?data=filled');
  await page.waitForTimeout(200);
  await page.screenshot({ path: '.tmp/shots/home-filled-light-1280.png' });
  await open(page, '?theme=dark&data=filled&material=solid');
  await page.screenshot({ path: '.tmp/shots/home-filled-dark-solid-1280.png' });
  await page.setViewportSize({ width: 560, height: 900 });
  await open(page, '?theme=dark&data=filled');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: '.tmp/shots/home-filled-dark-560.png', fullPage: true });
});

test('Enter sends, Shift+Enter adds a line, and the request keeps its shape', async ({ page }) => {
  await open(page, '?data=filled');
  const field = page.getByRole('textbox', { name: 'Task' });
  await field.click();
  await field.type('Add a health check');
  await field.press('Shift+Enter');
  await field.type('and test it');
  await expect(field).toHaveValue('Add a health check\nand test it');
  expect((await calls(page)).filter((c) => c.name === 'createSession')).toHaveLength(0);
  await field.press('Enter');
  await expect.poll(async () => (await calls(page)).filter((c) => c.name === 'createSession').length).toBe(1);
  const task = (await calls(page)).find((c) => c.name === 'createSession')!.args as Record<string, unknown>;
  expect(task).toMatchObject({ provider: 'claude', projectId: 'p1', workspaceId: 'w1', prompt: 'Add a health check\nand test it', specKit: true, lead: true });
  await expect.poll(async () => (await calls(page)).some((c) => c.name === 'focusOnCanvas')).toBe(true);
  await expect(field).toHaveValue('');
});

test('Start agent is disabled with a reason until a project and a task exist', async ({ page }) => {
  await open(page);
  const start = page.getByRole('button', { name: 'Start agent' });
  await expect(start).toBeDisabled();
  await expect(page.locator('#home-start-reason')).toHaveText('Add a project first');
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('starters fill the composer, focus it, and stay inert over a typed draft', async ({ page }) => {
  await open(page, '?data=filled');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const field = page.getByRole('textbox', { name: 'Task' });
  await page.getByRole('group', { name: 'Prompt starters' }).getByRole('button', { name: 'Fix a bug' }).click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(/find and fix a bug/);
  await field.fill('My own draft');
  await expect(page.getByRole('button', { name: 'Build a feature' })).toBeDisabled();
});

test('recent agents and projects open the canvas; provider and model pickers work', async ({ page }) => {
  await open(page, '?data=filled');
  await page.getByRole('button', { name: /Add rate limiting/ }).click();
  await page.getByRole('button', { name: /^api-gateway/ }).click();
  const log = await calls(page);
  expect(log).toContainEqual({ name: 'focusOnCanvas', args: 'a91e5c22-12f0-4b7b-8f3a-6d0c4e9b7a02' });
  expect(log).toContainEqual({ name: 'openCanvas', args: ['p2', 'w2'] });
  await page.getByRole('button', { name: /^Provider:/ }).click();
  await page.getByRole('menuitem', { name: 'Codex' }).click();
  await expect(page.getByRole('button', { name: /^Provider: Codex/ })).toBeVisible();
});

test('no connected provider: connect actions are offered', async ({ page }) => {
  await open(page, '?data=filled&providers=none');
  await expect(page.getByRole('button', { name: 'Connect Claude or Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Claude or Codex to start' })).toBeVisible();
});

test('attachments: picked files show as chips and can be removed', async ({ page }) => {
  await open(page, '?data=filled');
  await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText('notes.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(page.getByText('notes.txt')).toHaveCount(0);
});

test('backdrop is static and decorative', async ({ page }) => {
  await open(page, '?theme=dark');
  const bd = page.locator('.home-backdrop');
  await expect(bd).toHaveAttribute('aria-hidden', 'true');
  expect(await bd.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await page.locator('canvas').count()).toBe(0);
});
