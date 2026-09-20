import { describe, expect, it } from 'vitest'
import { gameRegistry } from '../../index.ts'
import { packOf, players, T0, turnCtx, viewCtx } from './helpers.ts'

/**
 * The host's override on the results screen.
 *
 * No dictionary of equivalents will ever be complete, and the table always
 * knows better than the machine — "petrol bunk" and "gas station", a word in a
 * language nobody wrote down, an inside joke. So the host can join groups by
 * hand before moving on, and undo it if the room objects.
 */

const def = gameRegistry.get('mind-meld')

interface Group {
  key: string
  label: string
  playerIds: string[]
  points: number
}

/** Play a round to its reveal with the given answers, one per player. */
function reveal(answers: string[]) {
  const roster = players(answers.length)
  let state: unknown = def.createGame({
    now: T0,
    seed: 'grouping',
    players: roster,
    sessionId: 'sess',
    settings: def.settingsSchema.parse({ rounds: 3, seconds: 20 }),
    content: packOf('prompt', 40),
    recentContentIds: [],
    hostId: roster[0]!.id,
  })
  let now = T0
  for (let i = 0; i < 6 && def.getPhase(state) !== 'PROMPT'; i++) {
    now = def.getDeadline(state) ?? now + 1
    state = def.advance(state, turnCtx(now, roster)).state
  }
  answers.forEach((answer, i) => {
    state = def.applyAction(state, roster[i]!.id, { type: 'meld/submit', payload: { answer } }, turnCtx(now, roster)).state
  })
  now = def.getDeadline(state) ?? now
  const settled = def.advance(state, turnCtx(now, roster))
  return { state: settled.state, roster, now, paid: settled.scoreDeltas ?? {} }
}

const groupsOf = (state: unknown, roster: ReturnType<typeof players>, now = T0): Group[] =>
  (def.getPublicState(state, 'p1', viewCtx(now, roster)).view as { groups: Group[] }).groups

const keyFor = (state: unknown, roster: ReturnType<typeof players>, label: string): string =>
  groupsOf(state, roster).find((g) => g.label === label)!.key

const merge = (state: unknown, roster: ReturnType<typeof players>, now: number, labels: string[], by = 'p1') =>
  def.applyAction(
    state,
    by,
    { type: 'meld/merge', payload: { keys: labels.map((label) => keyFor(state, roster, label)) } },
    turnCtx(now, roster),
  )

describe('the host joins groups the key folder kept apart', () => {
  it('merges two groups into one and pays the difference', () => {
    // Three ways of saying the same thing that no fold would catch.
    const { state, roster, now, paid } = reveal(['petrol bunk', 'gas station', 'library'])
    expect(groupsOf(state, roster)).toHaveLength(3)
    expect(paid).toEqual({})

    const merged = merge(state, roster, now, ['petrol bunk', 'gas station'])
    const groups = groupsOf(merged.state, roster)
    expect(groups).toHaveLength(2)

    const together = groups.find((g) => g.playerIds.length === 2)
    expect(together?.playerIds).toEqual(['p1', 'p2'])
    expect(together?.points).toBeGreaterThan(0)
    // Both were on zero, so the whole group's points are owed to them now.
    expect(merged.scoreDeltas).toEqual({ p1: together!.points, p2: together!.points })
  })

  it('keeps the wording the host merged into', () => {
    const { state, roster, now } = reveal(['gas station', 'petrol bunk'])
    const merged = merge(state, roster, now, ['petrol bunk', 'gas station'])
    expect(groupsOf(merged.state, roster)[0]?.label).toBe('petrol bunk')
  })

  it('tops up a group that had already scored, without paying twice', () => {
    const { state, roster, now, paid } = reveal(['chai', 'tea', 'cutting chai', 'juice'])
    // chai and tea are folded automatically; "cutting chai" is not.
    const before = groupsOf(state, roster)
    expect(before).toHaveLength(3)
    const alreadyPaid = paid['p1'] ?? 0
    expect(alreadyPaid).toBeGreaterThan(0)

    const merged = merge(state, roster, now, ['chai', 'cutting chai'])
    const group = groupsOf(merged.state, roster).find((g) => g.playerIds.length === 3)
    expect(group?.playerIds).toEqual(['p1', 'p2', 'p3'])
    // p1 and p2 keep what they had and receive only the increase; p3 is paid
    // the whole amount, having been alone.
    expect(merged.scoreDeltas?.['p1']).toBe(group!.points - alreadyPaid)
    expect(merged.scoreDeltas?.['p3']).toBe(group!.points)
  })

  it('folds a third group into a merge that already happened', () => {
    const { state, roster, now } = reveal(['bus', 'lorry', 'truck', 'boat'])
    const first = merge(state, roster, now, ['lorry', 'truck'])
    const second = merge(first.state, roster, now + 1_000, ['lorry', 'bus'])
    const groups = groupsOf(second.state, roster)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.playerIds).toEqual(['p1', 'p2', 'p3'])
  })

  it('undoes every merge and takes the points back', () => {
    const { state, roster, now } = reveal(['petrol bunk', 'gas station', 'library'])
    const merged = merge(state, roster, now, ['petrol bunk', 'gas station'])
    const gained = merged.scoreDeltas?.['p1'] ?? 0

    const undone = def.applyAction(merged.state, 'p1', { type: 'meld/unmerge', payload: {} }, turnCtx(now + 1_000, roster))
    expect(groupsOf(undone.state, roster)).toHaveLength(3)
    expect(undone.scoreDeltas).toEqual({ p1: -gained, p2: -gained })
  })

  it('leaves the automatic grouping recoverable, exactly', () => {
    const { state, roster, now } = reveal(['tea', 'chai', 'coffee'])
    const before = groupsOf(state, roster)
    const merged = merge(state, roster, now, ['tea', 'coffee'])
    const undone = def.applyAction(merged.state, 'p1', { type: 'meld/unmerge', payload: {} }, turnCtx(now + 1, roster))
    expect(groupsOf(undone.state, roster)).toEqual(before)
  })

  it('does not carry a merge into the next question', () => {
    const { state, roster, now } = reveal(['petrol bunk', 'gas station', 'library'])
    const merged = merge(state, roster, now, ['petrol bunk', 'gas station'])
    const next = def.hostAdvance?.(merged.state, turnCtx(now + 2_000, roster))
    expect((next!.state as { mergedInto: Record<string, string> }).mergedInto).toEqual({})
  })

  it('tells the room the grouping was edited', () => {
    const { state, roster, now } = reveal(['petrol bunk', 'gas station'])
    const view = (s: unknown) => def.getPublicState(s, 'p2', viewCtx(now, roster)).view as { merged?: boolean }
    expect(view(state).merged).toBe(false)
    expect(view(merge(state, roster, now, ['petrol bunk', 'gas station']).state).merged).toBe(true)
  })
})

describe('who may regroup, and when', () => {
  it('refuses anyone but the host', () => {
    const { state, roster, now } = reveal(['petrol bunk', 'gas station', 'library'])
    const keys = [keyFor(state, roster, 'petrol bunk'), keyFor(state, roster, 'gas station')]
    const check = def.validateAction(state, 'p2', { type: 'meld/merge', payload: { keys } }, turnCtx(now, roster))
    expect(check.ok).toBe(false)
    expect(check.ok ? null : check.error.code).toBe('NOT_HOST')

    // And the reducer is not a second implementation of that rule.
    const attempt = def.applyAction(state, 'p2', { type: 'meld/merge', payload: { keys } }, turnCtx(now, roster))
    expect(attempt.state).toEqual(state)
    expect(attempt.scoreDeltas).toBeUndefined()
  })

  it('refuses while people are still answering', () => {
    const roster = players(3)
    let state: unknown = def.createGame({
      now: T0,
      seed: 'grouping',
      players: roster,
      sessionId: 'sess',
      settings: def.settingsSchema.parse({ rounds: 3, seconds: 20 }),
      content: packOf('prompt', 40),
      recentContentIds: [],
      hostId: 'p1',
    })
    state = def.advance(state, turnCtx(T0 + 4_000, roster)).state
    expect(def.getPhase(state)).toBe('PROMPT')
    const check = def.validateAction(state, 'p1', { type: 'meld/merge', payload: { keys: ['a', 'b'] } }, turnCtx(T0 + 5_000, roster))
    expect(check.ok).toBe(false)
  })

  it('refuses a group that is no longer on screen', () => {
    // A host whose screen is a moment stale, tapping a key that has already
    // been merged away.
    const { state, roster, now } = reveal(['petrol bunk', 'gas station', 'library'])
    const stale = keyFor(state, roster, 'gas station')
    const merged = merge(state, roster, now, ['petrol bunk', 'gas station'])
    const check = def.validateAction(
      merged.state,
      'p1',
      { type: 'meld/merge', payload: { keys: [stale, keyFor(merged.state, roster, 'library')] } },
      turnCtx(now + 1_000, roster),
    )
    expect(check.ok).toBe(false)
  })

  it('refuses an undo when nothing has been merged', () => {
    const { state, roster, now } = reveal(['tea', 'coffee'])
    const check = def.validateAction(state, 'p1', { type: 'meld/unmerge', payload: {} }, turnCtx(now, roster))
    expect(check.ok).toBe(false)
  })
})
