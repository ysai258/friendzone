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
}

export type ContentItem = ImageQuestion | EmojiQuestion | IdentityCard | MeldPrompt | MafiaSubject
export type ContentKind = ContentItem['kind']

export interface ContentRequest {
  kind: ContentKind
  count: number
  difficulty: Difficulty
  category: string | null
}

export interface ContentPack {
  kind: ContentKind
  items: ContentItem[]
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
