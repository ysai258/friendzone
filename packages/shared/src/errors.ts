/**
 * The full error vocabulary. Clients switch on `code`; `message` is a short
 * human string safe to render. Nothing else crosses the wire — no stack, no
 * driver text, no internal identifiers.
 */
export const ERROR_CODES = {
  // Room / lobby
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_CLOSED: 410,
  ROOM_CODE_INVALID: 400,
  GAME_ALREADY_STARTED: 409,
  GAME_NOT_STARTED: 409,
  NOT_ENOUGH_PLAYERS: 409,
  TOO_MANY_PLAYERS: 409,
  NAME_TAKEN: 409,
  NAME_INVALID: 400,

  // Authorisation
  NOT_HOST: 403,
  SESSION_EXPIRED: 401,
  SESSION_INVALID: 401,
  PLAYER_NOT_FOUND: 404,
  PLAYER_REMOVED: 403,
  FORBIDDEN: 403,

  // Gameplay
  INVALID_ACTION: 400,
  INVALID_ROUND: 409,
  ROUND_CLOSED: 409,
  ALREADY_ANSWERED: 409,
  NOT_YOUR_TURN: 409,
  UNKNOWN_GAME: 400,
  INVALID_CONFIG: 400,

  // Platform
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_FAILED: 400,
  CONFLICT_RETRY_EXHAUSTED: 503,
  CONTENT_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code]
}

export interface WireError {
  code: ErrorCode
  message: string
  /** Echoed back so a client can match the failure to the action it sent. */
  actionId?: string
  /** Seconds to wait; only ever set on RATE_LIMITED. */
  retryAfter?: number
}

/** The only error type allowed to reach a client. Anything else becomes INTERNAL. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryAfter?: number
  /** Free-form context for logs. Never serialised to a client. */
  readonly context?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message?: string,
    options?: { retryAfter?: number; context?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message ?? DEFAULT_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter
    if (options?.context !== undefined) this.context = options.context
  }

  get status(): number {
    return httpStatusFor(this.code)
  }

  toWire(actionId?: string): WireError {
    const wire: WireError = { code: this.code, message: this.message }
    if (actionId !== undefined) wire.actionId = actionId
    if (this.retryAfter !== undefined) wire.retryAfter = this.retryAfter
    return wire
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}

/**
 * Anything thrown anywhere becomes a client-safe wire error here. Unknown
 * failures collapse to INTERNAL with a fixed message so a driver error or a
 * stack frame can never leak through a response body.
 */
export function toWireError(err: unknown, actionId?: string): WireError {
  if (isAppError(err)) return err.toWire(actionId)
  const wire: WireError = { code: 'INTERNAL', message: DEFAULT_MESSAGES.INTERNAL }
  if (actionId !== undefined) wire.actionId = actionId
  return wire
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: "That room doesn't exist any more.",
  ROOM_FULL: 'This room is full.',
  ROOM_CLOSED: 'This room has closed.',
  ROOM_CODE_INVALID: "That doesn't look like a room code.",
  GAME_ALREADY_STARTED: 'The game has already started.',
  GAME_NOT_STARTED: 'The game has not started yet.',
  NOT_ENOUGH_PLAYERS: 'You need more players to start.',
  TOO_MANY_PLAYERS: 'Too many players for this game.',
  NAME_TAKEN: 'Someone in the room already has that name.',
  NAME_INVALID: 'Pick a name between 1 and 20 characters.',
  NOT_HOST: 'Only the host can do that.',
  SESSION_EXPIRED: 'Your session expired. Rejoin the room.',
  SESSION_INVALID: 'Your session is not valid for this room.',
  PLAYER_NOT_FOUND: 'Player not found in this room.',
  PLAYER_REMOVED: 'You were removed from this room.',
  FORBIDDEN: 'Not allowed.',
  INVALID_ACTION: "That move isn't valid right now.",
  INVALID_ROUND: 'That round is no longer active.',
  ROUND_CLOSED: 'This round already ended.',
  ALREADY_ANSWERED: 'You already answered this round.',
  NOT_YOUR_TURN: "It's not your turn.",
  UNKNOWN_GAME: 'Unknown game.',
  INVALID_CONFIG: 'Those game settings are not valid.',
  RATE_LIMITED: "You're going too fast. Slow down a moment.",
  PAYLOAD_TOO_LARGE: 'That message is too large.',
  VALIDATION_FAILED: 'The request was malformed.',
  CONFLICT_RETRY_EXHAUSTED: 'The room is busy. Try that again.',
  CONTENT_UNAVAILABLE: 'No questions are available for those settings.',
  SERVICE_UNAVAILABLE: 'Temporarily unavailable. Try again shortly.',
  INTERNAL: 'Something went wrong on our side.',
}
