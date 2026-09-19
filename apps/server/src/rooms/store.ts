import { AppError, type RoomCode } from '@friendzone/shared'
import type { Redis } from 'ioredis'
import type { RedisKeys } from '../redis/keys.ts'
import type { RedisScripts } from '../redis/scripts.ts'
import type { RoomRecord } from './state.ts'

/**
 * The only thing that reads or writes authoritative room state.
 *
 * Concurrency is handled by optimistic compare-and-set rather than by locking.
 * A mutation is: read (state, version) -> run pure reducers -> write claiming
 * that version. If another instance wrote in between, the write is refused and
 * the whole thing runs again from the state that won.
 *
 * This is preferred over a distributed lock for three reasons. There is no
 * lease to expire, so a server dying mid-mutation strands nothing. There is no
 * lock to forget to release. And under the load that actually matters — one
 * room, several players tapping at once — conflicts are rare and a retry is
 * microseconds of pure function, not a network round trip waiting on a mutex.
 */

export interface VersionedRoom {
  room: RoomRecord
  version: number
}

/** What a mutation produced, plus whatever the caller wants to carry out. */
export interface MutationResult<T> {
  room: RoomRecord
  /** Applied after a successful write, never on a retried attempt. */
  value: T
}

export class RoomConflictError extends Error {
  constructor() {
    super('room version conflict')
    this.name = 'RoomConflictError'
  }
}

export interface RoomStoreOptions {
  lobbyTtlSeconds: number
  finishedTtlSeconds: number
  maxRetries: number
}

export class RoomStore {
  constructor(
    private readonly redis: Redis,
    private readonly scripts: RedisScripts,
    private readonly keys: RedisKeys,
    private readonly options: RoomStoreOptions,
    /** Called whenever a write lost its race, so conflicts are observable. */
    private readonly onConflict?: () => void,
  ) {}

  /** The key a room lives under, for callers that read it alongside something else. */
  roomKey(code: RoomCode): string {
    return this.keys.room(code)
  }

  async read(code: RoomCode): Promise<VersionedRoom | null> {
    const raw = await this.redis.hmget(this.keys.room(code), 'version', 'state')
    const [version, state] = raw
    if (version == null || state == null) return null
    return { room: JSON.parse(state) as RoomRecord, version: Number(version) }
  }

  async require(code: RoomCode): Promise<VersionedRoom> {
    const found = await this.read(code)
    if (found === null) throw new AppError('ROOM_NOT_FOUND')
    return found
  }

  /** Create a room, failing if the code is already taken. */
  async create(room: RoomRecord, deadlineAt: number | null): Promise<void> {
    const written = await this.write(room, 0, deadlineAt)
    if (!written) throw new AppError('CONFLICT_RETRY_EXHAUSTED', 'That room code was just taken.')
  }

  /**
   * Read, transform, write — retrying on conflict.
   *
   * `mutate` must be pure with respect to the room: it may be called several
   * times, and only the attempt that wins the race has any effect. Side effects
   * belong in the value it returns, which the caller runs afterwards.
   */
  async update<T>(
    code: RoomCode,
    mutate: (room: RoomRecord, version: number) => MutationResult<T> | null,
    deadlineFor: (room: RoomRecord) => number | null,
    /**
     * A room already read by the caller in the same round trip as something
     * else. Used for the first attempt only — a retry must re-read, because
     * the whole point of retrying is that this version lost.
     */
    prefetched?: VersionedRoom,
  ): Promise<{ room: RoomRecord; version: number; value: T } | null> {
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      const current = attempt === 0 && prefetched !== undefined ? prefetched : await this.require(code)
      const result = mutate(current.room, current.version)
      // A mutation with nothing to do: not an error, just no write.
      if (result === null) return null

      const nextVersion = current.version + 1
      const ok = await this.write(result.room, current.version, deadlineFor(result.room), nextVersion)
      if (ok) return { room: result.room, version: nextVersion, value: result.value }
      this.onConflict?.()
      // Lost the race. Loop: re-read and re-run against the winner's state.
    }
    throw new AppError('CONFLICT_RETRY_EXHAUSTED')
  }

  private async write(
    room: RoomRecord,
    expectedVersion: number,
    deadlineAt: number | null,
    nextVersion = expectedVersion + 1,
  ): Promise<boolean> {
    const ttlMs = this.ttlFor(room) * 1000
    const result = await this.scripts.casWrite(
      this.keys.room(room.code),
      this.keys.deadlines,
      this.keys.activeRooms,
      [
        String(expectedVersion),
        String(nextVersion),
        JSON.stringify(room),
        String(ttlMs),
        deadlineAt === null ? '' : String(deadlineAt),
        room.code,
      ],
    )
    return result === 1
  }

  /**
   * How long a room survives without being touched. A lobby nobody ever
   * started should not outlive the evening, and a finished room only needs to
   * stay up long enough for everyone to read the leaderboard and hit Play
   * Again. Every write refreshes it, so an active room never expires.
   */
  private ttlFor(room: RoomRecord): number {
    if (room.status === 'GAME_OVER' || room.status === 'CLOSED') return this.options.finishedTtlSeconds
    if (room.status === 'LOBBY') return this.options.lobbyTtlSeconds
    // A game in progress is kept for a lobby's worth of time past its last
    // write, which is far longer than any single round.
    return this.options.lobbyTtlSeconds
  }

  async delete(code: RoomCode): Promise<void> {
    await Promise.all([
      this.redis.del(this.keys.room(code)),
      this.redis.zrem(this.keys.deadlines, code),
      this.redis.srem(this.keys.activeRooms, code),
    ])
  }

  /** Rooms whose deadline has passed, leased to this caller for `leaseMs`. */
  async claimDue(now: number, leaseMs: number, limit: number): Promise<RoomCode[]> {
    return this.scripts.claimDue(this.keys.deadlines, now, now + leaseMs, limit)
  }

  async activeRoomCount(): Promise<number> {
    return this.redis.scard(this.keys.activeRooms)
  }

  /** Drop codes from the active set whose room hash has already expired. */
  async pruneActiveSet(limit = 200): Promise<number> {
    const codes = await this.redis.srandmember(this.keys.activeRooms, limit)
    if (codes.length === 0) return 0
    const pipeline = this.redis.pipeline()
    for (const code of codes) pipeline.exists(this.keys.room(code))
    const results = await pipeline.exec()
    const stale = codes.filter((_, i) => results?.[i]?.[1] === 0)
    if (stale.length > 0) {
      await this.redis.srem(this.keys.activeRooms, ...stale)
      await this.redis.zrem(this.keys.deadlines, ...stale)
    }
    return stale.length
  }
}
