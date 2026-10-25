import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_ACTIONS } from '@friendzone/shared'
import type { StatsReport } from '@friendzone/server/stats.ts'
import { startTestServer, type TestServer } from '../helpers/server.ts'
import { closeAll, TestClient } from '../helpers/client.ts'

/**
 * /stats against a real server and real Redis: the counters are driven by the
 * same room lifecycle players go through, not called directly.
 */

const servers: TestServer[] = []
const clients: TestClient[] = []

afterEach(async () => {
  await closeAll(...clients.splice(0))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function fetchStats(s: TestServer): Promise<StatsReport> {
  const response = await fetch(`${s.httpUrl}/stats?days=2`)
  expect(response.status).toBe(200)
  return (await response.json()) as StatsReport
}

/** Counter writes are fire-and-forget, so give them a moment to land. */
async function statsUntil(s: TestServer, predicate: (r: StatsReport) => boolean): Promise<StatsReport> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const report = await fetchStats(s)
    if (predicate(report) || Date.now() > deadline) return report
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('/stats', () => {
  it('counts a room, its players and its game, with nothing that identifies anyone', async () => {
    const s = await startTestServer({ schedulerTickMs: 50 })
    servers.push(s)
    s.services.stats.cacheMs = 0

    const before = await fetchStats(s)
    expect(before.days).toHaveLength(2)
    expect(before.totals).toMatchObject({ roomsCreated: 0, joins: 0, gamesStarted: 0 })

    const host = await TestClient.createRoom(s.httpUrl, s.wsUrl, 'Hostname', 'blur-battle')
    clients.push(host)
    await host.connect()
    const guest = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Guestname')
    clients.push(guest)
    await guest.connect()

    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY')
    await s.services.stats.sample(s.services.gateway().connectionCount)

    const report = await statsUntil(s, (r) => r.totals.gamesStarted === 1)
    expect(report.totals).toMatchObject({ roomsCreated: 1, joins: 1, players: 2, gamesStarted: 1, games: { 'blur-battle': 1 } })
    expect(report.days[0]!.peakOnline).toBe(2)
    expect(report.live).toEqual({ online: 2, rooms: 1 })

    const body = JSON.stringify(report)
    for (const secret of ['Hostname', 'Guestname', host.roomCode, host.playerId, guest.playerId]) {
      expect(body).not.toContain(secret)
    }
  })

  it('does not count a reconnect as a new player', async () => {
    const s = await startTestServer({ schedulerTickMs: 50 })
    servers.push(s)
    s.services.stats.cacheMs = 0

    const host = await TestClient.createRoom(s.httpUrl, s.wsUrl, 'Host')
    clients.push(host)
    await host.connect()
    const guest = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Rahul')
    clients.push(guest)
    await guest.connect()
    guest.kill()
    const back = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Rahul', guest.token)
    clients.push(back)
    await back.connect()

    const report = await statsUntil(s, (r) => r.totals.joins >= 1)
    // Give any stray second count time to arrive before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await fetchStats(s)).totals).toMatchObject({ roomsCreated: 1, joins: 1, players: 2 })
    expect(report.totals.joins).toBe(1)
  })
})
