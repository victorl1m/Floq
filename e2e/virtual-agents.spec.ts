import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1200, height: 800 } });
const by = (page: import('@playwright/test').Page, name: string) => page.locator(`[data-testid=virtual-agent-node][aria-label^="${name},"]`);
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } }); });

test('renders swarm workers as antigravity nodes, hides killed, follows frames, sends messages', async ({ page }) => {
  await page.goto('/e2e/harness/virtual-agents.html');
  const nodes = page.getByTestId('virtual-agent-node');
  await expect(nodes).toHaveCount(2); // killed one hidden
  const parser = by(page, 'parser');
  await expect(parser).toHaveAttribute('data-provider', 'antigravity');
  await expect(parser.getByTestId('virtual-kind')).toHaveText('swarm');
  await expect(parser.getByTestId('virtual-status')).toHaveText('Working');
  await expect(parser.getByTestId('virtual-activity')).toHaveText('Reading parser.ts');
  await expect(parser.getByTestId('virtual-step')).toHaveCount(2);
  await expect(parser.getByText('▸ Viewing parser.ts')).toBeVisible();
  const tester = by(page, 'tester');
  await expect(tester.getByTestId('virtual-kind')).toHaveText('subagent');
  await expect(tester.getByTestId('virtual-status')).toHaveText('Waiting');
  // Laid out under the host (y > 120), child below its parent.
  const [hb, pb, tb] = await Promise.all([page.locator('.react-flow__node-default').boundingBox(), parser.boundingBox(), tester.boundingBox()]);
  expect(pb!.y).toBeGreaterThan(hb!.y + hb!.height);
  expect(tb!.y).toBeGreaterThan(pb!.y + pb!.height - 1);

  // killed toggle
  await page.getByTestId('virtual-toggle-killed').click();
  await expect(nodes).toHaveCount(3);
  await expect(by(page, 'old-worker').getByTestId('virtual-status')).toHaveText('Killed');
  await page.getByTestId('virtual-toggle-killed').click();
  await expect(nodes).toHaveCount(2);

  // not deletable
  await parser.getByTestId('virtual-kind').click();
  await page.keyboard.press('Delete');
  await expect(nodes).toHaveCount(2);

  // events frame updates a status and adds a node
  await page.evaluate(() => (window as any).__push({ type: 'virtual-agents', projectId: 'p1', hostSessionId: 'host', agents: [
    { id: 'agy:1', hostSessionId: 'host', projectId: 'p1', parentId: 'host', name: 'parser', role: 'worker', kind: 'swarm', model: null, status: 'error', activity: 'boom', steps: 3, lastAt: null, swarmTitle: null, unread: 0 },
    { id: 'agy:9', hostSessionId: 'host', projectId: 'p1', parentId: 'host', name: 'newbie', role: 'worker', kind: 'swarm', model: null, status: 'done', activity: null, steps: 1, lastAt: null, swarmTitle: null, unread: 0 },
  ] }));
  await expect(nodes).toHaveCount(2);
  await expect(by(page, 'parser').getByTestId('virtual-status')).toHaveText('Error');
  await expect(by(page, 'newbie').getByTestId('virtual-status')).toHaveText('Done');

  // message box -> messageVirtualAgent
  const box = by(page, 'parser').getByLabel('Message parser');
  await box.fill('please check the lexer');
  await box.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__sent)).toEqual([{ id: 'agy:1', text: 'please check the lexer' }]);

  // an empty frame clears the host
  await page.evaluate(() => (window as any).__push({ type: 'virtual-agents', projectId: 'p1', hostSessionId: 'host', agents: [] }));
  await expect(nodes).toHaveCount(0);
});

test('an old runtime (404) renders nothing extra', async ({ page }) => {
  await page.goto('/e2e/harness/virtual-agents.html?old=1');
  await expect(page.locator('.react-flow__node-default')).toHaveCount(1);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('virtual-agent-node')).toHaveCount(0);
});

test('a slow REST seed never overwrites a host that already received a frame', async ({ page }) => {
  await page.goto('/e2e/harness/virtual-agents.html?slow=800');
  await expect.poll(() => page.evaluate(() => (window as any).__seeds)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__push({ type: 'virtual-agents', projectId: 'p1', hostSessionId: 'host', agents: [
    { id: 'agy:7', hostSessionId: 'host', projectId: 'p1', parentId: 'host', name: 'fresh', role: 'worker', kind: 'swarm', model: null, status: 'working', activity: null, steps: 1, lastAt: null, swarmTitle: null, unread: 0 },
  ] }));
  await expect(by(page, 'fresh')).toHaveCount(1);
  await page.waitForTimeout(1200); // the (older) seed has resolved by now
  await expect(by(page, 'fresh')).toHaveCount(1);
  await expect(by(page, 'parser')).toHaveCount(0);
});

test('the same agy id under two hosts renders once', async ({ page }) => {
  await page.goto('/e2e/harness/virtual-agents.html?dup=1');
  await expect(page.getByTestId('virtual-agent-node')).toHaveCount(2);
});

test('virtual nodes avoid Floq nodes already placed under the host', async ({ page }) => {
  await page.goto('/e2e/harness/virtual-agents.html?block=1');
  const blocker = page.locator('.react-flow__node-default').filter({ hasText: 'floq subagent' });
  await expect(page.getByTestId('virtual-agent-node')).toHaveCount(2);
  const b = (await blocker.boundingBox())!;
  for (const n of ['parser', 'tester']) {
    const r = (await by(page, n).boundingBox())!;
    const overlap = r.x < b.x + b.width && r.x + r.width > b.x && r.y < b.y + b.height && r.y + r.height > b.y;
    expect(overlap, n).toBe(false);
  }
});
