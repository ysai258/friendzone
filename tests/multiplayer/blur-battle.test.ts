import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOM_ACTIONS, type PublicRoomView } from '@friendzone/shared'
import { startTestServer, type TestServer } from '../helpers/server.ts'
import { closeAll, TestClient } from '../helpers/client.ts'

/**
 * A real game, played by five real WebSocket clients against a real server.
 *
 * This catches what no unit test can: reducers that are correct in isolation
 * but whose state never reaches the third player, a scheduler that advances a
 * round twice, an answer that turns up in somebody's payload.
 *
 * The game does not pause for assertions, so anything phase-specific is
 * asserted over the snapshots each client recorded while it played, rather
 * than by trying to catch a phase as it goes past.
 */

const gameView = (room: PublicRoomView): Record<string, unknown> =>
  (room.game?.view ?? {})

describe('blur battle, five players', () => {
  let server: TestServer
  let host: TestClient
  let players: TestClient[] = []

  /** What each player observed during the playthrough, filled in by the run. */
  const observed = {
    answer: '',
    hostScored: 0,
    duplicateActionId: '',
    scoreAfterFirstGuess: 0,
    scoreAfterReplay: 0,
  }

  beforeAll(async () => {
    server = await startTestServer({ schedulerTickMs: 50 })

    host = await TestClient.createRoom(server.httpUrl, server.wsUrl, 'Yashwanth', 'blur-battle')
    await host.connect()

    players = []
    for (const name of ['Rahul', 'Sai', 'Karthik', 'Divya']) {
      const client = await TestClient.join(server.httpUrl, server.wsUrl, host.roomCode, name)
      await client.connect()
      players.push(client)
    }
  }, 60_000)

  afterAll(async () => {
    await closeAll(...[host, ...players].filter(Boolean))
    await server?.close()
  })

  const everyone = () => [host, ...players]

  // --- Lobby: no clock running, so these can take their time ---------------

  it('shows every player the same lobby', async () => {
    for (const client of everyone()) {
      const room = await client.waitForRoom((r) => r.players.length === 5)
      expect(room.status).toBe('LOBBY')
      expect(room.players.map((p) => p.name).sort()).toEqual(['Divya', 'Karthik', 'Rahul', 'Sai', 'Yashwanth'])
      expect(room.hostId).toBe(host.playerId)
    }
    expect(host.me?.isHost).toBe(true)
    expect(players[0]!.me?.isHost).toBe(false)
  })

  it('refuses to start for anyone but the host', async () => {
    players[0]!.send(ROOM_ACTIONS.START_GAME)
    await players[0]!.waitFor((m) => m.t === 'error')
    expect(players[0]!.lastError?.code).toBe('NOT_HOST')
    expect(host.room?.status).toBe('LOBBY')
  })

  it('lets the host configure the game', async () => {
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 3, seconds: 20 } })
    for (const client of everyone()) {
      const room = await client.waitForRoom((r) => (r.config.settings as { questions?: number }).questions === 3)
      expect(room.config.settings).toMatchObject({ questions: 3, seconds: 20 })
    }
  })

  it('rejects settings outside the allowed range', async () => {
    const before = host.room?.config.settings
    host.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { questions: 999 } })
    await host.waitFor((m) => m.t === 'error' && m.error.code === 'INVALID_CONFIG')
    expect(host.room?.config.settings).toEqual(before)
  })

  // --- One playthrough, driven start to finish -----------------------------

  it('plays a complete game', async () => {
    host.send(ROOM_ACTIONS.START_GAME)

    // Everyone sees the same countdown, measured against the same server clock.
    const opening = await Promise.all(everyone().map((c) => c.waitForPhase('COUNTDOWN')))
    expect(new Set(opening.map((v) => v.deadlineAt)).size).toBe(1)
    expect(opening[0]!.game?.totalRounds).toBe(3)

    await host.waitForPhase('QUESTION', 20_000)

    // The answer is read from the server's own state. A client legitimately
    // cannot know it yet, which is the whole point of the game.
    const stored = await server.services.store.read(host.roomCode)
    const session = stored!.room.session!.state as { questions: { title: string }[]; roundIndex: number }
    observed.answer = session.questions[session.roundIndex]!.title

    host.send('blur/guess', { guess: observed.answer })
    await host.waitForRoom((r) => gameView(r)['yourAnswer'] !== undefined, 20_000)
    observed.hostScored = host.room!.scoreboard.find((s) => s.playerId === host.playerId)!.score

    // A second guess from the same player in the same round is refused.
    host.send('blur/guess', { guess: 'a second attempt' })
    await host.waitFor((m) => m.t === 'error' && m.error.code === 'ALREADY_ANSWERED', 10_000)

    // A retry of an action already applied changes nothing and is not an error.
    const target = players[1]!
    observed.duplicateActionId = target.send('blur/guess', { guess: observed.answer })
    await target.waitForRoom((r) => gameView(r)['yourAnswer'] !== undefined, 20_000)
    observed.scoreAfterFirstGuess = target.room!.scoreboard.find((s) => s.playerId === target.playerId)!.score

    target.send('blur/guess', { guess: observed.answer }, observed.duplicateActionId)
    target.send('blur/guess', { guess: observed.answer }, observed.duplicateActionId)
    await new Promise((resolve) => setTimeout(resolve, 600))
    observed.scoreAfterReplay = target.room!.scoreboard.find((s) => s.playerId === target.playerId)!.score

    // Let the remaining rounds run themselves out on the server's clock.
    await Promise.all(everyone().map((c) => c.waitForRoom((r) => r.status === 'GAME_OVER', 120_000)))
  }, 180_000)

  // --- Assertions over what was actually observed --------------------------

  it('revealed the blur one step at a time, in order', () => {
    const steps = host.valuesOf('stageIndex') as number[]
    // Several rounds, each counting up from 0. It must never skip forward.
    expect(steps.length).toBeGreaterThan(3)
    for (let i = 1; i < steps.length; i++) {
      const previous = steps[i - 1]!
      const current = steps[i]!
      const advancedOne = current === previous + 1
      const newRound = current === 0
      const heldStill = current === previous
      expect(advancedOne || newRound || heldStill).toBe(true)
    }
    expect(Math.max(...steps)).toBe(4)
  })

  it('never sent a sharper image than the round had reached', () => {
    for (const client of everyone()) {
      for (const snapshot of client.snapshotsIn('QUESTION')) {
        const v = gameView(snapshot)
        const stage = v['stageIndex'] as number
        const url = v['imageUrl'] as string
        expect(url).toMatch(new RegExp(`-s${stage + 1}\\.webp$`))
      }
      // The full-resolution file only ever appears once the round is over.
      for (const snapshot of client.snapshotsIn('QUESTION')) {
        expect(JSON.stringify(snapshot)).not.toContain('-full.webp')
      }
    }
  })

  it('never put the answer in a live question payload, for anybody', () => {
    for (const client of everyone()) {
      for (const snapshot of client.snapshotsIn('QUESTION')) {
        expect(gameView(snapshot)['answer']).toBeUndefined()
      }
    }
  })

  it('told only the guesser their own result', () => {
    expect(observed.hostScored).toBeGreaterThan(0)
    // While the host had answered and others had not, nobody else's payload
    // carried a yourAnswer or the answer text.
    const other = players[2]!
    for (const snapshot of other.snapshotsIn('QUESTION')) {
      expect(gameView(snapshot)['yourAnswer']).toBeUndefined()
      expect(JSON.stringify(snapshot)).not.toContain(observed.answer)
    }
  })

  it('did not score a replayed action twice', () => {
    expect(observed.scoreAfterFirstGuess).toBeGreaterThan(0)
    expect(observed.scoreAfterReplay).toBe(observed.scoreAfterFirstGuess)
    expect(players[1]!.errors.filter((e) => e.code === 'ALREADY_ANSWERED')).toHaveLength(0)
  })

  it('revealed the answer and its attribution to everyone', () => {
    for (const client of everyone()) {
      const reveals = client.snapshotsIn('REVEAL')
      expect(reveals.length).toBeGreaterThan(0)
      const v = gameView(reveals[0]!)
      expect(v['answer']).toBeTruthy()
      expect((v['attribution'] as { license: string }).license).toBeTruthy()
      expect((v['attribution'] as { sourceUrl: string }).sourceUrl).toContain('http')
    }
    // Everyone was shown the same answer for the first round.
    const answers = everyone().map((c) => gameView(c.snapshotsIn('REVEAL')[0]!)['answer'])
    expect(new Set(answers).size).toBe(1)
  })

  it('finished on one leaderboard that every client agrees on', () => {
    const board = host.room!.scoreboard
    expect(board).toHaveLength(5)
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1]!.score).toBeGreaterThanOrEqual(board[i]!.score)
    }
    expect(board[0]!.rank).toBe(1)
    expect(board.some((entry) => entry.score > 0)).toBe(true)

    for (const client of everyone()) {
      expect(client.room!.status).toBe('GAME_OVER')
      expect(client.room!.scoreboard.map((s) => `${s.playerId}:${s.score}`)).toEqual(
        board.map((s) => `${s.playerId}:${s.score}`),
      )
    }
  })

  it('wrote the finished game to Postgres', async () => {
    // The archive is written off the realtime path, so give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const { rows } = await server.services.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM game_results r
         JOIN game_sessions s ON s.id = r.session_id
        WHERE s.room_code = $1`,
      [host.roomCode],
    )
    expect(Number(rows[0]!.count)).toBe(5)
  })

  it('plays again with the same people, the same room, and a clean scoreboard', async () => {
    host.send(ROOM_ACTIONS.PLAY_AGAIN)
    for (const client of everyone()) {
      const room = await client.waitForRoom((r) => r.status === 'LOBBY', 15_000)
      expect(room.players).toHaveLength(5)
      expect(room.scoreboard.every((s) => s.score === 0)).toBe(true)
      expect(room.code).toBe(host.roomCode)
    }
  })
})
