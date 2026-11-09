import { expect, test, type Page } from '@playwright/test';

const shots = '.tmp/memory-design-review';
const user = { id: 'user-design', name: 'Ari Kim', email: 'ari@example.test' };
const org = { id: 'org-design', name: 'Floq Studio', slug: 'floq-studio', role: 'owner', members: [{ ...user, role: 'owner' }] };
const now = '2026-11-09T12:00:00.000Z';
const board = {
  id: 'board-design', organizationId: org.id, title: 'Product planning', createdAt: now,
  lists: [
    { id: 'todo', title: 'To do', position: 0, cards: [
      { id: 'memory-ui', title: 'Refine the memory graph', description: 'Keep the graph legible while preserving the canvas interaction.', position: 0, assigneeId: user.id, dueAt: null, createdAt: now, updatedAt: now },
      { id: 'tokens', title: 'Check light and dark tokens', description: 'Compare the dialog against the Tasks surface.', position: 1, assigneeId: null, dueAt: null, createdAt: now, updatedAt: now },
    ] },
    { id: 'doing', title: 'In progress', position: 1, cards: [
      { id: 'runtime', title: 'Graph endpoint', description: 'Return semantic edges with keyword fallback.', position: 0, assigneeId: user.id, dueAt: null, createdAt: now, updatedAt: now },
    ] },
  ],
};

async function mockTasks(page: Page) {
  await page.addInitScript(({ user, baseUrl }) => {
    localStorage.setItem('floq.connection', JSON.stringify({ baseUrl, token: 'visual-review', user }));
    class QuietSocket {
      static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
      readyState = 1; onmessage: ((event: MessageEvent) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(_url: string) {} send() {} close() { this.readyState = 3; this.onclose?.(); }
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = QuietSocket;
  }, { user, baseUrl: 'https://runtime.memory-design.test' });
  await page.route('https://runtime.memory-design.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const value = path === '/api/auth/get-session' ? { user }
      : path === '/v1/organizations' ? { organizations: [org] }
      : path === `/v1/organizations/${org.id}/boards` ? { boards: [{ id: board.id, organizationId: board.organizationId, title: board.title, createdAt: board.createdAt }] }
      : path === `/v1/task-boards/${board.id}` ? { board }
      : path === '/v1/task-sources' ? { sources: [] }
      : path === '/v1/plugins' ? { plugins: [] }
      : path === '/v1/plugins/updates' ? { updates: [] }
      : path === '/v1/me/role' ? { role: 'owner' }
      : path === '/v1/sessions' ? { sessions: [] }
      : path === '/v1/projects' ? { projects: [] }
      : path === '/v1/info' ? {}
      : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  });
}

test('captures Memory beside the canonical Tasks view across themes and widths', async ({ page }) => {
  await test.step('Tasks reference', async () => {
    await mockTasks(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/harness/tasks.html');
    await expect(page.getByRole('region', { name: /Product planning board/ })).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      await page.screenshot({ path: `${shots}/tasks-${theme}-1280.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 480, height: 800 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      await page.screenshot({ path: `${shots}/tasks-${theme}-480.png`, fullPage: true });
    }
  });

  await test.step('Memory reference', async () => {
    await page.addInitScript(() => localStorage.setItem('floq.memory.view', 'graph'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/harness/memory.html');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      await page.screenshot({ path: `${shots}/memory-${theme}-1280.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 480, height: 800 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      await page.screenshot({ path: `${shots}/memory-${theme}-480.png`, fullPage: true });
    }
  });
});
