import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests drive the real browser against the real stack. They assume
 * `docker compose up -d` and a seeded database; the web and API servers are
 * started here so a run is one command.
 */
const WEB_PORT = 5174
const API_PORT = 8080

export default defineConfig({
  testDir: './tests/e2e',
  // Several browser contexts in one test already exercise concurrency; running
  // whole files in parallel against one Postgres adds noise, not coverage.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI'] === 'true' ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // Mobile first, because that is how a party game is actually played.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npx tsx --env-file-if-exists=.env apps/server/src/index.ts',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `npm run dev -w @friendzone/web -- --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})
