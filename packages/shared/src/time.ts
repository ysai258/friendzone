/**
 * Clock helpers. Every duration in the system is epoch milliseconds produced by
 * the server; clients only ever subtract their own estimated offset for display.
 */

export const SECOND = 1000
export const MINUTE = 60 * SECOND

/** Milliseconds left until `deadline`, floored at zero. */
export function remainingMs(deadline: number | null, now: number): number {
  if (deadline === null) return 0
  return Math.max(0, deadline - now)
}

/** Whole seconds a countdown should display. Rounds up so a bar reading "1"
 *  is shown for the final second rather than flicking to "0" early. */
export function remainingSeconds(deadline: number | null, now: number): number {
  return Math.ceil(remainingMs(deadline, now) / SECOND)
}

/** Fraction of a phase already elapsed, clamped to [0, 1]. */
export function phaseProgress(startedAt: number | null, deadline: number | null, now: number): number {
  if (startedAt === null || deadline === null) return 0
  const span = deadline - startedAt
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (now - startedAt) / span))
}

/**
 * Rolling estimate of (server clock - local clock), refined on every pong.
 *
 * A client's own Date.now() is not trustworthy: laptops wake with a stale
 * clock, phones drift, and a user can simply change it. Countdowns are drawn
 * from serverNow() instead, so a wrong local clock changes nothing.
 */
export class ClockSync {
  private offsetMs = 0
  private bestRoundTrip = Number.POSITIVE_INFINITY
  private samples = 0

  /** Fold in one round trip. The lowest-latency sample wins: on a symmetric
   *  path its offset carries the least one-way error. */
  sample(sentAt: number, serverTime: number, receivedAt: number): void {
    const roundTrip = receivedAt - sentAt
    if (roundTrip < 0) return
    if (roundTrip <= this.bestRoundTrip || this.samples === 0) {
      this.bestRoundTrip = roundTrip
      this.offsetMs = serverTime + roundTrip / 2 - receivedAt
    }
    this.samples++
  }

  /** Seed from a single HTTP response before any socket exists. */
  seed(serverTime: number, receivedAt: number): void {
    if (this.samples === 0) this.offsetMs = serverTime - receivedAt
  }

  get offset(): number {
    return this.offsetMs
  }

  get roundTripMs(): number {
    return Number.isFinite(this.bestRoundTrip) ? this.bestRoundTrip : 0
  }

  get synced(): boolean {
    return this.samples > 0
  }

  /** Best estimate of the server's clock, right now. */
  serverNow(): number {
    return Date.now() + this.offsetMs
  }
}
