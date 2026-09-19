import { describe, expect, it } from 'vitest'
import { gameRegistry } from '../../index.ts'
import type { ErasedGameDefinition } from '../../types.ts'
import { packOf, players, T0, turnCtx, viewCtx } from './helpers.ts'

/**
 * The guarantee that matters most, checked the same way for every game: a
 * secret must be absent from the bytes a player receives, not merely unused by
 * the UI. Each case drives a real session forward and greps the serialised
 * payload for the string that must not be in it.
 *
 * This suite is parameterised over the registry, so a sixth game is covered the
 * day it is registered rather than the day somebody remembers to add a test.
 */

const CONTENT_FOR: Record<string, Parameters<typeof packOf>[0]> = {
  'blur-battle': 'image',
  'emoji-movie': 'emoji',
  'who-am-i': 'identity',
  'mind-meld': 'prompt',
  'movie-mafia': 'mafia',
}

function boot(def: ErasedGameDefinition, playerCount: number) {
  const roster = players(playerCount)
  const settings = def.settingsSchema.parse({})
  const kind = CONTENT_FOR[def.id]!
  const state = def.createGame({
    now: T0,
    seed: `seed-${def.id}`,
    players: roster,
    sessionId: `sess-${def.id}`,
    settings,
    content: packOf(kind, 30),
  })
  return { roster, state }
}

/** Every payload every player would receive at this instant. */
function payloadsFor(def: ErasedGameDefinition, state: unknown, roster: ReturnType<typeof players>, now: number) {
  return roster.map((p) => ({
    playerId: p.id,
    json: JSON.stringify(def.getPublicState(state, p.id, viewCtx(now, roster))),
  }))
}

describe('hidden information', () => {
  for (const def of gameRegistry.list()) {
    it(`${def.id}: a spectator payload carries no unrevealed answer`, () => {
      const { roster, state } = boot(def, Math.max(def.minPlayers, 4))
      const json = JSON.stringify(def.getPublicState(state, null, viewCtx(T0 + 100, roster)))
      // Nothing is revealed at t=0 in any game, so no phase-gated reveal key
      // should be present yet.
      expect(json).not.toContain('"answer"')
      expect(json).not.toContain('"imposterId"')
      expect(json).not.toContain('"reveal"')
    })
  }

  it('who-am-i: a player never receives their own identity, but does receive everyone else\'s', () => {
    const def = gameRegistry.get('who-am-i')
    const { roster, state } = boot(def, 4)

    for (const { playerId, json } of payloadsFor(def, state, roster, T0 + 100)) {
      const view = (JSON.parse(json) as { view: { identities: Record<string, { name: string }> } }).view
      expect(Object.keys(view.identities)).not.toContain(playerId)
      expect(Object.keys(view.identities).sort()).toEqual(
        roster.map((p) => p.id).filter((id) => id !== playerId).sort(),
      )
      // The name itself must not appear anywhere in that player's bytes.
      const own = (state as { identities: Record<string, { name: string }> }).identities[playerId]!.name
      const mineElsewhere = roster.some((p) => p.id !== playerId && (state as { identities: Record<string, { name: string }> }).identities[p.id]!.name === own)
      if (!mineElsewhere) expect(json).not.toContain(own)
    }
  })

  it('movie-mafia: only the imposter is told, and no clue but your own is sent', () => {
    const def = gameRegistry.get('movie-mafia')
    const { roster, state } = boot(def, 6)
    const s = state as { imposterId: string; clues: Record<string, string>; subject: { title: string; fanClue: string; imposterClue: string } }

    const flagged = payloadsFor(def, state, roster, T0 + 100).filter((p) => p.json.includes('youAreImposter'))
    expect(flagged).toHaveLength(1)
    expect(flagged[0]!.playerId).toBe(s.imposterId)

    for (const { playerId, json } of payloadsFor(def, state, roster, T0 + 100)) {
      // Your own clue is present; the other kind of clue is not.
      expect(json).toContain(s.clues[playerId]!)
      const otherClue = playerId === s.imposterId ? s.subject.fanClue : s.subject.imposterClue
      expect(json).not.toContain(otherClue)
      // Nobody learns the film, or who the imposter is, before the reveal.
      expect(json).not.toContain(s.subject.title)
      if (playerId !== s.imposterId) expect(json).not.toContain('"imposterId"')
    }
  })

  it('mind-meld: a live prompt payload carries no one else\'s answer', () => {
    const def = gameRegistry.get('mind-meld')
    const { roster, state } = boot(def, 4)

    // Walk into the answering phase and have three of four players commit.
    let live: unknown = state
    for (let i = 0; i < 8 && def.getPhase(live) !== 'PROMPT'; i++) {
      live = def.advance(live, turnCtx(T0 + 4_000, roster)).state
    }
    expect(def.getPhase(live)).toBe('PROMPT')

    const secrets = { p1: 'zebracrossing', p2: 'pineapplepizza', p3: 'trombone' }
    for (const [id, answer] of Object.entries(secrets)) {
      live = def.applyAction(live, id, { type: 'meld/submit', payload: { answer } }, turnCtx(T0 + 5_000, roster)).state
    }

    for (const { playerId, json } of payloadsFor(def, live, roster, T0 + 5_100)) {
      for (const [id, answer] of Object.entries(secrets)) {
        if (id === playerId) expect(json).toContain(answer)
        else expect(json).not.toContain(answer)
      }
      // Who has locked in is public; that is the only signal.
      const parsed = JSON.parse(json) as { view: { answeredPlayerIds: string[] } }
      expect(parsed.view.answeredPlayerIds).toEqual(['p1', 'p2', 'p3'])
    }
  })

  it('mind-meld: every answer becomes visible once the round is scored', () => {
    const def = gameRegistry.get('mind-meld')
    const { roster, state } = boot(def, 3)
    let live: unknown = state
    for (let i = 0; i < 8 && def.getPhase(live) !== 'PROMPT'; i++) {
      live = def.advance(live, turnCtx(T0 + 4_000, roster)).state
    }
    for (const id of ['p1', 'p2', 'p3']) {
      live = def.applyAction(live, id, { type: 'meld/submit', payload: { answer: 'sleeping' } }, turnCtx(T0 + 5_000, roster)).state
    }
    // All in, so the clock is cut; settle into the reveal.
    const deadline = def.getDeadline(live)!
    const scored = def.advance(live, turnCtx(deadline, roster))
    expect(def.getPhase(scored.state)).toBe('REVEAL')
    // "sleeping", "Sleep!" and "sleeps" all land in one group.
    const view = def.getPublicState(scored.state, 'p1', viewCtx(deadline, roster)).view as {
      groups: { playerIds: string[]; points: number }[]
    }
    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]!.playerIds).toHaveLength(3)
    expect(scored.scoreDeltas!['p1']).toBeGreaterThan(0)
  })

  it('emoji-movie: the title is withheld while the round runs', () => {
    const def = gameRegistry.get('emoji-movie')
    const { roster, state } = boot(def, 3)
    let live: unknown = state
    for (let i = 0; i < 8 && def.getPhase(live) !== 'QUESTION'; i++) {
      live = def.advance(live, turnCtx(T0 + 4_000, roster)).state
    }
    const title = (live as { questions: { title: string }[]; roundIndex: number }).questions[0]!.title
    for (const { json } of payloadsFor(def, live, roster, T0 + 5_000)) {
      expect(json).not.toContain(title)
      expect(json).toContain('emojis')
    }
  })
})
