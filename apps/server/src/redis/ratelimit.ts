import { AppError } from '@friendzone/shared'
import type { Metrics } from '../metrics.ts'
import type { RedisKeys } from './keys.ts'
import type { RedisScripts } from './scripts.ts'

/**
 * Distributed token buckets.
 *
 * Enforced in Redis rather than per process, because with several instances
 * behind a load balancer a per-process limiter effectively multiplies every
 * quota by the instance count — and the instance count is exactly what an
 * attacker would discover by trying.
 *
 * Buckets rather than fixed windows: a person joining a room, fumbling the
 * name, and trying again should never be told to wait, while a script firing
 * continuously should be. A bucket allows the burst and then throttles to the
 * refill rate, which is the shape of the real distinction.
 */
export interface RateLimitSpec {
  capacity: number
  refillPerSecond: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export class RateLimiter {
  constructor(
    private readonly scripts: RedisScripts,
    private readonly keys: RedisKeys,
    private readonly metrics: Metrics,
  ) {}

  async check(bucket: string, subject: string, spec: RateLimitSpec, cost = 1): Promise<RateLimitResult> {
    // A bucket must live at least long enough to refill from empty, or a burst
    // could be reset simply by pausing until the key expires.
    const ttlMs = Math.max(60_000, Math.ceil((spec.capacity / Math.max(spec.refillPerSecond, 0.01)) * 1000) + 60_000)

    try {
      const [allowed, remaining, retryAfterMs] = await this.scripts.tokenBucket(
        this.keys.rateLimit(bucket, subject),
        spec.capacity,
        spec.refillPerSecond,
        Date.now(),
        cost,
        ttlMs,
      )
      if (allowed !== 1) this.metrics.rateLimited.inc({ bucket })
      return { allowed: allowed === 1, remaining, retryAfterMs }
    } catch {
      // Redis is unavailable. Fail open: refusing every request would turn a
      // cache outage into a full outage, and the limiter protects against
      // abuse rather than guarding correctness. Redis being down is itself
      // alarming and visible in the metrics above.
      return { allowed: true, remaining: spec.capacity, retryAfterMs: 0 }
    }
  }

  /**
   * Take a token and read the room together.
   *
   * The hot path: one round trip instead of two. Returns null for the room
   * when it does not exist, exactly as a plain read would.
   */
  async checkAndReadRoom(
    bucket: string,
    subject: string,
    spec: RateLimitSpec,
    roomKey: string,
  ): Promise<{ limit: RateLimitResult; room: { version: number; state: string } | null }> {
    const ttlMs = Math.max(60_000, Math.ceil((spec.capacity / Math.max(spec.refillPerSecond, 0.01)) * 1000) + 60_000)

    const [allowed, remaining, retryAfterMs, version, state] = await this.scripts.limitAndRead(
      this.keys.rateLimit(bucket, subject),
      roomKey,
      spec.capacity,
      spec.refillPerSecond,
      Date.now(),
      1,
      ttlMs,
    )

    if (allowed !== 1) this.metrics.rateLimited.inc({ bucket })

    return {
      limit: { allowed: allowed === 1, remaining, retryAfterMs },
      room: version === '' || state === '' ? null : { version: Number(version), state },
    }
  }

  /** Check and throw the client-safe error, for call sites that just want a gate. */
  async enforce(bucket: string, subject: string, spec: RateLimitSpec, cost = 1): Promise<void> {
    const result = await this.check(bucket, subject, spec, cost)
    if (result.allowed) return
    throw new AppError('RATE_LIMITED', undefined, { retryAfter: Math.ceil(result.retryAfterMs / 1000) })
  }
}
