import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'workflow.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
