import type { PlayerId, RoomCode } from './ids.ts'

/**
 * Room lifecycle. The room service owns these transitions; a game definition
 * can request a move (via its own phase machine) but never writes them itself.
 *
 *   CREATED -> LOBBY -> STARTING -> PLAYING <-> ROUND_RESULT -> GAME_OVER
 *                ^                                                  |
 *                +-------------------- PLAY_AGAIN ------------------+
 */
export const ROOM_STATUSES = [
  'LOBBY',
  'STARTING',
  'PLAYING',
  'ROUND_RESULT',
  'GAME_OVER',
  'CLOSED',
] as const
export type RoomStatus = (typeof ROOM_STATUSES)[number]

/**
 * Presence is deliberately three-valued. A dropped socket is not a departure:
 * the seat, the score and any in-flight round state survive until the grace
 * period expires, at which point the player becomes INACTIVE and the game is
 * told so it can stop waiting on them.
 */
export const PRESENCE_STATES = ['CONNECTED', 'DISCONNECTED', 'INACTIVE'] as const
export type PresenceState = (typeof PRESENCE_STATES)[number]

export interface Player {
  id: PlayerId
  name: string
  /** Monotonic per room. The sole input to host succession, so it never changes. */
  joinSeq: number
  avatar: string
  presence: PresenceState
  joinedAt: number
  lastSeenAt: number
  /** Epoch ms at which a DISCONNECTED player becomes INACTIVE. */
  graceEndsAt: number | null
  /** Cumulative score across the current game session. */
  score: number
}

export interface RoomConfig {
  gameId: string
  maxPlayers: number
  /** Game-specific; validated against the game definition's own schema. */
  settings: Record<string, unknown>
}

export interface PublicPlayer {
  id: PlayerId
  name: string
  avatar: string
  presence: PresenceState
  isHost: boolean
  joinSeq: number
  score: number
}

export interface ScoreEntry {
  playerId: PlayerId
  name: string
  avatar: string
  score: number
  rank: number
  /** Points gained in the round that just resolved, when one has. */
  delta: number | null
}

/**
 * Everything a client is allowed to know. Built per viewer: `game` has already
 * been through the game definition's getPublicState for this specific player,
 * so secrets belonging to others are absent from the payload, not merely hidden
 * by the UI.
 */
export interface PublicRoomView {
  code: RoomCode
  status: RoomStatus
  hostId: PlayerId
  players: PublicPlayer[]
  config: RoomConfig
  /** Authoritative clock reading at the moment this view was produced. */
  serverTime: number
  /** Epoch ms when the current phase ends, or null if nothing is timed. */
  deadlineAt: number | null
  /** Epoch ms when the current phase began; lets clients draw a full bar. */
  phaseStartedAt: number | null
  game: GamePublicState | null
  scoreboard: ScoreEntry[]
  version: number
  viewerId: PlayerId | null
}

/** Shape a game definition must produce. `phase` drives which screen renders. */
export interface GamePublicState {
  gameId: string
  sessionId: string
  phase: string
  roundNumber: number
  totalRounds: number
  /** Free-form, game-specific, already filtered for the viewer. */
  view: Record<string, unknown>
}

/** Declarative host-configuration field, rendered generically by the web UI. */
export type SettingField =
  | { key: string; label: string; help?: string; kind: 'int'; min: number; max: number; step: number; default: number; unit?: string }
  | { key: string; label: string; help?: string; kind: 'bool'; default: boolean }
  | { key: string; label: string; help?: string; kind: 'choice'; options: { value: string; label: string }[]; default: string }

export interface GameCatalogEntry {
  id: string
  name: string
  tagline: string
  description: string
  emoji: string
  accent: string
  minPlayers: number
  maxPlayers: number
  estimatedMinutes: number
  settings: SettingField[]
  /** False while a game is present in the registry but not offered in the lobby. */
  playable: boolean
}
