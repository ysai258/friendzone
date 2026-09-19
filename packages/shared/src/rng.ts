/**
 * Deterministic randomness for the game reducers.
 *
 * Reducers must be pure so the same room state plus the same action always
 * produces the same next state — that is what makes a transition replayable in
 * a test and reproducible when a round is re-derived after a server restart.
 * Math.random would break that, so every draw is derived from the room's stored
 * seed plus a label describing what is being drawn. There is no mutable
 * generator to persist: the same (seed, label) always rebuilds the same stream.
 */

/** xmur3: string -> well-mixed 32-bit seed. */
function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  h ^= h >>> 16
  return h >>> 0
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  /** Fisher-Yates on a copy; the input array is untouched. */
  shuffle<T>(items: readonly T[]): T[]
  /** `count` distinct items, or all of them when the pool is smaller. */
  sample<T>(items: readonly T[], count: number): T[]
}

/** mulberry32 — 32-bit state, good distribution, no dependencies. */
export function createRng(seed: string, ...labels: (string | number)[]): Rng {
  let state = hashSeed(labels.length > 0 ? `${seed}:${labels.join(':')}` : seed)

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`rng.int: empty range ${min}..${max}`)
    return min + Math.floor(next() * (max - min + 1))
  }

  const pick = <T,>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('rng.pick: empty array')
    return items[int(0, items.length - 1)] as T
  }

  const shuffle = <T,>(items: readonly T[]): T[] => {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i)
      const a = out[i] as T
      out[i] = out[j] as T
      out[j] = a
    }
    return out
  }

  const sample = <T,>(items: readonly T[], count: number): T[] =>
    shuffle(items).slice(0, Math.max(0, Math.min(count, items.length)))

  return { next, int, pick, shuffle, sample }
}

/** Cryptographically random seed for a new room, created once at room birth. */
export function randomSeed(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
