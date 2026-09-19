import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ROOM_ACTIONS } from '@friendzone/shared'
import { startTestServer, type TestServer } from '../helpers/server.ts'
import { closeAll, TestClient } from '../helpers/client.ts'

/**
 * The questions a reviewer asks about a system where several servers mutate the
 * same room: can it start twice, can it have two hosts, can a retry score
 * twice, can a stale action land. Each one is answered by racing it rather than
 * by reasoning about it.
 */

const servers: TestServer[] = []
const clients: TestClient[] = []

async function cluster(size: number, graceSeconds = 45): Promise<TestServer[]> {
  const prefix = `fzrace:${randomUUID().slice(0, 8)}`
  const instances: TestServer[] = []
  for (let i = 0; i < size; i++) {
    const instance = await startTestServer({ redisPrefix: prefix, schedulerTickMs: 50, graceSeconds })
    servers.push(instance)
    instances.push(instance)
  }
  return instances
}

afterEach(async () => {
  await closeAll(...clients.splice(0))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('racing the same room', () => {
  it('starts the game exactly once when the host fires start twice', async () => {
    const [a] = await cluster(1)
    const host = await TestClient.createRoom(a!.httpUrl, a!.wsUrl, 'Host')
    await host.connect()
    clients.push(host)

    // Two start actions with different ids, sent back to back. Idempotency
    // cannot help here — these are genuinely two different requests.
    host.send(ROOM_ACTIONS.START_GAME)
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)
    await new Promise((resolve) => setTimeout(resolve, 800))

    const stored = await a!.services.store.read(host.roomCode)
    expect(stored!.room.sessionCount).toBe(1)
    expect(host.errors.filter((e) => e.code === 'GAME_ALREADY_STARTED')).toHaveLength(1)

    // And exactly one session was recorded.
    const { rows } = await a!.services.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM game_sessions WHERE room_code = $1',
      [host.roomCode],
    )
    expect(Number(rows[0]!.count)).toBe(1)
  }, 40_000)

  it('starts the game exactly once when two instances are asked at the same moment', async () => {
    const [a, b] = await cluster(2)

    const host = await TestClient.createRoom(a!.httpUrl, a!.wsUrl, 'Host')
    await host.connect()
    clients.push(host)

    // The same player, connected through the other instance. Both sockets
    // belong to one seat, so the second replaces the first — but the room
    // service on each instance is still asked to start, concurrently.
    await Promise.allSettled([
      a!.services.service.startGame({ code: host.roomCode, playerId: host.playerId, actionId: randomUUID() }),
      b!.services.service.startGame({ code: host.roomCode, playerId: host.playerId, actionId: randomUUID() }),
    ])

    const stored = await a!.services.store.read(host.roomCode)
    expect(stored!.room.sessionCount).toBe(1)
    expect(stored!.room.session).not.toBeNull()
  }, 40_000)

  it('seats five simultaneous joiners exactly once each, with unique join sequences', async () => {
    const [a, b] = await cluster(2)

    const host = await TestClient.createRoom(a!.httpUrl, a!.wsUrl, 'Host')
    await host.connect()
    clients.push(host)

    // Five people opening the shared link at the same instant, spread across
    // two instances. This is the case that actually produces CAS conflicts.
    const joins = await Promise.all(
      ['P1', 'P2', 'P3', 'P4', 'P5'].map((name, i) =>
        TestClient.join((i % 2 === 0 ? a! : b!).httpUrl, (i % 2 === 0 ? a! : b!).wsUrl, host.roomCode, name),
      ),
    )
    clients.push(...joins)

    const stored = await a!.services.store.read(host.roomCode)
    const players = Object.values(stored!.room.players)
    expect(players).toHaveLength(6)

    // Nobody lost their seat to somebody else's write.
    expect(new Set(players.map((p) => p.id)).size).toBe(6)
    expect(new Set(players.map((p) => p.name)).size).toBe(6)

    // Join sequences are unique and contiguous, which host succession depends on.
    const seqs = players.map((p) => p.joinSeq).sort((x, y) => x - y)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
  }, 40_000)

  it('never produces two hosts, whichever instance is asked', async () => {
    // A short grace, because a host who merely dropped keeps the room for the
    // whole of theirs — that is the "brief blip" rule, tested separately.
    const [a, b] = await cluster(2, 2)

    const host = await TestClient.createRoom(a!.httpUrl, a!.wsUrl, 'First')
    await host.connect()
    clients.push(host)

    const second = await TestClient.join(b!.httpUrl, b!.wsUrl, host.roomCode, 'Second')
    await second.connect()
    clients.push(second)
    const third = await TestClient.join(a!.httpUrl, a!.wsUrl, host.roomCode, 'Third')
    await third.connect()
    clients.push(third)

    await host.waitForRoom((r) => r.players.length === 3, 15_000)
    await second.waitForRoom((r) => r.players.length === 3, 15_000)

    // The host drops. Both instances independently recompute succession from
    // the same stored state; they must agree without talking to each other.
    host.kill()

    await second.waitForRoom((r) => r.hostId === second.playerId, 25_000)
    await third.waitForRoom((r) => r.hostId === second.playerId, 25_000)

    // Exactly one player is host in every client's view of the room.
    for (const client of [second, third]) {
      expect(client.room!.players.filter((p) => p.isHost)).toHaveLength(1)
      expect(client.room!.hostId).toBe(second.playerId)
    }

    const stored = await a!.services.store.read(host.roomCode)
    expect(stored!.room.hostId).toBe(second.playerId)
  }, 60_000)

  it('applies a burst of concurrent actions without losing any of them', async () => {
    const [a, b] = await cluster(2)

    const host = await TestClient.createRoom(a!.httpUrl, a!.wsUrl, 'Host', 'mind-meld')
    await host.connect()
    clients.push(host)

    const others = await Promise.all(
      ['P1', 'P2', 'P3'].map(async (name, i) => {
        const target = i % 2 === 0 ? b! : a!
        const client = await TestClient.join(target.httpUrl, target.wsUrl, host.roomCode, name)
        await client.connect()
        clients.push(client)
        return client
      }),
    )

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { rounds: 3, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { seconds?: number }).seconds === 45)
    host.send(ROOM_ACTIONS.START_GAME)

    const everyone = [host, ...others]
    await Promise.all(everyone.map((c) => c.waitForPhase('PROMPT', 25_000)))

    // Four players answering in the same instant, across two instances. Every
    // one of these is a read-modify-write of the same room.
    for (const client of everyone) client.send('meld/submit', { answer: `answer-${client.name}` })

    // All four answers must be present — a lost update would drop one.
    await host.waitForRoom(
      (r) => ((r.game?.view as { answeredPlayerIds?: string[] }).answeredPlayerIds ?? []).length === 4,
      25_000,
    )

    const stored = await a!.services.store.read(host.roomCode)
    const answers = (stored!.room.session!.state as { answers: Record<string, unknown> }).answers
    expect(Object.keys(answers)).toHaveLength(4)
    for (const client of everyone) expect(answers[client.playerId]).toBeDefined()
  }, 60_000)
})
