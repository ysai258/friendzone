import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { AppError, type PlayerId, type RoomCode } from '@friendzone/shared'

/**
 * Identity without accounts.
 *
 * A player is a random id plus a signed statement that the id belongs to this
 * room. The token is HMAC-signed by the server and stored in the browser; it
 * carries no secret and grants nothing beyond a seat in one room, so losing one
 * costs a stranger exactly one nickname in one party game.
 *
 * Why not a bare id in localStorage: the id is the only thing standing between
 * a player and someone else's score. Unsigned, anybody who saw an id in a
 * payload could claim it. Signed, the id must have been issued by this server
 * for this room, and cannot be edited without the key.
 *
 * Deliberately not JWT. There are no claims to negotiate, no algorithm field to
 * confuse, and no library to keep patched — three fields and one HMAC.
 */

const VERSION = 'v1'

export interface SessionToken {
  playerId: PlayerId
  roomCode: RoomCode
  issuedAt: number
  expiresAt: number
}

export class SessionSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  issue(roomCode: RoomCode, now: number, playerId: PlayerId = randomUUID()): { token: string; session: SessionToken } {
    const session: SessionToken = {
      playerId,
      roomCode,
      issuedAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    }
    return { token: this.sign(session), session }
  }

  private sign(session: SessionToken): string {
    const body = `${VERSION}.${session.playerId}.${session.roomCode}.${session.issuedAt}.${session.expiresAt}`
    return `${body}.${this.mac(body)}`
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }

  /**
   * Verify a token and return what it asserts.
   *
   * The signature is compared in constant time, and the room code is checked
   * against the room actually being entered — a valid token for room A must not
   * open room B.
   */
  verify(token: string, expectedRoom: RoomCode, now: number): SessionToken {
    const parts = token.split('.')
    if (parts.length !== 6) throw new AppError('SESSION_INVALID')

    const [version, playerId, roomCode, issuedAt, expiresAt, signature] = parts as [string, string, string, string, string, string]
    if (version !== VERSION) throw new AppError('SESSION_INVALID')

    const body = `${version}.${playerId}.${roomCode}.${issuedAt}.${expiresAt}`
    const expected = this.mac(body)

    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('SESSION_INVALID')

    const expiry = Number(expiresAt)
    if (!Number.isFinite(expiry) || expiry <= now) throw new AppError('SESSION_EXPIRED')
    if (roomCode !== expectedRoom) throw new AppError('SESSION_INVALID', 'That session belongs to a different room.')

    return { playerId, roomCode, issuedAt: Number(issuedAt), expiresAt: expiry }
  }
}
