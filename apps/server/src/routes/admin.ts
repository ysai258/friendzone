import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '@friendzone/shared'
import type { AppServices } from '../services.ts'

/**
 * Operator views. Registered only when ADMIN_TOKEN is set — an admin surface
 * that exists by default is an admin surface somebody forgets to lock.
 *
 * Nothing here returns player names, answers, or anything from inside a live
 * game. These are counts and health, which is what an operator needs and the
 * most that can be safely exposed behind a shared bearer token.
 */
export function registerAdminRoutes(app: FastifyInstance, services: AppServices): void {
  if (services.config.ADMIN_TOKEN.length === 0) {
    services.logger.info('ADMIN_TOKEN is unset; admin routes are disabled')
    return
  }

  const expected = Buffer.from(`Bearer ${services.config.ADMIN_TOKEN}`)

  const requireToken = (request: FastifyRequest): void => {
    const header = request.headers.authorization ?? ''
    const provided = Buffer.from(header)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppError('FORBIDDEN')
    }
  }

  app.register(
    (scope, _opts, done) => {
      scope.addHook('onRequest', (request, _reply, next) => {
        requireToken(request)
        next()
      })

      scope.get('/admin/overview', async () => {
        const [activeRooms, content] = await Promise.all([
          services.store.activeRoomCount(),
          services.content.summary().catch(() => ({})),
        ])
        return {
          instance: { version: services.version, uptimeSeconds: Math.floor(process.uptime()), pid: process.pid },
          rooms: { active: activeRooms },
          sockets: { onThisInstance: services.gateway().connectionCount },
          content,
          memory: process.memoryUsage(),
        }
      })

      scope.get('/admin/sessions', async () => ({ sessions: await services.archive.recentSessions(25) }))

      /** Inspect one room. Returns structure and counts, never game secrets. */
      scope.get('/admin/rooms/:code', async (request) => {
        const code = String((request.params as { code: string }).code).toUpperCase()
        const found = await services.store.read(code)
        if (found === null) throw new AppError('ROOM_NOT_FOUND')
        const { room, version } = found
        return {
          code: room.code,
          status: room.status,
          version,
          gameId: room.config.gameId,
          createdAt: room.createdAt,
          lastActivityAt: room.lastActivityAt,
          sessionCount: room.sessionCount,
          players: Object.values(room.players).map((p) => ({
            // Deliberately not the display name.
            id: p.id,
            joinSeq: p.joinSeq,
            presence: p.presence,
            isHost: p.id === room.hostId,
          })),
          // The game's own state is omitted entirely: it contains answers.
          phase: room.session === null ? null : services.registry.get(room.session.gameId).getPhase(room.session.state),
        }
      })

      done()
    },
    { prefix: '' },
  )

  services.logger.info('admin routes enabled')
}
