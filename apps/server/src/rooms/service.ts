import { randomUUID } from 'node:crypto'
import {
  AppError,
  ROOM_ACTIONS,
  ROOM_ACTION_PREFIX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  randomSeed,
  type PlayerId,
  type PublicEvent,
  type RoomCode,
  type RoomConfig,
} from '@friendzone/shared'
import { DEFAULT_GAME_ID, RECENT_LIMITS } from '@friendzone/game-engine'
import type { EngineEvent, ErasedGameDefinition, GameRegistry, TurnContext } from '@friendzone/game-engine'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { ContentProvider } from '../content/provider.ts'
import type { RoomArchive } from '../db/archive.ts'
import { computeDeadline } from './deadline.ts'
import { type RoomStore } from './store.ts'
import {
  addPlayer,
  applyScoreDeltas,
  connectedPlayers,
  createRoom,
  hasSeenAction,
  nextEvents,
  playersByJoinSeq,
  reconcileHost,
  recordContentUse,
  rememberAction,
  resetToLobby,
  seatCount,
  seatedPlayers,
  setPresence,
  type RoomRecord,
} from './state.ts'

/**
 * The room service. Everything a player can cause happens through here.
 *
 * It knows nothing about any specific game: it resolves a definition from the
 * registry by id, hands it state and actions, and applies whatever transition
 * comes back. There is no branch on game id anywhere below this line.
 */

/** Safety valve on the advance loop; a game that cannot settle in this many
 *  steps has a bug, and spinning forever would take the instance with it. */
const MAX_ADVANCE_STEPS = 24

/**
 * What a caller's reducer produced. `settleAt` lets an action ask for the room
 * to be brought up to date as of a later instant than now — the host skipping a
 * reveal is exactly "treat the current phase as though its clock had run out",
 * which needs no game-specific hook.
 */
interface Reduction<T> {
  room: RoomRecord
  events: EngineEvent[]
  value: T
  settleAt?: number
}

/** Carried through the store so the built events survive a compare-and-set. */
interface Carried<T> {
  value: T | undefined
  events: PublicEvent[]
}

export interface RoomChange {
  room: RoomRecord
  version: number
  events: PublicEvent[]
}

export type RoomPublisher = (change: RoomChange) => void

export interface RoomServiceDeps {
  store: RoomStore
  registry: GameRegistry
  content: ContentProvider
  archive: RoomArchive
  config: Config
  logger: Logger
  now?: () => number
}

export class RoomService {
  private readonly store: RoomStore
  private readonly registry: GameRegistry
  private readonly content: ContentProvider
  private readonly archive: RoomArchive
  private readonly config: Config
  private readonly logger: Logger
  private readonly now: () => number
  private publish: RoomPublisher = () => undefined

  constructor(deps: RoomServiceDeps) {
    this.store = deps.store
    this.registry = deps.registry
    this.content = deps.content
    this.archive = deps.archive
    this.config = deps.config
    this.logger = deps.logger
    this.now = deps.now ?? (() => Date.now())
  }

  /** The gateway installs itself here so state can be fanned out after a write. */
  onChange(publisher: RoomPublisher): void {
    this.publish = publisher
  }

  definitionFor(room: RoomRecord): ErasedGameDefinition | null {
    const gameId = room.session?.gameId ?? room.config.gameId
    return this.registry.has(gameId) ? this.registry.get(gameId) : null
  }

  // -------------------------------------------------------------------------
  // Creation and joining
  // -------------------------------------------------------------------------

  async createRoom(args: { hostName: string; gameId?: string; hostId: PlayerId }): Promise<RoomRecord> {
    const gameId = args.gameId ?? DEFAULT_GAME_ID
    if (!this.registry.has(gameId)) throw new AppError('UNKNOWN_GAME')
    const definition = this.registry.get(gameId)

    const config: RoomConfig = {
      gameId,
      maxPlayers: definition.maxPlayers,
      settings: this.registry.defaultSettings(gameId),
    }

    // Retry on collision rather than pre-checking: the check would be a race,
    // and the create is a compare-and-set that already detects the conflict.
    for (let attempt = 0; attempt < 6; attempt++) {
      const now = this.now()
      const room = createRoom({
        code: generateRoomCode(),
        seed: randomSeed(),
        hostId: args.hostId,
        hostName: args.hostName,
        config,
        now,
      })
      try {
        await this.store.create(room, computeDeadline(room, definition))
        void this.archive.recordRoomCreated(room).catch((err: unknown) => {
          this.logger.error({ err, roomCode: room.code }, 'failed to archive room creation')
        })
        this.logger.info({ roomCode: room.code, gameId }, 'room created')
        return room
      } catch (error) {
        if (error instanceof AppError && error.code === 'CONFLICT_RETRY_EXHAUSTED') continue
        throw error
      }
    }
    throw new AppError('SERVICE_UNAVAILABLE', 'Could not allocate a room code. Try again.')
  }

  async peek(code: RoomCode): Promise<{ room: RoomRecord; definition: ErasedGameDefinition | null }> {
    const { room } = await this.store.require(code)
    return { room, definition: this.definitionFor(room) }
  }

  /**
   * Join, or rejoin.
   *
   * A browser that already holds a valid session for this room reclaims its
   * seat instead of taking a second one. That is what makes a refresh mid-game
   * a non-event, and it is why the token is checked before the name.
   */
  async join(args: { code: RoomCode; name: string; existingPlayerId: PlayerId | null; newPlayerId: PlayerId }): Promise<{
    room: RoomRecord
    playerId: PlayerId
    rejoined: boolean
  }> {
    const result = await this.transact(args.code, (room) => {
      const existing = args.existingPlayerId === null ? undefined : room.players[args.existingPlayerId]
      if (existing !== undefined) {
        // Reclaiming a seat. Name changes are allowed; the score is not reset.
        const renamed = args.name === existing.name ? room : renamePlayer(room, existing.id, args.name)
        return {
          room: setPresence(renamed, existing.id, 'CONNECTED', this.now(), this.config.PLAYER_GRACE_SECONDS),
          events: [],
          value: { playerId: existing.id, rejoined: true },
        }
      }

      if (!isOpenForNewPlayers(room)) throw new AppError('GAME_ALREADY_STARTED')
      if (seatCount(room) >= room.config.maxPlayers) throw new AppError('ROOM_FULL')
      if (nameTaken(room, args.name)) throw new AppError('NAME_TAKEN')

      const joined = addPlayer(room, args.newPlayerId, args.name, this.now())
      return {
        room: joined,
        events: [{ type: 'PLAYER_JOINED' as const, data: { playerId: args.newPlayerId, name: args.name } }],
        value: { playerId: args.newPlayerId, rejoined: false },
      }
    })

    // The join reducer always produces a value, so a missing one means the
    // write never happened — the room went away between the read and the write.
    if (result === null || result.value === undefined) throw new AppError('ROOM_NOT_FOUND')
    return { room: result.room, playerId: result.value.playerId, rejoined: result.value.rejoined }
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  async markConnected(code: RoomCode, playerId: PlayerId): Promise<RoomRecord | null> {
    const result = await this.transact(code, (room) => {
      const player = room.players[playerId]
      if (player === undefined) throw new AppError('PLAYER_NOT_FOUND')
      if (player.presence === 'CONNECTED') return null
      const reconnected = player.presence === 'DISCONNECTED'
      return {
        room: setPresence(room, playerId, 'CONNECTED', this.now(), this.config.PLAYER_GRACE_SECONDS),
        events: reconnected ? [{ type: 'PLAYER_RECONNECTED' as const, data: { playerId } }] : [],
        value: undefined,
      }
    })
    return result?.room ?? null
  }

  /**
   * A socket closed. The player is not removed — they enter a grace period,
   * and the room keeps their seat, their score and any answer they had already
   * committed. Only when the grace deadline fires do they become inactive.
   */
  async markDisconnected(code: RoomCode, playerId: PlayerId): Promise<void> {
    await this.transact(code, (room) => {
      const player = room.players[playerId]
      if (player === undefined || player.presence !== 'CONNECTED') return null
      return {
        room: setPresence(room, playerId, 'DISCONNECTED', this.now(), this.config.PLAYER_GRACE_SECONDS),
        events: [{ type: 'PLAYER_DISCONNECTED' as const, data: { playerId } }],
        value: undefined,
      }
    }).catch((error: unknown) => {
      // A room that expired while a socket was closing is not an error worth
      // surfacing; the player and the room are both gone.
      if (error instanceof AppError && error.code === 'ROOM_NOT_FOUND') return null
      throw error
    })
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Apply one action from one player.
   *
   * The duplicate check and the effect are written together under a single
   * compare-and-set, which is what makes a client retry safe: the second copy
   * of an action finds its id already recorded and changes nothing.
   */
  async handleAction(args: {
    code: RoomCode
    playerId: PlayerId
    actionId: string
    type: string
    payload: Record<string, unknown>
    /** Already read by the caller, in the same round trip as the rate-limit
     *  check. Saves a Redis hop on the hottest path in the system. */
    prefetched?: { room: RoomRecord; version: number }
  }): Promise<void> {
    const startedAt = this.now()

    await this.transact(args.code, (room) => {
      const player = room.players[args.playerId]
      if (player === undefined) throw new AppError('PLAYER_NOT_FOUND')

      if (hasSeenAction(room, args.actionId)) {
        // Already applied. Return no change; the caller still receives current
        // state, which is exactly what a retrying client is asking for.
        return null
      }

      const remembered = rememberAction(room, args.actionId)

      if (args.type.startsWith(ROOM_ACTION_PREFIX)) {
        return this.applyRoomAction(remembered, args.playerId, args.type, args.payload, startedAt)
      }
      return this.applyGameAction(remembered, args.playerId, args, startedAt)
    }, args.prefetched)
  }

  private applyRoomAction(
    room: RoomRecord,
    playerId: PlayerId,
    type: string,
    payload: Record<string, unknown>,
    now: number,
  ): Reduction<undefined> {
    const requireHost = (): void => {
      if (room.hostId !== playerId) throw new AppError('NOT_HOST')
    }

    switch (type) {
      case ROOM_ACTIONS.UPDATE_CONFIG: {
        requireHost()
        if (room.status !== 'LOBBY') throw new AppError('GAME_ALREADY_STARTED')
        return { room: this.withConfig(room, payload, now), events: [{ type: 'CONFIG_UPDATED', data: {} }], value: undefined }
      }

      case ROOM_ACTIONS.KICK_PLAYER: {
        requireHost()
        const raw = payload['playerId']
        const targetId = typeof raw === 'string' ? raw : ''
        if (room.players[targetId] === undefined) throw new AppError('PLAYER_NOT_FOUND')
        if (targetId === playerId) throw new AppError('INVALID_ACTION', 'You cannot remove yourself.')
        const players = { ...room.players }
        delete players[targetId]
        return {
          room: { ...room, players, lastActivityAt: now },
          events: [{ type: 'PLAYER_KICKED', data: { playerId: targetId } }],
          value: undefined,
        }
      }

      case ROOM_ACTIONS.LEAVE: {
        const players = { ...room.players }
        delete players[playerId]
        return {
          room: { ...room, players, lastActivityAt: now },
          events: [{ type: 'PLAYER_LEFT', data: { playerId } }],
          value: undefined,
        }
      }

      case ROOM_ACTIONS.PLAY_AGAIN: {
        requireHost()
        if (room.status !== 'GAME_OVER') throw new AppError('INVALID_ACTION', 'The game is still running.')
        return {
          room: resetToLobby(room, now),
          events: [{ type: 'ROOM_RESET', data: {} }],
          value: undefined,
        }
      }

      case ROOM_ACTIONS.CONTINUE: {
        requireHost()
        // Two shapes of "move it along", both host-only.
        //
        // A phase with a clock is skipped by settling the room as though that
        // clock had run out; the game's own advance does the rest.
        //
        // A phase with no clock is waiting on a person by design — Mind Meld's
        // results screen, which stays up so the table can argue — and only the
        // game knows whether it can be advanced. hostAdvance returns null when
        // it cannot, which is what makes a double-tap harmless.
        if (room.status !== 'ROUND_RESULT' && room.status !== 'STARTING') {
          throw new AppError('INVALID_ACTION', 'There is nothing to skip right now.')
        }

        const session = room.session
        if (session === null) throw new AppError('GAME_NOT_STARTED')
        const definition = this.registry.get(session.gameId)
        const deadline = definition.getDeadline(session.state)

        if (deadline === null) {
          const pushed = definition.hostAdvance?.(session.state, this.turnContext(room, now))
          if (pushed === undefined || pushed === null) {
            throw new AppError('INVALID_ACTION', 'There is nothing to skip right now.')
          }
          const advanced = applyScoreDeltas(
            { ...room, session: { ...session, state: pushed.state }, lastActivityAt: now },
            pushed.scoreDeltas ?? {},
          )
          return { room: advanced, events: pushed.events, value: undefined }
        }

        return {
          room: { ...room, lastActivityAt: now },
          events: [],
          value: undefined,
          settleAt: deadline,
        }
      }

      case ROOM_ACTIONS.START_GAME:
        // Handled by startGame, which must load content before it can transact.
        throw new AppError('INVALID_ACTION', 'Use the start endpoint.')

      default:
        throw new AppError('INVALID_ACTION')
    }
  }

  private applyGameAction(
    room: RoomRecord,
    playerId: PlayerId,
    args: { actionId: string; type: string; payload: Record<string, unknown> },
    now: number,
  ): Reduction<undefined> {
    if (room.session === null) throw new AppError('GAME_NOT_STARTED')
    const definition = this.registry.get(room.session.gameId)

    const ctx: TurnContext = { ...this.turnContext(room, now), actionId: args.actionId }
    const action = { type: args.type, payload: args.payload }

    // Validate first so the player gets a reason, rather than a silent no-op.
    const check = definition.validateAction(room.session.state, playerId, action, ctx)
    if (!check.ok) throw new AppError(check.error.code, check.error.message)

    const result = definition.applyAction(room.session.state, playerId, action, ctx)
    const withState: RoomRecord = { ...room, session: { ...room.session, state: result.state }, lastActivityAt: now }
    const scored = applyScoreDeltas(withState, result.scoreDeltas ?? {})
    return { room: scored, events: result.events, value: undefined }
  }

  // -------------------------------------------------------------------------
  // Starting a game
  // -------------------------------------------------------------------------

  /**
   * Start a game. Content is loaded before the transaction opens, because a
   * compare-and-set mutator may run several times and must not perform I/O.
   */
  async startGame(args: { code: RoomCode; playerId: PlayerId; actionId: string }): Promise<void> {
    const { room } = await this.store.require(args.code)
    if (room.hostId !== args.playerId) throw new AppError('NOT_HOST')
    if (room.status !== 'LOBBY') throw new AppError('GAME_ALREADY_STARTED')

    const definition = this.registry.get(room.config.gameId)
    const seated = seatedPlayers(room).length
    if (seated < definition.minPlayers) {
      throw new AppError('NOT_ENOUGH_PLAYERS', `${definition.meta.name} needs at least ${definition.minPlayers} players.`)
    }
    if (seated > definition.maxPlayers) throw new AppError('TOO_MANY_PLAYERS')

    const settings = definition.settingsSchema.parse(room.config.settings)
    const request = definition.contentRequest(settings)
    const pack = await this.content.load({
      ...request,
      excludeIds: room.recentContent[request.kind] ?? [],
    })
    const sessionId = randomUUID()

    await this.transact(args.code, (current) => {
      if (current.hostId !== args.playerId) throw new AppError('NOT_HOST')
      // Re-checked inside the transaction: between the read above and this
      // write, another instance may have started the game already.
      if (current.status !== 'LOBBY') throw new AppError('GAME_ALREADY_STARTED')
      if (hasSeenAction(current, args.actionId)) return null

      const now = this.now()
      const state = definition.createGame({
        ...this.turnContext(current, now),
        sessionId,
        settings,
        content: pack,
        // What this room has already played. The game prefers anything else.
        recentContentIds: current.recentContent[request.kind] ?? [],
      })

      // Record the draw so the next game in this room avoids it. Done here,
      // inside the same compare-and-set as the session itself, so a room can
      // never end up having played content it did not remember.
      const remembered = recordContentUse(
        rememberAction(current, args.actionId),
        request.kind,
        definition.usedContentIds?.(state) ?? [],
        RECENT_LIMITS[request.kind],
      )

      const started: RoomRecord = {
        ...remembered,
        status: 'PLAYING',
        session: { sessionId, gameId: definition.id, state, startedAt: now },
        scores: Object.fromEntries(Object.keys(current.players).map((id) => [id, 0])),
        lastDeltas: {},
        sessionCount: current.sessionCount + 1,
        lastActivityAt: now,
      }

      return {
        room: started,
        events: [{ type: 'GAME_STARTED' as const, data: { gameId: definition.id, sessionId } }],
        value: { sessionId, settings },
      }
    }).then((result) => {
      if (result === null) return
      void this.archive
        .recordGameStarted(result.room, sessionId, settings)
        .catch((err: unknown) => this.logger.error({ err, roomCode: args.code }, 'failed to archive game start'))
    })
  }

  // -------------------------------------------------------------------------
  // Time-driven transitions
  // -------------------------------------------------------------------------

  /**
   * Called by the scheduler when a room's deadline has passed. It asks for no
   * change of its own; the settle step inside the transaction is the work.
   */
  async advanceDue(code: RoomCode): Promise<void> {
    await this.transact(code, () => null)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private turnContext(
    room: RoomRecord,
    now: number,
  ): { now: number; seed: string; players: TurnContext['players']; hostId: PlayerId } {
    return {
      now,
      seed: room.seed,
      players: playersByJoinSeq(room).map((p) => ({
        id: p.id,
        name: p.name,
        joinSeq: p.joinSeq,
        presence: p.presence,
      })),
      hostId: room.hostId,
    }
  }

  /**
   * One mutation, end to end.
   *
   * Runs the caller's reducer, then settles everything time has made true since
   * the last write — expired grace periods, finished rounds, a game that has
   * ended — then reconciles the host, then writes. Doing all of that inside one
   * compare-and-set is what keeps the room consistent: there is never a moment
   * where the score has moved but the round has not, or a host has gone but no
   * successor has been chosen.
   */
  private async transact<T = undefined>(
    code: RoomCode,
    reduce: (room: RoomRecord) => Reduction<T> | null,
    prefetched?: { room: RoomRecord; version: number },
  ): Promise<{ room: RoomRecord; version: number; value: T | undefined } | null> {
    const finished: { room: RoomRecord; sessionId: string }[] = []

    const result = await this.store.update<Carried<T>>(
      code,
      (current) => {
        const now = this.now()
        const reduced = reduce(current)

        let room = reduced?.room ?? current
        let events: EngineEvent[] = reduced?.events ?? []

        const settled = this.settle(room, Math.max(now, reduced?.settleAt ?? 0))
        const timeMovedSomething = settled.room !== room || settled.events.length > 0
        // Nothing asked for, nothing overdue: skip the write entirely rather
        // than burn a version and a broadcast on an identical state.
        if (reduced === null && !timeMovedSomething) return null

        room = settled.room
        events = [...events, ...settled.events]

        const host = reconcileHost(room)
        room = host.room
        if (host.changed) events = [...events, { type: 'HOST_CHANGED', data: { hostId: room.hostId } }]

        if (room.status === 'GAME_OVER' && current.status !== 'GAME_OVER' && room.session !== null) {
          finished.push({ room, sessionId: room.session.sessionId })
        }

        const built = nextEvents(room, events, now)
        return { room: built.room, value: { value: reduced?.value, events: built.events } }
      },
      (room) => computeDeadline(room, this.definitionFor(room)),
      prefetched,
    )

    if (result === null) return null

    this.publish({ room: result.room, version: result.version, events: result.value.events })

    for (const entry of finished) {
      void this.archive
        .recordGameFinished(entry.room, entry.sessionId)
        .catch((err: unknown) => this.logger.error({ err, roomCode: code }, 'failed to archive game result'))
    }

    return { room: result.room, version: result.version, value: result.value.value }
  }

  /**
   * Bring the room up to date with the clock.
   *
   * Two things can be overdue: a player's grace period, and the game's own
   * deadline. Grace is handled first so the game is told a player is gone
   * before it decides whether the round can end — otherwise a round would wait
   * out its full timer for somebody who has already left.
   */
  private settle(start: RoomRecord, now: number): { room: RoomRecord; events: EngineEvent[] } {
    let room = start
    const events: EngineEvent[] = []

    // 1. Grace periods.
    for (const player of Object.values(room.players)) {
      if (player.presence !== 'DISCONNECTED') continue
      if (player.graceEndsAt === null || player.graceEndsAt > now) continue

      room = {
        ...room,
        players: { ...room.players, [player.id]: { ...player, presence: 'INACTIVE', graceEndsAt: null } },
      }
      events.push({ type: 'PLAYER_INACTIVE', data: { playerId: player.id } })

      if (room.session !== null) {
        const definition = this.registry.get(room.session.gameId)
        const result = definition.onPlayerInactive(room.session.state, player.id, this.turnContext(room, now))
        room = applyScoreDeltas(
          { ...room, session: { ...room.session, state: result.state } },
          result.scoreDeltas ?? {},
        )
        events.push(...result.events)
      }
    }

    // 2. The game's own clock. A transition may expire immediately in order to
    //    chain into the next phase, so this loops rather than stepping once.
    if (room.session !== null) {
      const definition = this.registry.get(room.session.gameId)
      for (let step = 0; step < MAX_ADVANCE_STEPS; step++) {
        const session = room.session
        if (session === null) break
        const deadline = definition.getDeadline(session.state)
        if (deadline === null || deadline > now) break

        const result = definition.advance(session.state, this.turnContext(room, now))
        room = applyScoreDeltas({ ...room, session: { ...session, state: result.state } }, result.scoreDeltas ?? {})
        events.push(...result.events)

        if (definition.isGameOver(result.state)) break
      }

      const session = room.session
      if (session !== null) {
        const over = definition.isGameOver(session.state)
        const status = over ? 'GAME_OVER' : mapPhaseToStatus(definition.getPhase(session.state))
        if (status !== room.status) room = { ...room, status }
      }
    }

    return { room, events }
  }

  private withConfig(room: RoomRecord, payload: Record<string, unknown>, now: number): RoomRecord {
    const gameId = typeof payload['gameId'] === 'string' ? payload['gameId'] : room.config.gameId
    if (!this.registry.has(gameId)) throw new AppError('UNKNOWN_GAME')
    const definition = this.registry.get(gameId)

    // Switching games discards the old game's settings rather than trying to
    // carry them across; the two schemas have nothing in common.
    const base = gameId === room.config.gameId ? room.config.settings : this.registry.defaultSettings(gameId)
    const incoming = isPlainObject(payload['settings']) ? payload['settings'] : {}
    const merged = { ...base, ...incoming }

    const parsed = definition.settingsSchema.safeParse(merged)
    if (!parsed.success) throw new AppError('INVALID_CONFIG', firstIssue(parsed.error))

    const requestedMax = typeof payload['maxPlayers'] === 'number' ? payload['maxPlayers'] : room.config.maxPlayers
    const maxPlayers = Math.min(definition.maxPlayers, Math.max(definition.minPlayers, Math.floor(requestedMax)))
    if (maxPlayers < seatCount(room)) {
      throw new AppError('INVALID_CONFIG', 'There are already more players than that in the room.')
    }

    return {
      ...room,
      config: { gameId, maxPlayers, settings: parsed.data },
      lastActivityAt: now,
    }
  }

  /** Exposed for the scheduler's metrics and the admin view. */
  get rooms(): RoomStore {
    return this.store
  }

  connectedCount(room: RoomRecord): number {
    return connectedPlayers(room).length
  }
}

// ---------------------------------------------------------------------------

/**
 * A game's own phase names are its business; the room only needs to know
 * whether players should be looking at a question or at a result. Anything
 * unrecognised counts as active play, which is the safe default.
 */
function mapPhaseToStatus(phase: string): RoomRecord['status'] {
  switch (phase) {
    case 'COUNTDOWN':
    case 'ASSIGN':
    case 'ROLES':
      return 'STARTING'
    case 'REVEAL':
    case 'RESULT':
      return 'ROUND_RESULT'
    case 'FINISHED':
      return 'GAME_OVER'
    default:
      return 'PLAYING'
  }
}

function isOpenForNewPlayers(room: RoomRecord): boolean {
  if (room.closedAt !== null) return false
  // Latecomers are welcome in the lobby and between games, but not mid-round:
  // they would have no score, no role, and nothing to do until it ended.
  return room.status === 'LOBBY' || room.status === 'GAME_OVER'
}

function nameTaken(room: RoomRecord, name: string): boolean {
  const wanted = name.toLocaleLowerCase()
  return Object.values(room.players).some((p) => p.name.toLocaleLowerCase() === wanted)
}

function renamePlayer(room: RoomRecord, playerId: PlayerId, name: string): RoomRecord {
  const player = room.players[playerId]
  if (player === undefined) return room
  if (nameTaken(room, name) && player.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) return room
  return { ...room, players: { ...room.players, [playerId]: { ...player, name } } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  return issue === undefined ? 'Invalid settings.' : `${issue.path.join('.')}: ${issue.message}`
}

export function generateRoomCode(): RoomCode {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let code = ''
  for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]
  return code
}
