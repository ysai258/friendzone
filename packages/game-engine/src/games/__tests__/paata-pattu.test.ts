import { describe, expect, it } from 'vitest'
import { CLIP_SECONDS, MIXED_SHARE, MOVIE_POINTS, STAGE_POINTS, paataPattu, songCatalog, stageWindowMs } from '../paata-pattu.ts'
import { placementBonus } from '../../scoring.ts'
import { packOf, players, settle, songQuestion, T0, turnCtx, viewCtx } from './helpers.ts'

const def = paataPattu
const roster = players(3)
const START = T0 + 3_000

function newGame(settings: Record<string, unknown> = {}, recentContentIds: string[] = [], content = packOf('song', 12)) {
  return def.createGame({
    now: T0,
    seed: 'seed-1',
    players: roster,
    sessionId: 'sess-1',
    settings: def.settingsSchema.parse({ songs: 3, ...settings }),
    content,
    recentContentIds,
    hostId: roster[0]!.id,
  })
}

function intoQuestion(settings: Record<string, unknown> = {}, content?: ReturnType<typeof packOf>) {
  const state = settle(def, newGame(settings, [], content), START, roster)
  expect(def.getPhase(state)).toBe('QUESTION')
  return state
}

/** The song actually drawn for this round; the draw is seeded, not fixture order. */
function answer(state: unknown): { id: string; movie: string; year: number | null } {
  const s = state as { songs: { id: string; movie: string; year: number | null }[]; roundIndex: number }
  return s.songs[s.roundIndex]!
}

function wrongId(state: unknown, n = 0): string {
  const s = state as { catalog: { id: string; movie: string }[] }
  return s.catalog.filter((entry) => entry.movie !== answer(state).movie)[n]!.id
}

const guess = (state: unknown, playerId: string, trackId: string, now: number) =>
  def.applyAction(state, playerId, { type: 'song/guess', payload: { trackId } }, turnCtx(now, roster))

interface TestView {
  stage: number
  unlockedSeconds: number
  board: Record<string, { solvedStage: number | null; place: number | null; misses: number; usedStage: boolean }>
  catalog?: { id: string }[]
  you: { canGuess: boolean; points: number; guesses: { title: string | null; kind: string; stage: number }[] }
  answer?: { title: string }
  results?: { playerId: string; picks: { title: string | null; kind: string }[] }[]
}

function view(state: unknown, viewerId: string | null, now: number): TestView {
  return def.getPublicState(state, viewerId, viewCtx(now, roster)).view as unknown as TestView
}

describe('paata pattu / one clock for the room', () => {
  it('opens on the two-second clue and widens for everyone on the same schedule', () => {
    let state = intoQuestion()
    expect(view(state, 'p1', START).unlockedSeconds).toBe(2)
    state = settle(def, state, START + stageWindowMs(0), roster)
    expect(view(state, 'p1', START + stageWindowMs(0)).unlockedSeconds).toBe(4)
    expect(view(state, 'p2', START + stageWindowMs(0)).unlockedSeconds).toBe(4)
  })

  it('reveals after the last clue has had its time', () => {
    let state: unknown = intoQuestion()
    let now = START
    for (let stage = 0; stage < CLIP_SECONDS.length; stage++) {
      now += stageWindowMs(stage)
      state = settle(def, state, now, roster)
    }
    expect(def.getPhase(state)).toBe('REVEAL')
    expect(view(state, 'p1', now).unlockedSeconds).toBe(15)
  })
})

describe('paata pattu / one guess per clue', () => {
  it('a wrong pick locks you out until the next clue opens', () => {
    let state = intoQuestion()
    state = guess(state, 'p1', wrongId(state), START + 1_000).state
    expect(view(state, 'p1', START + 1_100).you.canGuess).toBe(false)
    const again = def.validateAction(state, 'p1', { type: 'song/guess', payload: { trackId: wrongId(state, 1) } }, turnCtx(START + 1_200, roster))
    expect(again.ok).toBe(false)

    state = settle(def, state, START + stageWindowMs(0), roster)
    expect(view(state, 'p1', START + stageWindowMs(0)).you.canGuess).toBe(true)
  })

  it('opens the next clue at once when everyone has used this one', () => {
    let state = intoQuestion()
    state = guess(state, 'p1', wrongId(state, 0), START + 500).state
    state = guess(state, 'p2', wrongId(state, 1), START + 600).state
    state = guess(state, 'p3', answer(state).id, START + 700).state
    expect(def.getDeadline(state)).toBe(START + 700)
    state = settle(def, state, START + 700, roster)
    expect(view(state, 'p1', START + 700).stage).toBe(1)
  })

  it('ends the round as soon as everyone has it', () => {
    let state = intoQuestion()
    for (const [i, p] of ['p1', 'p2', 'p3'].entries()) state = guess(state, p, answer(state).id, START + 500 + i).state
    expect(def.getPhase(settle(def, state, START + 502, roster))).toBe('REVEAL')
  })

  it('picking a song already tried does not spend the clue', () => {
    let state = intoQuestion()
    const wrong = wrongId(state)
    state = guess(state, 'p1', wrong, START + 500).state
    state = settle(def, state, START + stageWindowMs(0), roster)
    const again = guess(state, 'p1', wrong, START + stageWindowMs(0) + 100)
    expect(again.state).toBe(state)
  })

  it('rejects a track that is not in the catalog', () => {
    const state = intoQuestion()
    const result = def.validateAction(state, 'p1', { type: 'song/guess', payload: { trackId: 'nope' } }, turnCtx(START + 500, roster))
    expect(result.ok).toBe(false)
  })
})

describe('paata pattu / scoring', () => {
  it('pays by the clue it landed on, plus a bonus for being first', () => {
    let state = intoQuestion()
    const first = guess(state, 'p1', answer(state).id, START + 1_000)
    expect(first.scoreDeltas).toEqual({ p1: STAGE_POINTS[0] + placementBonus(1) })
    state = settle(def, first.state, START + stageWindowMs(0), roster)

    const second = guess(state, 'p2', answer(state).id, START + stageWindowMs(0) + 500)
    expect(second.scoreDeltas).toEqual({ p2: STAGE_POINTS[1] + placementBonus(2) })
  })

  it('the right film with the wrong song pays a little, once, and says so', () => {
    const content = packOf('song', 12)
    // Every fixture shares one film, so any wrong pick is from the right film.
    content.items = content.items.map((_, i) => songQuestion(i + 1, { movie: 'Same Film', year: 2001 }))
    let state = intoQuestion({}, content)
    const s = state as { catalog: { id: string }[] }
    const others = s.catalog.filter((entry) => entry.id !== answer(state).id)

    const hint = guess(state, 'p1', others[0]!.id, START + 500)
    expect(hint.scoreDeltas).toEqual({ p1: MOVIE_POINTS })
    state = settle(def, hint.state, START + stageWindowMs(0), roster)
    expect(view(state, 'p1', START + stageWindowMs(0)).you.guesses[0]!.kind).toBe('movie')

    const twice = guess(state, 'p1', others[1]!.id, START + stageWindowMs(0) + 100)
    expect(twice.scoreDeltas).toBeUndefined()
  })

  it('a song whose year is unknown still counts as the same film', () => {
    const content = packOf('song', 12)
    content.items = content.items.map((_, i) => songQuestion(i + 1, { movie: 'Same Film', year: i % 2 === 0 ? 2001 : null }))
    const state = intoQuestion({}, content)
    const s = state as { catalog: { id: string; year: number | null }[] }
    const other = s.catalog.find((entry) => entry.id !== answer(state).id && entry.year !== answer(state).year)!
    expect(guess(state, 'p1', other.id, START + 500).scoreDeltas).toEqual({ p1: MOVIE_POINTS })
  })

  it('a wrong pick from another film scores nothing', () => {
    const state = intoQuestion()
    expect(guess(state, 'p1', wrongId(state), START + 500).scoreDeltas).toBeUndefined()
  })
})

describe('paata pattu / what each player sees', () => {
  it('shows who has it and on which clue, but nobody\'s picks, until the reveal', () => {
    let state = intoQuestion()
    const wrong = wrongId(state)
    state = guess(state, 'p1', wrong, START + 500).state
    state = settle(def, state, START + stageWindowMs(0), roster)
    state = guess(state, 'p1', answer(state).id, START + stageWindowMs(0) + 500).state

    const p2 = view(state, 'p2', START + stageWindowMs(0) + 600)
    expect(p2.board['p1']).toMatchObject({ solvedStage: 1, place: 1, misses: 1 })
    expect(JSON.stringify(p2.board)).not.toContain(wrong)
    expect(p2.answer).toBeUndefined()
    expect(p2.results).toBeUndefined()

    let now = START + stageWindowMs(0)
    for (let stage = 1; stage < CLIP_SECONDS.length; stage++) now += stageWindowMs(stage)
    const revealed = view(settle(def, state, now, roster), 'p2', now)
    expect(revealed.answer!.title).toBeTypeOf('string')
    expect(revealed.results![0]!.playerId).toBe('p1')
    expect(revealed.results![0]!.picks).toHaveLength(2)
  })

  it('keeps the catalog out of the view; the page fetches it once over HTTP', () => {
    expect(view(intoQuestion(), 'p1', START).catalog).toBeUndefined()
  })

  it('the catalog is the whole pool, titles only', () => {
    const pool = packOf('song', 12).items as Parameters<typeof songCatalog>[0]
    const catalog = songCatalog(pool)
    expect(catalog).toHaveLength(12)
    expect(JSON.stringify(catalog)).not.toContain('videoId')
  })
})

describe('paata pattu / content', () => {
  it('draws the chosen difficulty when there is enough of it', () => {
    const state = newGame({ difficulty: 'hard' }) as { songs: { difficulty: string }[] }
    expect(state.songs.every((song) => song.difficulty === 'hard')).toBe(true)
  })

  it('a mixed game is mostly songs people know, with a classic or two', () => {
    const content = packOf('song', 30)
    content.items = content.items.map((_, i) =>
      songQuestion(i + 1, { difficulty: (['easy', 'medium', 'hard'] as const)[i % 3]! }),
    )
    const state = newGame({ songs: 8 }, [], content) as { songs: { id: string; difficulty: string }[] }
    const count = (d: string) => state.songs.filter((song) => song.difficulty === d).length
    expect(state.songs).toHaveLength(8)
    expect(new Set(state.songs.map((song) => song.id)).size).toBe(8)
    expect(count('easy')).toBe(Math.round(8 * MIXED_SHARE.easy))
    expect(count('medium')).toBe(Math.round(8 * MIXED_SHARE.medium))
    expect(count('hard')).toBe(Math.round(8 * MIXED_SHARE.hard))
  })

  it('a mixed game tops up from elsewhere when a difficulty runs short', () => {
    const content = packOf('song', 10)
    content.items = content.items.map((_, i) => songQuestion(i + 1, { difficulty: 'medium' }))
    const state = newGame({ songs: 8 }, [], content) as { songs: unknown[] }
    expect(state.songs).toHaveLength(8)
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
