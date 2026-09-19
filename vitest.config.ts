import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic: reducers, scoring, protocol. No network, no containers.
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
          testTimeout: 10_000,
        },
      },
      {
        // Needs `docker compose up -d`: talks to real Postgres and real Redis,
        // and drives real WebSocket clients against a real server instance.
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts', 'tests/multiplayer/**/*.test.ts'],
          setupFiles: ["./tests/helpers/setup-env.ts"],
          testTimeout: 45_000,
          hookTimeout: 60_000,
          // Rooms and Redis keys are namespaced per file, but a shared Postgres
          // schema means migrations must not race. One file at a time.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      reporter: ['text', 'html'],
    },
  },
})
