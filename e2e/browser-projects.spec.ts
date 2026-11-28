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

// Every socket a card opens is recorded with the node's registered owner and the project that was open at the time.
const foreignSockets = (page: import('@playwright/test').Page) => page.evaluate(() => ((window as unknown as { __opened?: Array<{ node: string; owner: string | null; project: string }> }).__opened ?? []).filter((s) => s.owner !== s.project));

test('opening project B never connects to, or shows, a page of project A', async ({ page }) => {
  await page.goto('/e2e/harness/browser-projects.html');
  await page.evaluate(() => { for (const p of ['pA', 'pB']) localStorage.setItem(`floq:browser-nodes:${p}`, JSON.stringify({ nodes: [{ id: 'main', x: 40, y: 40, width: 900, height: 620 }], seen: true })); });
  await page.reload();
  await expect(page.getByTestId('browser-node')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: unknown[] }).__opened?.length ?? 0)).toBeGreaterThan(0);
  await page.getByTestId('to-b').click();
  await expect(page.getByTestId('project')).toHaveText('pB');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('floq:browser-nodes:pB')!).nodes[0].id)).not.toBe('main');
  await page.waitForTimeout(400);
  expect(await foreignSockets(page), 'a node connected before its owner was known, or to another project\'s node').toEqual([]);
});

test('a claim that fails (not a 409) keeps the node disconnected until it succeeds', async ({ page }) => {
  await page.goto('/e2e/harness/browser-projects.html?flaky');
  await page.getByTestId('new-browser').click();
  await expect(page.getByTestId('browser-node')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __opened?: unknown[] }).__opened?.length ?? 0), 'no socket while the node is unclaimed').toBe(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: unknown[] }).__opened?.length ?? 0), { timeout: 8000 }).toBeGreaterThan(0);
  expect(await foreignSockets(page)).toEqual([]);
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

test('an agent connected to the browser never opens a node by itself (agent presence is per user, not per project)', async ({ page }) => {
  await page.goto('/e2e/harness/browser-projects.html?auto');
  await page.evaluate(() => localStorage.setItem('floq:browser-nodes:pA', JSON.stringify({ nodes: [], seen: true })));
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
  await page.getByTestId('to-b').click();
  await page.waitForTimeout(800);
  await expect(page.getByTestId('browser-node')).toHaveCount(0);
});
