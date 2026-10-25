/**
 * Every Redis key the server uses, in one place. Each is prefixed so several
 * environments can share an instance, and so a stray `KEYS fz:*` in an incident
 * finds exactly this application's data.
 */
export class RedisKeys {
  constructor(private readonly prefix: string) {}

  /** HASH { version, state } — the authoritative live room. */
  room(code: string): string {
    return `${this.prefix}:room:${code}`
  }

  /** ZSET code -> epoch ms. The single scheduling index for the whole cluster. */
  get deadlines(): string {
    return `${this.prefix}:deadlines`
  }

  /** SET of live room codes, for metrics and the admin view. */
  get activeRooms(): string {
    return `${this.prefix}:rooms:active`
  }

  /** Pub/sub channel per room. Subscribed to only by instances actually holding
   *  a socket for that room, so a state payload never fans out to servers with
   *  no one listening. */
  roomChannel(code: string): string {
    return `${this.prefix}:chan:room:${code}`
  }

  /** HASH { tokens, at } for one token bucket. */
  rateLimit(bucket: string, subject: string): string {
    return `${this.prefix}:rl:${bucket}:${subject}`
  }

  /** HASH counter -> n: one India-time day of play statistics. Counts only. */
  statsDay(date: string): string {
    return `${this.prefix}:stats:day:${date}`
  }

  /** ZSET { online: peak }: the day's busiest moment. A ZSET for ZADD GT. */
  statsPeak(date: string): string {
    return `${this.prefix}:stats:peak:${date}`
  }

  /** HASH instanceId -> "count:reportedAt": who is connected right now, per instance. */
  get statsOnline(): string {
    return `${this.prefix}:stats:online`
  }

  /** STRING counter, for "rooms created today"-style metrics. */
  counter(name: string): string {
    return `${this.prefix}:count:${name}`
  }
}
