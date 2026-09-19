import type { Redis } from 'ioredis'

/**
 * The three Lua scripts the system's correctness rests on. Each runs as a
 * single atomic Redis operation, which is what lets several server instances
 * share one room without a lock manager between them.
 */

/**
 * Compare-and-set a room, and update its scheduling entry in the same step.
 *
 * The room service reads a room at version N, runs the pure reducers, and
 * writes back claiming N. If another instance got there first the version no
 * longer matches, the write is refused, and the caller re-reads and re-runs.
 * Because the reducers are pure, replaying them against the state that actually
 * won is always correct — there is no partial mutation to unwind.
 *
 * Folding the deadline update in here matters: a room whose state said "this
 * round ends at T" while the index disagreed would either stall forever or be
 * advanced twice.
 *
 * KEYS[1] room hash   KEYS[2] deadline zset   KEYS[3] active-rooms set
 * ARGV[1] expected version ('0' for a create)
 * ARGV[2] new version      ARGV[3] state JSON
 * ARGV[4] ttl ms           ARGV[5] deadline epoch ms, or '' for none
 * ARGV[6] room code
 * -> 1 on success, 0 on version conflict
 */
export const CAS_WRITE = `
local current = redis.call('HGET', KEYS[1], 'version')
if current == false then
  if ARGV[1] ~= '0' then return 0 end
elseif current ~= ARGV[1] then
  return 0
end

redis.call('HSET', KEYS[1], 'version', ARGV[2], 'state', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[3], ARGV[6])

if ARGV[5] == '' then
  redis.call('ZREM', KEYS[2], ARGV[6])
else
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])
end
return 1
`

/**
 * Claim rooms whose deadline has passed.
 *
 * Claiming pushes each code forward by a lease rather than removing it. If the
 * instance that claimed a room dies before it finishes advancing, the lease
 * expires and another instance picks the room up — a round cannot be stranded
 * because a server went away mid-transition. The successful write that follows
 * overwrites the lease with the real next deadline.
 *
 * KEYS[1] deadline zset
 * ARGV[1] now   ARGV[2] lease-until   ARGV[3] max rooms per tick
 * -> array of room codes
 */
export const CLAIM_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
for i = 1, #due do
  redis.call('ZADD', KEYS[1], ARGV[2], due[i])
end
return due
`

/**
 * Token bucket, refilled lazily from the elapsed time rather than by a timer.
 *
 * Distributed on purpose: with several instances behind a load balancer, a
 * per-process limiter would multiply every quota by the instance count, which
 * is precisely the limit an attacker would go looking for.
 *
 * KEYS[1] bucket hash
 * ARGV[1] capacity  ARGV[2] refill/sec  ARGV[3] now ms  ARGV[4] cost  ARGV[5] ttl ms
 * -> { allowed, tokensRemaining, retryAfterMs }
 */
export const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])

if tokens == nil or at == nil then
  tokens = capacity
  at = now
end

local elapsed = math.max(0, now - at) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  if refill > 0 then
    retry = math.ceil(((cost - tokens) / refill) * 1000)
  else
    retry = ttl
  end
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, math.floor(tokens), retry }
`

/**
 * Take a token and read the room in one round trip.
 *
 * Added after profiling. Under 5,000 concurrent sockets, applying one action
 * cost about 240ms while the server sat at under half a core and Redis
 * reported 40 microseconds of work per action — so the time was not compute
 * and not Redis, it was waiting. Each action made three sequential round trips
 * (limit, read, write), and every await returns to an event loop with
 * thousands of pending socket events behind it. Measured loop lag was around
 * 70ms, which is three awaits' worth of exactly the latency observed.
 *
 * Folding the limiter into the read removes one of the three. It also makes
 * the pair atomic, which removes a smaller oddity: a request could pass the
 * limiter and then read a room that had been deleted in between.
 *
 * The read is skipped entirely when the bucket is empty, so a throttled client
 * costs strictly less than an accepted one.
 *
 * KEYS[1] bucket hash   KEYS[2] room hash
 * ARGV[1] capacity  ARGV[2] refill/sec  ARGV[3] now ms  ARGV[4] cost  ARGV[5] bucket ttl ms
 * -> { allowed, tokensRemaining, retryAfterMs, version|'', state|'' }
 */
export const LIMIT_AND_READ = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])

if tokens == nil or at == nil then
  tokens = capacity
  at = now
end

local elapsed = math.max(0, now - at) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  if refill > 0 then
    retry = math.ceil(((cost - tokens) / refill) * 1000)
  else
    retry = ttl
  end
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], ttl)

if allowed == 0 then
  return { 0, math.floor(tokens), retry, '', '' }
end

local room = redis.call('HMGET', KEYS[2], 'version', 'state')
local version = room[1]
local state = room[2]
if version == false then version = '' end
if state == false then state = '' end

return { 1, math.floor(tokens), 0, version, state }
`

/** Register the scripts once; ioredis then addresses them by SHA. */
export interface RedisScripts {
  casWrite(roomKey: string, deadlineKey: string, activeKey: string, args: [string, string, string, string, string, string]): Promise<number>
  claimDue(deadlineKey: string, now: number, leaseUntil: number, limit: number): Promise<string[]>
  tokenBucket(key: string, capacity: number, refillPerSecond: number, now: number, cost: number, ttlMs: number): Promise<[number, number, number]>
  limitAndRead(
    bucketKey: string,
    roomKey: string,
    capacity: number,
    refillPerSecond: number,
    now: number,
    cost: number,
    ttlMs: number,
  ): Promise<[number, number, number, string, string]>
}

export function defineScripts(redis: Redis): RedisScripts {
  redis.defineCommand('fzCasWrite', { numberOfKeys: 3, lua: CAS_WRITE })
  redis.defineCommand('fzClaimDue', { numberOfKeys: 1, lua: CLAIM_DUE })
  redis.defineCommand('fzTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET })
  redis.defineCommand('fzLimitAndRead', { numberOfKeys: 2, lua: LIMIT_AND_READ })

  // ioredis attaches defined commands at runtime; this shape describes them.
  const typed = redis as Redis & {
    fzCasWrite(roomKey: string, deadlineKey: string, activeKey: string, ...args: string[]): Promise<number>
    fzClaimDue(deadlineKey: string, now: string, leaseUntil: string, limit: string): Promise<string[]>
    fzTokenBucket(key: string, capacity: string, refill: string, now: string, cost: string, ttl: string): Promise<[number, number, number]>
    fzLimitAndRead(
      bucketKey: string,
      roomKey: string,
      capacity: string,
      refill: string,
      now: string,
      cost: string,
      ttl: string,
    ): Promise<[number, number, number, string, string]>
  }

  return {
    casWrite: (roomKey, deadlineKey, activeKey, args) => typed.fzCasWrite(roomKey, deadlineKey, activeKey, ...args),
    claimDue: (deadlineKey, now, leaseUntil, limit) =>
      typed.fzClaimDue(deadlineKey, String(now), String(leaseUntil), String(limit)),
    tokenBucket: (key, capacity, refillPerSecond, now, cost, ttlMs) =>
      typed.fzTokenBucket(key, String(capacity), String(refillPerSecond), String(now), String(cost), String(ttlMs)),
    limitAndRead: (bucketKey, roomKey, capacity, refillPerSecond, now, cost, ttlMs) =>
      typed.fzLimitAndRead(
        bucketKey,
        roomKey,
        String(capacity),
        String(refillPerSecond),
        String(now),
        String(cost),
        String(ttlMs),
      ),
  }
}
