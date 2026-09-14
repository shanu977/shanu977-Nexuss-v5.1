import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: { NEXT_PUBLIC_E2E_TEST_MODE: '1' },
  },
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
  },
});

