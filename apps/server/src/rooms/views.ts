import type { GamePublicState, PlayerId, PublicPlayer, PublicRoomView, ScoreEntry } from '@friendzone/shared'
import type { ErasedGameDefinition, ViewContext } from '@friendzone/game-engine'
import { playersByJoinSeq, type RoomRecord } from './state.ts'

/**
 * Turn the authoritative room into the payload one specific player receives.
 *
 * Built per viewer rather than once per room, because the game's slice is
 * filtered by identity. That is a real cost — one getPublicState call per
 * connected player per update — and it is the right one: the alternative is a
 * shared payload with secrets in it and a client trusted not to look.
 */
export function buildRoomView(args: {
  room: RoomRecord
  version: number
  viewerId: PlayerId | null
  definition: ErasedGameDefinition | null
  now: number
}): PublicRoomView {
  const { room, viewerId, now } = args

  const players: PublicPlayer[] = playersByJoinSeq(room).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    presence: p.presence,
    isHost: p.id === room.hostId,
    joinSeq: p.joinSeq,
    score: room.scores[p.id] ?? 0,
  }))

  let game: GamePublicState | null = null
  let deadlineAt: number | null = null
  let phaseStartedAt: number | null = null

  if (room.session !== null && args.definition !== null) {
    const ctx: ViewContext = {
      now,
      seed: room.seed,
      players: playersByJoinSeq(room).map((p) => ({
        id: p.id,
        name: p.name,
        joinSeq: p.joinSeq,
        presence: p.presence,
      })),
      roomCode: room.code,
    }
    game = args.definition.getPublicState(room.session.state, viewerId, ctx)
    phaseStartedAt = readPhaseTime(room.session.state, 'phaseStartedAt')
    // The end of the phase a player is living through, which is what a
    // countdown on screen means.
    //
    // Deliberately not getDeadline(): that is the scheduler's next wake-up,
    // which during a Blur Battle round is the next reveal step, a few seconds
    // away. Publishing it would make every client's timer jump backwards each
    // time the image sharpened, and two clients a step apart would disagree
    // about when the round ends.
    //
    // A phase the game is not counting down at all — Mind Meld's discussion,
    // or a finished game — has no deadline to publish: its phaseEndsAt is
    // already in the past, and sending it parks a dead timer at zero on every
    // screen. getDeadline() returning null is exactly that statement.
    const scheduled = args.definition.getDeadline(room.session.state)
    deadlineAt = scheduled === null ? null : (readPhaseTime(room.session.state, 'phaseEndsAt') ?? scheduled)
  }

  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players,
    config: room.config,
    // Stamped here rather than by the client, which is what every countdown on
    // every screen is measured against.
    serverTime: now,
    deadlineAt,
    phaseStartedAt,
    game,
    scoreboard: buildScoreboard(room),
    version: args.version,
    viewerId,
  }
}

/**
 * Every game stores when its current phase began and ends, which is what lets
 * the UI draw a bar that empties rather than a bare number. Read structurally
 * and treated as optional, so a game that keeps neither simply gets no bar
 * instead of a crash.
 */
function readPhaseTime(state: unknown, key: 'phaseStartedAt' | 'phaseEndsAt'): number | null {
  if (typeof state !== 'object' || state === null) return null
  const value = (state as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : null
}

export function buildScoreboard(room: RoomRecord): ScoreEntry[] {
  const entries = playersByJoinSeq(room).map((p) => ({
    playerId: p.id,
    name: p.name,
    avatar: p.avatar,
    score: room.scores[p.id] ?? 0,
    delta: room.lastDeltas[p.id] ?? null,
  }))

  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  let rank = 0
  let lastScore = Number.NaN
  return entries.map((entry, index) => {
    if (entry.score !== lastScore) {
      rank = index + 1
      lastScore = entry.score
    }
    return { ...entry, rank }
  })
}
