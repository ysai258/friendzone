/** Identifier shapes shared by every layer. Plain aliases: they document intent
 *  at call sites without forcing casts through the pure reducers. */
export type RoomCode = string
export type PlayerId = string
export type SessionId = string
export type ActionId = string
export type GameSessionId = string

/**
 * Room-code alphabet. Deliberately excludes the characters people mis-hear or
 * mis-type when reading a code aloud to a friend: 0/O, 1/I/L, 5/S, 8/B, U/V.
 * 25 symbols over 5 characters is ~9.8M codes, which keeps collision retries
 * negligible at our scale while staying short enough to say over a phone call.
 */
export const ROOM_CODE_ALPHABET = '234679ACDEFGHJKMNPQRTWXYZ'
export const ROOM_CODE_LENGTH = 5

/**
 * Uppercase and drop separators people paste in ("ab7-kq", "AB7 KQ").
 *
 * Note what this deliberately does NOT do: fold look-alike characters such as
 * O -> Q. Ambiguous characters are excluded at generation time, so a code
 * containing one cannot exist. Folding it would let a typo resolve to a real
 * room belonging to strangers, which is worse than a clean ROOM_NOT_FOUND.
 */
export function normalizeRoomCode(input: string): RoomCode {
  return input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}
