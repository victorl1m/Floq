import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  outputDir: '.tmp/island-pw/results',
  reporter: 'list',
  use: { baseURL: 'http://localhost:1420', viewport: { width: 440, height: 600 }, reducedMotion: 'no-preference', video: 'retain-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://localhost:1420/?window=island', reuseExistingServer: true, timeout: 60_000 },
});
