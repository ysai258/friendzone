/**
 * Answer comparison. Shared between the game reducers and the content pipeline
 * so a dataset is validated with exactly the rules that will later judge a
 * player's typing.
 */

const ARTICLES = /^(the|a|an)\s+/

/**
 * Fold a free-text answer to its comparison form: unaccented lowercase letters
 * and digits, single-spaced, leading article removed.
 *
 *   "  Thé   Dark-Knight!! " -> "dark knight"
 */
export function normalizeAnswer(input: string): string {
  let s = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Applied once: "the the wall" is a different title from "the wall".
  s = s.replace(ARTICLES, '')
  return s
}

/** Levenshtein distance, capped so a hopeless comparison exits early. */
export function editDistance(a: string, b: string, max = 4): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const v = Math.min((curr[j - 1] as number) + 1, (prev[j] as number) + 1, (prev[j - 1] as number) + cost)
      curr[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] as number
  }
  return prev[b.length] as number
}

/**
 * How many typos to forgive. Short answers get none — at four characters a
 * single edit turns one real title into another. The allowance grows with
 * length, where a slip is far more likely than a different correct answer.
 */
export function typoAllowance(length: number): number {
  if (length <= 4) return 0
  if (length <= 8) return 1
  if (length <= 14) return 2
  return 3
}

export interface AnswerMatch {
  correct: boolean
  /** Which accepted form matched, for the reveal screen. */
  matched: string | null
  exact: boolean
}

/**
 * Judge a guess against a title and its accepted aliases. Aliases exist because
 * one film is legitimately "RRR", "Rise Roar Revolt" and "Roudram Ranam Rudhiram".
 */
export function matchAnswer(guess: string, accepted: readonly string[]): AnswerMatch {
  const g = normalizeAnswer(guess)
  if (g.length === 0) return { correct: false, matched: null, exact: false }

  for (const candidate of accepted) {
    if (normalizeAnswer(candidate) === g) return { correct: true, matched: candidate, exact: true }
  }
  for (const candidate of accepted) {
    const c = normalizeAnswer(candidate)
    if (c.length === 0) continue
    if (editDistance(g, c, typoAllowance(c.length)) <= typoAllowance(c.length)) {
      return { correct: true, matched: candidate, exact: false }
    }
  }
  return { correct: false, matched: null, exact: false }
}

/**
 * Bucket free-text answers that mean the same thing, for Mind Meld. Looser than
 * matchAnswer: here we are clustering players against each other, not against a
 * known truth, so "sleeping" and "sleep" must land together.
 */
export function meldKey(input: string): string {
  const base = normalizeAnswer(input)
  if (base.length === 0) return ''
  return base
    .split(' ')
    .map(stem)
    .filter((w) => w.length > 0)
    .sort()
    .join(' ')
}

/** Crude suffix stripper. Enough to merge plurals and gerunds; no more. */
function stem(word: string): string {
  if (word.length <= 3) return word
  for (const suffix of ['ing', 'ies', 'es', 'ed', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      let base = word.slice(0, word.length - suffix.length)
      if (suffix === 'ies') base += 'y'
      // "sleeping" -> "sleep", but "running" -> "runn" -> "run"
      if (base.length > 3 && base.at(-1) === base.at(-2)) base = base.slice(0, -1)
      return base
    }
  }
  return word
}
