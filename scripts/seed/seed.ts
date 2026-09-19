import { pino } from 'pino'
import { loadConfig } from '@friendzone/server/config.ts'
import { createPool } from '@friendzone/server/db/pool.ts'
import { contentCounts, seedContent } from '@friendzone/server/content/seed.ts'
import { resolveDataDir } from '@friendzone/server/content/data-dir.ts'

/**
 * `npm run seed` — load every game's content into Postgres.
 *
 * A thin wrapper: the work lives in the server so a single-service deployment
 * can run exactly the same code at boot.
 */
const config = loadConfig()
const logger = pino({ level: 'silent' })
const pool = createPool(config, logger)

try {
  const results = await seedContent(pool, {
    dataDir: resolveDataDir(config.DATA_DIR),
    log: (message) => console.log(message),
  })

  console.log('\nSeeded:')
  for (const r of results) {
    console.log(
      `  ${r.kind.padEnd(9)} ${String(r.loaded).padStart(4)} loaded  ${String(r.skipped).padStart(3)} skipped  (${r.dataset})`,
    )
  }

  const counts = await contentCounts(pool)
  console.log('\nIn the database now:')
  for (const kind of Object.keys(counts).sort()) console.log(`  ${kind.padEnd(9)} ${counts[kind]}`)

  if ((counts['image'] ?? 0) === 0) {
    console.log('\nNo Blur Battle images yet. Run one of:')
    console.log('  npm run dataset:sample   (offline, generated art)')
    console.log('  npm run dataset:fetch    (real photographs from Wikimedia Commons)')
  }
  console.log()
} finally {
  await pool.end()
}
