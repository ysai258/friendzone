import type { Rng } from '@friendzone/shared'
import type { ContentItem } from './content.ts'

/**
 * Picking content without repeating yourself.
 *
 * Three games draw from a pool every round, and the complaint this solves is
 * specific: after a few evenings the same films and prompts keep coming back.
 * Plain random sampling does that — with sixty items and six per game, a
 * repeat inside two games is more likely than not.
 *
 * The rule here is: prefer what this room has not seen, and only fall back to
 * what it has when there is genuinely not enough left. The room's history
 * lives in its stored state, so it survives a reconnect and carries across
 * games in the same room.
 */

export interface PickOptions {
  /** How many distinct items the game needs. */
  count: number
  /** Ids this room has seen recently, newest last. */
  recentIds?: readonly string[]
  rng: Rng
}

export interface PickResult<T> {
  items: T[]
  /** True when history had to be ignored because too little was left. */
  reusedRecent: boolean
}

/**
 * Draw `count` distinct items, preferring ones absent from `recentIds`.
 *
 * Unseen items are drawn first, in shuffled order. If they run out, the
 * shortfall is topped up from the seen ones — oldest first, so the film you
 * played last night is the last to come back.
 */
export function pickFresh<T extends { id: string }>(pool: readonly T[], options: PickOptions): PickResult<T> {
  const { count, rng } = options
  const recent = options.recentIds ?? []

  if (pool.length === 0) return { items: [], reusedRecent: false }

  const recentRank = new Map<string, number>()
  recent.forEach((id, index) => recentRank.set(id, index))

  const unseen = pool.filter((item) => !recentRank.has(item.id))
  const seen = pool.filter((item) => recentRank.has(item.id))

  const chosen = rng.shuffle(unseen).slice(0, count)
  if (chosen.length >= count) return { items: chosen, reusedRecent: false }

  // Not enough unseen. Top up from what was seen longest ago — a lower rank in
  // `recent` means it was recorded earlier, so it is the stalest.
  const stalestFirst = [...seen].sort(
    (a, b) => (recentRank.get(a.id) ?? 0) - (recentRank.get(b.id) ?? 0),
  )
  const topUp = stalestFirst.slice(0, count - chosen.length)

  return { items: rng.shuffle([...chosen, ...topUp]), reusedRecent: topUp.length > 0 }
}

/**
 * Fold newly used ids into a room's history, newest last and bounded.
 *
 * The bound matters twice over: the history is part of the room state that is
 * read and written on every action, and an unbounded list would eventually
 * exclude the entire pool and defeat itself.
 */
export function rememberUsed(
  previous: readonly string[] | undefined,
  used: readonly string[],
  limit: number,
): string[] {
  const next = [...(previous ?? []).filter((id) => !used.includes(id)), ...used]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * How much history to keep per content kind.
 *
 * Roughly a few games' worth. Large enough that consecutive evenings feel
 * different, small enough to leave most of the pool eligible — remembering
 * everything would force a reuse every game once the pool was exhausted, which
 * is the behaviour this exists to avoid.
 */
export const RECENT_LIMITS: Record<ContentItem['kind'], number> = {
  emoji: 60,
  mafia: 30,
  prompt: 80,
  identity: 40,
  image: 60,
}
