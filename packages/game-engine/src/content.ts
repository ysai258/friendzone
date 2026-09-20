/**
 * Content a game needs in order to run a session.
 *
 * The engine never reaches for a database. A definition declares what it wants
 * through `contentRequest`, the server loads it, and `createGame` bakes the
 * chosen items straight into the session state. Two things follow from that:
 * a round never blocks on a query while players are waiting, and re-deriving a
 * session after a restart cannot silently draw different questions.
 */

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

/**
 * Film industries the movie games draw from.
 *
 * Ordered by the audience this is built for — a friend group in India — so
 * Telugu comes first and English last. That ordering sets the default
 * selection, not a restriction: every language can be switched on.
 */
export const MOVIE_LANGUAGES = ['telugu', 'hindi', 'tamil', 'malayalam', 'english'] as const
export type MovieLanguage = (typeof MOVIE_LANGUAGES)[number]

export const MOVIE_LANGUAGE_LABELS: Record<MovieLanguage, string> = {
  telugu: 'Telugu',
  hindi: 'Hindi',
  tamil: 'Tamil',
  malayalam: 'Malayalam',
  english: 'English',
}

export interface Attribution {
  source: string
  sourceUrl: string
  license: string
  licenseUrl: string
  author: string | null
}

interface BaseItem {
  id: string
  difficulty: Exclude<Difficulty, 'mixed'>
  category: string
}

/** Blur Battle: one image, plus the pre-rendered reveal ladder. */
export interface ImageQuestion extends BaseItem {
  kind: 'image'
  title: string
  /** Other spellings judged correct. Never shown before the reveal. */
  aliases: string[]
  /** Blurriest first. Index N is shown once the round is N/(stages) through. */
  stageUrls: string[]
  fullUrl: string
  attribution: Attribution
}

/** Emoji Movie: the clue is the emoji string itself. */
export interface EmojiQuestion extends BaseItem {
  kind: 'emoji'
  emojis: string
  title: string
  aliases: string[]
  year: number | null
  language: MovieLanguage
}

/**
 * Who Am I? categories.
 *
 * A game draws everyone from exactly one of these. Mixing an actor, a singer
 * and a cricketer in the same round makes the yes/no questions useless —
 * "am I an actor?" stops narrowing anything — so the category is chosen once
 * and every identity comes from it.
 */
export const IDENTITY_CATEGORIES = [
  'telugu-actors',
  'telugu-actresses',
  'indian-actors',
  'indian-actresses',
  'indian-cricketers',
  'indian-singers',
  'world-figures',
] as const
export type IdentityCategory = (typeof IDENTITY_CATEGORIES)[number]

export const IDENTITY_CATEGORY_LABELS: Record<IdentityCategory, string> = {
  'telugu-actors': 'Telugu Actors',
  'telugu-actresses': 'Telugu Actresses',
  'indian-actors': 'Indian Actors',
  'indian-actresses': 'Indian Actresses',
  'indian-cricketers': 'Indian Cricketers',
  'indian-singers': 'Indian Singers',
  'world-figures': 'World Figures',
}

/** Who Am I?: the secret pinned to a player's forehead. */
export interface IdentityCard extends BaseItem {
  kind: 'identity'
  name: string
  aliases: string[]
  /** Progressively more revealing; drip-fed when a round stalls. */
  hints: string[]
}

/** Mind Meld: a prompt with no right answer, only agreement. */
export interface MeldPrompt extends BaseItem {
  kind: 'prompt'
  prompt: string
}

/** Movie Mafia: fans get `fanClue`, the imposter gets `imposterClue`. */
export interface MafiaSubject extends BaseItem {
  kind: 'mafia'
  title: string
  fanClue: string
  imposterClue: string
  language: MovieLanguage
}

export type ContentItem = ImageQuestion | EmojiQuestion | IdentityCard | MeldPrompt | MafiaSubject
export type ContentKind = ContentItem['kind']

export interface ContentRequest {
  kind: ContentKind
  /** How large a pool the game would like, for variety across repeat plays. */
  count: number
  /**
   * How large a pool the game genuinely cannot play without. Only meaningful
   * with `strict`, and defaults to `count`. Who Am I? wants forty people so a
   * room can play a category several times without seeing a repeat, but it is
   * only actually unplayable below one person per seat — asking for headroom
   * should not turn a perfectly good category into an error.
   */
  minimum?: number
  difficulty: Difficulty
  category: string | null
  /** Film industries to draw from. Ignored by kinds that are not movies. */
  languages?: MovieLanguage[]
  /**
   * Items this room has seen recently. Excluded while enough others remain,
   * which is what stops the same film turning up three evenings running.
   */
  excludeIds?: string[]
  /**
   * Refuse rather than widen when the filter leaves too little.
   *
   * Who Am I? needs this: a game where four players share a category and the
   * fifth is a cricketer is broken, so an under-filled category must fail
   * loudly. The movie games do not — a thin language selection is better
   * served by a wider pool than by an error.
   */
  strict?: boolean
}

export interface ContentPack {
  kind: ContentKind
  items: ContentItem[]
  /** True when the filter had to be widened to fill the request, so a game can
   *  say so rather than silently serving something nobody asked for. */
  widened?: boolean
}

/** Every movie language present in a pack. For reporting and tests. */
export function languagesIn(items: readonly ContentItem[]): MovieLanguage[] {
  const seen = new Set<MovieLanguage>()
  for (const item of items) {
    if (item.kind === 'emoji' || item.kind === 'mafia') seen.add(item.language)
  }
  return [...seen]
}

/** Narrowing helpers; a definition asserts the kind it asked for. */
export function expectItems<K extends ContentKind>(
  pack: ContentPack,
  kind: K,
): Extract<ContentItem, { kind: K }>[] {
  if (pack.kind !== kind) {
    throw new Error(`content pack mismatch: wanted ${kind}, received ${pack.kind}`)
  }
  return pack.items as Extract<ContentItem, { kind: K }>[]
}
