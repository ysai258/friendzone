import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { normalizeAnswer } from '@friendzone/shared'
import type { ContentItem } from '@friendzone/game-engine'

/**
 * Load every game's content into Postgres.
 *
 * Lives in the server rather than in a script because two callers need it: the
 * `npm run seed` command, and a single-service deployment that seeds itself at
 * boot. Idempotent either way — running it twice leaves the same rows.
 */

export interface SeedResult {
  dataset: string
  kind: string
  loaded: number
  skipped: number
  retired: number
}

export interface SeedOptions {
  /** Root holding `seed/` and, if the pipeline has run, `out/`. */
  dataDir: string
  log?: (message: string) => void
}

export async function seedContent(pool: Pool, options: SeedOptions): Promise<SeedResult[]> {
  const results: SeedResult[] = []
  results.push(await seedImages(pool, options))
  results.push(await seedEmoji(pool, options))
  results.push(await seedIdentities(pool, options))
  results.push(await seedPrompts(pool, options))
  results.push(await seedMafia(pool, options))
  return results
}

/** How many playable questions exist, per kind. */
export async function contentCounts(pool: Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ kind: string; count: string }>(
    'SELECT kind, count(*)::text AS count FROM questions WHERE active GROUP BY kind',
  )
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]))
}

// ---------------------------------------------------------------------------

async function seedImages(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  // Produced by the pipeline rather than checked in: the images are tens of
  // megabytes, and the metadata is meaningless without them.
  let parsed: { items: ContentItem[]; source?: string; version?: string }
  try {
    parsed = JSON.parse(await readFile(join(options.dataDir, 'out', 'image.json'), 'utf8')) as typeof parsed
  } catch {
    return { dataset: 'not built', kind: 'image', loaded: 0, skipped: 0, retired: 0 }
  }
  return upsert(pool, options, {
    datasetId: 'blur-images',
    kind: 'image',
    version: parsed.version ?? 'dev',
    source: parsed.source ?? 'pipeline',
    license: 'Mixed free licences; per-item attribution travels with each record',
    items: parsed.items,
  })
}

async function seedEmoji(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  const raw = await readJson<{ items: RawEmoji[] }>(options, 'emoji-movies.json')
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
  return upsert(pool, options, {
    datasetId: 'emoji-movies',
    kind: 'emoji',
    version: '1',
    source: 'authored',
    license: 'Film titles are facts; the emoji clues are original to this project',
    items,
  })
}

async function seedIdentities(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  const raw = await readJson<{ items: RawIdentity[] }>(options, 'identities.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'identity',
    id: item.id,
    name: item.name,
    aliases: item.aliases,
    hints: item.hints,
    category: item.category,
    difficulty: item.difficulty,
  }))
  return upsert(pool, options, {
    datasetId: 'identities',
    kind: 'identity',
    version: '1',
    source: 'authored',
    license: 'Original clues written for this project',
    items,
  })
}

async function seedPrompts(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  const raw = await readJson<{ items: RawPrompt[] }>(options, 'prompts.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'prompt',
    id: item.id,
    prompt: item.prompt,
    category: 'everyday',
    difficulty: item.difficulty,
  }))
  return upsert(pool, options, {
    datasetId: 'meld-prompts',
    kind: 'prompt',
    version: '1',
    source: 'authored',
    license: 'Original prompts written for this project',
    items,
  })
}

async function seedMafia(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  const raw = await readJson<{ items: RawMafia[] }>(options, 'mafia.json')
  const items: ContentItem[] = raw.items.map((item) => ({
    kind: 'mafia',
    id: item.id,
    title: item.title,
    fanClue: item.fanClue,
    imposterClue: item.imposterClue,
    category: 'film',
    difficulty: item.difficulty,
  }))
  return upsert(pool, options, {
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
  pool: Pool,
  options: SeedOptions,
  args: { datasetId: string; kind: string; version: string; source: string; license: string; items: ContentItem[] },
): Promise<SeedResult> {
  const client = await pool.connect()
  let loaded = 0
  let skipped = 0
  let retired: number

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
    const { rowCount } = await client.query(
      `UPDATE questions
          SET active = FALSE
        WHERE dataset_id = $1
          AND active
          AND NOT (id = ANY($2::text[]))`,
      [args.datasetId, args.items.map((item) => item.id)],
    )
    retired = rowCount ?? 0
    if (retired > 0) options.log?.(`  retired ${retired} item(s) no longer in ${args.datasetId}`)

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    // A collision on (kind, answer_key) means two items share an answer. That
    // is a content bug worth failing on, not something to paper over.
    throw new Error(`seeding ${args.datasetId} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  } finally {
    client.release()
  }

  return { dataset: args.datasetId, kind: args.kind, loaded, skipped, retired }
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

async function readJson<T>(options: SeedOptions, name: string): Promise<T> {
  return JSON.parse(await readFile(join(options.dataDir, 'seed', name), 'utf8')) as T
}

interface RawEmoji { id: string; title: string; emojis: string; year: number; difficulty: 'easy' | 'medium' | 'hard'; aliases: string[] }
interface RawIdentity { id: string; name: string; category: string; difficulty: 'easy' | 'medium' | 'hard'; aliases: string[]; hints: string[] }
interface RawPrompt { id: string; prompt: string; difficulty: 'easy' | 'medium' | 'hard' }
interface RawMafia { id: string; title: string; difficulty: 'easy' | 'medium' | 'hard'; fanClue: string; imposterClue: string }
