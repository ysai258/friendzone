import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { editDistance, normalizeAnswer, typoAllowance } from '@friendzone/shared'
import type { ContentItem, MovieLanguage } from '@friendzone/game-engine'

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

/**
 * Reject content whose answers a player could not distinguish.
 *
 * Two kinds of collision matter. Identical normalised answers would violate
 * the unique index and fail the insert anyway. Near-identical ones would not:
 * the games forgive typos, so two titles a single edit apart mean one is
 * accepted for the other, silently, in production. "Gamyam" and "Gaayam" are
 * one edit apart, and both are real films.
 *
 * Checked here rather than in the pipeline so it applies to every kind of
 * content, including the hand-written ones.
 */
export function findConfusableAnswers(items: readonly ContentItem[]): string[] {
  const problems: string[] = []
  const entries = items.map((item) => ({ id: item.id, key: normalizeAnswer(answerFor(item)) }))

  const byKey = new Map<string, string[]>()
  for (const entry of entries) {
    const list = byKey.get(entry.key) ?? []
    list.push(entry.id)
    byKey.set(entry.key, list)
  }
  for (const [key, ids] of byKey) {
    if (ids.length > 1) problems.push(`identical answer "${key}": ${ids.join(', ')}`)
  }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!
      const b = entries[j]!
      if (a.key === b.key) continue
      const allowance = typoAllowance(a.key.length)
      if (allowance > 0 && editDistance(a.key, b.key, allowance) <= allowance) {
        problems.push(`"${a.key}" (${a.id}) is within the typo allowance of "${b.key}" (${b.id})`)
      }
    }
  }
  return problems
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
  // One file per language, so adding an industry is a new file rather than an
  // edit to a single enormous one.
  const dir = join(options.dataDir, 'seed', 'movies')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()

  const items: ContentItem[] = []
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as {
      language: MovieLanguage
      items: RawEmoji[]
    }
    for (const item of raw.items) {
      items.push({
        kind: 'emoji',
        id: item.id,
        title: item.title,
        aliases: item.aliases,
        emojis: item.emojis,
        year: item.year,
        category: 'film',
        difficulty: item.difficulty,
        language: raw.language,
      })
    }
  }
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
    // The theme the prompt was written for. Not filtered on today, but it is
    // what keeps the bank diverse and lets a category filter be added later.
    category: item.category,
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
    language: item.language,
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
  // Prompts are questions rather than answers, so near-duplicate wording is
  // fine; everything with a guessable answer is checked.
  if (args.kind !== 'prompt') {
    const problems = findConfusableAnswers(args.items)
    if (problems.length > 0) {
      throw new Error(
        `${args.datasetId} has answers players could not tell apart:\n  ${problems.slice(0, 10).join('\n  ')}`,
      )
    }
  }

  const client = await pool.connect()
  let loaded = 0
  let skipped = 0
  let retired: number

  try {
    await client.query('BEGIN')

    // Remove what this dataset no longer contains, before inserting what it
    // does. Order matters: the unique index on (kind, answer_key) does not care
    // whether a row is active, so a retired row still occupies its answer and a
    // rebuild that renamed ids would collide with its own previous version.
    const { rowCount: removed } = await client.query(
      `DELETE FROM questions WHERE dataset_id = $1 AND NOT (id = ANY($2::text[]))`,
      [args.datasetId, args.items.map((item) => item.id)],
    )
    retired = removed ?? 0
    if (retired > 0) options.log?.(`  removed ${retired} item(s) no longer in ${args.datasetId}`)

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
interface RawPrompt { id: string; prompt: string; category: string; difficulty: 'easy' | 'medium' | 'hard' }
interface RawMafia { id: string; title: string; difficulty: 'easy' | 'medium' | 'hard'; fanClue: string; imposterClue: string; language: MovieLanguage }
