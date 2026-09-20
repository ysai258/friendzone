/**
 * Answer comparison. Shared between the game reducers and the content pipeline
 * so a dataset is validated with exactly the rules that will later judge a
 * player's typing.
 */

import { SYNONYM_GROUPS } from './synonyms.ts'

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
 * known truth, so "sleeping" and "sleep" must land together — and so must
 * "phone" and "mobile", which is what SYNONYM_GROUPS is for.
 *
 * Exact match on this key, never a fuzzy comparison. Clustering by edit
 * distance is not transitive — A near B and B near C does not make A near C —
 * so the groups would depend on the order answers arrived in, and the same
 * round would score differently on a replay. A key is order-independent, which
 * is what lets the reducer stay pure.
 */
export function meldKey(input: string): string {
  const base = normalizeAnswer(input)
  if (base.length === 0) return ''

  const words = base
    .split(' ')
    .map(stem)
    .filter((w) => w.length > 0)
    .map((w) => WORD_SYNONYMS.get(w) ?? w)

  // Deduplicated because a synonym can collapse two words into one: "mobile
  // phone" becomes phone twice, and must key the same as "phone".
  const key = [...new Set(words)].sort().join(' ')
  return PHRASE_SYNONYMS.get(key) ?? key
}

/**
 * Crude suffix stripper, then a fold that makes the endings consistent.
 *
 * The fold is the part that matters. Stripping alone left "movie" and "movies"
 * in different groups (-ies became -y, so "movy"), and "phone" and "phones" in
 * different groups (the doubled-letter rule ate the wrong letter). Folding a
 * trailing "y" to "i" and dropping a trailing "e" afterwards puts every form of
 * a word on the same key: movie/movies -> movi, city/cities -> citi,
 * phone/phones -> phon.
 */
function stem(word: string): string {
  let w = word
  if (w.length > 3) {
    for (const suffix of ['ing', 'ies', 'es', 'ed', 's']) {
      if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
        w = w.slice(0, w.length - suffix.length)
        if (suffix === 'ies') w += 'y'
        break
      }
    }
  }
  return fold(w)
}

function fold(word: string): string {
  let w = word
  if (w.length <= 3) return w
  if (w.endsWith('y')) w = `${w.slice(0, -1)}i`
  // Every trailing e, not just one: the -es rule takes two characters off
  // "coffees" and the -s rule takes one off "coffee", and both have to land in
  // the same place.
  else while (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  // "runn" -> "run": the stripper leaves a doubled consonant behind.
  if (w.length > 3 && w.at(-1) === w.at(-2)) w = w.slice(0, -1)
  return w
}

/** A single word folded the way meldKey folds it, with no synonym applied. */
function plainKey(raw: string): string {
  return [
    ...new Set(
      normalizeAnswer(raw)
        .split(' ')
        .map(stem)
        .filter((w) => w.length > 0),
    ),
  ]
    .sort()
    .join(' ')
}

/**
 * The synonym groups, indexed for lookup: one-word variants by their stem,
 * several-word variants by the key their words produce ("air conditioner" ->
 * "air condition"), both pointing at their group's first entry.
 */
const WORD_SYNONYMS = new Map<string, string>()
const PHRASE_SYNONYMS = new Map<string, string>()
for (const group of SYNONYM_GROUPS) {
  const canonical = plainKey(group[0] ?? '')
  if (canonical.length === 0) continue
  for (const variant of group) {
    const key = plainKey(variant)
    if (key.length === 0 || key === canonical) continue
    if (key.includes(' ')) PHRASE_SYNONYMS.set(key, canonical)
    else WORD_SYNONYMS.set(key, canonical)
  }
}
