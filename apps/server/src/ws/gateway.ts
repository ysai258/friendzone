import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  AppError,
  MAX_WS_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ROOM_ACTIONS,
  clientMessageSchema,
  parseClientJson,
  toWireError,
  type ByeReason,
  type PlayerId,
  type PublicEvent,
  type RoomCode,
  type ServerMessage,
} from '@friendzone/shared'
import type { Redis } from 'ioredis'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { Metrics } from '../metrics.ts'
import type { RedisKeys } from '../redis/keys.ts'
import type { RateLimiter } from '../redis/ratelimit.ts'
import type { RoomService, RoomChange } from '../rooms/service.ts'
import type { RoomStore } from '../rooms/store.ts'
import type { SessionSigner } from '../rooms/session.ts'
import type { RoomRecord } from '../rooms/state.ts'
import { buildRoomView } from '../rooms/views.ts'

/**
 * The WebSocket gateway.
 *
 * Holds the sockets this instance owns, turns authoritative room changes into
 * per-player payloads, and keeps instances in step through Redis pub/sub.
 *
 * The part worth explaining is the subscription model. A change is published to
 * a channel named for its room, and an instance subscribes to that channel only
 * while it actually holds a socket for that room. A room's state therefore
 * travels to the one or two servers with players in it, not to all of them —
 * which is what keeps fan-out proportional to players rather than to
 * players × instances.
 */

/** Dead-socket detection. A browser that is asleep or on a dropped tunnel stops
 *  answering pings long before the TCP connection notices. */
const HEARTBEAT_MS = 15_000
const HEARTBEAT_MISSES = 2

interface Connection {
  id: string
  socket: WebSocket
  roomCode: RoomCode
  playerId: PlayerId | null
  /** Pongs missed in a row. Reset by any inbound frame. */
  missedBeats: number
  authenticatedAt: number | null
}

/** What crosses the Redis channel between instances. */
interface RoomBroadcast {
  origin: string
  version: number
  room: RoomRecord
  events: PublicEvent[]
}

export class Gateway {
  /** Distinguishes our own published messages from other instances' on the
   *  shared channel, so a change is never applied to local sockets twice. */
  private readonly instanceId = randomUUID()
  private readonly byRoom = new Map<RoomCode, Set<Connection>>()
  private heartbeat: NodeJS.Timeout | null = null
  private shuttingDown = false

  constructor(
    private readonly deps: {
      service: RoomService
      store: RoomStore
      signer: SessionSigner
      redis: Redis
      subscriber: Redis
      keys: RedisKeys
      limiter: RateLimiter
      config: Config
      logger: Logger
      metrics: Metrics
    },
  ) {
    this.deps.service.onChange((change) => this.onRoomChange(change))
    this.deps.subscriber.on('message', (channel, payload) => this.onRedisMessage(channel, payload))
  }

  start(): void {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  get connectionCount(): number {
    let total = 0
    for (const set of this.byRoom.values()) total += set.size
    return total
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  handleConnection(socket: WebSocket, roomCode: RoomCode): void {
    if (this.shuttingDown) {
      this.sendRaw(socket, { t: 'bye', reason: 'SERVER_SHUTDOWN', message: 'Server is restarting. Reconnecting…' })
      socket.close(1012, 'shutting down')
      return
    }

    const connection: Connection = {
      id: randomUUID(),
      socket,
      roomCode,
      playerId: null,
      missedBeats: 0,
      authenticatedAt: null,
    }

    this.deps.metrics.wsConnections.inc()
    this.track(connection)

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      void this.onMessage(connection, data)
    })
    socket.on('pong', () => {
      connection.missedBeats = 0
    })
    socket.on('close', () => void this.onClose(connection))
    socket.on('error', (error: Error) => {
      this.deps.logger.debug({ err: error, connectionId: connection.id }, 'socket error')
    })

    // A socket that never says hello is holding a slot for nothing.
    setTimeout(() => {
      if (connection.authenticatedAt === null && connection.socket.readyState === connection.socket.OPEN) {
        this.sendError(connection, new AppError('SESSION_INVALID', 'No session was presented.'))
        connection.socket.close(4401, 'unauthenticated')
      }
    }, 10_000).unref()
  }

  private async onMessage(connection: Connection, data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    connection.missedBeats = 0

    const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (raw.byteLength > MAX_WS_MESSAGE_BYTES) {
      this.sendError(connection, new AppError('PAYLOAD_TOO_LARGE'))
      return
    }

    let parsedJson: unknown
    try {
      parsedJson = parseClientJson(raw.toString('utf8'))
    } catch {
      this.sendError(connection, new AppError('VALIDATION_FAILED', 'That was not valid JSON.'))
      return
    }

    const message = clientMessageSchema.safeParse(parsedJson)
    if (!message.success) {
      this.sendError(connection, new AppError('VALIDATION_FAILED'))
      return
    }

    this.deps.metrics.wsMessagesIn.inc({ type: message.data.t })

    try {
      switch (message.data.t) {
        case 'hello':
          await this.onHello(connection, message.data.token, message.data.protocolVersion)
          return
        case 'ping':
          this.sendRaw(connection.socket, { t: 'pong', clientTime: message.data.clientTime, serverTime: Date.now() })
          return
        case 'resync':
          await this.onResync(connection)
          return
        case 'action':
          await this.onAction(connection, message.data.actionId, message.data.type, message.data.payload)
          return
      }
    } catch (error) {
      this.sendError(connection, error)
      // A socket that failed to authenticate has nothing it can legally do
      // next. Close it now rather than leave it open until the unauthenticated
      // timeout, which also tells the client immediately that its stored
      // session is no good and it should ask for a new one.
      if (message.data.t === 'hello' && connection.playerId === null) {
        connection.socket.close(4401, 'authentication failed')
      }
    }
  }

  private async onHello(connection: Connection, token: string, protocolVersion: number): Promise<void> {
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.sendRaw(connection.socket, {
        t: 'bye',
        reason: 'PROTOCOL_MISMATCH',
        message: 'This page is out of date. Reload to keep playing.',
      })
      connection.socket.close(4426, 'protocol mismatch')
      return
    }

    const session = this.deps.signer.verify(token, connection.roomCode, Date.now())
    const room = await this.deps.service.markConnected(connection.roomCode, session.playerId)

    const wasReconnect = connection.playerId === null && room !== null
    connection.playerId = session.playerId
    connection.authenticatedAt = Date.now()
    if (wasReconnect) this.deps.metrics.wsReconnects.inc()

    // One seat, one socket. A second tab for the same player replaces the
    // first rather than doubling their presence — and the old tab is told why
    // instead of silently going quiet.
    for (const other of this.connectionsFor(connection.roomCode)) {
      if (other !== connection && other.playerId === session.playerId) {
        this.sendRaw(other.socket, { t: 'bye', reason: 'REPLACED', message: 'You opened this room in another tab.' })
        other.socket.close(4409, 'replaced')
      }
    }

    const current = room ?? (await this.deps.service.peek(connection.roomCode)).room
    const view = this.viewFor(current, session.playerId)

    this.sendRaw(connection.socket, {
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      playerId: session.playerId,
      roomCode: connection.roomCode,
      serverTime: Date.now(),
      room: view,
    })

    this.deps.logger.debug(
      { roomCode: connection.roomCode, playerId: session.playerId, connectionId: connection.id },
      'socket authenticated',
    )
  }

  /**
   * Full state on demand. A client asks for this after a reconnect, or when it
   * notices a gap in versions — there is no delta protocol to get out of step,
   * the snapshot is always authoritative and always complete.
   */
  private async onResync(connection: Connection): Promise<void> {
    if (connection.playerId === null) throw new AppError('SESSION_INVALID')
    const { room } = await this.deps.service.peek(connection.roomCode)
    this.sendRaw(connection.socket, { t: 'state', room: this.viewFor(room, connection.playerId), events: [] })
  }

  private async onAction(
    connection: Connection,
    actionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const playerId = connection.playerId
    if (playerId === null) throw new AppError('SESSION_INVALID')

    const kind = type.split('/')[0] ?? 'unknown'
    const endTimer = this.deps.metrics.actionDuration.startTimer({ kind })

    // Take a token and read the room together. Limited per player rather than
    // per connection, so opening more sockets does not buy more actions.
    const gate = await this.deps.limiter.checkAndReadRoom(
      'ws',
      playerId,
      this.deps.config.RL_WS_ACTION,
      this.deps.store.roomKey(connection.roomCode),
    )

    if (!gate.limit.allowed) {
      endTimer()
      this.deps.metrics.actionsRejected.inc({ code: 'RATE_LIMITED' })
      this.sendRaw(connection.socket, {
        t: 'error',
        error: {
          code: 'RATE_LIMITED',
          message: 'You\u2019re going too fast. Slow down a moment.',
          actionId,
          retryAfter: Math.ceil(gate.limit.retryAfterMs / 1000),
        },
      })
      return
    }

    const prefetched =
      gate.room === null
        ? undefined
        : { room: JSON.parse(gate.room.state) as RoomRecord, version: gate.room.version }

    try {
      if (type === ROOM_ACTIONS.START_GAME) {
        await this.deps.service.startGame({ code: connection.roomCode, playerId, actionId })
      } else {
        await this.deps.service.handleAction({
          code: connection.roomCode,
          playerId,
          actionId,
          type,
          payload,
          ...(prefetched === undefined ? {} : { prefetched }),
        })
      }
      this.deps.metrics.actionsApplied.inc({ kind })
    } catch (error) {
      if (error instanceof AppError) this.deps.metrics.actionsRejected.inc({ code: error.code })
      // The action failed, but the client's view may be stale — send the reason
      // and let it reconcile against current state.
      this.sendRaw(connection.socket, { t: 'error', error: toWireError(error, actionId) })
      return
    } finally {
      endTimer()
    }
  }

  private async onClose(connection: Connection): Promise<void> {
    this.untrack(connection)
    this.deps.metrics.wsDisconnections.inc({ reason: connection.playerId === null ? 'unauthenticated' : 'closed' })

    if (connection.playerId === null || this.shuttingDown) return

    // Only mark the player away if this was their live socket. A replaced tab
    // closing must not start a grace period for a player who is right here.
    const stillHere = this.connectionsFor(connection.roomCode).some((c) => c.playerId === connection.playerId)
    if (stillHere) return

    try {
      await this.deps.service.markDisconnected(connection.roomCode, connection.playerId)
    } catch (error) {
      this.deps.logger.debug({ err: error, roomCode: connection.roomCode }, 'failed to mark player disconnected')
    }
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  /** A room changed on this instance. Fan out locally, then tell the others. */
  private onRoomChange(change: RoomChange): void {
    this.deliver(change.room, change.version, change.events)

    const message: RoomBroadcast = {
      origin: this.instanceId,
      version: change.version,
      room: change.room,
      events: change.events,
    }
    void this.deps.redis
      .publish(this.deps.keys.roomChannel(change.room.code), JSON.stringify(message))
      .catch((error: unknown) => {
        // Players on this instance already have the update. Players elsewhere
        // will resync on their next action or heartbeat.
        this.deps.logger.warn({ err: error, roomCode: change.room.code }, 'failed to publish room change')
      })
  }

  private onRedisMessage(channel: string, payload: string): void {
    let message: RoomBroadcast
    try {
      message = JSON.parse(payload) as RoomBroadcast
    } catch {
      this.deps.logger.warn({ channel }, 'unparseable broadcast')
      return
    }
    // Our own publish, echoed back. Already delivered locally.
    if (message.origin === this.instanceId) return
    this.deliver(message.room, message.version, message.events)
  }

  /**
   * Write the update to every local socket in the room.
   *
   * The view is rebuilt per player because the game's slice is filtered by
   * identity — that per-player cost is precisely what keeps another player's
   * secret out of the bytes on the wire.
   */
  private deliver(room: RoomRecord, version: number, events: PublicEvent[]): void {
    const connections = this.connectionsFor(room.code)
    if (connections.length === 0) return

    const now = Date.now()
    const definition = this.deps.service.definitionFor(room)
    let sent = 0

    for (const connection of connections) {
      if (connection.socket.readyState !== connection.socket.OPEN) continue
      const view = buildRoomView({ room, version, viewerId: connection.playerId, definition, now })
      this.sendRaw(connection.socket, { t: 'state', room: view, events })
      sent++
    }

    this.deps.metrics.wsBroadcastFanout.observe(sent)
  }

  private viewFor(room: RoomRecord, viewerId: PlayerId | null) {
    return buildRoomView({
      room,
      version: 0,
      viewerId,
      definition: this.deps.service.definitionFor(room),
      now: Date.now(),
    })
  }

  // -------------------------------------------------------------------------
  // Registry and subscriptions
  // -------------------------------------------------------------------------

  private track(connection: Connection): void {
    let set = this.byRoom.get(connection.roomCode)
    if (set === undefined) {
      set = new Set()
      this.byRoom.set(connection.roomCode, set)
      // First socket here: start listening for this room's changes.
      void this.deps.subscriber.subscribe(this.deps.keys.roomChannel(connection.roomCode)).catch((error: unknown) => {
        this.deps.logger.error({ err: error, roomCode: connection.roomCode }, 'failed to subscribe to room channel')
      })
    }
    set.add(connection)
    this.deps.metrics.playersConnected.set(this.connectionCount)
  }

  private untrack(connection: Connection): void {
    const set = this.byRoom.get(connection.roomCode)
    if (set === undefined) return
    set.delete(connection)
    if (set.size === 0) {
      this.byRoom.delete(connection.roomCode)
      // Nobody here any more: stop paying to hear about this room.
      void this.deps.subscriber.unsubscribe(this.deps.keys.roomChannel(connection.roomCode)).catch(() => undefined)
    }
    this.deps.metrics.playersConnected.set(this.connectionCount)
  }

  private connectionsFor(code: RoomCode): Connection[] {
    return [...(this.byRoom.get(code) ?? [])]
  }

  // -------------------------------------------------------------------------
  // Heartbeat and shutdown
  // -------------------------------------------------------------------------

  private sweep(): void {
    for (const set of this.byRoom.values()) {
      for (const connection of set) {
        if (connection.missedBeats >= HEARTBEAT_MISSES) {
          // Silent for two intervals: the socket is open only in this process's
          // opinion. Terminate so the player enters their grace period now
          // rather than when TCP eventually gives up.
          this.deps.metrics.wsDisconnections.inc({ reason: 'heartbeat' })
          connection.socket.terminate()
          continue
        }
        connection.missedBeats += 1
        try {
          connection.socket.ping()
        } catch {
          connection.socket.terminate()
        }
      }
    }
  }

  private sendError(connection: Connection, error: unknown): void {
    this.sendRaw(connection.socket, { t: 'error', error: toWireError(error) })
  }

  private sendRaw(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(message))
    this.deps.metrics.wsMessagesOut.inc()
  }

  /**
   * Tell everyone to reconnect, then close.
   *
   * Clients treat a `bye` as "come straight back", so a rolling deploy moves
   * players to another instance within their grace period. Their seats, their
   * scores and the round in progress are all in Redis, so nothing is lost.
   */
  async shutdown(reason: ByeReason = 'SERVER_SHUTDOWN'): Promise<void> {
    this.shuttingDown = true
    if (this.heartbeat !== null) clearInterval(this.heartbeat)

    const all = [...this.byRoom.values()].flatMap((set) => [...set])
    for (const connection of all) {
      this.sendRaw(connection.socket, { t: 'bye', reason, message: 'Reconnecting…' })
      connection.socket.close(1012, 'server shutting down')
    }

    // A moment for close frames to leave the box before the process exits.
    await new Promise((resolve) => setTimeout(resolve, 150))
    this.byRoom.clear()
  }
}
