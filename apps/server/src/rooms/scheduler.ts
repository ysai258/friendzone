import { AppError } from '@friendzone/shared'
import type { Logger } from '../logger.ts'
import type { Metrics } from '../metrics.ts'
import type { RoomService } from './service.ts'
import type { RoomStore } from './store.ts'

/**
 * The clock.
 *
 * Every timed transition in FriendZone — a round ending, a reveal advancing, a
 * disconnected player's grace running out — happens because this loop noticed a
 * deadline had passed. There is no setTimeout anywhere holding a pending round.
 *
 * Why it is built this way:
 *
 *  - A process holding in-memory timers loses every pending transition when it
 *    restarts or crashes. A sorted set in Redis does not, so a room whose
 *    server disappeared mid-round is picked up by another instance within a
 *    tick and continues from the state it was actually in.
 *
 *  - Claiming is atomic and leased. Several instances tick concurrently, but a
 *    room is handed to exactly one of them, and if that instance dies before
 *    finishing, the lease expires and someone else retries. A round can be
 *    late; it cannot be advanced twice or dropped.
 *
 * Correctness does not depend on the tick being fast. Every transition is
 * computed from the stored timestamps, so a late tick produces the same result
 * as a punctual one — the round simply resolves a few milliseconds later.
 */

/** How long a claimed room is reserved before another instance may retry it.
 *  Comfortably longer than a settle takes, short enough that a dead instance
 *  does not strand a round for a noticeable time. */
const CLAIM_LEASE_MS = 5_000

/** Ceiling on rooms processed per tick, so one busy instant cannot starve the
 *  event loop that is also serving WebSocket traffic. */
const MAX_PER_TICK = 200

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false
  private pruneCounter = 0

  constructor(
    private readonly service: RoomService,
    private readonly store: RoomStore,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly tickMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.stopped = false
    // unref so a pending tick never keeps the process alive during shutdown.
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    this.timer.unref()
    this.logger.info({ tickMs: this.tickMs }, 'scheduler started')
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Exposed so tests can drive the loop deterministically instead of waiting. */
  async tick(now = Date.now()): Promise<number> {
    // Ticks do not overlap. A slow tick delays the next one rather than
    // running two claims against the same rooms.
    if (this.running || this.stopped) return 0
    this.running = true
    const startedAt = process.hrtime.bigint()

    try {
      const due = await this.store.claimDue(now, CLAIM_LEASE_MS, MAX_PER_TICK)
      if (due.length === 0) return 0

      // Rooms are independent, so they settle concurrently. Each failure is
      // contained: one broken room must not stop the other 199.
      const results = await Promise.allSettled(due.map((code) => this.advance(code)))
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) this.metrics.schedulerErrors.inc(failed)

      this.metrics.roomsAdvanced.inc(due.length - failed)
      this.metrics.schedulerTickDuration.observe(Number(process.hrtime.bigint() - startedAt) / 1e9)
      return due.length
    } catch (error) {
      // Redis is unreachable. Log once per tick and keep ticking: the moment it
      // returns, every overdue room is still in the sorted set waiting.
      this.metrics.schedulerErrors.inc()
      this.logger.warn({ err: error }, 'scheduler tick failed')
      return 0
    } finally {
      this.running = false
      void this.maybePrune()
    }
  }

  private async advance(code: string): Promise<void> {
    try {
      await this.service.advanceDue(code)
    } catch (error) {
      if (error instanceof AppError && error.code === 'ROOM_NOT_FOUND') {
        // The room expired between being claimed and being read. Clear its
        // index entry so it is not claimed again every tick forever.
        await this.store.delete(code).catch(() => undefined)
        return
      }
      this.logger.error({ err: error, roomCode: code }, 'failed to advance room')
      throw error
    }
  }

  /**
   * Occasional housekeeping. Room hashes expire on their own TTL, which leaves
   * their codes behind in the active set and the deadline index; this drops
   * those. Run rarely, since it is pure bookkeeping.
   */
  private async maybePrune(): Promise<void> {
    if (this.stopped) return
    this.pruneCounter += 1
    const everyNTicks = Math.max(1, Math.floor(60_000 / this.tickMs))
    if (this.pruneCounter % everyNTicks !== 0) return
    try {
      const removed = await this.store.pruneActiveSet()
      if (removed > 0) this.logger.debug({ removed }, 'pruned expired room keys')
    } catch {
      // Best effort; the next pass will try again.
    }
  }
}
