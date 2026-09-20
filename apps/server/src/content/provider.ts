import { AppError } from '@friendzone/shared'
import type { ContentItem, ContentPack, ContentRequest } from '@friendzone/game-engine'
import type { Pool } from 'pg'
import type { Logger } from '../logger.ts'

/**
 * Where games get their questions.
 *
 * Content is read once, when a session is created, and then lives inside the
 * session state. Nothing queries the database during a round.
 *
 * A per-kind in-memory cache backs that up: the pools are small (thousands of
 * rows at most), entirely static between deploys, and shared by every room on
 * the instance. Starting a game is therefore usually zero queries, and stays
 * correct if Postgres is briefly unavailable — a real failure mode this turns
 * from "nobody can start a game" into "nobody notices".
 */

interface CacheEntry {
  items: ContentItem[]
  loadedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000

export class ContentProvider {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async load(request: ContentRequest): Promise<ContentPack> {
    const pool = await this.pool_(request.kind)

    // Language and category are what the host actually chose, so they are
    // applied first and — for category — never relaxed.
    const byIdentity = pool.filter((item) => {
      if (request.category !== null && item.category !== request.category) return false
      if (request.languages !== undefined && request.languages.length > 0) {
        if (item.kind === 'emoji' || item.kind === 'mafia') {
          if (!request.languages.includes(item.language)) return false
        }
      }
      return true
    })

    if (byIdentity.length === 0) {
      throw new AppError(
        'CONTENT_UNAVAILABLE',
        request.category !== null
          ? 'There is no content for that category yet.'
          : 'There are no movies loaded for those languages.',
      )
    }

    // Strict callers would rather fail than play something nobody asked for.
    // Who Am I? is the case: a table where one player is from a different
    // category is a broken game, not a slightly wider one.
    const minimum = request.minimum ?? request.count
    if (request.strict === true && byIdentity.length < minimum) {
      throw new AppError(
        'CONTENT_UNAVAILABLE',
        `That category only has ${byIdentity.length} people, and this game needs ${minimum}.`,
      )
    }

    // Difficulty is a preference rather than a constraint, so it relaxes when
    // it would otherwise leave too little to play with.
    const byDifficulty =
      request.difficulty === 'mixed'
        ? byIdentity
        : byIdentity.filter((item) => item.difficulty === request.difficulty)
    const chosen = byDifficulty.length >= request.count ? byDifficulty : byIdentity
    const widened = chosen !== byDifficulty

    if (chosen.length < request.count) {
      this.logger.warn(
        { kind: request.kind, wanted: request.count, available: chosen.length, category: request.category },
        'content pool smaller than requested',
      )
    }

    // excludeIds is honoured by the game's own draw rather than here: the game
    // needs the whole eligible pool to fall back into when history has used up
    // everything, and dropping rows at this layer would hide that option.
    return { kind: request.kind, items: chosen, widened }
  }

  private async pool_(kind: ContentItem['kind']): Promise<ContentItem[]> {
    const cached = this.cache.get(kind)
    if (cached !== undefined && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.items

    try {
      const { rows } = await this.pool.query<{ payload: ContentItem }>(
        'SELECT payload FROM questions WHERE kind = $1 AND active ORDER BY id',
        [kind],
      )
      const items = rows.map((r) => r.payload)
      this.cache.set(kind, { items, loadedAt: Date.now() })
      return items
    } catch (error) {
      // Serve stale rather than fail: a five-minute-old question list is a
      // perfectly good question list, and the round is about to start.
      if (cached !== undefined) {
        this.logger.warn({ err: error, kind }, 'content refresh failed; serving cached pool')
        return cached.items
      }
      throw new AppError('CONTENT_UNAVAILABLE', 'Question content is unavailable right now.', { cause: error })
    }
  }

  /** Counts per kind, for the readiness probe and the admin page. */
  async summary(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ kind: string; count: string }>(
      'SELECT kind, count(*)::text AS count FROM questions WHERE active GROUP BY kind',
    )
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]))
  }

  clearCache(): void {
    this.cache.clear()
  }
}
