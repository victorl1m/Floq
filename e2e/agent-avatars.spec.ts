import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 980, height: 500 } });

test('agents get different, stable Floq avatars with a provider badge; the setting falls back to logos', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html');
  const avatars = page.locator('#avatars [data-agent-avatar] svg[data-avatar-shape]');
  await expect(avatars).toHaveCount(3);
  const html = await avatars.evaluateAll((els) => els.map((e) => e.outerHTML));
  expect(new Set(html).size).toBe(3);
  await page.screenshot({ path: '.tmp/shots/agent-avatars.png' });
  await page.reload();
  await expect(avatars).toHaveCount(3);
  expect(await avatars.evaluateAll((els) => els.map((e) => e.outerHTML))).toEqual(html);
  await expect(page.locator('#avatars [data-avatar-badge] svg').first()).toBeVisible();
  await page.evaluate(() => { localStorage.setItem('floq.robotAvatars', 'off'); window.dispatchEvent(new Event('floq:robot-avatars')); });
  await expect(page.locator('[data-agent-avatar]')).toHaveCount(0);
});

test('generator is deterministic and varied across seeds', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html');
  const out = await page.evaluate(async () => {
    const m = await import('/src/lib/robot-avatar.ts' as string);
    const seeds = Array.from({ length: 200 }, (_, i) => `${i.toString(16)}-seed-${i * 7919}`);
    const specs = seeds.map((s) => JSON.stringify(m.avatarSpec(s)));
    return {
      same: seeds.every((s, i) => JSON.stringify(m.avatarSpec(s)) === specs[i] && m.robotAvatarSvg(s) === m.robotAvatarSvg(s)),
      distinct: new Set(specs).size,
      colors: new Set(seeds.map((s) => m.avatarSpec(s).color)).size,
      shapes: new Set(seeds.map((s) => m.avatarSpec(s).shape)).size,
      eyes: new Set(seeds.map((s) => m.avatarSpec(s).eyes)).size,
      pinned: m.avatarSpec('3f2c1b9a-7d4e-4a10-9c55-0b1f6e2a8d11'),
    };
  });
  expect(out.same).toBe(true);
  expect(out.distinct).toBeGreaterThan(180);
  expect(out.colors).toBe(10);
  expect(out.shapes).toBe(9);
  expect(out.eyes).toBe(6);
  // Same seed = same avatar forever: pin one seed so a table reorder fails loudly.
  expect(out.pinned).toEqual({ color: expect.any(String), shape: expect.any(String), eyes: expect.any(String), rotate: expect.any(Number), shine: expect.any(Boolean) });
  expect(JSON.stringify(out.pinned)).toMatchSnapshot('pinned-seed.txt');
});

test('badge sits inside the bottom-right corner and never covers the eyes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1240, height: 1000 });
    await page.goto(`/e2e/harness/agent-avatars.html?grid=1&theme=${theme}`);
    const avatars = page.locator('#grid [data-agent-avatar]');
    await expect(avatars).toHaveCount(24 * 3 + 1);
    const bad = await avatars.evaluateAll((els) => els.flatMap((el) => {
      const a = el.getBoundingClientRect();
      const b = el.querySelector('[data-avatar-badge]')!.getBoundingClientRect();
      const issues: string[] = [];
      if (b.right > a.right + 0.5 || b.bottom > a.bottom + 0.5 || b.right < a.right - 0.5 || b.bottom < a.bottom - 0.5) issues.push('badge not flush in corner');
      for (const eye of el.querySelectorAll('[data-eye]')) {
        const e = eye.getBoundingClientRect();
        if (e.right > b.left + 0.5 && e.bottom > b.top + 0.5) issues.push(`eye under badge ${el.querySelector('svg')!.getAttribute('data-avatar-shape')} @${a.width}`);
      }
      return issues;
    }));
    expect(bad).toEqual([]);
    await page.locator('#grid').screenshot({ path: `.tmp/shots/avatars-floq-${theme}.png` });
    await page.locator('.react-flow__node').first().screenshot({ path: `.tmp/shots/avatars-floq-card-${theme}.png` });
    await page.locator('#chip').screenshot({ path: `.tmp/shots/avatars-floq-chip-${theme}.png` });
  }
});

test('card header: state label, role chips inside pills, no dot, link button or in-context chip', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html');
  await expect(page.getByTestId('agent-state')).toHaveText(['Failed']);
  await expect(page.getByText('Orchestrator', { exact: true })).toBeVisible();
  await expect(page.getByText('Implementer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('in-context-badge')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Link .* to another agent$/ })).toHaveCount(0);
});

test('card footer: transparent message input, no activity dots; screenshot', async ({ page }) => {
  await page.goto('/e2e/harness/agent-avatars.html?theme=dark');
  const input = page.locator('.canvas-node-message-input').first();
  await expect(input).toBeVisible();
  expect(await input.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  await expect(page.locator('.canvas-node-message-bar [role="status"]')).toHaveCount(0);
  await page.locator('[data-slot="sidebar-inner"], .react-flow__node').first().screenshot({ path: '.tmp/shots/agent-card-after.png' });
});
