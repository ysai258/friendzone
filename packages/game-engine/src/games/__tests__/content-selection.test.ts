import { describe, expect, it } from 'vitest'
import { gameRegistry } from '../../index.ts'
import { pickFresh, rememberUsed } from '../../selection.ts'
import { languagesIn, type MovieLanguage } from '../../content.ts'
import { createRng } from '@friendzone/shared'
import { packOf, players, T0, turnCtx, viewCtx } from './helpers.ts'

/**
 * Language selection, category coherence, and not repeating yourself.
 *
 * These are the complaints this content work answers: an English-heavy pool,
 * the same films every evening, and a Who Am I? table where one player is a
 * cricketer among four actors.
 */

const rng = () => createRng('selection-test')

function boot(gameId: string, playerCount: number, settings: Record<string, unknown> = {}, recent: string[] = []) {
  const def = gameRegistry.get(gameId)
  const roster = players(playerCount)
  const kind = { 'emoji-movie': 'emoji', 'who-am-i': 'identity', 'mind-meld': 'prompt', 'movie-mafia': 'mafia' }[
    gameId
  ] as Parameters<typeof packOf>[0]
  const state = def.createGame({
    now: T0,
    seed: `seed-${gameId}`,
    players: roster,
    sessionId: 'sess',
    settings: def.settingsSchema.parse(settings),
    content: packOf(kind, 40),
    recentContentIds: recent,
  })
  return { def, roster, state }
}

describe('pickFresh', () => {
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}` }))

  it('prefers what has not been seen', () => {
    const recent = pool.slice(0, 15).map((p) => p.id)
    const picked = pickFresh(pool, { count: 5, recentIds: recent, rng: rng() })
    expect(picked.items).toHaveLength(5)
    expect(picked.items.every((item) => !recent.includes(item.id))).toBe(true)
    expect(picked.reusedRecent).toBe(false)
  })

  it('never returns the same item twice', () => {
    const picked = pickFresh(pool, { count: 12, rng: rng() })
    expect(new Set(picked.items.map((i) => i.id)).size).toBe(12)
  })

  it('falls back to the stalest when there is not enough left', () => {
    // Everything seen, oldest first. Only five are genuinely unseen.
    const recent = pool.slice(0, 18).map((p) => p.id)
    const picked = pickFresh(pool, { count: 8, recentIds: recent, rng: rng() })
    expect(picked.items).toHaveLength(8)
    expect(picked.reusedRecent).toBe(true)
    // The two unseen ones must both be in there.
    const ids = picked.items.map((i) => i.id)
    expect(ids).toContain('x18')
    expect(ids).toContain('x19')
    // Anything reused is from the oldest end of the history, not the newest.
    const reused = ids.filter((id) => recent.includes(id))
    expect(reused.every((id) => recent.indexOf(id) < 10)).toBe(true)
  })

  it('copes with a pool smaller than the request', () => {
    const picked = pickFresh(pool.slice(0, 3), { count: 10, rng: rng() })
    expect(picked.items).toHaveLength(3)
  })
})

describe('rememberUsed', () => {
  it('keeps newest last and drops the oldest past the limit', () => {
    const history = rememberUsed(['a', 'b', 'c'], ['d', 'e'], 4)
    expect(history).toEqual(['b', 'c', 'd', 'e'])
  })

  it('moves a repeat to the newest end rather than storing it twice', () => {
    expect(rememberUsed(['a', 'b', 'c'], ['a'], 10)).toEqual(['b', 'c', 'a'])
  })
})

describe('emoji movie / languages', () => {
  it('defaults to Telugu and Hindi rather than English', () => {
    const settings = gameRegistry.get('emoji-movie').settingsSchema.parse({}) as { languages: MovieLanguage[] }
    expect(settings.languages).toEqual(['telugu', 'hindi'])
  })

  it('asks for only the languages the host selected', () => {
    const def = gameRegistry.get('emoji-movie')
    const request = def.contentRequest(def.settingsSchema.parse({ languages: ['telugu'] }))
    expect(request.languages).toEqual(['telugu'])
  })

  it('treats an empty selection as the default rather than an empty pool', () => {
    const settings = gameRegistry.get('emoji-movie').settingsSchema.parse({ languages: [] }) as {
      languages: MovieLanguage[]
    }
    expect(settings.languages).toEqual(['telugu', 'hindi'])
  })

  it('removes duplicates a client might send', () => {
    const settings = gameRegistry.get('emoji-movie').settingsSchema.parse({
      languages: ['telugu', 'telugu', 'tamil'],
    }) as { languages: MovieLanguage[] }
    expect(settings.languages).toEqual(['telugu', 'tamil'])
  })

  it('rejects a language that does not exist', () => {
    expect(() => gameRegistry.get('emoji-movie').settingsSchema.parse({ languages: ['klingon'] })).toThrow()
  })

  it('draws no film twice within a game', () => {
    const { state } = boot('emoji-movie', 3, { questions: 10 })
    const ids = (state as { questions: { id: string }[] }).questions.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('avoids films the room played last time', () => {
    const first = boot('emoji-movie', 3, { questions: 6 })
    const played = (first.state as { questions: { id: string }[] }).questions.map((q) => q.id)

    const second = boot('emoji-movie', 3, { questions: 6 }, played)
    const next = (second.state as { questions: { id: string }[] }).questions.map((q) => q.id)

    expect(next.some((id) => played.includes(id))).toBe(false)
  })

  it('reports what it drew so the room can remember it', () => {
    const { def, state } = boot('emoji-movie', 3, { questions: 5 })
    expect(def.usedContentIds?.(state)).toHaveLength(5)
  })
})

describe('movie mafia / languages', () => {
  it('defaults to Telugu and Hindi', () => {
    const settings = gameRegistry.get('movie-mafia').settingsSchema.parse({}) as { languages: MovieLanguage[] }
    expect(settings.languages).toEqual(['telugu', 'hindi'])
  })

  it('passes the selection through to the content request', () => {
    const def = gameRegistry.get('movie-mafia')
    const request = def.contentRequest(def.settingsSchema.parse({ languages: ['tamil', 'malayalam'] }))
    expect(request.languages).toEqual(['tamil', 'malayalam'])
  })

  it('avoids the film the room just played', () => {
    const first = boot('movie-mafia', 5)
    const played = first.def.usedContentIds?.(first.state) ?? []
    expect(played).toHaveLength(1)

    const second = boot('movie-mafia', 5, {}, played)
    expect(second.def.usedContentIds?.(second.state)).not.toEqual(played)
  })

  it('has a language on every subject in the fixtures', () => {
    expect(languagesIn(packOf('mafia', 10).items).length).toBeGreaterThan(1)
  })
})

describe('who am i / one category per game', () => {
  it('defaults to Telugu actors', () => {
    const settings = gameRegistry.get('who-am-i').settingsSchema.parse({}) as { category: string }
    expect(settings.category).toBe('telugu-actors')
  })

  it('asks for exactly that category, and refuses to be widened', () => {
    const def = gameRegistry.get('who-am-i')
    const request = def.contentRequest(def.settingsSchema.parse({ category: 'indian-cricketers' }))
    expect(request.category).toBe('indian-cricketers')
    // A table half cricketers and half actors is a broken game, not a wider one.
    expect(request.strict).toBe(true)
  })

  it('gives every player a different person', () => {
    const { state } = boot('who-am-i', 6)
    const names = Object.values((state as { identities: Record<string, { name: string }> }).identities).map(
      (c) => c.name,
    )
    expect(new Set(names).size).toBe(names.length)
  })

  it('tells everyone which category they are guessing inside', () => {
    const { def, state, roster } = boot('who-am-i', 4, { category: 'indian-singers' })
    const view = def.getPublicState(state, 'p1', viewCtx(T0, roster)).view
    expect(view['category']).toBe('indian-singers')
    expect(view['categoryLabel']).toBe('Indian Singers')
  })

  it('rejects a category that does not exist', () => {
    expect(() => gameRegistry.get('who-am-i').settingsSchema.parse({ category: 'footballers' })).toThrow()
  })
})

describe('mind meld / the host moves it on', () => {
  const def = gameRegistry.get('mind-meld')

  function intoReveal() {
    const roster = players(4)
    let state: unknown = def.createGame({
      now: T0,
      seed: 'meld',
      players: roster,
      sessionId: 'sess',
      settings: def.settingsSchema.parse({ rounds: 3, seconds: 20 }),
      content: packOf('prompt', 40),
      recentContentIds: [],
    })
    // Into the prompt, everyone answers, then the clock closes the round.
    let now = T0
    for (let i = 0; i < 6 && def.getPhase(state) !== 'PROMPT'; i++) {
      now = def.getDeadline(state) ?? now + 1
      state = def.advance(state, turnCtx(now, roster)).state
    }
    for (const p of roster) {
      state = def.applyAction(state, p.id, { type: 'meld/submit', payload: { answer: 'sleep' } }, turnCtx(now, roster)).state
    }
    now = def.getDeadline(state) ?? now
    state = def.advance(state, turnCtx(now, roster)).state
    expect(def.getPhase(state)).toBe('REVEAL')
    return { state, roster, now }
  }

  it('stops scheduling once the results are up', () => {
    const { state } = intoReveal()
    // No deadline means no timer, which is the whole point: the table talks.
    expect(def.getDeadline(state)).toBeNull()
  })

  it('does not advance on its own, however long it waits', () => {
    const { state, roster, now } = intoReveal()
    const later = def.advance(state, turnCtx(now + 5 * 60_000, roster))
    expect(def.getPhase(later.state)).toBe('REVEAL')
    expect(later.state).toEqual(state)
  })

  it('advances when the host asks', () => {
    const { state, roster, now } = intoReveal()
    const pushed = def.hostAdvance?.(state, turnCtx(now + 1_000, roster))
    expect(pushed).not.toBeNull()
    expect(def.getPhase(pushed!.state)).toBe('COUNTDOWN')
  })

  it('ignores a second press rather than skipping a question', () => {
    const { state, roster, now } = intoReveal()
    const first = def.hostAdvance?.(state, turnCtx(now + 1_000, roster))
    // The button is tapped twice; the second lands on the next countdown.
    const second = def.hostAdvance?.(first!.state, turnCtx(now + 1_100, roster))
    expect(second ?? null).toBeNull()
    expect((first!.state as { roundIndex: number }).roundIndex).toBe(1)
  })

  it('tells the room it is waiting, and whether this was the last one', () => {
    const { state, roster } = intoReveal()
    const view = def.getPublicState(state, 'p1', viewCtx(T0, roster)).view
    expect(view['awaitingHost']).toBe(true)
    expect(view['isLastRound']).toBe(false)
  })

  it('avoids prompts the room used last game', () => {
    const roster = players(3)
    const make = (recent: string[]) =>
      def.createGame({
        now: T0,
        seed: 'meld-rotate',
        players: roster,
        sessionId: 'sess',
        settings: def.settingsSchema.parse({ rounds: 5 }),
        content: packOf('prompt', 40),
        recentContentIds: recent,
      })
    const first = make([])
    const used = def.usedContentIds?.(first) ?? []
    const second = make(used)
    expect((def.usedContentIds?.(second) ?? []).some((id) => used.includes(id))).toBe(false)
  })
})
