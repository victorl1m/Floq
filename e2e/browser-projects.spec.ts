import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 760 } });

test('a Browser node belongs to the project it was created on', async ({ page }) => {
  await page.goto('/e2e/harness/browser-projects.html');
  await expect(page.getByTestId('project')).toHaveText('pA');
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
  await page.getByTestId('new-browser').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(1);

  await page.getByTestId('to-b').click();
  await expect(page.getByTestId('project')).toHaveText('pB');
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
  await page.waitForTimeout(300); // a stale list must not be written under B afterwards
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('floq:browser-nodes:pB'))).toBeNull();

  await page.getByTestId('to-a').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(1);
});

test('legacy shared "main" page: only the owning project keeps it, the other gets a fresh page', async ({ page }) => {
  await page.goto('/e2e/harness/browser-projects.html');
  await page.evaluate(() => {
    const node = { id: 'main', x: 40, y: 40, width: 900, height: 620 };
    for (const p of ['pA', 'pB']) localStorage.setItem(`floq:browser-nodes:${p}`, JSON.stringify({ nodes: [node], seen: true }));
  });
  await page.reload();
  await expect(page.getByTestId('browser-node')).toHaveCount(1); // A claims "main"
  await page.getByTestId('to-b').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('floq:browser-nodes:pB')!).nodes[0].id)).not.toBe('main');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('floq:browser-nodes:pA')!).nodes[0].id)).toBe('main');
});
