import { pino } from 'pino'
import { loadConfig } from '@friendzone/server/config.ts'
import { createPool } from '@friendzone/server/db/pool.ts'
import { runMigrations } from '@friendzone/server/db/migrate.ts'

/**
 * Apply migrations without starting a server.
 *
 * The server migrates at boot, which is what makes a normal deploy work with
 * no extra step. This exists for the cases where that is not what you want: a
 * migration you would rather run and verify before any instance starts serving,
 * or a database you are setting up by hand.
 */
const config = loadConfig()
const logger = pino({ level: config.LOG_LEVEL === 'silent' ? 'info' : config.LOG_LEVEL })
const pool = createPool(config, logger)

try {
  const applied = await runMigrations(pool, logger)
  logger.info(applied === 0 ? 'database is already up to date' : `applied ${applied} migration(s)`)
} finally {
  await pool.end()
}
