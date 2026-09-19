/**
 * Speed scoring, shared by every timed game.
 *
 * The design goal is that answering early is worth real money without making a
 * late correct answer feel pointless. Three constants do that:
 *
 *   BASE_POINTS   a correct answer at t=0 is worth this
 *   FLOOR_FACTOR  a correct answer on the final tick still earns this share
 *   CURVE         >1 bends the payout toward the opening seconds
 *
 * In Blur Battle the same elapsed fraction also drives how much of the image
 * has been revealed, so the risk and the reward are literally the same number:
 * guessing through heavy blur pays more because less time has passed. There is
 * no separate "blur bonus" to keep in sync.
 *
 *   elapsed   0%    25%   50%   75%   100%
 *   points   1000   734   497   332    250
 */

export const BASE_POINTS = 1000
export const FLOOR_FACTOR = 0.25
export const CURVE = 1.6

export interface SpeedScoreInput {
  /** When the round's clock started, epoch ms. */
  startedAt: number
  /** When it ends, epoch ms. */
  endsAt: number
  /** Server receive time of the answer, epoch ms. Never a client timestamp. */
  answeredAt: number
  /** Multiplier for games that weight rounds differently. Defaults to 1. */
  weight?: number
}

/**
 * Points for a correct answer. `answeredAt` is stamped by the server when the
 * frame arrives, so a client cannot claim to have answered sooner than it did;
 * the worst it can do is lie in its own favour about latency it did not have.
 */
export function speedScore({ startedAt, endsAt, answeredAt, weight = 1 }: SpeedScoreInput): number {
  const span = endsAt - startedAt
  if (span <= 0) return Math.round(BASE_POINTS * weight)
  const elapsed = clamp((answeredAt - startedAt) / span, 0, 1)
  const factor = FLOOR_FACTOR + (1 - FLOOR_FACTOR) * Math.pow(1 - elapsed, CURVE)
  return Math.round(BASE_POINTS * factor * weight)
}

/**
 * Bonus for being first to a correct answer, shaded by how many people got it.
 * Keeps a lobby of eight from turning into a race only the fastest typist wins:
 * the edge is real but small next to the speed curve above.
 */
export function placementBonus(place: number): number {
  if (place === 1) return 150
  if (place === 2) return 75
  if (place === 3) return 25
  return 0
}

/**
 * Mind Meld pays for agreement, not speed. A player earns for every other
 * player who landed on the same answer, so a four-way match is worth more per
 * head than a pair, and a unique answer earns nothing.
 */
export function meldScore(groupSize: number, totalAnswers: number): number {
  if (groupSize < 2) return 0
  const share = totalAnswers > 0 ? groupSize / totalAnswers : 0
  return Math.round(BASE_POINTS * (0.35 + 0.65 * share))
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Rank a score map, dense-ranking ties to the same place. */
export function rankScores(scores: Record<string, number>): { playerId: string; score: number; rank: number }[] {
  const entries = Object.entries(scores)
    .map(([playerId, score]) => ({ playerId, score }))
    .sort((a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId))

  let rank = 0
  let lastScore = Number.NaN
  return entries.map((entry, index) => {
    if (entry.score !== lastScore) {
      rank = index + 1
      lastScore = entry.score
    }
    return { ...entry, rank }
  })
}
