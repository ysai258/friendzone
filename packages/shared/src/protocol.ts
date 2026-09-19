import { z } from 'zod'
import type { PlayerId, RoomCode } from './ids.ts'
import type { PublicRoomView } from './room.ts'
import type { WireError } from './errors.ts'

/** Bumped when a change to these shapes is not backward compatible. A client
 *  holding an older version is told to reload rather than fed a payload it
 *  will misread. */
export const PROTOCOL_VERSION = 1

/** Hard ceiling on a single inbound WebSocket frame. Nothing a client legitimately
 *  sends comes close; the cap exists so one socket cannot buy unbounded parsing. */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024

export const DISPLAY_NAME_MAX = 20

/** Keys that must never reach an object built from client input. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Parse JSON that came from a client, refusing anything carrying a key that can
 * reach an object's prototype.
 *
 * This has to happen during parsing, not after it. `JSON.parse` does create
 * `__proto__` as an ordinary own property, but the moment that object is
 * copied — by a schema validator, a spread, or Object.assign — the copy is
 * built with `=`, and `target.__proto__ = value` sets the prototype instead
 * of storing a key. By the time any later check runs, there is no own
 * `__proto__` left to find and the damage is already done. A reviver sees the
 * key while it is still just a key.
 */
export function parseClientJson(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError(`forbidden key: ${key}`)
    return value
  })
}

/**
 * Object whose keys came from a client. Second line of defence behind
 * parseClientJson, for any path that did not come through it.
 */
export const safeRecord = z
  .record(z.string(), z.unknown())
  .refine((obj) => Object.keys(obj).every((k) => !FORBIDDEN_KEYS.has(k)), {
    message: 'forbidden key',
  })

/**
 * Control characters, plus the invisible formatting characters people paste
 * in to fake a duplicate name or smuggle direction overrides into a lobby.
 * Built from a string literal so this source file holds no invisible bytes.
 */
const INVISIBLE_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex -- stripping them is exactly the point
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'g',
)

/** Trim, collapse internal whitespace, strip anything invisible. */
export function normalizeDisplayName(raw: string): string {
  return raw
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DISPLAY_NAME_MAX)
}

export const displayNameSchema = z
  .string()
  .max(200)
  .transform(normalizeDisplayName)
  .refine((n) => n.length >= 1 && n.length <= DISPLAY_NAME_MAX, { message: 'name length' })

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Room-level actions carry a `room/` prefix. That single convention is how the
 * room service dispatches without knowing a thing about any game: prefixed goes
 * to the room reducer, everything else is handed to the game definition.
 */
export const ROOM_ACTION_PREFIX = 'room/'

export const ROOM_ACTIONS = {
  START_GAME: 'room/start-game',
  UPDATE_CONFIG: 'room/update-config',
  PLAY_AGAIN: 'room/play-again',
  KICK_PLAYER: 'room/kick-player',
  CONTINUE: 'room/continue',
  LEAVE: 'room/leave',
} as const

export const clientHelloSchema = z.strictObject({
  t: z.literal('hello'),
  token: z.string().min(8).max(512),
  protocolVersion: z.int(),
  clientTime: z.number(),
})

export const clientActionSchema = z.strictObject({
  t: z.literal('action'),
  /** Client-generated UUID. The server records it and ignores repeats, which is
   *  what makes a retry after a flaky network safe. */
  actionId: z.uuid(),
  type: z.string().min(1).max(64).regex(/^[a-z0-9/_-]+$/),
  payload: safeRecord.default({}),
})

export const clientPingSchema = z.strictObject({
  t: z.literal('ping'),
  clientTime: z.number(),
})

export const clientResyncSchema = z.strictObject({
  t: z.literal('resync'),
})

export const clientMessageSchema = z.discriminatedUnion('t', [
  clientHelloSchema,
  clientActionSchema,
  clientPingSchema,
  clientResyncSchema,
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ClientAction = z.infer<typeof clientActionSchema>

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const PUBLIC_EVENTS = [
  'PLAYER_JOINED',
  'PLAYER_LEFT',
  'PLAYER_DISCONNECTED',
  'PLAYER_RECONNECTED',
  'PLAYER_INACTIVE',
  'PLAYER_KICKED',
  'HOST_CHANGED',
  'CONFIG_UPDATED',
  'GAME_STARTED',
  'ROUND_STARTED',
  'PLAYER_ANSWERED',
  'PLAYER_SCORED',
  'ROUND_ENDED',
  'GAME_COMPLETED',
  'ROOM_RESET',
] as const
export type PublicEventType = (typeof PUBLIC_EVENTS)[number]

/** Broadcast alongside state so the UI can animate a change rather than diffing
 *  two snapshots to guess what happened. Never carries hidden information. */
export interface PublicEvent {
  type: PublicEventType
  at: number
  seq: number
  data: Record<string, unknown>
}

export type ServerMessage =
  | { t: 'welcome'; protocolVersion: number; playerId: PlayerId; roomCode: RoomCode; serverTime: number; room: PublicRoomView }
  | { t: 'state'; room: PublicRoomView; events: PublicEvent[] }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; error: WireError }
  | { t: 'bye'; reason: ByeReason; message: string }

export const BYE_REASONS = ['KICKED', 'ROOM_CLOSED', 'SERVER_SHUTDOWN', 'REPLACED', 'PROTOCOL_MISMATCH'] as const
export type ByeReason = (typeof BYE_REASONS)[number]

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const createRoomRequestSchema = z.strictObject({
  name: displayNameSchema,
  gameId: z.string().min(1).max(40).optional(),
})

export const joinRoomRequestSchema = z.strictObject({
  name: displayNameSchema,
  /** Present when this browser already holds a session for the room, which turns
   *  the join into a rejoin instead of creating a second seat. */
  token: z.string().min(8).max(512).optional(),
})

export interface SessionResponse {
  roomCode: RoomCode
  playerId: PlayerId
  token: string
  expiresAt: number
  joinUrl: string
  isHost: boolean
  serverTime: number
}

/** Unauthenticated peek used by the join screen. Deliberately thin: it reveals
 *  whether knocking is worthwhile and nothing about who is inside. */
export interface RoomPeekResponse {
  code: RoomCode
  status: string
  gameId: string
  gameName: string
  playerCount: number
  maxPlayers: number
  joinable: boolean
}
