// Emoji picker open performance (4x CPU throttle, Vite dev build = React dev mode, so absolute numbers are ~3x a production build):
// best of 3 open/close cycles for the first paint of the picker and the longest task while it opens.
// Before the fix (whole set rendered on open) this measured ~520 ms paint; after, ~90-120 ms on a loaded machine.
import { expect, test } from '@playwright/test';

test('emoji picker opens fast without a long task (4x CPU throttle)', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/e2e/harness/waha-composer.html');
  await page.locator('.wa-row').first().click();
  await expect(page.locator('.wa-composer')).toBeVisible();
  await page.waitForTimeout(1500); // idle preloads settle
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
  });
  let paint = Infinity, long = Infinity, buttons = 0;
  for (let i = 0; i < 3; i++) {
    const res = await page.evaluate(() => new Promise<{ paint: number; long: number; buttons: number }>((resolve) => {
      const w = window as unknown as { __long: number[] };
      w.__long.length = 0;
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Emoji"]')!;
      const t0 = performance.now();
      btn.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const p = performance.now() - t0, b = document.querySelectorAll('.wa-emoji-btn').length;
        setTimeout(() => { const l = Math.max(0, ...w.__long); btn.click(); resolve({ paint: p, long: l, buttons: b }); }, 1200);
      }));
    }));
    paint = Math.min(paint, res.paint); long = Math.min(long, res.long); buttons = res.buttons;
    await page.waitForTimeout(300);
  }
  console.log('EMOJI_PERF', JSON.stringify({ paint, long, buttonsAtPaint: buttons }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  expect(paint).toBeLessThan(150);
  expect(long).toBeLessThan(100);
  expect(buttons).toBeLessThan(100);
});
