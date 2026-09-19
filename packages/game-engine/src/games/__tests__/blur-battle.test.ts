import { describe, expect, it } from 'vitest'
import { blurBattle } from '../blur-battle.ts'
import { BASE_POINTS } from '../../scoring.ts'
import { imagePack, players, settle, T0, turnCtx, viewCtx } from './helpers.ts'

const def = blurBattle
const roster = players(3)

function newGame(settings: Record<string, unknown> = {}) {
  const parsed = def.settingsSchema.parse({ questions: 3, seconds: 20, ...settings })
  return def.createGame({
    now: T0,
    seed: 'seed-1',
    players: roster,
    sessionId: 'sess-1',
    settings: parsed,
    content: imagePack(10),
  })
}

/** Fast-forward past the opening countdown into the first live question. */
function intoQuestion(settings: Record<string, unknown> = {}) {
  const created = newGame(settings)
  const state = settle(def, created, T0 + 3_000, roster)
  expect(def.getPhase(state)).toBe('QUESTION')
  return state
}

/** The question actually drawn for the current round. The draw is seeded, so
 *  it is stable, but it is not the fixture order and tests must not assume it. */
function currentAnswer(state: unknown): string {
  const s = state as { questions: { title: string; aliases: string[] }[]; roundIndex: number }
  return s.questions[s.roundIndex]!.title
}

function currentAlias(state: unknown): string {
  const s = state as { questions: { title: string; aliases: string[] }[]; roundIndex: number }
  return s.questions[s.roundIndex]!.aliases[0]!
}

function guess(state: unknown, playerId: string, text: string, now: number) {
  return def.applyAction(state, playerId, { type: 'blur/guess', payload: { guess: text } }, turnCtx(now, roster))
}

describe('blur battle / lifecycle', () => {
  it('opens on a countdown and only then starts the first question', () => {
    const state = newGame()
    expect(def.getPhase(state)).toBe('COUNTDOWN')
    expect(def.getDeadline(state)).toBe(T0 + 3_000)

    const live = settle(def, state, T0 + 3_000, roster)
    expect(def.getPhase(live)).toBe('QUESTION')
  })

  it('walks countdown -> question -> reveal -> next round -> finished', () => {
    let state: unknown = newGame({ questions: 3, seconds: 10 })
    const seen: string[] = []
    // Step a long way in coarse jumps; the settle loop chains phases for us.
    for (let t = T0; t <= T0 + 120_000; t += 1_000) {
      state = settle(def, state, t, roster)
      const phase = def.getPhase(state)
      if (seen.at(-1) !== phase) seen.push(phase)
      if (def.isGameOver(state)) break
    }
    expect(seen).toEqual([
      'COUNTDOWN', 'QUESTION', 'REVEAL',
      'COUNTDOWN', 'QUESTION', 'REVEAL',
      'COUNTDOWN', 'QUESTION', 'REVEAL',
      'FINISHED',
    ])
    expect(def.isGameOver(state)).toBe(true)
    expect(def.getDeadline(state)).toBeNull()
  })

  it('draws the same questions for the same seed and different ones otherwise', () => {
    const a = def.createGame({
      now: T0, seed: 'alpha', players: roster, sessionId: 's', settings: def.settingsSchema.parse({ questions: 3 }), content: imagePack(10),
    })
    const b = def.createGame({
      now: T0, seed: 'alpha', players: roster, sessionId: 's', settings: def.settingsSchema.parse({ questions: 3 }), content: imagePack(10),
    })
    const c = def.createGame({
      now: T0, seed: 'beta', players: roster, sessionId: 's', settings: def.settingsSchema.parse({ questions: 3 }), content: imagePack(10),
    })
    const ids = (s: unknown) => (def.getPublicState(s, null, viewCtx(T0, roster)).view)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
    expect(ids(a)).toBeDefined()
  })
})

describe('blur battle / hidden information', () => {
  it('never puts the answer in a live question payload', () => {
    const state = intoQuestion()
    for (const viewer of [null, 'p1', 'p2']) {
      const pub = def.getPublicState(state, viewer, viewCtx(T0 + 5_000, roster))
      const json = JSON.stringify(pub)
      expect(json).not.toContain(currentAnswer(state))
      expect(json).not.toContain('"answer"')
      expect(pub.view['answer']).toBeUndefined()
    }
  })

  it('sends only the reveal step that has actually unlocked', () => {
    const state = intoQuestion({ seconds: 20 })
    const pub = def.getPublicState(state, 'p1', viewCtx(T0 + 3_100, roster))
    expect(pub.view['stageIndex']).toBe(0)
    // The sharper files exist, but their URLs are not in the payload.
    const json = JSON.stringify(pub)
    expect(json).toContain('-s1.webp')
    for (const s of ['-s2', '-s3', '-s4', '-s5', '-full']) expect(json).not.toContain(s)
  })

  it('unlocks one step at a time as the round runs down', () => {
    let state: unknown = intoQuestion({ seconds: 20 })
    const start = T0 + 3_000
    const seen: number[] = []
    for (let t = start; t < start + 20_000; t += 500) {
      state = settle(def, state, t, roster)
      if (def.getPhase(state) !== 'QUESTION') break
      const idx = def.getPublicState(state, 'p1', viewCtx(t, roster)).view['stageIndex'] as number
      if (seen.at(-1) !== idx) seen.push(idx)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })

  it('reveals the answer and the attribution once the round closes', () => {
    let state: unknown = intoQuestion({ seconds: 10 })
    state = settle(def, state, T0 + 3_000 + 10_000, roster)
    expect(def.getPhase(state)).toBe('REVEAL')
    const pub = def.getPublicState(state, 'p1', viewCtx(T0 + 14_000, roster))
    expect(pub.view['answer']).toBe(currentAnswer(state))
    expect(pub.view['attribution']).toBeDefined()
  })

  it('shows a player their own result without leaking it to anyone else', () => {
    const state = intoQuestion()
    const after = guess(state, 'p1', currentAnswer(state), T0 + 4_000).state

    const own = def.getPublicState(after, 'p1', viewCtx(T0 + 4_100, roster))
    expect(own.view['yourAnswer']).toMatchObject({ correct: true, locked: true })

    const other = def.getPublicState(after, 'p2', viewCtx(T0 + 4_100, roster))
    expect(other.view['yourAnswer']).toBeUndefined()
    // p2 learns that p1 answered, and nothing more.
    expect(other.view['answeredPlayerIds']).toEqual(['p1'])
    expect(JSON.stringify(other)).not.toContain(currentAnswer(state))
  })
})

describe('blur battle / scoring', () => {
  it('pays more the earlier the correct answer lands', () => {
    const state = intoQuestion({ seconds: 20 })
    const start = T0 + 3_000
    const early = guess(state, 'p1', currentAnswer(state), start + 1_000).scoreDeltas?.['p1'] ?? 0
    const late = guess(state, 'p1', currentAnswer(state), start + 19_000).scoreDeltas?.['p1'] ?? 0
    expect(early).toBeGreaterThan(late)
    expect(late).toBeGreaterThan(0)
    expect(early).toBeLessThanOrEqual(BASE_POINTS + 150)
  })

  it('awards nothing for a wrong answer and still locks the player out', () => {
    const state = intoQuestion()
    const wrong = guess(state, 'p1', 'not even close', T0 + 4_000)
    expect(wrong.scoreDeltas).toBeUndefined()

    const second = guess(wrong.state, 'p1', currentAnswer(state), T0 + 5_000)
    expect(second.scoreDeltas).toBeUndefined()
    expect(def.validateAction(wrong.state, 'p1', { type: 'blur/guess', payload: { guess: currentAnswer(state) } }, turnCtx(T0 + 5_000, roster)))
      .toMatchObject({ ok: false, error: { code: 'ALREADY_ANSWERED' } })
  })

  it('ranks the first correct answer above a later one at the same instant', () => {
    const state = intoQuestion({ seconds: 20 })
    const at = T0 + 6_000
    const first = guess(state, 'p1', currentAnswer(state), at)
    const second = guess(first.state, 'p2', currentAlias(state), at)
    expect(first.scoreDeltas?.['p1']).toBeGreaterThan(second.scoreDeltas?.['p2'] ?? 0)
  })

  it('accepts a listed alias and forgives a small typo', () => {
    const state = intoQuestion()
    const answer = currentAnswer(state)
    expect(guess(state, 'p1', currentAlias(state), T0 + 4_000).scoreDeltas?.['p1']).toBeGreaterThan(0)
    expect(guess(state, 'p2', answer.toLowerCase(), T0 + 4_000).scoreDeltas?.['p2']).toBeGreaterThan(0)
    // One transposed character is forgiven; the allowance scales with length.
    const typo = answer.slice(0, 2) + answer.charAt(3) + answer.charAt(2) + answer.slice(4)
    expect(guess(state, 'p3', typo, T0 + 4_000).scoreDeltas?.['p3']).toBeGreaterThan(0)
  })
})

describe('blur battle / round control', () => {
  it('rejects a guess once the round has closed', () => {
    let state: unknown = intoQuestion({ seconds: 10 })
    state = settle(def, state, T0 + 3_000 + 10_000, roster)
    expect(def.validateAction(state, 'p1', { type: 'blur/guess', payload: { guess: 'x' } }, turnCtx(T0 + 14_000, roster)))
      .toMatchObject({ ok: false, error: { code: 'ROUND_CLOSED' } })
  })

  it('rejects an action belonging to another game', () => {
    const state = intoQuestion()
    expect(def.validateAction(state, 'p1', { type: 'meld/submit', payload: { answer: 'x' } }, turnCtx(T0 + 4_000, roster)))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } })
  })

  it('ends the round early once every active player has answered', () => {
    const state = intoQuestion({ seconds: 30 })
    const at = T0 + 5_000
    let s: unknown = state
    for (const p of ['p1', 'p2', 'p3']) s = guess(s, p, currentAnswer(state), at).state
    // The deadline has been pulled back to now, so the room service's loop moves on.
    expect(def.getDeadline(s)!).toBeLessThanOrEqual(at)
    expect(def.getPhase(settle(def, s, at, roster))).toBe('REVEAL')
  })

  it('does not end early while a disconnected player still holds their seat', () => {
    const dropped = players(3, [{}, { presence: 'DISCONNECTED' }])
    const state = intoQuestion({ seconds: 30 })
    const at = T0 + 5_000
    let s: unknown = state
    for (const p of ['p1', 'p3']) s = guess(s, p, currentAnswer(state), at).state
    expect(def.getDeadline(s)!).toBeGreaterThan(at)
    // Once the grace period expires the round can close without them.
    s = def.onPlayerInactive(s, 'p2', { now: at, seed: 'test-seed', players: dropped.map((p) => p.id === 'p2' ? { ...p, presence: 'INACTIVE' } : p) }).state
    expect(def.getDeadline(s)!).toBeLessThanOrEqual(at)
  })
})
