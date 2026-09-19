import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  AppError,
  createRoomRequestSchema,
  isValidRoomCode,
  joinRoomRequestSchema,
  normalizeRoomCode,
  type RoomPeekResponse,
  type SessionResponse,
} from '@friendzone/shared'
import type { AppServices } from '../services.ts'

/**
 * Creating and joining happen over HTTP rather than the socket. The socket is
 * for a player who already has a seat; getting one is a request that can be
 * rate limited by IP, can fail with a status code a browser understands, and
 * can be retried without a connection lifecycle in the way.
 */
export function registerRoomRoutes(app: FastifyInstance, services: AppServices): void {
  const { service, signer, limiter, config, registry } = services

  const sessionResponse = (args: {
    code: string
    playerId: string
    token: string
    expiresAt: number
    isHost: boolean
  }): SessionResponse => ({
    roomCode: args.code,
    playerId: args.playerId,
    token: args.token,
    expiresAt: args.expiresAt,
    joinUrl: `${config.PUBLIC_WEB_ORIGIN}/r/${args.code}`,
    isHost: args.isHost,
    serverTime: Date.now(),
  })

  app.post('/api/rooms', async (request, reply) => {
    await limiter.enforce('room-create', clientKey(request.ip), config.RL_ROOM_CREATE)

    const body = createRoomRequestSchema.parse(request.body)
    const playerId = randomUUID()
    const room = await service.createRoom({
      hostName: body.name,
      hostId: playerId,
      ...(body.gameId === undefined ? {} : { gameId: body.gameId }),
    })

    services.metrics.roomsCreated.inc()
    const { token, session } = signer.issue(room.code, Date.now(), playerId)
    return reply
      .code(201)
      .send(sessionResponse({ code: room.code, playerId, token, expiresAt: session.expiresAt, isHost: true }))
  })

  /**
   * An unauthenticated peek, used by the join screen before a name is typed.
   * It says whether knocking is worth it and nothing about who is inside — no
   * names, no scores, no game state.
   */
  app.get('/api/rooms/:code', async (request) => {
    const code = requireCode(request.params)
    const { room, definition } = await service.peek(code)

    const response: RoomPeekResponse = {
      code: room.code,
      status: room.status,
      gameId: room.config.gameId,
      gameName: definition?.meta.name ?? room.config.gameId,
      playerCount: Object.values(room.players).filter((p) => p.presence !== 'INACTIVE').length,
      maxPlayers: room.config.maxPlayers,
      joinable: (room.status === 'LOBBY' || room.status === 'GAME_OVER') && room.closedAt === null,
    }
    return response
  })

  app.post('/api/rooms/:code/join', async (request, reply) => {
    const code = requireCode(request.params)
    await limiter.enforce('room-join', clientKey(request.ip), config.RL_ROOM_JOIN)

    const body = joinRoomRequestSchema.parse(request.body)

    // A browser holding a valid session for this room reclaims its seat. An
    // invalid or foreign token is ignored rather than rejected: the person is
    // simply treated as new, which is what they experience anyway.
    let existingPlayerId: string | null = null
    if (body.token !== undefined) {
      try {
        existingPlayerId = signer.verify(body.token, code, Date.now()).playerId
      } catch {
        existingPlayerId = null
      }
    }

    const newPlayerId = randomUUID()
    const result = await service.join({ code, name: body.name, existingPlayerId, newPlayerId })

    const { token, session } = signer.issue(code, Date.now(), result.playerId)
    return reply.code(result.rejoined ? 200 : 201).send(
      sessionResponse({
        code,
        playerId: result.playerId,
        token,
        expiresAt: session.expiresAt,
        isHost: result.room.hostId === result.playerId,
      }),
    )
  })

  app.get('/api/games', () => registry.catalog().filter((g) => g.playable))

  /** Lets a client seed its clock offset before any socket exists. */
  app.get('/api/time', () => ({ serverTime: Date.now() }))
}

function requireCode(params: unknown): string {
  const raw = (params as { code?: unknown }).code
  if (typeof raw !== 'string') throw new AppError('ROOM_CODE_INVALID')
  const code = normalizeRoomCode(raw)
  if (!isValidRoomCode(code)) throw new AppError('ROOM_CODE_INVALID')
  return code
}

/** Rate-limit subject. Grouped per IP; behind a proxy, Fastify's trustProxy
 *  setting decides what that means, and it is configured explicitly. */
function clientKey(ip: string): string {
  return ip
}
