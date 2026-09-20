import { describe, expect, it } from 'vitest'
import { gameRegistry } from '../../index.ts'
import type { ErasedGameDefinition } from '../../types.ts'
import { packOf, players, settle, T0, turnCtx, viewCtx } from './helpers.ts'

function boot(def: ErasedGameDefinition, count: number, settings: Record<string, unknown> = {}) {
  const roster = players(count)
  const kind = { 'blur-battle': 'image', 'emoji-movie': 'emoji', 'who-am-i': 'identity', 'mind-meld': 'prompt', 'movie-mafia': 'mafia' }[def.id] as Parameters<typeof packOf>[0]
  const state = def.createGame({
    now: T0,
    seed: `seed-${def.id}`,
    players: roster,
    sessionId: 'sess',
    settings: def.settingsSchema.parse(settings),
    content: packOf(kind, 30),
    recentContentIds: [],
    hostId: roster[0]!.id,
  })
  return { roster, state }
}

/** Advance to a named phase, failing loudly rather than looping forever. */
function reach(def: ErasedGameDefinition, state: unknown, roster: ReturnType<typeof players>, phase: string, from = T0) {
  let current = state
  let now = from
  for (let i = 0; i < 200; i++) {
    if (def.getPhase(current) === phase) return { state: current, now }
    const deadline = def.getDeadline(current)
    if (deadline === null) break
    now = Math.max(now, deadline)
    current = settle(def, current, now, roster)
  }
  throw new Error(`never reached ${phase}; stuck in ${def.getPhase(current)}`)
}

describe('emoji movie / anti-spam', () => {
  const def = gameRegistry.get('emoji-movie')

  it('refuses a second guess inside the cooldown', () => {
    const { roster, state } = boot(def, 3)
    const { state: live, now } = reach(def, state, roster, 'QUESTION')

    const first = def.applyAction(live, 'p1', { type: 'emoji/guess', payload: { guess: 'wrong one' } }, turnCtx(now + 100, roster))
    const tooSoon = def.validateAction(first.state, 'p1', { type: 'emoji/guess', payload: { guess: 'another' } }, turnCtx(now + 400, roster))
    expect(tooSoon).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } })

    const later = def.validateAction(first.state, 'p1', { type: 'emoji/guess', payload: { guess: 'another' } }, turnCtx(now + 2_000, roster))
    expect(later.ok).toBe(true)
  })

  it('treats an immediate repeat of the same guess as a double-tap, not an attempt', () => {
    const { roster, state } = boot(def, 3)
    const { state: live, now } = reach(def, state, roster, 'QUESTION')

    const first = def.applyAction(live, 'p1', { type: 'emoji/guess', payload: { guess: 'jaws' } }, turnCtx(now + 100, roster))
    const repeat = def.applyAction(first.state, 'p1', { type: 'emoji/guess', payload: { guess: 'jaws' } }, turnCtx(now + 150, roster))

    const attempts = (s: unknown) => (def.getPublicState(s, 'p1', viewCtx(now + 200, roster)).view['yourAttempts'] as string[]).length
    expect(attempts(first.state)).toBe(attempts(repeat.state))
    expect(repeat.events).toHaveLength(0)
  })

  it('caps attempts so a title cannot be brute-forced', () => {
    const { roster, state } = boot(def, 3, { seconds: 90 })
    const { state: live, now } = reach(def, state, roster, 'QUESTION')

    let current = live
    for (let i = 0; i < 8; i++) {
      current = def.applyAction(current, 'p1', { type: 'emoji/guess', payload: { guess: `attempt ${i}` } }, turnCtx(now + 100 + i * 2_000, roster)).state
    }
    const blocked = def.validateAction(current, 'p1', { type: 'emoji/guess', payload: { guess: 'attempt 9' } }, turnCtx(now + 40_000, roster))
    expect(blocked).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } })
  })

  it('locks a player out once they have solved it', () => {
    const { roster, state } = boot(def, 3)
    const { state: live, now } = reach(def, state, roster, 'QUESTION')
    const title = (live as { questions: { title: string }[]; roundIndex: number }).questions[0]!.title

    const solved = def.applyAction(live, 'p1', { type: 'emoji/guess', payload: { guess: title } }, turnCtx(now + 500, roster))
    expect(solved.scoreDeltas?.['p1']).toBeGreaterThan(0)
    expect(def.validateAction(solved.state, 'p1', { type: 'emoji/guess', payload: { guess: title } }, turnCtx(now + 5_000, roster)))
      .toMatchObject({ ok: false, error: { code: 'ALREADY_ANSWERED' } })
  })
})

describe('who am i / turns', () => {
  const def = gameRegistry.get('who-am-i')

  it('only the player holding the turn may ask', () => {
    const { roster, state } = boot(def, 4)
    const { state: live, now } = reach(def, state, roster, 'ASK')
    const asker = def.getPublicState(live, null, viewCtx(now, roster)).view['asker'] as string
    const other = roster.map((p) => p.id).find((id) => id !== asker)!

    expect(def.validateAction(live, other, { type: 'whoami/ask', payload: { question: 'Am I real?' } }, turnCtx(now, roster)))
      .toMatchObject({ ok: false, error: { code: 'NOT_YOUR_TURN' } })
    expect(def.validateAction(live, asker, { type: 'whoami/ask', payload: { question: 'Am I real?' } }, turnCtx(now, roster)).ok).toBe(true)
  })

  it('the asker does not vote on their own question', () => {
    const { roster, state } = boot(def, 4)
    const { state: live, now } = reach(def, state, roster, 'ASK')
    const asker = def.getPublicState(live, null, viewCtx(now, roster)).view['asker'] as string

    const voting = def.applyAction(live, asker, { type: 'whoami/ask', payload: { question: 'Am I fictional?' } }, turnCtx(now, roster)).state
    expect(def.getPhase(voting)).toBe('VOTE')
    expect(def.validateAction(voting, asker, { type: 'whoami/vote', payload: { vote: 'yes' } }, turnCtx(now + 10, roster)))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } })

    const other = roster.map((p) => p.id).find((id) => id !== asker)!
    expect(def.validateAction(voting, other, { type: 'whoami/vote', payload: { vote: 'yes' } }, turnCtx(now + 10, roster)).ok).toBe(true)
  })

  it('pays more for solving in fewer turns', () => {
    const { roster, state } = boot(def, 4)
    const { state: live, now } = reach(def, state, roster, 'ASK')
    const asker = def.getPublicState(live, null, viewCtx(now, roster)).view['asker'] as string
    const own = (live as { identities: Record<string, { name: string }> }).identities[asker]!.name

    const quick = def.applyAction(live, asker, { type: 'whoami/guess', payload: { guess: own } }, turnCtx(now + 1_000, roster))

    // Same player, but with nine turns already spent.
    const spent = { ...(live as object), turnsUsed: { ...(live as { turnsUsed: Record<string, number> }).turnsUsed, [asker]: 9 } }
    const slow = def.applyAction(spent, asker, { type: 'whoami/guess', payload: { guess: own } }, turnCtx(now + 1_000, roster))

    expect(quick.scoreDeltas![asker]!).toBeGreaterThan(slow.scoreDeltas![asker]!)
  })

  it('a hint costs a turn and only ever describes your own card', () => {
    const { roster, state } = boot(def, 4)
    const { state: live, now } = reach(def, state, roster, 'ASK')
    const asker = def.getPublicState(live, null, viewCtx(now, roster)).view['asker'] as string

    const before = (live as { turnsUsed: Record<string, number> }).turnsUsed[asker] ?? 0
    const after = def.applyAction(live, asker, { type: 'whoami/hint', payload: {} }, turnCtx(now + 500, roster)).state
    expect((after as { turnsUsed: Record<string, number> }).turnsUsed[asker]).toBe(before + 1)

    const mine = def.getPublicState(after, asker, viewCtx(now + 600, roster)).view['yourHints'] as string[]
    expect(mine).toHaveLength(1)
    // Nobody else is shown it.
    const other = roster.map((p) => p.id).find((id) => id !== asker)!
    expect(def.getPublicState(after, other, viewCtx(now + 600, roster)).view['yourHints']).toHaveLength(0)
  })
})

describe('movie mafia / voting', () => {
  const def = gameRegistry.get('movie-mafia')

  it('rejects self-votes and votes for the eliminated', () => {
    const { roster, state } = boot(def, 5)
    const { state: live, now } = reach(def, state, roster, 'VOTE')
    expect(def.validateAction(live, 'p1', { type: 'mafia/vote', payload: { targetId: 'p1' } }, turnCtx(now, roster)))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } })
    expect(def.validateAction(live, 'p1', { type: 'mafia/vote', payload: { targetId: 'ghost' } }, turnCtx(now, roster)))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } })
    expect(def.validateAction(live, 'p1', { type: 'mafia/vote', payload: { targetId: 'p2' } }, turnCtx(now, roster)).ok).toBe(true)
  })

  it('a vote is counted once; a second is refused', () => {
    const { roster, state } = boot(def, 5)
    const { state: live, now } = reach(def, state, roster, 'VOTE')
    const once = def.applyAction(live, 'p1', { type: 'mafia/vote', payload: { targetId: 'p2' } }, turnCtx(now, roster)).state
    expect(def.validateAction(once, 'p1', { type: 'mafia/vote', payload: { targetId: 'p3' } }, turnCtx(now + 100, roster)))
      .toMatchObject({ ok: false, error: { code: 'ALREADY_ANSWERED' } })
  })

  it('who you voted for stays private until the result', () => {
    const { roster, state } = boot(def, 5)
    const { state: live, now } = reach(def, state, roster, 'VOTE')
    const voted = def.applyAction(live, 'p1', { type: 'mafia/vote', payload: { targetId: 'p2' } }, turnCtx(now, roster)).state

    const mine = def.getPublicState(voted, 'p1', viewCtx(now + 10, roster)).view
    expect(mine['yourVote']).toBe('p2')
    const theirs = def.getPublicState(voted, 'p3', viewCtx(now + 10, roster)).view
    expect(theirs['yourVote']).toBeUndefined()
    // p3 can see that p1 voted, not for whom.
    expect(theirs['votedPlayerIds']).toEqual(['p1'])
  })

  it('voting out the imposter ends it for the fans and pays the correct voters', () => {
    const { roster, state } = boot(def, 5)
    const { state: live, now } = reach(def, state, roster, 'VOTE')
    const imposter = (live as { imposterId: string }).imposterId
    const fans = roster.map((p) => p.id).filter((id) => id !== imposter)

    let current = live
    for (const fan of fans) {
      current = def.applyAction(current, fan, { type: 'mafia/vote', payload: { targetId: imposter } }, turnCtx(now + 100, roster)).state
    }
    const resolved = def.advance(current, turnCtx(def.getDeadline(current)!, roster))
    expect(def.getPhase(resolved.state)).toBe('RESULT')
    for (const fan of fans) expect(resolved.scoreDeltas![fan]!).toBeGreaterThan(0)
    expect(resolved.scoreDeltas![imposter]).toBeUndefined()

    const view = def.getPublicState(resolved.state, 'p1', viewCtx(now + 200, roster)).view
    expect(view['outcome']).toBe('FANS_WIN')
    expect(view['imposterId']).toBe(imposter)
  })

  it('a tied vote eliminates nobody', () => {
    const { roster, state } = boot(def, 4)
    const { state: live, now } = reach(def, state, roster, 'VOTE')
    let current = live
    current = def.applyAction(current, 'p1', { type: 'mafia/vote', payload: { targetId: 'p2' } }, turnCtx(now, roster)).state
    current = def.applyAction(current, 'p2', { type: 'mafia/vote', payload: { targetId: 'p1' } }, turnCtx(now, roster)).state
    current = def.applyAction(current, 'p3', { type: 'mafia/vote', payload: { targetId: 'p1' } }, turnCtx(now, roster)).state
    current = def.applyAction(current, 'p4', { type: 'mafia/vote', payload: { targetId: 'p2' } }, turnCtx(now, roster)).state

    const resolved = def.advance(current, turnCtx(def.getDeadline(current)!, roster))
    const view = def.getPublicState(resolved.state, 'p1', viewCtx(now + 100, roster)).view
    expect((view['lastRound'] as { tied: boolean }).tied).toBe(true)
    expect((view['lastRound'] as { eliminated: string | null }).eliminated).toBeNull()
    expect((resolved.state as { alive: string[] }).alive).toHaveLength(4)
  })

  it('ends safely if the imposter walks out', () => {
    const { roster, state } = boot(def, 5)
    const { state: live, now } = reach(def, state, roster, 'DISCUSSION')
    const imposter = (live as { imposterId: string }).imposterId
    const ended = def.onPlayerInactive(live, imposter, turnCtx(now + 1_000, roster))
    expect(def.isGameOver(ended.state)).toBe(true)
    expect(def.getPublicState(ended.state, 'p1', viewCtx(now + 1_100, roster)).view['outcome']).toBe('FANS_WIN')
  })
})

describe('every game', () => {
  for (const def of gameRegistry.list()) {
    it(`${def.id}: reaches a finished state and then stops scheduling`, () => {
      const { roster, state } = boot(def, Math.max(def.minPlayers, 4))
      let current = state
      let now = T0
      for (let i = 0; i < 2_000 && !def.isGameOver(current); i++) {
        const deadline = def.getDeadline(current)
        if (deadline === null) {
          // No clock means the game is waiting on a person. Drive it the way
          // the room service does when the host presses the button.
          const pushed = def.hostAdvance?.(current, turnCtx(now + 1, roster))
          if (pushed === undefined || pushed === null) break
          now += 1
          current = pushed.state
          continue
        }
        now = Math.max(now + 1, deadline)
        current = def.advance(current, turnCtx(now, roster)).state
      }
      expect(def.isGameOver(current)).toBe(true)
      expect(def.getDeadline(current)).toBeNull()
      // A finished game absorbs further advances without changing.
      const after = def.advance(current, turnCtx(now + 60_000, roster))
      expect(after.state).toEqual(current)
      expect(after.events).toHaveLength(0)
    })

    it(`${def.id}: rejects an action from a game it does not own`, () => {
      const { roster, state } = boot(def, Math.max(def.minPlayers, 4))
      const result = def.validateAction(state, 'p1', { type: 'nonsense/action', payload: {} }, turnCtx(T0 + 100, roster))
      expect(result.ok).toBe(false)
    })

    it(`${def.id}: default settings satisfy its own schema`, () => {
      const defaults = gameRegistry.defaultSettings(def.id)
      expect(() => def.settingsSchema.parse(defaults)).not.toThrow()
    })
  }
})
