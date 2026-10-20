import { describe, expect, it } from 'vitest'
import { ATTEMPT_POINTS, CLIP_SECONDS, paataPattu } from '../paata-pattu.ts'
import { placementBonus } from '../../scoring.ts'
import { packOf, players, settle, T0, turnCtx, viewCtx } from './helpers.ts'

const def = paataPattu
const roster = players(3)

function newGame(settings: Record<string, unknown> = {}, recentContentIds: string[] = []) {
  return def.createGame({
    now: T0,
    seed: 'seed-1',
    players: roster,
    sessionId: 'sess-1',
    settings: def.settingsSchema.parse({ songs: 3, seconds: 60, ...settings }),
    content: packOf('song', 12),
    recentContentIds,
    hostId: roster[0]!.id,
  })
}

function intoQuestion(settings: Record<string, unknown> = {}) {
  const state = settle(def, newGame(settings), T0 + 3_000, roster)
  expect(def.getPhase(state)).toBe('QUESTION')
  return state
}

/** The song actually drawn for this round; the draw is seeded, not fixture order. */
function answerId(state: unknown): string {
  const s = state as { songs: { id: string }[]; roundIndex: number }
  return s.songs[s.roundIndex]!.id
}

function wrongId(state: unknown, n = 0): string {
  const s = state as { catalog: { id: string }[] }
  return s.catalog.filter((entry) => entry.id !== answerId(state))[n]!.id
}

const guess = (state: unknown, playerId: string, trackId: string, now: number) =>
  def.applyAction(state, playerId, { type: 'song/guess', payload: { trackId } }, turnCtx(now, roster))

const skip = (state: unknown, playerId: string, now: number) =>
  def.applyAction(state, playerId, { type: 'song/skip', payload: {} }, turnCtx(now, roster))

interface TestView {
  ladders: Record<string, { marks: string[]; status: string }>
  catalog?: { id: string }[]
  you: { status: string; unlockedSeconds: number; attempts: { kind: string; title: string | null }[] }
  answer?: { title: string }
  results?: { playerId: string; picks: string[] }[]
}

function view(state: unknown, viewerId: string | null, now: number): TestView {
  return def.getPublicState(state, viewerId, viewCtx(now, roster)).view as unknown as TestView
}

describe('paata pattu / clues', () => {
  it('starts every player on the two-second clue', () => {
    const state = intoQuestion()
    expect(view(state, 'p1', T0 + 3_100).you.unlockedSeconds).toBe(2)
  })

  it('a skip or a wrong pick unlocks the next clip for that player only', () => {
    let state = intoQuestion()
    state = skip(state, 'p1', T0 + 4_000).state
    expect(view(state, 'p1', T0 + 4_100).you.unlockedSeconds).toBe(4)
    state = guess(state, 'p1', wrongId(state), T0 + 5_000).state
    expect(view(state, 'p1', T0 + 5_100).you.unlockedSeconds).toBe(7)
    expect(view(state, 'p2', T0 + 5_100).you.unlockedSeconds).toBe(2)
  })

  it('five misses end your round without ending anyone else\'s', () => {
    let state = intoQuestion()
    for (let i = 0; i < CLIP_SECONDS.length; i++) state = skip(state, 'p1', T0 + 4_000 + i).state
    expect(view(state, 'p1', T0 + 5_000).you.status).toBe('lost')
    expect(def.validateAction(state, 'p1', { type: 'song/skip', payload: {} }, turnCtx(T0 + 5_000, roster)).ok).toBe(false)
    expect(def.getPhase(state)).toBe('QUESTION')
  })

  it('picking a song already tried does not burn a clue', () => {
    let state = intoQuestion()
    const wrong = wrongId(state)
    state = guess(state, 'p1', wrong, T0 + 4_000).state
    const again = guess(state, 'p1', wrong, T0 + 4_200)
    expect(again.state).toBe(state)
  })

  it('rejects a track that is not in the catalog', () => {
    const state = intoQuestion()
    const result = def.validateAction(state, 'p1', { type: 'song/guess', payload: { trackId: 'nope' } }, turnCtx(T0 + 4_000, roster))
    expect(result.ok).toBe(false)
  })
})

describe('paata pattu / scoring', () => {
  it('pays by the clue that landed, plus a bonus for being first', () => {
    let state = intoQuestion()
    const first = guess(state, 'p1', answerId(state), T0 + 4_000)
    expect(first.scoreDeltas).toEqual({ p1: ATTEMPT_POINTS[0] + placementBonus(1) })
    state = first.state

    state = skip(state, 'p2', T0 + 5_000).state
    const second = guess(state, 'p2', answerId(state), T0 + 6_000)
    expect(second.scoreDeltas).toEqual({ p2: ATTEMPT_POINTS[1] + placementBonus(2) })
  })

  it('a wrong pick or skip scores nothing', () => {
    const state = intoQuestion()
    expect(guess(state, 'p1', wrongId(state), T0 + 4_000).scoreDeltas).toBeUndefined()
    expect(skip(state, 'p1', T0 + 4_000).scoreDeltas).toBeUndefined()
  })

  it('ends the round as soon as everyone has finished their ladder', () => {
    let state = intoQuestion()
    state = guess(state, 'p1', answerId(state), T0 + 4_000).state
    state = guess(state, 'p2', answerId(state), T0 + 4_500).state
    for (let i = 0; i < CLIP_SECONDS.length; i++) state = skip(state, 'p3', T0 + 5_000 + i).state
    expect(def.getDeadline(state)).toBeLessThanOrEqual(T0 + 5_010)
    expect(def.getPhase(settle(def, state, T0 + 5_010, roster))).toBe('REVEAL')
  })
})

describe('paata pattu / what each player sees', () => {
  it('shows everyone\'s ladder as marks, but nobody\'s picks, until the reveal', () => {
    let state = intoQuestion()
    const wrong = wrongId(state)
    state = guess(state, 'p1', wrong, T0 + 4_000).state
    state = guess(state, 'p1', answerId(state), T0 + 4_500).state

    const p2 = view(state, 'p2', T0 + 4_600)
    expect(p2.ladders['p1']).toEqual({ marks: ['wrong', 'correct'], status: 'won' })
    expect(JSON.stringify(p2.ladders)).not.toContain(wrong)
    expect(p2.answer).toBeUndefined()
    expect(p2.results).toBeUndefined()

    const revealed = view(settle(def, state, T0 + 3_000 + 60_000, roster), 'p2', T0 + 63_100)
    expect(revealed.answer!.title).toBeTypeOf('string')
    expect(revealed.results![0]!.playerId).toBe('p1')
    expect(revealed.results![0]!.picks).toHaveLength(2)
  })

  it('carries the catalog only while guessing, and it is the whole pool', () => {
    const live = intoQuestion()
    expect(view(live, 'p1', T0 + 3_100).catalog).toHaveLength(12)
    expect(view(newGame(), 'p1', T0 + 100).catalog).toBeUndefined()
  })

  it('a player sees their own picks by title', () => {
    let state = intoQuestion()
    state = guess(state, 'p1', wrongId(state), T0 + 4_000).state
    const you = view(state, 'p1', T0 + 4_100).you
    expect(you.attempts).toHaveLength(1)
    expect(you.attempts[0]!.kind).toBe('wrong')
    expect(you.attempts[0]!.title).toMatch(/Song$/)
  })
})

describe('paata pattu / content', () => {
  it('draws the chosen difficulty when there is enough of it', () => {
    const state = newGame({ difficulty: 'hard' }) as { songs: { difficulty: string }[] }
    expect(state.songs.every((song) => song.difficulty === 'hard')).toBe(true)
  })

  it('widens to the whole pool rather than play a short game', () => {
    const state = newGame({ difficulty: 'hard', songs: 10 }) as { songs: unknown[] }
    expect(state.songs).toHaveLength(10)
  })

  it('prefers songs this room has not heard recently', () => {
    const recent = Array.from({ length: 9 }, (_, i) => `song-${i + 1}`)
    const state = newGame({ songs: 3 }, recent) as { songs: { id: string }[] }
    expect(state.songs.every((song) => !recent.includes(song.id))).toBe(true)
  })
})
