import { afterEach, describe, expect, it } from 'vitest'
import { MAX_WS_MESSAGE_BYTES, ROOM_ACTIONS } from '@friendzone/shared'
import { startTestServer, type TestServer } from '../helpers/server.ts'
import { closeAll, TestClient } from '../helpers/client.ts'

/**
 * What a modified client can and cannot do.
 *
 * Each case is written from the attacker's side: send the frame a patched
 * client would send, and assert the server refused it. Asserting that the
 * official UI does not offer the button would prove nothing.
 */

const servers: TestServer[] = []
const clients: TestClient[] = []

async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const instance = await startTestServer({ schedulerTickMs: 50, ...options })
  servers.push(instance)
  return instance
}

afterEach(async () => {
  await closeAll(...clients.splice(0))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function lobby(gameId = 'blur-battle', names = ['Host', 'Guest']) {
  const s = await server()
  const host = await TestClient.createRoom(s.httpUrl, s.wsUrl, names[0]!, gameId)
  await host.connect()
  clients.push(host)

  const others: TestClient[] = []
  for (const name of names.slice(1)) {
    const client = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, name)
    await client.connect()
    clients.push(client)
    others.push(client)
  }
  return { s, host, others }
}

describe('clients cannot decide anything that matters', () => {
  it('ignores a score the client made up', async () => {
    const { host, others } = await lobby()
    const before = host.room!.scoreboard.find((x) => x.playerId === host.playerId)!.score

    // Every shape a hopeful attacker might try.
    host.send('blur/guess', { guess: 'x', score: 999_999, points: 999_999 })
    host.sendRaw({ t: 'action', actionId: crypto.randomUUID(), type: 'room/set-score', payload: { score: 5000 } })
    host.sendRaw({ t: 'state', room: { scoreboard: [{ playerId: host.playerId, score: 99999 }] } })
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(host.room!.scoreboard.find((x) => x.playerId === host.playerId)!.score).toBe(before)
    expect(others[0]!.room!.scoreboard.find((x) => x.playerId === host.playerId)!.score).toBe(before)
  })

  it('attributes an action to the socket, not to a playerId in the payload', async () => {
    const { host, others } = await lobby()
    const guest = others[0]!

    // Guest claims to be the host in the payload.
    guest.send(ROOM_ACTIONS.UPDATE_CONFIG, { playerId: host.playerId, settings: { questions: 9 } })
    await guest.waitFor((m) => m.t === 'error' && m.error.code === 'NOT_HOST', 10_000)
    expect((host.room!.config.settings as { questions?: number }).questions).not.toBe(9)
  })

  it('refuses to let a non-host start, kick, or reset', async () => {
    const { host, others } = await lobby()
    const guest = others[0]!

    for (const action of [ROOM_ACTIONS.START_GAME, ROOM_ACTIONS.PLAY_AGAIN]) {
      guest.send(action)
      await guest.waitFor((m) => m.t === 'error', 10_000)
      expect(['NOT_HOST', 'INVALID_ACTION']).toContain(guest.lastError?.code)
    }

    guest.send(ROOM_ACTIONS.KICK_PLAYER, { playerId: host.playerId })
    await guest.waitFor((m) => m.t === 'error' && m.error.code === 'NOT_HOST', 10_000)
    expect(host.room!.players).toHaveLength(2)
  })

  it('rejects an action for a game that is not running', async () => {
    const { host } = await lobby()
    host.send('blur/guess', { guess: 'anything' })
    await host.waitFor((m) => m.t === 'error' && m.error.code === 'GAME_NOT_STARTED', 10_000)
  })

  it('rejects another game\'s action while this one is running', async () => {
    const { host } = await lobby()
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 3, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { seconds?: number }).seconds === 45)
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForPhase('QUESTION', 25_000)

    host.send('mafia/vote', { targetId: host.playerId })
    await host.waitFor((m) => m.t === 'error' && m.error.code === 'INVALID_ACTION', 10_000)
  }, 60_000)
})

describe('input handling', () => {
  it('survives malformed frames without dropping the player', async () => {
    const { host } = await lobby()

    host.sendRaw('not json at all')
    host.sendRaw({ t: 'action' })
    host.sendRaw({ t: 'action', actionId: 'not-a-uuid', type: 'blur/guess', payload: {} })
    host.sendRaw({ t: 'action', actionId: crypto.randomUUID(), type: '../../etc/passwd', payload: {} })
    host.sendRaw({ t: 'nonsense' })
    host.sendRaw([])
    host.sendRaw(null)
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(host.errors.length).toBeGreaterThan(0)
    expect(host.errors.every((e) => e.code === 'VALIDATION_FAILED' || e.code === 'INVALID_ACTION')).toBe(true)
    // Still connected, still playing.
    expect(host.closed).toBe(false)
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 4 } })
    await host.waitForRoom((r) => (r.config.settings as { questions?: number }).questions === 4)
  })

  it('refuses an oversized frame', async () => {
    const { host } = await lobby()
    host.sendRaw({
      t: 'action',
      actionId: crypto.randomUUID(),
      type: 'blur/guess',
      payload: { guess: 'A'.repeat(MAX_WS_MESSAGE_BYTES) },
    })
    await host.waitFor((m) => m.t === 'error', 10_000)
    expect(['PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED']).toContain(host.lastError?.code)
    expect(host.closed).toBe(false)
  })

  it('refuses a payload carrying __proto__', async () => {
    const { host } = await lobby()
    host.sendRaw({
      t: 'action',
      actionId: crypto.randomUUID(),
      type: ROOM_ACTIONS.UPDATE_CONFIG,
      payload: JSON.parse('{"__proto__":{"polluted":true},"settings":{"questions":5}}') as Record<string, unknown>,
    })
    await host.waitFor((m) => m.t === 'error' && m.error.code === 'VALIDATION_FAILED', 10_000)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('refuses an HTTP body carrying __proto__', async () => {
    const s = await server()
    const response = await fetch(`${s.httpUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"__proto__":{"polluted":true},"name":"Attacker"}',
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('strips invisible characters from a name instead of seating a twin', async () => {
    const { s, host } = await lobby('blur-battle', ['Yashwanth'])
    // A zero-width space between the letters would otherwise read as a new name.
    const response = await fetch(`${s.httpUrl}/api/rooms/${host.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Yash​wanth' }),
    })
    const body = (await response.json()) as { error?: { code: string }; playerId?: string }
    expect(response.status).toBe(409)
    expect(body.error?.code).toBe('NAME_TAKEN')
  })

  it('never returns a stack trace or internal detail', async () => {
    const s = await server()
    const responses = await Promise.all([
      fetch(`${s.httpUrl}/api/rooms/@@@@@`),
      fetch(`${s.httpUrl}/api/rooms/ZZZZZ/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      }),
      fetch(`${s.httpUrl}/nope`),
    ])
    for (const response of responses) {
      const text = await response.text()
      expect(text).not.toMatch(/at \w+ \(/)
      expect(text.toLowerCase()).not.toContain('postgres')
      expect(text.toLowerCase()).not.toContain('redis')
      expect(text).not.toContain('node_modules')
      expect(JSON.parse(text)).toHaveProperty('error.code')
    }
  })
})

describe('rate limiting', () => {
  it('throttles room creation from one address', async () => {
    const s = await server({ env: { RL_ROOM_CREATE: '3:0' } })

    const codes: number[] = []
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${s.httpUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `Player ${i}` }),
      })
      codes.push(response.status)
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toBeTruthy()
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
      } else {
        await response.json()
      }
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(3)
    expect(codes.filter((c) => c === 429)).toHaveLength(3)
  })

  it('throttles a player spraying actions down the socket', async () => {
    const s = await server({ env: { RL_WS_ACTION: '5:0' } })
    const host = await TestClient.createRoom(s.httpUrl, s.wsUrl, 'Spammer')
    await host.connect()
    clients.push(host)

    for (let i = 0; i < 25; i++) host.send('blur/guess', { guess: `attempt ${i}` })
    await host.waitFor((m) => m.t === 'error' && m.error.code === 'RATE_LIMITED', 10_000)

    expect(host.errors.some((e) => e.code === 'RATE_LIMITED')).toBe(true)
    expect(host.errors.find((e) => e.code === 'RATE_LIMITED')?.retryAfter).toBeGreaterThanOrEqual(0)
    // Throttled, not disconnected.
    expect(host.closed).toBe(false)
  })
})

describe('room access', () => {
  it('will not seat a player once the game is under way', async () => {
    const { s, host } = await lobby('blur-battle', ['Host', 'Second'])
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const response = await fetch(`${s.httpUrl}/api/rooms/${host.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Latecomer' }),
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('GAME_ALREADY_STARTED')
  }, 40_000)

  it('enforces the room capacity', async () => {
    const { s, host } = await lobby('blur-battle', ['Host'])
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { maxPlayers: 2 })
    await host.waitForRoom((r) => r.config.maxPlayers === 2)

    const ok = await fetch(`${s.httpUrl}/api/rooms/${host.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second' }),
    })
    expect(ok.status).toBe(201)
    await ok.json()

    const full = await fetch(`${s.httpUrl}/api/rooms/${host.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Third' }),
    })
    expect(full.status).toBe(409)
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('ROOM_FULL')
  })

  it('tells a peek nothing about who is in the room', async () => {
    const { s, host } = await lobby('blur-battle', ['Yashwanth', 'Rahul'])
    const response = await fetch(`${s.httpUrl}/api/rooms/${host.roomCode}`)
    const text = await response.text()
    expect(text).not.toContain('Yashwanth')
    expect(text).not.toContain('Rahul')
    expect(JSON.parse(text)).toMatchObject({ playerCount: 2, joinable: true })
  })

  it('does not enable admin routes without a token', async () => {
    const s = await server()
    const response = await fetch(`${s.httpUrl}/admin/overview`)
    expect(response.status).toBe(404)
  })

  it('requires the bearer token when admin is enabled', async () => {
    const s = await server({ env: { ADMIN_TOKEN: 'super-secret-token' } })

    expect((await fetch(`${s.httpUrl}/admin/overview`)).status).toBe(403)
    expect((await fetch(`${s.httpUrl}/admin/overview`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(403)

    const ok = await fetch(`${s.httpUrl}/admin/overview`, { headers: { authorization: 'Bearer super-secret-token' } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toHaveProperty('rooms.active')
  })
})
