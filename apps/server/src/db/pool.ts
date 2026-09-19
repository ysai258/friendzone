import pg from 'pg'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'

/**
 * Postgres is a dependency of durability, not of gameplay. Nothing on the
 * realtime path awaits a query: writes are recorded at lifecycle boundaries
 * (room created, game started, results final) and a failure there degrades the
 * record, never the round in progress. See docs/reliability.md.
 */
export function createPool(config: Config, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    // Fail fast rather than pile up connections behind a struggling database.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // A realtime handler must never be the thing that waits on a slow query.
    statement_timeout: 10_000,
    application_name: 'friendzone',
  })

  pool.on('error', (error) => {
    // An idle client dropped. The pool replaces it; this must not take down
    // the process, which would disconnect every player on this instance.
    logger.error({ err: error }, 'idle postgres client error')
  })

  return pool
}

export type { Pool } from 'pg'
