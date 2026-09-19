import { existsSync } from 'node:fs'

/**
 * Integration tests talk to the same Postgres and Redis that `docker compose
 * up` starts, and read their addresses from the same .env the server does.
 * Loading it here means a test run and a dev run cannot drift apart.
 */
if (existsSync('.env')) {
  process.loadEnvFile('.env')
}
