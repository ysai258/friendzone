import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_ACTIONS } from '@friendzone/shared'
import { startTestServer, type TestServer } from '../helpers/server.ts'
import { closeAll, TestClient } from '../helpers/client.ts'

/**
 * The behaviour that decides whether this is a toy: what happens when the
 * network, the host, or a whole server goes away mid-game.
 */

const servers: TestServer[] = []
const clients: TestClient[] = []

async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const instance = await startTestServer({ schedulerTickMs: 50, ...options })
  servers.push(instance)
  return instance
}

async function room(s: TestServer, hostName = 'Host', gameId = 'blur-battle'): Promise<TestClient> {
  const client = await TestClient.createRoom(s.httpUrl, s.wsUrl, hostName, gameId)
  await client.connect()
  clients.push(client)
  return client
}

async function joiner(s: TestServer, code: string, name: string): Promise<TestClient> {
  const client = await TestClient.join(s.httpUrl, s.wsUrl, code, name)
  await client.connect()
  clients.push(client)
  return client
}

afterEach(async () => {
  await closeAll(...clients.splice(0))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('reconnection', () => {
  it('returns a player to their seat and score after the socket drops', async () => {
    const s = await server()
    const host = await room(s)
    const rahul = await joiner(s, host.roomCode, 'Rahul')

    // Drop the way a lost network does: no close frame, no warning.
    rahul.kill()

    // The seat is held, not removed. The room shows them as away.
    await host.waitForRoom((r) => r.players.some((p) => p.id === rahul.playerId && p.presence === 'DISCONNECTED'))
    expect(host.room!.players).toHaveLength(2)

    // The same browser reconnects with the token it already had.
    const back = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Rahul', rahul.token)
    clients.push(back)
    expect(back.playerId).toBe(rahul.playerId)
    await back.connect()

    await host.waitForRoom((r) => r.players.some((p) => p.id === rahul.playerId && p.presence === 'CONNECTED'))
    expect(host.room!.players).toHaveLength(2)
    // And they are handed the full current state, not a fragment.
    expect(back.room!.players).toHaveLength(2)
    expect(back.room!.code).toBe(host.roomCode)
  })

  it('keeps a score and a locked-in answer across a reconnect mid-round', async () => {
    const s = await server()
    const host = await room(s)
    const rahul = await joiner(s, host.roomCode, 'Rahul')

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 3, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { seconds?: number }).seconds === 45)
    host.send(ROOM_ACTIONS.START_GAME)
    await rahul.waitForPhase('QUESTION', 20_000)

    const stored = await s.services.store.read(host.roomCode)
    const session = stored!.room.session!.state as { questions: { title: string }[]; roundIndex: number }
    const answer = session.questions[session.roundIndex]!.title

    rahul.send('blur/guess', { guess: answer })
    await rahul.waitForRoom((r) => (r.game?.view as Record<string, unknown>)['yourAnswer'] !== undefined, 15_000)
    const scored = rahul.room!.scoreboard.find((x) => x.playerId === rahul.playerId)!.score
    expect(scored).toBeGreaterThan(0)

    rahul.kill()
    const back = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Rahul', rahul.token)
    clients.push(back)
    await back.connect()

    // Everything survived: the seat, the points, and the fact they already answered.
    expect(back.room!.scoreboard.find((x) => x.playerId === rahul.playerId)!.score).toBe(scored)
    expect((back.room!.game!.view)['yourAnswer']).toBeDefined()
  }, 60_000)

  it('replaces an earlier tab rather than seating the player twice', async () => {
    const s = await server()
    const host = await room(s)

    const secondTab = new TestClient('Host tab 2', s.httpUrl, s.wsUrl)
    secondTab.playerId = host.playerId
    secondTab.token = host.token
    secondTab.roomCode = host.roomCode
    clients.push(secondTab)
    await secondTab.connect()

    await host.waitFor((m) => m.t === 'bye', 10_000)
    expect(host.byeReason).toBe('REPLACED')
    expect(secondTab.room!.players).toHaveLength(1)
  })

  it('refuses a session issued for a different room', async () => {
    const s = await server()
    const a = await room(s, 'A')
    const b = await room(s, 'B')

    const impostor = new TestClient('impostor', s.httpUrl, s.wsUrl)
    impostor.playerId = a.playerId
    impostor.token = a.token // valid signature, wrong room
    impostor.roomCode = b.roomCode
    clients.push(impostor)

    await impostor.connect()
    expect(impostor.errors.some((e) => e.code === 'SESSION_INVALID')).toBe(true)
    expect(impostor.room).toBeNull()
  })

  it('refuses a tampered token', async () => {
    const s = await server()
    const host = await room(s)

    const forged = new TestClient('forger', s.httpUrl, s.wsUrl)
    forged.roomCode = host.roomCode
    // Swap the player id but keep the original signature.
    const parts = host.token.split('.')
    parts[1] = '00000000-0000-4000-8000-000000000000'
    forged.token = parts.join('.')
    clients.push(forged)

    await forged.connect()
    expect(forged.errors.some((e) => e.code === 'SESSION_INVALID')).toBe(true)
  })
})

describe('presence and the grace period', () => {
  it('marks a player inactive only once their grace runs out', async () => {
    // Two seconds of grace, so the test does not sit for a minute.
    const s = await server({ graceSeconds: 2 })
    const host = await room(s)
    const rahul = await joiner(s, host.roomCode, 'Rahul')

    rahul.kill()
    await host.waitForRoom((r) => r.players.some((p) => p.id === rahul.playerId && p.presence === 'DISCONNECTED'))

    // Still holding their seat a moment later.
    expect(host.room!.players.find((p) => p.id === rahul.playerId)!.presence).toBe('DISCONNECTED')

    // The scheduler notices the grace deadline without anyone doing anything.
    await host.waitForRoom(
      (r) => r.players.some((p) => p.id === rahul.playerId && p.presence === 'INACTIVE'),
      15_000,
    )
    expect(host.events.some((e) => e.type === 'PLAYER_INACTIVE')).toBe(true)
  }, 30_000)
})

describe('host migration', () => {
  it('hands the room to the longest-present connected player when the host goes', async () => {
    const s = await server({ graceSeconds: 2 })
    const host = await room(s, 'Yashwanth')
    const rahul = await joiner(s, host.roomCode, 'Rahul')
    const sai = await joiner(s, host.roomCode, 'Sai')

    expect(rahul.room!.hostId).toBe(host.playerId)

    host.kill()

    // Deterministic: Rahul joined before Sai, so Rahul takes it. Both clients
    // reach the same conclusion independently, from the same stored state.
    await rahul.waitForRoom((r) => r.hostId === rahul.playerId, 20_000)
    await sai.waitForRoom((r) => r.hostId === rahul.playerId, 20_000)

    expect(rahul.me?.isHost).toBe(true)
    expect(sai.me?.isHost).toBe(false)
    expect(rahul.events.some((e) => e.type === 'HOST_CHANGED')).toBe(true)

    // And the new host can actually do host things.
    rahul.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 4 } })
    await rahul.waitForRoom((r) => (r.config.settings as { questions?: number }).questions === 4)
    sai.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 5 } })
    await sai.waitFor((m) => m.t === 'error' && m.error.code === 'NOT_HOST')
  }, 40_000)

  it('does not hand over the room for a brief blip', async () => {
    const s = await server({ graceSeconds: 30 })
    const host = await room(s, 'Yashwanth')
    const rahul = await joiner(s, host.roomCode, 'Rahul')

    host.kill()
    await rahul.waitForRoom((r) => r.players.some((p) => p.id === host.playerId && p.presence === 'DISCONNECTED'))

    // Host is away but inside their grace: the room is still theirs, because
    // Rahul arrived later and has no better claim to it.
    expect(rahul.room!.hostId).toBe(host.playerId)

    const back = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Yashwanth', host.token)
    clients.push(back)
    await back.connect()
    await rahul.waitForRoom((r) => r.players.some((p) => p.id === host.playerId && p.presence === 'CONNECTED'))
    expect(rahul.room!.hostId).toBe(host.playerId)
  }, 30_000)
})

describe('two server instances', () => {
  it('shows a player on one instance what a player on the other did', async () => {
    // One logical cluster: same Redis prefix, two independent processes.
    const prefix = `fzcluster:${Date.now()}`
    const a = await server({ redisPrefix: prefix })
    const b = await server({ redisPrefix: prefix })

    const host = await room(a, 'OnA')
    const rahul = await joiner(b, host.roomCode, 'OnB')

    // A join that happened on instance B reaches the socket held by instance A.
    await host.waitForRoom((r) => r.players.length === 2, 15_000)
    expect(host.room!.players.map((p) => p.name).sort()).toEqual(['OnA', 'OnB'])

    // And a host action on A reaches the socket held by B.
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 7 } })
    await rahul.waitForRoom((r) => (r.config.settings as { questions?: number }).questions === 7, 15_000)

    // A game started on A runs for the player on B, advanced by whichever
    // scheduler claims the room.
    host.send(ROOM_ACTIONS.START_GAME)
    await rahul.waitForPhase('QUESTION', 25_000)
    expect(rahul.room!.status).toBe('PLAYING')
    expect(rahul.room!.deadlineAt).toBe(host.room!.deadlineAt)
  }, 60_000)

  it('keeps the game running when the instance holding a player goes away', async () => {
    const prefix = `fzcluster:${Date.now()}-2`
    const a = await server({ redisPrefix: prefix })
    const b = await server({ redisPrefix: prefix })

    const host = await room(a, 'OnA')
    const rahul = await joiner(b, host.roomCode, 'OnB')
    await host.waitForRoom((r) => r.players.length === 2, 15_000)

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 3, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { seconds?: number }).seconds === 45)
    host.send(ROOM_ACTIONS.START_GAME)
    await rahul.waitForPhase('QUESTION', 25_000)

    // Instance B shuts down cleanly. Its player is told to come back.
    const index = servers.indexOf(b)
    if (index >= 0) servers.splice(index, 1)
    await b.close()
    await rahul.waitFor((m) => m.t === 'bye', 15_000)
    expect(rahul.byeReason).toBe('SERVER_SHUTDOWN')

    // They reconnect to the surviving instance and the round is exactly where
    // they left it — the state was never in instance B's memory.
    const back = await TestClient.join(a.httpUrl, a.wsUrl, host.roomCode, 'OnB', rahul.token)
    clients.push(back)
    await back.connect()

    expect(back.playerId).toBe(rahul.playerId)
    expect(back.room!.status).toBe('PLAYING')
    expect(back.room!.game?.phase).toBe('QUESTION')
    expect(back.room!.deadlineAt).toBe(host.room!.deadlineAt)
  }, 90_000)
})
