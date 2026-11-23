import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1100, height: 820 } });
const SHOTS = '/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f/waha-full-plugin-update';

for (const theme of ['light', 'dark'] as const) {
  test(`row update icon: only with an update, spinner, toast, new version, error path (${theme})`, async ({ page }) => {
    await page.goto(`/e2e/harness/plugin-update.html?theme=${theme}`);
    const row = (id: string) => page.locator(`[data-plugin="${id}"]`);
    await expect(row('helpdesk')).toBeVisible();
    await expect(row('helpdesk').getByRole('button', { name: 'Update to 1.1.0' })).toBeVisible();
    await expect(row('gitrepo').getByRole('button', { name: 'Update to 0.4.0' })).toBeVisible();
    await expect(row('movidesk').locator('[data-slot="plugin-update"]')).toHaveCount(0);
    await expect(row('current').locator('[data-slot="plugin-update"]')).toHaveCount(0);
    await expect(row('helpdesk').getByText('Update available')).toBeVisible();
    await row('helpdesk').getByRole('button', { name: 'Update to 1.1.0' }).hover();
    await expect(page.getByRole('tooltip', { name: 'Update to 1.1.0' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}-${theme}-available.png` });

    // success: spinner while running, toast, new version, icon gone
    await row('helpdesk').getByRole('button', { name: 'Update to 1.1.0' }).click();
    await expect(row('helpdesk').locator('[data-slot="plugin-update"]')).toHaveAttribute('aria-busy', 'true');
    await page.screenshot({ path: `${SHOTS}-${theme}-updating.png` });
    await expect(page.getByText('Helpdesk updated to v1.1.0')).toBeVisible();
    await expect(row('helpdesk').getByText('v1.1.0')).toBeVisible();
    await expect(row('helpdesk').locator('[data-slot="plugin-update"]')).toHaveCount(0);
    await expect(row('helpdesk').getByText('Update available')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}-${theme}-updated.png` });

    // repository install: inspected first, sha256 passed to the update call; failure keeps the icon
    await page.evaluate(() => { (window as any).__failNext = true; });
    await row('gitrepo').getByRole('button', { name: 'Update to 0.4.0' }).click();
    await expect(page.getByText('Could not update Repo plugin')).toBeVisible();
    await expect(page.getByText('The new version failed to start')).toBeVisible();
    await expect(row('gitrepo').getByText('v0.3.0')).toBeVisible();
    await expect(row('gitrepo').getByRole('button', { name: 'Update to 0.4.0' })).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}-${theme}-error.png` });
    await row('gitrepo').getByRole('button', { name: 'Update to 0.4.0' }).click();
    await expect(row('gitrepo').getByText('v0.4.0')).toBeVisible();
    const calls = await page.evaluate(() => (window as any).__calls);
    expect(calls.filter((c: any) => c.name === 'update').map((c: any) => c.args)).toEqual([
      { id: 'helpdesk', sha256: undefined }, { id: 'gitrepo', sha256: 'abc123' }, { id: 'gitrepo', sha256: 'abc123' },
    ]);
    expect(calls.find((c: any) => c.name === 'inspect').args).toBe('https://github.com/acme/repo-plugin');
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`uninstall from the row: installed plugins only, typed id required, optional data delete (${theme})`, async ({ page }) => {
    await page.goto(`/e2e/harness/plugin-update.html?theme=${theme}`);
    const row = (id: string) => page.locator(`[data-plugin="${id}"]`);
    await expect(row('current')).toBeVisible();
    // bundled plugins cannot be uninstalled
    await expect(row('movidesk').locator('[data-slot="plugin-uninstall"]')).toHaveCount(0);
    await expect(row('current').getByRole('button', { name: 'Uninstall Up to date' })).toBeVisible();

    // keep data: confirm needs the id
    await row('current').getByRole('button', { name: 'Uninstall Up to date' }).click();
    const dialog = page.locator('[data-slot="plugin-uninstall-dialog"]');
    await expect(dialog).toBeVisible();
    const confirm = dialog.locator('[data-slot="plugin-uninstall-confirm"]');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Type current to confirm/).fill('curren');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Type current to confirm/).fill('current');
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: `/home/agent/Artifacts/1151cd0e-3578-48c7-8816-0d0c82f16a7f/plugin-uninstall-${theme}-dialog.png` });
    await confirm.click();
    await expect(page.getByText('Up to date uninstalled')).toBeVisible();
    await expect(row('current')).toHaveCount(0);

    // with data: purge after uninstall
    await row('gitrepo').getByRole('button', { name: 'Uninstall Repo plugin' }).click();
    await dialog.getByLabel(/Type gitrepo to confirm/).fill('gitrepo');
    await dialog.getByRole('checkbox', { name: 'Also delete its data and credentials' }).click();
    await dialog.getByLabel(/Type gitrepo to confirm/).press('Enter');
    await expect(page.getByText('Its data and credentials were deleted too.')).toBeVisible();
    await expect(row('gitrepo')).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).__calls);
    expect(calls.filter((c: any) => c.name === 'uninstall' || c.name === 'purge')).toEqual([
      { name: 'uninstall', args: { id: 'current', confirm: 'current' } },
      { name: 'uninstall', args: { id: 'gitrepo', confirm: 'gitrepo' } },
      { name: 'purge', args: { id: 'gitrepo', confirm: 'gitrepo' } },
    ]);
  });
}
