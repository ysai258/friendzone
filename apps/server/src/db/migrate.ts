import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Pool } from 'pg'
import type { Logger } from '../logger.ts'

/**
 * A migration runner small enough to read in one sitting.
 *
 * Files are applied in filename order, each inside its own transaction, and a
 * row is written to schema_migrations as part of that same transaction. A
 * crash mid-migration therefore leaves either the whole file applied and
 * recorded, or neither.
 *
 * An advisory lock serialises concurrent boots: when three instances start at
 * once, one migrates and the others wait, then find nothing to do.
 */

const LOCK_ID = 8_213_004 // arbitrary, but must be stable across deploys

export async function runMigrations(pool: Pool, logger: Logger): Promise<number> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const applied = new Set(rows.map((r) => r.name))

    let count = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      logger.info({ migration: file }, 'applying migration')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        count++
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    if (count > 0) logger.info({ count }, 'migrations applied')
    return count
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined)
    client.release()
  }
}
