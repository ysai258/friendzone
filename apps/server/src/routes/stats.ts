import type { FastifyInstance } from 'fastify'
import type { AppServices } from '../services.ts'

/**
 * GET /stats?days=14 — public play statistics. Counts only, like /health, so it
 * needs no token: how many rooms, players and games per India-time day, the
 * day's peak, and how many people are on right now.
 */
export function registerStatsRoutes(app: FastifyInstance, services: AppServices): void {
  app.get('/stats', async (request, reply) => {
    void reply.header('cache-control', 'no-store')
    const days = Number((request.query as { days?: string }).days ?? 14)
    const localOnline = services.gateway().connectionCount
    try {
      const rooms = await services.store.activeRoomCount()
      return await services.stats.report(days, { localOnline, rooms })
    } catch (error) {
      services.logger.warn({ err: error }, 'stats report failed')
      return reply.code(503).send({ error: 'Stats are unavailable right now.', live: { onThisInstance: localOnline } })
    }
  })
}
