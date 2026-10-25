import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import type { PublicEvent, PublicEventType } from '@friendzone/shared'
import type { RoomChange } from './rooms/service.ts'
import { Stats, dayOf, lastDates, type StatsStore } from './stats.ts'

/** The Redis store's contract, in memory. The Redis one is covered end to end in tests/integration/stats.test.ts. */
class MemoryStore implements StatsStore {
  days = new Map<string, Record<string, number>>()
  peaks = new Map<string, number>()
  online = new Map<string, { n: number; at: number }>()
  reads = 0

  increment(date: string, fields: Record<string, number>): Promise<void> {
    const day = this.days.get(date) ?? {}
    for (const [field, n] of Object.entries(fields)) day[field] = (day[field] ?? 0) + n
    this.days.set(date, day)
    return Promise.resolve()
  }

  reportOnline(instanceId: string, count: number, now: number): Promise<number> {
    this.online.set(instanceId, { n: count, at: now })
    let total = 0
    for (const { n, at } of this.online.values()) if (now - at <= 20_000) total += n
    return Promise.resolve(total)
  }

  forgetInstance(instanceId: string): Promise<void> {
    this.online.delete(instanceId)
    return Promise.resolve()
  }

  recordPeak(date: string, online: number): Promise<void> {
    this.peaks.set(date, Math.max(online, this.peaks.get(date) ?? 0))
    return Promise.resolve()
  }

  read(dates: string[]) {
    this.reads++
    return Promise.resolve(
      dates.map((date) => ({
        date,
        fields: Object.fromEntries(Object.entries(this.days.get(date) ?? {}).map(([k, v]) => [k, String(v)])),
        peak: this.peaks.get(date) ?? 0,
      })),
    )
  }
}

const logger = pino({ level: 'silent' })
// 2026-10-25 12:00 in India.
const NOON_IST = Date.parse('2026-10-25T06:30:00Z')

function change(...events: [PublicEventType, Record<string, unknown>?][]): RoomChange {
  const built: PublicEvent[] = events.map(([type, data], i) => ({ type, data: data ?? {}, at: 0, seq: i + 1 }))
  return { room: {} as RoomChange['room'], version: 1, events: built }
}

function setup(now = NOON_IST) {
  const clock = { now }
  const store = new MemoryStore()
  const stats = new Stats(store, logger, () => clock.now)
  return { store, stats, clock }
}

/** Writes are fire-and-forget; let them land. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('dayOf', () => {
  it('buckets by India time, not UTC', () => {
    // 20:00 UTC on the 24th is 01:30 on the 25th in India.
    expect(dayOf(Date.parse('2026-10-24T20:00:00Z'))).toBe('2026-10-25')
    expect(dayOf(Date.parse('2026-10-24T18:00:00Z'))).toBe('2026-10-24')
  })

  it('lists the last n days newest first', () => {
    expect(lastDates(3, NOON_IST)).toEqual(['2026-10-25', '2026-10-24', '2026-10-23'])
  })
})

describe('Stats', () => {
  it('counts rooms, joins, starts and completions from committed room changes', async () => {
    const { stats } = setup()
    stats.roomCreated()
    stats.observe(change(['PLAYER_JOINED', { playerId: 'p2', name: 'Rahul' }], ['PLAYER_JOINED', { playerId: 'p3', name: 'Sita' }]))
    stats.observe(change(['GAME_STARTED', { gameId: 'blur-battle', sessionId: 's1' }]))
    stats.observe(change(['ROUND_ENDED'], ['GAME_COMPLETED', { rounds: 5 }]))
    stats.observe(change(['GAME_STARTED', { gameId: 'mind-meld', sessionId: 's2' }]))
    await settle()

    const report = await stats.report(1, { localOnline: 3, rooms: 1 })
    expect(report.days).toEqual([
      {
        date: '2026-10-25',
        roomsCreated: 1,
        joins: 2,
        players: 3,
        gamesStarted: 2,
        gamesCompleted: 1,
        peakOnline: 0,
        games: { 'blur-battle': 1, 'mind-meld': 1 },
      },
    ])
    expect(report.totals).toMatchObject({ roomsCreated: 1, players: 3, gamesStarted: 2, gamesCompleted: 1 })
    expect(report.live).toEqual({ online: 3, rooms: 1 })
  })

  it('ignores events that are not play counts', async () => {
    const { stats, store } = setup()
    stats.observe(change(['PLAYER_DISCONNECTED'], ['PLAYER_RECONNECTED'], ['HOST_CHANGED'], ['ROOM_RESET']))
    await settle()
    expect(store.days.size).toBe(0)
  })

  it('never carries names, player ids or room codes', async () => {
    const { stats } = setup()
    stats.roomCreated()
    stats.observe(change(['PLAYER_JOINED', { playerId: 'player-uuid-123', name: 'Rahul' }]))
    await settle()
    const body = JSON.stringify(await stats.report(14, { localOnline: 1, rooms: 1 }))
    expect(body).not.toContain('Rahul')
    expect(body).not.toContain('player-uuid-123')
  })

  it('keeps each day separate and totals across them', async () => {
    const { stats, clock } = setup(NOON_IST - 86_400_000)
    stats.roomCreated()
    clock.now = NOON_IST
    stats.roomCreated()
    stats.roomCreated()
    await settle()

    const report = await stats.report(2, { localOnline: 0, rooms: 0 })
    expect(report.days.map((d) => [d.date, d.roomsCreated])).toEqual([
      ['2026-10-25', 2],
      ['2026-10-24', 1],
    ])
    expect(report.totals.roomsCreated).toBe(3)
  })

  it('keeps the day’s peak of people online, summed across instances', async () => {
    const store = new MemoryStore()
    const a = new Stats(store, logger, () => NOON_IST)
    const b = new Stats(store, logger, () => NOON_IST)
    await a.sample(4)
    await b.sample(3)
    await a.sample(1)

    const report = await a.report(1, { localOnline: 1, rooms: 2 })
    expect(report.days[0]!.peakOnline).toBe(7)
    expect(report.live.online).toBe(4)
  })

  it('stops counting an instance that has shut down', async () => {
    const store = new MemoryStore()
    const a = new Stats(store, logger, () => NOON_IST)
    const b = new Stats(store, logger, () => NOON_IST)
    await a.sample(2)
    await b.sample(5)
    await b.stop()
    expect(await a.sample(2)).toBe(2)
  })

  it('reuses a report briefly so a busy page cannot hammer the store', async () => {
    const { stats, store, clock } = setup()
    await stats.report(14, { localOnline: 0, rooms: 0 })
    await stats.report(14, { localOnline: 0, rooms: 0 })
    expect(store.reads).toBe(1)
    clock.now += stats.cacheMs
    await stats.report(14, { localOnline: 0, rooms: 0 })
    expect(store.reads).toBe(2)
  })

  it('clamps the number of days', async () => {
    const { stats } = setup()
    expect((await stats.report(1000, { localOnline: 0, rooms: 0 })).days).toHaveLength(90)
    expect((await stats.report(Number.NaN, { localOnline: 0, rooms: 0 })).days).toHaveLength(14)
  })

  it('a failing store costs a count, not an error on the game path', async () => {
    const store = new MemoryStore()
    store.increment = () => Promise.reject(new Error('redis down'))
    const stats = new Stats(store, logger, () => NOON_IST)
    expect(() => stats.roomCreated()).not.toThrow()
    await settle()
    expect(stats.lastError).toBe('redis down')
  })
})
