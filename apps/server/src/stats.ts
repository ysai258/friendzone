import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Logger } from './logger.ts'
import type { RedisKeys } from './redis/keys.ts'
import type { RoomChange } from './rooms/service.ts'

/**
 * Public play statistics: how much FriendZone gets played, per day in India
 * time. Served at /stats.
 *
 * Counts only. No names, no IPs, no room codes, no player ids — nothing here
 * says who played, only how much. The one label kept is the game id, which is
 * the name of a game, not of a person.
 *
 * The counters live in the same Redis as the rooms, incremented as each event
 * happens, so several instances add into one total without coordinating. On
 * Render's free Key Value that store is in-memory and can restart, which
 * resets the history; the live numbers recover within seconds.
 *
 * /metrics already exists, but it is per process and resets on every restart
 * or free-tier sleep, which makes it no use for "how many games were played
 * this week".
 */

export const COUNTERS = ['roomsCreated', 'joins', 'gamesStarted', 'gamesCompleted'] as const
export type Counter = (typeof COUNTERS)[number]

export interface DayStats extends Record<Counter, number> {
  date: string
  /** Seats taken: each room's host plus everyone who joined it. */
  players: number
  /** Most sockets connected at once, sampled every few seconds. */
  peakOnline: number
  /** Games started, by game id. */
  games: Record<string, number>
}

export interface StatsReport {
  live: { online: number; rooms: number }
  days: DayStats[]
  totals: Record<Counter, number> & { players: number; games: Record<string, number> }
  timeZone: 'Asia/Kolkata'
}

/** What the counters need from storage. The real one is Redis; tests use memory. */
export interface StatsStore {
  increment(date: string, fields: Record<string, number>): Promise<void>
  /** Record this instance's live count; returns the total across live instances. */
  reportOnline(instanceId: string, count: number, now: number): Promise<number>
  forgetInstance(instanceId: string): Promise<void>
  recordPeak(date: string, online: number): Promise<void>
  read(dates: string[]): Promise<{ date: string; fields: Record<string, string>; peak: number }[]>
}

const KEEP_DAYS = 400
/** An instance that has not reported for this long is gone; its count no longer counts. */
const ONLINE_STALE_MS = 20_000
const GAME_FIELD = 'game:'

/** YYYY-MM-DD in India time. */
export function dayOf(ms: number): string {
  return new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10)
}

/** The last `n` India-time dates, newest first. */
export function lastDates(n: number, now: number): string[] {
  return Array.from({ length: n }, (_, i) => dayOf(now - i * 86_400_000))
}

export class RedisStatsStore implements StatsStore {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
  ) {}

  async increment(date: string, fields: Record<string, number>): Promise<void> {
    const key = this.keys.statsDay(date)
    const pipeline = this.redis.multi()
    for (const [field, n] of Object.entries(fields)) pipeline.hincrby(key, field, n)
    pipeline.expire(key, KEEP_DAYS * 86_400)
    await pipeline.exec()
  }

  async reportOnline(instanceId: string, count: number, now: number): Promise<number> {
    const key = this.keys.statsOnline
    const [, all] = await Promise.all([this.redis.hset(key, instanceId, `${count}:${now}`), this.redis.hgetall(key)])
    let total = 0
    const stale: string[] = []
    for (const [id, value] of Object.entries(all)) {
      const [n, at] = value.split(':').map(Number)
      if (n === undefined || at === undefined || Number.isNaN(n) || now - at > ONLINE_STALE_MS) stale.push(id)
      else total += n
    }
    if (stale.length > 0) await this.redis.hdel(key, ...stale)
    return total
  }

  async forgetInstance(instanceId: string): Promise<void> {
    await this.redis.hdel(this.keys.statsOnline, instanceId)
  }

  async recordPeak(date: string, online: number): Promise<void> {
    const key = this.keys.statsPeak(date)
    // GT: only ever raises the day's peak, whichever instance writes first.
    await this.redis.multi().zadd(key, 'GT', online, 'online').expire(key, KEEP_DAYS * 86_400).exec()
  }

  async read(dates: string[]): Promise<{ date: string; fields: Record<string, string>; peak: number }[]> {
    const pipeline = this.redis.pipeline()
    for (const date of dates) pipeline.hgetall(this.keys.statsDay(date)).zscore(this.keys.statsPeak(date), 'online')
    const results = (await pipeline.exec()) ?? []
    return dates.map((date, i) => {
      const [hashError, hash] = results[i * 2] ?? [null, null]
      const [peakError, peak] = results[i * 2 + 1] ?? [null, null]
      if (hashError !== null) throw hashError
      if (peakError !== null) throw peakError
      return { date, fields: (hash ?? {}) as Record<string, string>, peak: Number(peak) || 0 }
    })
  }
}

export class Stats {
  private readonly instanceId = randomUUID()
  private sampler: NodeJS.Timeout | null = null
  private cache: { at: number; days: number; value: Omit<StatsReport, 'live'> } | null = null
  lastError = ''
  /** How long a report is reused, so a busy public page cannot hammer Redis. */
  cacheMs = 20_000

  constructor(
    private readonly store: StatsStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** A room was created. Its host takes the first seat. */
  roomCreated(): void {
    this.add({ roomsCreated: 1 })
  }

  /**
   * Every committed room change passes through here. Each change is published
   * exactly once, by the instance that won the write, so counting its events
   * never double-counts across retries or instances.
   */
  observe(change: RoomChange): void {
    const fields: Record<string, number> = {}
    const bump = (field: string): void => {
      fields[field] = (fields[field] ?? 0) + 1
    }
    // Every other event (presence, rounds, host changes) is not a play count.
    for (const event of change.events) {
      if (event.type === 'PLAYER_JOINED') bump('joins')
      else if (event.type === 'GAME_COMPLETED') bump('gamesCompleted')
      else if (event.type === 'GAME_STARTED') {
        bump('gamesStarted')
        const gameId = event.data['gameId']
        if (typeof gameId === 'string') bump(`${GAME_FIELD}${gameId}`)
      }
    }
    this.add(fields)
  }

  /** Sample how many people are connected right now, and keep the day's peak. */
  async sample(localOnline: number): Promise<number> {
    const now = this.now()
    const online = await this.store.reportOnline(this.instanceId, localOnline, now)
    if (online > 0) await this.store.recordPeak(dayOf(now), online)
    return online
  }

  start(localOnline: () => number, everyMs = 5_000): void {
    if (this.sampler !== null) return
    this.sampler = setInterval(() => {
      this.sample(localOnline()).catch((error: unknown) => this.failed(error))
    }, everyMs)
    this.sampler.unref()
  }

  async stop(): Promise<void> {
    if (this.sampler !== null) clearInterval(this.sampler)
    this.sampler = null
    await this.store.forgetInstance(this.instanceId).catch(() => undefined)
  }

  /** Daily numbers for the last `days` days, newest first, plus who is on right now. */
  async report(days: number, live: { localOnline: number; rooms: number }): Promise<StatsReport> {
    const n = Math.max(1, Math.min(90, Math.floor(days) || 14))
    const now = this.now()
    const online = await this.store.reportOnline(this.instanceId, live.localOnline, now)

    if (this.cache === null || this.cache.days !== n || now - this.cache.at >= this.cacheMs) {
      const rows = await this.store.read(lastDates(n, now))
      const list = rows.map((row) => toDay(row.date, row.fields, row.peak))
      const totals = {
        ...(Object.fromEntries(COUNTERS.map((c) => [c, list.reduce((sum, d) => sum + d[c], 0)])) as Record<Counter, number>),
        players: list.reduce((sum, d) => sum + d.players, 0),
        games: sumGames(list),
      }
      this.cache = { at: now, days: n, value: { days: list, totals, timeZone: 'Asia/Kolkata' } }
    }
    return { live: { online, rooms: live.rooms }, ...this.cache.value }
  }

  private add(fields: Record<string, number>): void {
    if (Object.keys(fields).length === 0) return
    // Never on the game's path: a stats write that fails costs a count, not a round.
    this.store.increment(dayOf(this.now()), fields).catch((error: unknown) => this.failed(error))
  }

  private failed(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : 'unknown'
    this.logger.warn({ err: error }, 'stats write failed')
  }
}

function toDay(date: string, fields: Record<string, string>, peak: number): DayStats {
  const read = (field: string): number => Number(fields[field]) || 0
  const games: Record<string, number> = {}
  for (const [field, value] of Object.entries(fields)) {
    if (field.startsWith(GAME_FIELD)) games[field.slice(GAME_FIELD.length)] = Number(value) || 0
  }
  const counts = Object.fromEntries(COUNTERS.map((c) => [c, read(c)])) as Record<Counter, number>
  return { date, ...counts, players: counts.roomsCreated + counts.joins, peakOnline: peak, games }
}

function sumGames(days: DayStats[]): Record<string, number> {
  const total: Record<string, number> = {}
  for (const day of days) for (const [game, n] of Object.entries(day.games)) total[game] = (total[game] ?? 0) + n
  return total
}
