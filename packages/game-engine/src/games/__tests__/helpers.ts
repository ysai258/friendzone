import type { ContentPack, ImageQuestion } from '../../content.ts'
import type { EnginePlayer, TurnContext, ViewContext } from '../../types.ts'

export const T0 = 1_700_000_000_000

export function players(count: number, overrides: Partial<EnginePlayer>[] = []): EnginePlayer[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    joinSeq: i + 1,
    presence: 'CONNECTED' as const,
    ...overrides[i],
  }))
}

/** The first seat is the host, as it is in a real room. */
const hostOf = (roster: EnginePlayer[]): string => roster[0]?.id ?? 'p1'

export function turnCtx(now: number, roster: EnginePlayer[], actionId?: string): TurnContext {
  const base = { now, seed: 'test-seed', players: roster, hostId: hostOf(roster) }
  return actionId === undefined ? base : { ...base, actionId }
}

export function viewCtx(now: number, roster: EnginePlayer[]): ViewContext {
  return { now, seed: 'test-seed', players: roster, roomCode: 'TEST1', hostId: hostOf(roster) }
}

/** Deliberately unlike one another: titles a single edit apart would be judged
 *  interchangeable by the typo allowance, which is right for real answers and
 *  useless for a fixture. */
const FIXTURE_TITLES = [
  'Eiffel Tower', 'Blue Whale', 'Sunflowers', 'Great Barrier Reef', 'Machu Picchu',
  'Red Panda', 'Taj Mahal', 'Mount Fuji', 'Colosseum', 'Golden Gate Bridge',
  'Sagrada Familia', 'Pyramid of Giza', 'Angkor Wat', 'Stonehenge', 'Petra',
]

export function fixtureTitle(n: number): string {
  return FIXTURE_TITLES[(n - 1) % FIXTURE_TITLES.length] as string
}

export function imageQuestion(n: number, over: Partial<ImageQuestion> = {}): ImageQuestion {
  const title = fixtureTitle(n)
  return {
    kind: 'image',
    id: `img-${n}`,
    title,
    aliases: [`${title} (alt)`],
    category: 'landmark',
    difficulty: 'medium',
    stageUrls: [1, 2, 3, 4, 5].map((s) => `/content/img-${n}-s${s}.webp`),
    fullUrl: `/content/img-${n}-full.webp`,
    attribution: {
      source: 'Wikimedia Commons',
      sourceUrl: 'https://commons.wikimedia.org/',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      author: 'Someone',
    },
    ...over,
  }
}

export function imagePack(count: number): ContentPack {
  return { kind: 'image', items: Array.from({ length: count }, (_, i) => imageQuestion(i + 1)) }
}

/**
 * Drive a definition the way the room service does: advance repeatedly while
 * the deadline is in the past. Mirrors the real loop so a test exercises the
 * same chaining behaviour rather than a simplified version of it.
 */
export function settle<S>(
  def: { advance: (s: S, c: TurnContext) => { state: S }; getDeadline: (s: S) => number | null },
  state: S,
  now: number,
  roster: EnginePlayer[],
): S {
  let current = state
  for (let i = 0; i < 32; i++) {
    const deadline = def.getDeadline(current)
    if (deadline === null || deadline > now) return current
    current = def.advance(current, turnCtx(now, roster)).state
  }
  throw new Error('settle: deadline never moved past now')
}

// --- content packs for the other games --------------------------------------

import type { ContentItem, EmojiQuestion, IdentityCard, MafiaSubject, MeldPrompt, MovieLanguage } from '../../content.ts'

const EMOJI_TITLES = [
  ['Jurassic Park', '🦕 🏝️ 🚙'],
  ['Finding Nemo', '🐠 🔍 🌊'],
  ['The Lion King', '🦁 👑 🌅'],
  ['Titanic', '🚢 🧊 💔'],
  ['Home Alone', '🏠 😱 👦'],
  ['Up', '🏠 🎈 👴'],
  ['Frozen', '❄️ 👭 ⛄'],
  ['Inception', '🌀 💤 🏙️'],
  ['Gravity', '🚀 👩‍🚀 🌍'],
  ['Jaws', '🦈 🏖️ 🩸'],
]

export function emojiQuestion(n: number, over: Partial<EmojiQuestion> = {}): EmojiQuestion {
  const entry = EMOJI_TITLES[(n - 1) % EMOJI_TITLES.length] as [string, string]
  return {
    kind: 'emoji',
    id: `emoji-${n}`,
    title: entry[0],
    aliases: [],
    emojis: entry[1],
    year: 1990 + n,
    category: 'film',
    difficulty: 'medium',
    language: FIXTURE_LANGUAGES[(n - 1) % FIXTURE_LANGUAGES.length] as MovieLanguage,
    ...over,
  }
}

/** Cycled through the fixtures so a language filter has something to select. */
const FIXTURE_LANGUAGES = ['telugu', 'hindi', 'tamil', 'malayalam', 'english'] as const

const IDENTITY_NAMES = [
  'Cleopatra', 'Serena Williams', 'Sherlock Holmes', 'Marie Curie', 'Bruce Wayne',
  'Frida Kahlo', 'Darth Vader', 'Ada Lovelace', 'James Bond', 'Rani Lakshmibai',
  'Hermione Granger', 'Nelson Mandela',
]

export function identityCard(n: number, over: Partial<IdentityCard> = {}): IdentityCard {
  // One id, one person — as in the real dataset. Cycling a short list would
  // hand two players the same name and hide a genuine duplicate bug.
  const base = IDENTITY_NAMES[(n - 1) % IDENTITY_NAMES.length] as string
  const round = Math.floor((n - 1) / IDENTITY_NAMES.length)
  const name = round === 0 ? base : `${base} ${'I'.repeat(round + 1)}`
  return {
    kind: 'identity',
    id: `id-${n}`,
    name,
    aliases: [],
    hints: [`Hint one about ${n}`, `Hint two about ${n}`, `Hint three about ${n}`],
    category: 'people',
    difficulty: 'medium',
    ...over,
  }
}

export function meldPrompt(n: number, over: Partial<MeldPrompt> = {}): MeldPrompt {
  return {
    kind: 'prompt',
    id: `prompt-${n}`,
    prompt: `Name something people do on a Sunday (${n}).`,
    category: 'everyday',
    difficulty: 'easy',
    ...over,
  }
}

export function mafiaSubject(n: number, over: Partial<MafiaSubject> = {}): MafiaSubject {
  return {
    kind: 'mafia',
    id: `mafia-${n}`,
    title: `Secret Film ${n}`,
    fanClue: `FANCLUE${n}: a heist goes wrong in the rain.`,
    imposterClue: `IMPOSTERCLUE${n}: something happens outdoors.`,
    category: 'film',
    difficulty: 'medium',
    language: FIXTURE_LANGUAGES[(n - 1) % FIXTURE_LANGUAGES.length] as MovieLanguage,
    ...over,
  }
}

export function packOf(kind: ContentItem['kind'], count: number) {
  const build = {
    image: imageQuestion,
    emoji: emojiQuestion,
    identity: identityCard,
    prompt: meldPrompt,
    mafia: mafiaSubject,
  }[kind]
  return { kind, items: Array.from({ length: count }, (_, i) => build(i + 1)) as ContentItem[] }
}
