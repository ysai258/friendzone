import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { normalizeAnswer } from '@friendzone/shared'
import type { ContentItem } from '@friendzone/game-engine'

/**
 * Load every game's content into Postgres.
 *
 * Idempotent: running it twice leaves the same rows. Each item is stored as the
 * engine's own ContentItem shape in a JSONB column, with only the fields
 * selection actually filters on lifted out into columns. That keeps the
 * database from needing to know what a "blur stage" is, and keeps the engine
 * from needing a migration every time a game gains a field.
 */

const ROOT = new URL('../../', import.meta.url).pathname
const SEED_DIR = join(ROOT, 'data/seed')
const OUT_DIR = join(ROOT, 'data/out')

interface SeedResult {
  dataset: string
  kind: string
  loaded: number
  skipped: number
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (url === undefined) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.')

  const pool = new pg.Pool({ connectionString: url, max: 4 })
  try {
    const results: SeedResult[] = []
    results.push(await seedImages(pool))
    results.push(await seedEmoji(pool))
    results.push(await seedIdentities(pool))
    results.push(await seedPrompts(pool))
    results.push(await seedMafia(pool))

    console.log('\nSeeded:')
    for (const r of results) {
      console.log(`  ${r.kind.padEnd(9)} ${String(r.loaded).padStart(4)} loaded  ${String(r.skipped).padStart(3)} skipped  (${r.dataset})`)
    }

    const { rows } = await pool.query<{ kind: string; count: string }>(
      'SELECT kind, count(*)::text AS count FROM questions WHERE active GROUP BY kind ORDER BY kind',
    )
    console.log('\nIn the database now:')
    for (const row of rows) console.log(`  ${row.kind.padEnd(9)} ${row.count}`)

    const playable = rows.filter((r) => Number(r.count) > 0).map((r) => r.kind)
    if (!playable.includes('image')) {
      console.log('\nNo Blur Battle images yet. Run one of:')
      console.log('  npm run dataset:sample   (offline, generated art)')
      console.log('  npm run dataset:fetch    (real photographs from Wikimedia Commons)')
    }
    console.log()
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------

async function seedImages(pool: pg.Pool): Promise<SeedResult> {
  // Produced by the pipeline rather than checked in: the images are tens of
  // megabytes, and the metadata is meaningless without them.
  const path = join(OUT_DIR, 'image.json')
  let parsed: { items: ContentItem[]; source?: string; version?: string }
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as typeof parsed
  } catch {
    return { dataset: 'not built', kind: 'image', loaded: 0, skipped: 0 }
  }
  return upsert(pool, {
    datasetId: 'blur-images',
    kind: 'image',
    version: parsed.version ?? 'dev',
    source: parsed.source ?? 'pipeline',
    license: 'Mixed free licences; per-item attribution travels with each record',
    items: parsed.items,
  })
}

async function seedEmoji(pool: pg.Pool): Promise<SeedResult> {
  const raw = await readJson<{ items: RawEmoji[] }>('emoji-movies.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'emoji',
    id: item.id,
    title: item.title,
    aliases: item.aliases,
    emojis: item.emojis,
    year: item.year,
    category: 'film',
    difficulty: item.difficulty,
  }))
  return upsert(pool, {
    datasetId: 'emoji-movies',
    kind: 'emoji',
    version: '1',
    source: 'authored',
    license: 'Film titles are facts; the emoji clues are original to this project',
    items,
  })
}

async function seedIdentities(pool: pg.Pool): Promise<SeedResult> {
  const raw = await readJson<{ items: RawIdentity[] }>('identities.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'identity',
    id: item.id,
    name: item.name,
    aliases: item.aliases,
    hints: item.hints,
    category: item.category,
    difficulty: item.difficulty,
  }))
  return upsert(pool, {
    datasetId: 'identities',
    kind: 'identity',
    version: '1',
    source: 'authored',
    license: 'Original clues written for this project',
    items,
  })
}

async function seedPrompts(pool: pg.Pool): Promise<SeedResult> {
  const raw = await readJson<{ items: RawPrompt[] }>('prompts.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'prompt',
    id: item.id,
    prompt: item.prompt,
    category: 'everyday',
    difficulty: item.difficulty,
  }))
  return upsert(pool, {
    datasetId: 'meld-prompts',
    kind: 'prompt',
    version: '1',
    source: 'authored',
    license: 'Original prompts written for this project',
    items,
  })
}

async function seedMafia(pool: pg.Pool): Promise<SeedResult> {
  const raw = await readJson<{ items: RawMafia[] }>('mafia.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'mafia',
    id: item.id,
    title: item.title,
    fanClue: item.fanClue,
    imposterClue: item.imposterClue,
    category: 'film',
    difficulty: item.difficulty,
  }))
  return upsert(pool, {
    datasetId: 'mafia-subjects',
    kind: 'mafia',
    version: '1',
    source: 'authored',
    license: 'Original clues written for this project',
    items,
  })
}

// ---------------------------------------------------------------------------

async function upsert(
  pool: pg.Pool,
  args: { datasetId: string; kind: string; version: string; source: string; license: string; items: ContentItem[] },
): Promise<SeedResult> {
  const client = await pool.connect()
  let loaded = 0
  let skipped = 0

  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO datasets (id, kind, version, source, license, item_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET version = EXCLUDED.version, item_count = EXCLUDED.item_count, built_at = now()`,
      [args.datasetId, args.kind, args.version, args.source, args.license, args.items.length],
    )

    for (const item of args.items) {
      const answerKey = normalizeAnswer(answerFor(item))
      if (answerKey.length === 0) {
        skipped++
        continue
      }
      // The unique index on (kind, answer_key) is what stops two rows that a
      // player could not tell apart from both being in the pool.
      const result = await client.query(
        `INSERT INTO questions (id, dataset_id, kind, category, difficulty, payload, answer_key, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
         ON CONFLICT (id) DO UPDATE
           SET payload = EXCLUDED.payload, category = EXCLUDED.category,
               difficulty = EXCLUDED.difficulty, answer_key = EXCLUDED.answer_key, active = TRUE
         RETURNING 1`,
        [item.id, args.datasetId, item.kind, item.category, item.difficulty, JSON.stringify(item), answerKey],
      )
      if (result.rowCount === 1) loaded++
      else skipped++
    }

    // Anything this dataset used to contain and no longer does is retired
    // rather than left behind. Without this, rebuilding a dataset that drops an
    // item leaves a row pointing at image files that no longer exist, and the
    // game eventually deals that question to somebody.
    const { rowCount: retired } = await client.query(
      `UPDATE questions
          SET active = FALSE
        WHERE dataset_id = $1
          AND active
          AND NOT (id = ANY($2::text[]))`,
      [args.datasetId, args.items.map((item) => item.id)],
    )
    if (retired !== null && retired > 0) {
      console.log(`  retired ${retired} item(s) no longer in ${args.datasetId}`)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    // A collision on (kind, answer_key) means two items share an answer. That
    // is a content bug worth failing on, not something to paper over.
    throw new Error(`seeding ${args.datasetId} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    client.release()
  }

  return { dataset: args.datasetId, kind: args.kind, loaded, skipped }
}

/** The string a player would type to get this item right. */
function answerFor(item: ContentItem): string {
  switch (item.kind) {
    case 'image':
    case 'emoji':
    case 'mafia':
      return item.title
    case 'identity':
      return item.name
    case 'prompt':
      return item.prompt
  }
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(SEED_DIR, name), 'utf8')) as T
}

interface RawEmoji { id: string; title: string; emojis: string; year: number; difficulty: 'easy' | 'medium' | 'hard'; aliases: string[] }
interface RawIdentity { id: string; name: string; category: string; difficulty: 'easy' | 'medium' | 'hard'; aliases: string[]; hints: string[] }
interface RawPrompt { id: string; prompt: string; difficulty: 'easy' | 'medium' | 'hard' }
interface RawMafia { id: string; title: string; difficulty: 'easy' | 'medium' | 'hard'; fanClue: string; imposterClue: string }

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
