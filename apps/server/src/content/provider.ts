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

    const filtered = pool.filter((item) => {
      if (request.difficulty !== 'mixed' && item.difficulty !== request.difficulty) return false
      if (request.category !== null && item.category !== request.category) return false
      return true
    })

    // Fall back rather than refuse: a host who picked "hard landmarks" and a
    // dataset that is thin there should still get a game, just a broader one.
    const chosen = filtered.length >= request.count ? filtered : pool

    if (chosen.length === 0) {
      throw new AppError('CONTENT_UNAVAILABLE', 'No questions are loaded for this game. Run `npm run seed`.')
    }
    if (chosen.length < request.count) {
      this.logger.warn(
        { kind: request.kind, wanted: request.count, available: chosen.length },
        'content pool smaller than requested; questions will repeat',
      )
    }

    return { kind: request.kind, items: chosen }
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
