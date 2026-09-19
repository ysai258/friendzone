import {
  avatarFor,
  type PlayerId,
  type Player,
  type PublicEvent,
  type PublicEventType,
  type RoomConfig,
  type RoomStatus,
} from '@friendzone/shared'

/**
 * The authoritative room, exactly as it is stored in Redis.
 *
 * Everything in this file is a pure function of a RoomRecord. That is not
 * stylistic: the store writes with a compare-and-set, and a losing write is
 * retried by re-running these functions against whichever state won. Purity is
 * what makes that retry equivalent to having gone second in the first place.
 */
export interface RoomRecord {
  code: string
  createdAt: number
  /** Seeds every draw the games make. Stored so a session is reproducible. */
  seed: string
  status: RoomStatus
  hostId: PlayerId
  players: Record<PlayerId, Player>
  /** Monotonic. Assigned once per player and never reused, because host
   *  succession is defined in terms of it. */
  joinCounter: number
  config: RoomConfig
  session: GameSessionRecord | null
  /** Cumulative score for the current session, owned by the room so the
   *  leaderboard works identically for every game. */
  scores: Record<PlayerId, number>
  /** Points from the round that just resolved, for the "+320" flourish. */
  lastDeltas: Record<PlayerId, number>
  /** Recently applied action ids, newest last. Bounded; see rememberAction. */
  recentActions: string[]
  eventSeq: number
  lastActivityAt: number
  closedAt: number | null
  /** Games played in this room so far, incremented by Play Again. */
  sessionCount: number
}

export interface GameSessionRecord {
  sessionId: string
  gameId: string
  /** Opaque to the room service. Only the matching game definition reads it. */
  state: unknown
  startedAt: number
}

/** How many action ids to remember for duplicate suppression. */
export const ACTION_MEMORY = 256

// ---------------------------------------------------------------------------
// Players and presence
// ---------------------------------------------------------------------------

export function addPlayer(room: RoomRecord, playerId: PlayerId, name: string, now: number): RoomRecord {
  const joinSeq = room.joinCounter + 1
  const player: Player = {
    id: playerId,
    name,
    joinSeq,
    avatar: avatarFor(playerId),
    presence: 'CONNECTED',
    joinedAt: now,
    lastSeenAt: now,
    graceEndsAt: null,
    score: 0,
  }
  return {
    ...room,
    joinCounter: joinSeq,
    players: { ...room.players, [playerId]: player },
    scores: { ...room.scores, [playerId]: room.scores[playerId] ?? 0 },
    lastActivityAt: now,
  }
}

export function setPresence(
  room: RoomRecord,
  playerId: PlayerId,
  presence: Player['presence'],
  now: number,
  graceSeconds: number,
): RoomRecord {
  const player = room.players[playerId]
  if (player === undefined) return room

  const updated: Player = {
    ...player,
    presence,
    lastSeenAt: now,
    // A dropped socket starts a clock rather than removing anybody. Their seat,
    // their score and any answer they already locked in all survive it.
    graceEndsAt: presence === 'DISCONNECTED' ? now + graceSeconds * 1000 : null,
  }

  return {
    ...room,
    players: { ...room.players, [playerId]: updated },
    lastActivityAt: now,
  }
}

export function removePlayer(room: RoomRecord, playerId: PlayerId, now: number): RoomRecord {
  const players = { ...room.players }
  delete players[playerId]
  // The score stays: a player who rejoins the same room keeps what they earned,
  // and the final results should still name someone who left near the end.
  return { ...room, players, lastActivityAt: now }
}

export function connectedPlayers(room: RoomRecord): Player[] {
  return Object.values(room.players).filter((p) => p.presence === 'CONNECTED')
}

export function seatedPlayers(room: RoomRecord): Player[] {
  return Object.values(room.players).filter((p) => p.presence !== 'INACTIVE')
}

/** Ordered by arrival. The canonical order for host succession and turn order. */
export function playersByJoinSeq(room: RoomRecord): Player[] {
  return Object.values(room.players).sort((a, b) => a.joinSeq - b.joinSeq)
}

// ---------------------------------------------------------------------------
// Host migration
// ---------------------------------------------------------------------------

/**
 * Who should be host right now.
 *
 * The rule is: the connected player with the lowest join sequence. It is chosen
 * for being deterministic rather than clever — every instance computes the same
 * answer from the same state without talking to any other instance, so a host
 * change during a network partition cannot produce two hosts.
 *
 * A merely disconnected host keeps the role while their grace period runs; a
 * ten-second phone tunnel should not hand the room to somebody else. Only once
 * nobody is connected does the seat fall back to the earliest seated player, so
 * a room that everyone briefly drops out of still has a host to come back to.
 */
export function electHost(room: RoomRecord): PlayerId {
  const current = room.players[room.hostId]
  if (current !== undefined && current.presence !== 'INACTIVE') {
    if (current.presence === 'CONNECTED') return room.hostId
    // Host is mid-grace: keep them unless somebody is actually connected and
    // arrived earlier, which would mean the room already has a natural leader.
    const connected = connectedPlayers(room).sort((a, b) => a.joinSeq - b.joinSeq)
    const first = connected[0]
    return first === undefined || first.joinSeq > current.joinSeq ? room.hostId : first.id
  }

  const connected = connectedPlayers(room).sort((a, b) => a.joinSeq - b.joinSeq)
  if (connected[0] !== undefined) return connected[0].id

  const seated = seatedPlayers(room).sort((a, b) => a.joinSeq - b.joinSeq)
  return seated[0]?.id ?? room.hostId
}

/** Apply succession, reporting whether the room changed hands. */
export function reconcileHost(room: RoomRecord): { room: RoomRecord; changed: boolean } {
  const hostId = electHost(room)
  if (hostId === room.hostId) return { room, changed: false }
  return { room: { ...room, hostId }, changed: true }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Has this action already been applied?
 *
 * The record of seen ids lives inside the room state, so the check and the
 * effect are written under the same compare-and-set. A separate "seen" key
 * could be updated while the state write lost its race, which is exactly the
 * window a retry would slip through and score twice.
 */
export function hasSeenAction(room: RoomRecord, actionId: string): boolean {
  return room.recentActions.includes(actionId)
}

export function rememberAction(room: RoomRecord, actionId: string): RoomRecord {
  // Bounded on purpose. A room state that grows with every action would slow
  // every read of it, and duplicates only ever arrive within a retry window.
  const recent = [...room.recentActions, actionId]
  return { ...room, recentActions: recent.length > ACTION_MEMORY ? recent.slice(-ACTION_MEMORY) : recent }
}

// ---------------------------------------------------------------------------
// Scores and events
// ---------------------------------------------------------------------------

export function applyScoreDeltas(room: RoomRecord, deltas: Record<PlayerId, number>): RoomRecord {
  if (Object.keys(deltas).length === 0) return room
  const scores = { ...room.scores }
  for (const [playerId, delta] of Object.entries(deltas)) {
    if (room.players[playerId] === undefined) continue
    scores[playerId] = (scores[playerId] ?? 0) + delta
  }
  return { ...room, scores, lastDeltas: deltas }
}

export function nextEvents(
  room: RoomRecord,
  events: { type: PublicEventType; data: Record<string, unknown> }[],
  now: number,
): { room: RoomRecord; events: PublicEvent[] } {
  if (events.length === 0) return { room, events: [] }
  let seq = room.eventSeq
  const built = events.map((e) => ({ type: e.type, data: e.data, at: now, seq: ++seq }))
  return { room: { ...room, eventSeq: seq }, events: built }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function createRoom(args: {
  code: string
  seed: string
  hostId: PlayerId
  hostName: string
  config: RoomConfig
  now: number
}): RoomRecord {
  const empty: RoomRecord = {
    code: args.code,
    createdAt: args.now,
    seed: args.seed,
    status: 'LOBBY',
    hostId: args.hostId,
    players: {},
    joinCounter: 0,
    config: args.config,
    session: null,
    scores: {},
    lastDeltas: {},
    recentActions: [],
    eventSeq: 0,
    lastActivityAt: args.now,
    closedAt: null,
    sessionCount: 0,
  }
  return addPlayer(empty, args.hostId, args.hostName, args.now)
}

/** Back to the lobby with the same people and the same room code. */
export function resetToLobby(room: RoomRecord, now: number): RoomRecord {
  return {
    ...room,
    status: 'LOBBY',
    session: null,
    scores: Object.fromEntries(Object.keys(room.players).map((id) => [id, 0])),
    lastDeltas: {},
    lastActivityAt: now,
  }
}

export function isJoinable(room: RoomRecord): boolean {
  if (room.closedAt !== null) return false
  if (room.status === 'CLOSED') return false
  return true
}

export function seatCount(room: RoomRecord): number {
  return seatedPlayers(room).length
}
