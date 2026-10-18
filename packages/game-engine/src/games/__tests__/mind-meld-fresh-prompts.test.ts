import { describe, expect, it } from 'vitest'
import { gameRegistry } from '../../index.ts'
import { packOf, players, settle, T0, turnCtx, viewCtx } from './helpers.ts'

/**
 * Keeping a regular table from seeing the same prompts every night.
 *
 * The host can skip a prompt the table has already played, and with custom
 * questions on, everyone writes one of their own before the game starts.
 */

const def = gameRegistry.get('mind-meld')

interface View {
  prompt?: string
  authorId?: string
  canSkip?: boolean
  submittedPlayerIds?: string[]
  yourQuestion?: string
}

function start(settings: Record<string, unknown>, count = 3) {
  const roster = players(count)
  const state = def.createGame({
    now: T0,
    seed: 'fresh',
    players: roster,
    sessionId: 'sess',
    settings: def.settingsSchema.parse({ rounds: 3, seconds: 20, ...settings }),
    content: packOf('prompt', 40),
    recentContentIds: [],
    hostId: roster[0]!.id,
  })
  return { state, roster }
}

const viewOf = (state: unknown, roster: ReturnType<typeof players>, viewer = 'p1') =>
  def.getPublicState(state, viewer, viewCtx(T0, roster)).view as View

const ask = (state: unknown, roster: ReturnType<typeof players>, by: string, question: string, now = T0) =>
  def.applyAction(state, by, { type: 'meld/question', payload: { question } }, turnCtx(now, roster)).state

describe('the host skips a prompt', () => {
  it('swaps in a fresh prompt and counts down to it again', () => {
    const { state, roster } = start({})
    const now = T0 + 3_000
    const live = settle(def, state, now, roster)
    expect(def.getPhase(live)).toBe('PROMPT')
    const before = viewOf(live, roster).prompt

    const answered = def.applyAction(live, 'p2', { type: 'meld/submit', payload: { answer: 'sleep' } }, turnCtx(now, roster)).state
    const skipped = def.applyAction(answered, 'p1', { type: 'meld/skip', payload: {} }, turnCtx(now, roster)).state

    expect(def.getPhase(skipped)).toBe('COUNTDOWN')
    const after = settle(def, skipped, now + 3_000, roster)
    const view = def.getPublicState(after, 'p2', viewCtx(now, roster))
    expect((view.view as View).prompt).not.toBe(before)
    // Same game length, and the answer to the old prompt is gone.
    expect(view.roundNumber).toBe(1)
    expect(view.totalRounds).toBe(3)
    expect(view.view).not.toHaveProperty('yourAnswer')
  })

  it('is the host’s call alone, and only while a prompt is up', () => {
    const { state, roster } = start({})
    const live = settle(def, state, T0 + 3_000, roster)
    expect(def.validateAction(live, 'p2', { type: 'meld/skip', payload: {} }, turnCtx(T0, roster)).ok).toBe(false)

    const revealed = settle(def, live, T0 + 60_000, roster)
    expect(def.getPhase(revealed)).toBe('REVEAL')
    expect(def.validateAction(revealed, 'p1', { type: 'meld/skip', payload: {} }, turnCtx(T0, roster)).ok).toBe(false)
  })
})

describe('custom questions', () => {
  it('are off by default', () => {
    const { state } = start({})
    expect(def.getPhase(state)).toBe('COUNTDOWN')
  })

  it('open with a 60 second window to write one', () => {
    const { state } = start({ customQuestions: true })
    expect(def.getPhase(state)).toBe('COLLECT')
    expect(def.getDeadline(state)).toBe(T0 + 60_000)
  })

  it('stay hidden from everyone but their author', () => {
    const { state, roster } = start({ customQuestions: true })
    const next = ask(state, roster, 'p2', 'Name a yellow fruit')
    expect(viewOf(next, roster, 'p2').yourQuestion).toBe('Name a yellow fruit')
    expect(JSON.stringify(viewOf(next, roster, 'p1'))).not.toContain('yellow')
    expect(viewOf(next, roster, 'p1').submittedPlayerIds).toEqual(['p2'])
  })

  it('close early once everyone has written one, and all of them are played', () => {
    const { state, roster } = start({ customQuestions: true })
    let next = ask(state, roster, 'p1', 'Name a yellow fruit')
    next = ask(next, roster, 'p2', 'Name a famous cricketer')
    expect(def.getDeadline(next)).toBe(T0 + 60_000)
    next = ask(next, roster, 'p3', 'Name something in a kitchen')
    expect(def.getDeadline(next)).toBe(T0)

    const dealt = settle(def, next, T0, roster)
    expect(def.getPhase(dealt)).toBe('COUNTDOWN')

    // Three rounds, three custom questions: every round is somebody's.
    const asked: { prompt?: string; authorId?: string }[] = []
    let current = dealt
    let now = T0
    for (let round = 0; round < 3; round++) {
      now += 3_000
      current = settle(def, current, now, roster)
      asked.push(viewOf(current, roster))
      now += 20_000
      current = settle(def, current, now, roster)
      current = def.hostAdvance!(current, turnCtx(now, roster))!.state
    }
    expect(asked.map((a) => a.authorId).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(def.isGameOver(current)).toBe(true)
  })

  it('make room among the built-in prompts, and grow the game only when there are more of them', () => {
    const { state, roster } = start({ customQuestions: true, rounds: 3 }, 5)
    let next = state
    for (const [i, id] of ['p1', 'p2', 'p3', 'p4', 'p5'].entries()) next = ask(next, roster, id, `Custom question number ${i}`)
    const dealt = settle(def, next, T0, roster)
    expect(def.getPublicState(dealt, 'p1', viewCtx(T0, roster)).totalRounds).toBe(5)

    const few = settle(def, ask(start({ customQuestions: true }).state, roster, 'p1', 'Name a yellow fruit'), T0 + 60_000, roster)
    expect(def.getPublicState(few, 'p1', viewCtx(T0, roster)).totalRounds).toBe(3)
  })

  it('never reach the content history', () => {
    const { state, roster } = start({ customQuestions: true })
    const dealt = settle(def, ask(state, roster, 'p1', 'Name a yellow fruit'), T0 + 60_000, roster)
    expect(def.usedContentIds!(dealt).some((id) => id.startsWith('custom:'))).toBe(false)
  })

  it('reject anything too short to be a question', () => {
    const { state, roster } = start({ customQuestions: true })
    expect(def.validateAction(state, 'p1', { type: 'meld/question', payload: { question: 'hi' } }, turnCtx(T0, roster)).ok).toBe(false)
  })
})

describe('the host closes questions early', () => {
  it('deals the game straight away, counting down from now', () => {
    const { state, roster } = start({ customQuestions: true })
    const now = T0 + 10_000
    const closed = def.applyAction(ask(state, roster, 'p2', 'Name a yellow fruit'), 'p1', { type: 'meld/close-questions', payload: {} }, turnCtx(now, roster)).state
    const dealt = settle(def, closed, now, roster)
    expect(def.getPhase(dealt)).toBe('COUNTDOWN')
    expect(def.getDeadline(dealt)).toBe(now + 3_000)
  })

  it('is the host’s call alone', () => {
    const { state, roster } = start({ customQuestions: true })
    expect(def.validateAction(state, 'p2', { type: 'meld/close-questions', payload: {} }, turnCtx(T0, roster)).ok).toBe(false)
  })
})
