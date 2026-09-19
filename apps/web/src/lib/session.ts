import type { SessionResponse } from '@friendzone/shared'

/**
 * Who this browser is, per room.
 *
 * Stored per room code rather than globally, so opening a second room in
 * another tab does not overwrite the first — and so a stale session for a room
 * that ended never gets offered to a new one.
 *
 * Every access is wrapped: in a private window, or with site data blocked,
 * localStorage throws rather than returning null, and a party game should
 * degrade to "type your name again" rather than to a blank screen.
 */
const PREFIX = 'friendzone:session:'
const NAME_KEY = 'friendzone:name'

export interface StoredSession {
  roomCode: string
  playerId: string
  token: string
  expiresAt: number
  name: string
}

export function loadSession(roomCode: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(PREFIX + roomCode)
    if (raw === null) return null
    const session = JSON.parse(raw) as StoredSession
    // An expired token would be refused by the server anyway; drop it here so
    // the person is asked for a name instead of shown an error.
    if (session.expiresAt <= Date.now()) {
      localStorage.removeItem(PREFIX + roomCode)
      return null
    }
    return session
  } catch {
    return null
  }
}

export function saveSession(response: SessionResponse, name: string): StoredSession {
  const session: StoredSession = {
    roomCode: response.roomCode,
    playerId: response.playerId,
    token: response.token,
    expiresAt: response.expiresAt,
    name,
  }
  try {
    localStorage.setItem(PREFIX + response.roomCode, JSON.stringify(session))
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // Not fatal: the session lives in memory for this tab either way. Only a
    // refresh would lose it.
  }
  return session
}

export function clearSession(roomCode: string): void {
  try {
    localStorage.removeItem(PREFIX + roomCode)
  } catch {
    // Nothing to do; the token expires on its own.
  }
}

/** The last name this person used, so they only type it once. */
export function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}
