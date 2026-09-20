import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_ACTIONS } from '@friendzone/shared'
import { startTestServer, type TestServer } from '../helpers/server.ts'
import { closeAll, TestClient } from '../helpers/client.ts'

/**
 * Language selection, category coherence and anti-repetition, end to end
 * against real Redis and Postgres.
 *
 * The engine tests prove the reducers pick correctly; these prove the room
 * actually asks for what the host chose, remembers what it dealt, and carries
 * that memory across games and reconnects.
 */

const servers: TestServer[] = []
const clients: TestClient[] = []

async function server(): Promise<TestServer> {
  const instance = await startTestServer({ schedulerTickMs: 50 })
  servers.push(instance)
  return instance
}

async function room(s: TestServer, gameId: string, names: string[]) {
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
  await host.waitForRoom((r) => r.players.length === names.length, 15_000)
  return { host, others }
}

/** Read the server's own state; a client cannot see unplayed content. */
async function session(s: TestServer, code: string): Promise<Record<string, unknown>> {
  const stored = await s.services.store.read(code)
  return (stored?.room.session?.state ?? {}) as Record<string, unknown>
}

/** Force the room to the end of its game so Play Again is legal. */
async function endGame(s: TestServer, code: string): Promise<void> {
  await s.services.store.update(
    code,
    (room) => ({ room: { ...room, status: 'GAME_OVER' as const }, value: undefined }),
    () => null,
  )
}

afterEach(async () => {
  await closeAll(...clients.splice(0))
  await Promise.all(servers.splice(0).map((instance) => instance.close()))
})

describe('emoji movie / language selection', () => {
  it('plays only Telugu films when only Telugu is selected', async () => {
    const s = await server()
    const { host } = await room(s, 'emoji-movie', ['Host', 'Guest'])

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { languages: ['telugu'], questions: 6, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { languages?: string[] }).languages?.length === 1)
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const state = await session(s, host.roomCode)
    const questions = state['questions'] as { id: string; language: string }[]
    expect(questions.length).toBe(6)
    expect(questions.every((q) => q.language === 'telugu')).toBe(true)
    expect(questions.every((q) => q.id.startsWith('te-'))).toBe(true)
  }, 45_000)

  it('mixes exactly the languages that were selected', async () => {
    const s = await server()
    const { host } = await room(s, 'emoji-movie', ['Host', 'Guest'])

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { languages: ['tamil', 'malayalam'], questions: 8, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { languages?: string[] }).languages?.length === 2)
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const questions = (await session(s, host.roomCode))['questions'] as { language: string }[]
    expect(questions.every((q) => q.language === 'tamil' || q.language === 'malayalam')).toBe(true)
  }, 45_000)

  it('defaults a fresh room to Telugu and Hindi', async () => {
    const s = await server()
    const { host } = await room(s, 'emoji-movie', ['Host', 'Guest'])
    expect((host.room?.config.settings as { languages: string[] }).languages).toEqual(['telugu', 'hindi'])
  }, 30_000)

  it('does not repeat films across consecutive games in the same room', async () => {
    const s = await server()
    const { host } = await room(s, 'emoji-movie', ['Host', 'Guest'])
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 6, seconds: 45 } })
    await host.waitForRoom((r) => (r.config.settings as { seconds?: number }).seconds === 45)

    const played: string[][] = []
    for (let game = 0; game < 3; game++) {
      host.send(ROOM_ACTIONS.START_GAME)
      await host.waitForRoom((r) => r.status !== 'LOBBY' && r.status !== 'GAME_OVER', 20_000)
      const questions = (await session(s, host.roomCode))['questions'] as { id: string }[]
      played.push(questions.map((q) => q.id))

      // Straight back to the lobby for the next game, without sitting through
      // six rounds of timers three times over.
      await endGame(s, host.roomCode)
      host.send(ROOM_ACTIONS.PLAY_AGAIN)
      await host.waitForRoom((r) => r.status === 'LOBBY', 15_000)
    }

    // No film appears in two different games.
    const all = played.flat()
    expect(new Set(all).size).toBe(all.length)
  }, 90_000)

  it('starts a game in a room written by the previous release', async () => {
    const s = await server()
    const { host } = await room(s, 'emoji-movie', ['Host', 'Guest'])

    // What the room looked like before this release added recentContent. Rooms
    // outlive a deploy, so this is the state a rollout actually meets.
    await s.services.store.update(
      host.roomCode,
      (current) => {
        const legacy = { ...current } as Partial<typeof current>
        delete legacy.recentContent
        return { room: legacy as typeof current, value: undefined }
      },
      () => null,
    )

    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)
    expect(host.errors).toHaveLength(0)

    const stored = await s.services.store.read(host.roomCode)
    expect(stored?.room.recentContent['emoji']?.length).toBeGreaterThan(0)
  }, 45_000)

  it('remembers what it dealt in the room state, so a reconnect cannot reset it', async () => {
    const s = await server()
    const { host } = await room(s, 'emoji-movie', ['Host', 'Guest'])
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const stored = await s.services.store.read(host.roomCode)
    const remembered = stored?.room.recentContent['emoji'] ?? []
    expect(remembered.length).toBeGreaterThan(0)

    // Drop and rejoin: the history belongs to the room, not the connection.
    host.kill()
    const back = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Host', host.token)
    clients.push(back)
    await back.connect()

    const after = await s.services.store.read(host.roomCode)
    expect(after?.room.recentContent['emoji']).toEqual(remembered)
  }, 45_000)
})

describe('movie mafia / language selection', () => {
  it('draws its secret film from the selected language only', async () => {
    const s = await server()
    const { host } = await room(s, 'movie-mafia', ['Host', 'B', 'C', 'D'])

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { languages: ['telugu'] } })
    await host.waitForRoom((r) => (r.config.settings as { languages?: string[] }).languages?.length === 1)
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const subject = (await session(s, host.roomCode))['subject'] as { id: string; language: string }
    expect(subject.language).toBe('telugu')
  }, 45_000)
})

describe('who am i / one category per game', () => {
  it('gives every player someone from the chosen category, with no repeats', async () => {
    const s = await server()
    const { host } = await room(s, 'who-am-i', ['Host', 'B', 'C', 'D', 'E'])

    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { category: 'indian-cricketers' } })
    await host.waitForRoom((r) => (r.config.settings as { category?: string }).category === 'indian-cricketers')
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const identities = (await session(s, host.roomCode))['identities'] as Record<
      string,
      { id: string; name: string; category: string }
    >
    const cards = Object.values(identities)
    expect(cards).toHaveLength(5)
    expect(cards.every((c) => c.category === 'indian-cricketers')).toBe(true)
    expect(new Set(cards.map((c) => c.id)).size).toBe(5)
    expect(new Set(cards.map((c) => c.name)).size).toBe(5)
  }, 45_000)

  it('refuses to start rather than mixing categories when one is too thin', async () => {
    const s = await server()
    // The shipped categories all seat a full table, so the floor is raised
    // instead of shipping a deliberately broken one.
    await expect(
      s.services.content.load({
        kind: 'identity',
        count: 500,
        minimum: 500,
        difficulty: 'mixed',
        category: 'indian-singers',
        strict: true,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' })

    // The same category, asked for honestly, is perfectly playable.
    const pack = await s.services.content.load({
      kind: 'identity',
      count: 40,
      minimum: 10,
      difficulty: 'mixed',
      category: 'indian-singers',
      strict: true,
    })
    expect(pack.items.length).toBeGreaterThanOrEqual(10)
    expect(pack.items.every((item) => item.category === 'indian-singers')).toBe(true)
  }, 30_000)

  it('still hides a player their own identity', async () => {
    const s = await server()
    const { host, others } = await room(s, 'who-am-i', ['Host', 'B', 'C'])
    host.send(ROOM_ACTIONS.START_GAME)
    await host.waitForRoom((r) => r.status !== 'LOBBY', 20_000)

    const identities = (await session(s, host.roomCode))['identities'] as Record<string, { name: string }>
    const hostName = identities[host.playerId]?.name ?? ''
    expect(hostName).not.toBe('')
    await host.waitForRoom((r) => r.game !== null, 15_000)

    expect(JSON.stringify(host.room!.game)).not.toContain(hostName)
    // Somebody else can see it, which is the point of the game.
    const other = others[0]!
    await other.waitForRoom((r) => r.game !== null, 15_000)
    expect(JSON.stringify(other.room!.game)).toContain(hostName)
  }, 45_000)
})

describe('mind meld / the host controls progression', () => {
  async function intoReveal(s: TestServer) {
    const { host, others } = await room(s, 'mind-meld', ['Host', 'B', 'C'])
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { rounds: 3, seconds: 10 } })
    await host.waitForRoom((r) => (r.config.settings as { seconds?: number }).seconds === 10)
    host.send(ROOM_ACTIONS.START_GAME)

    const everyone = [host, ...others]
    await Promise.all(everyone.map((c) => c.waitForPhase('PROMPT', 25_000)))
    for (const client of everyone) client.send('meld/submit', { answer: 'sleep' })
    await Promise.all(everyone.map((c) => c.waitForPhase('REVEAL', 25_000)))
    return { host, others }
  }

  it('stays on the results with no timer until the host acts', async () => {
    const s = await server()
    const { host } = await intoReveal(s)

    // No clock at all, rather than a dead one parked at zero.
    expect(host.room?.deadlineAt).toBeNull()
    expect(host.view['awaitingHost']).toBe(true)

    // Well past the five seconds it used to auto-advance after.
    await new Promise((resolve) => setTimeout(resolve, 7_000))
    expect(host.room!.game?.phase).toBe('REVEAL')
  }, 60_000)

  it('advances when the host presses, and tells everyone', async () => {
    const s = await server()
    const { host, others } = await intoReveal(s)
    const round = host.room!.game!.roundNumber

    host.send(ROOM_ACTIONS.CONTINUE)
    await Promise.all([host, ...others].map((c) => c.waitForRoom((r) => r.game!.roundNumber > round, 20_000)))
    expect(host.room!.game!.roundNumber).toBe(round + 1)
  }, 60_000)

  it('refuses to advance for anyone but the host', async () => {
    const s = await server()
    const { host, others } = await intoReveal(s)
    const guest = others[0]!
    const round = host.room!.game!.roundNumber

    guest.send(ROOM_ACTIONS.CONTINUE)
    await guest.waitFor((m) => m.t === 'error' && m.error.code === 'NOT_HOST', 15_000)
    expect(host.room!.game!.roundNumber).toBe(round)
  }, 60_000)

  it('does not skip a question when the host taps twice', async () => {
    const s = await server()
    const { host } = await intoReveal(s)
    const round = host.room!.game!.roundNumber

    // Two presses in quick succession, as an impatient thumb produces.
    host.send(ROOM_ACTIONS.CONTINUE)
    host.send(ROOM_ACTIONS.CONTINUE)
    await host.waitForRoom((r) => r.game!.roundNumber > round, 20_000)
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(host.room!.game!.roundNumber).toBe(round + 1)
  }, 60_000)

  it('keeps the results on screen across a reconnect', async () => {
    const s = await server()
    const { host } = await intoReveal(s)
    const round = host.room!.game!.roundNumber

    host.kill()
    const back = await TestClient.join(s.httpUrl, s.wsUrl, host.roomCode, 'Host', host.token)
    clients.push(back)
    await back.connect()

    expect(back.room!.game?.phase).toBe('REVEAL')
    expect(back.room!.game!.roundNumber).toBe(round)
    expect(back.view['awaitingHost']).toBe(true)
  }, 60_000)
})
