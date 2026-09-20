import { z } from 'zod'
import {
  accept,
  createRng,
  matchAnswer,
  reject,
  type GamePublicState,
  type PlayerId,
  type Result,
  type SettingField,
} from '@friendzone/shared'
import {
  expectItems,
  MOVIE_LANGUAGES,
  MOVIE_LANGUAGE_LABELS,
  type ContentRequest,
  type EmojiQuestion,
  type MovieLanguage,
} from '../content.ts'
import { pickFresh } from '../selection.ts'
import { placementBonus, speedScore } from '../scoring.ts'
import {
  defineGame,
  noChange,
  transition,
  type CreateContext,
  type ErasedGameDefinition,
  type GameAction,
  type Transition,
  type ViewContext,
} from '../types.ts'

/**
 * Emoji Movie.
 *
 * A film rendered as emoji; type the title. Unlike Blur Battle this is an open
 * race — wrong answers cost you nothing but the clock, so you keep firing.
 *
 * That freedom is exactly what has to be fenced in. Two limits do it, both
 * enforced in the reducer rather than only at the transport:
 *
 *  - a per-player cooldown between attempts, so a script gains nothing a fast
 *    typist could not manage
 *  - a hard cap on attempts per round, so nobody can brute-force a title
 *
 * A repeated identical guess is also swallowed silently: it neither burns an
 * attempt nor restarts the cooldown, so a double-tap on mobile is harmless.
 */

const COUNTDOWN_MS = 3_000
const REVEAL_MS = 6_000
const GUESS_COOLDOWN_MS = 1_200
const MAX_ATTEMPTS = 8

type Phase = 'COUNTDOWN' | 'QUESTION' | 'REVEAL' | 'FINISHED'

interface Attempt {
  guess: string
  at: number
}

interface PlayerRound {
  attempts: Attempt[]
  lastAt: number
  solvedAt: number | null
  points: number
  place: number | null
}

interface EmojiState {
  sessionId: string
  phase: Phase
  roundIndex: number
  questions: EmojiQuestion[]
  phaseStartedAt: number
  phaseEndsAt: number
  rounds: Record<PlayerId, PlayerRound>
  solvedCount: number
  questionSeconds: number
}

/** Telugu and Hindi on by default: this is built for a friend group in India,
 *  and an English-first pool was the thing that made it feel like someone
 *  else's game. Every language can be switched on. */
const DEFAULT_LANGUAGES: MovieLanguage[] = ['telugu', 'hindi']

const settingsSchema = z.strictObject({
  questions: z.int().min(3).max(15).default(6),
  seconds: z.int().min(15).max(90).default(30),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
  languages: z
    .array(z.enum(MOVIE_LANGUAGES))
    .default(DEFAULT_LANGUAGES)
    // An empty selection is a slip, not a request for an empty pool.
    .transform((values) => (values.length === 0 ? DEFAULT_LANGUAGES : [...new Set(values)])),
})

type EmojiSettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'questions', label: 'Movies', kind: 'int', min: 3, max: 15, step: 1, default: 6 },
  { key: 'seconds', label: 'Time per movie', kind: 'int', min: 15, max: 90, step: 5, default: 30, unit: 's' },
  {
    key: 'languages',
    label: 'Movie languages',
    help: 'Pick as many as you like.',
    kind: 'multi',
    default: DEFAULT_LANGUAGES,
    options: MOVIE_LANGUAGES.map((value) => ({ value, label: MOVIE_LANGUAGE_LABELS[value] })),
  },
  {
    key: 'difficulty',
    label: 'Difficulty',
    kind: 'choice',
    default: 'mixed',
    options: [
      { value: 'easy', label: 'Easy' },
      { value: 'medium', label: 'Medium' },
      { value: 'hard', label: 'Hard' },
      { value: 'mixed', label: 'Mixed' },
    ],
  },
]

const actionSchema = z.strictObject({
  type: z.literal('emoji/guess'),
  payload: z.strictObject({ guess: z.string().min(1).max(80) }),
})

function parseGuess(action: GameAction): string | null {
  const parsed = actionSchema.safeParse(action)
  return parsed.success ? parsed.data.payload.guess : null
}

const EMPTY_ROUND: PlayerRound = { attempts: [], lastAt: 0, solvedAt: null, points: 0, place: null }

function currentQuestion(state: EmojiState): EmojiQuestion | null {
  return state.questions[state.roundIndex] ?? null
}

function roundFor(state: EmojiState, playerId: PlayerId): PlayerRound {
  return state.rounds[playerId] ?? EMPTY_ROUND
}

function activeIds(ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  return ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id)
}

function validate(state: EmojiState, playerId: PlayerId, action: GameAction, now: number): Result<void> {
  if (parseGuess(action) === null) return reject('INVALID_ACTION')
  if (state.phase !== 'QUESTION') return reject('ROUND_CLOSED')
  if (currentQuestion(state) === null) return reject('INVALID_ROUND')

  const mine = roundFor(state, playerId)
  if (mine.solvedAt !== null) return reject('ALREADY_ANSWERED')
  if (mine.attempts.length >= MAX_ATTEMPTS) return reject('INVALID_ACTION', 'Out of guesses for this one.')
  if (now - mine.lastAt < GUESS_COOLDOWN_MS) return reject('RATE_LIMITED', 'Take a breath.')
  return accept
}

function startCountdown(state: EmojiState, now: number): EmojiState {
  return { ...state, phase: 'COUNTDOWN', phaseStartedAt: now, phaseEndsAt: now + COUNTDOWN_MS, rounds: {}, solvedCount: 0 }
}

// ---------------------------------------------------------------------------

export const emojiMovie: ErasedGameDefinition = defineGame<EmojiState, EmojiSettings>({
  id: 'emoji-movie',
  meta: {
    name: 'Emoji Movie',
    tagline: 'Three emoji. One film. Go.',
    description:
      'A movie squeezed into a handful of emoji. Everyone types at once and the clock pays the quick — wrong guesses only cost you the seconds you spent on them.',
    emoji: '🎬',
    accent: 'rose',
    estimatedMinutes: 5,
    playable: true,
  },
  minPlayers: 1,
  maxPlayers: 12,
  settingsSpec,
  settingsSchema,
  actionSchema,

  contentRequest: (settings): ContentRequest => ({
    kind: 'emoji',
    // Ask for far more than one game needs. The pool that comes back is what
    // the draw avoids repeating from, so a wider pool means fresher rounds.
    count: Math.max(settings.questions * 8, 60),
    difficulty: settings.difficulty,
    category: null,
    languages: settings.languages,
  }),

  createGame(ctx: CreateContext<EmojiSettings>): EmojiState {
    const pool = expectItems(ctx.content, 'emoji')
    const rng = createRng(ctx.seed, 'emoji-movie', ctx.sessionId)
    // The room passes what it has already dealt; those go to the back of the
    // queue rather than being drawn again.
    const drawn = pickFresh(pool, { count: ctx.settings.questions, recentIds: ctx.recentContentIds, rng })
    return {
      sessionId: ctx.sessionId,
      phase: 'COUNTDOWN',
      roundIndex: 0,
      questions: drawn.items,
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + COUNTDOWN_MS,
      rounds: {},
      solvedCount: 0,
      questionSeconds: ctx.settings.seconds,
    }
  },

  getDeadline: (state) => (state.phase === 'FINISHED' ? null : state.phaseEndsAt),
  getPhase: (state) => state.phase,
  isGameOver: (state) => state.phase === 'FINISHED',
  usedContentIds: (state) => state.questions.map((q) => q.id),

  validateAction: (state, playerId, action, ctx) => validate(state, playerId, action, ctx.now),

  applyAction(state, playerId, action, ctx): Transition<EmojiState> {
    const raw = parseGuess(action)
    const question = currentQuestion(state)
    if (raw === null || question === null) return noChange(state)

    const mine = roundFor(state, playerId)

    // A repeat of the guess just sent is a double-tap, not a new attempt.
    // Swallow it: no attempt burned, no cooldown restarted, no event.
    if (mine.attempts.at(-1)?.guess === raw) return noChange(state)

    if (!validate(state, playerId, action, ctx.now).ok) return noChange(state)

    const match = matchAnswer(raw, [question.title, ...question.aliases])
    const attempts = [...mine.attempts, { guess: raw, at: ctx.now }]

    if (!match.correct) {
      return transition(
        { ...state, rounds: { ...state.rounds, [playerId]: { ...mine, attempts, lastAt: ctx.now } } },
        [{ type: 'PLAYER_ANSWERED', data: { playerId, correct: false } }],
      )
    }

    const place = state.solvedCount + 1
    const points =
      speedScore({ startedAt: state.phaseStartedAt, endsAt: state.phaseEndsAt, answeredAt: ctx.now }) +
      placementBonus(place)

    let next: EmojiState = {
      ...state,
      solvedCount: place,
      rounds: {
        ...state.rounds,
        [playerId]: { ...mine, attempts, lastAt: ctx.now, solvedAt: ctx.now, points, place },
      },
    }

    const everyone = activeIds(ctx)
    if (everyone.length > 0 && everyone.every((id) => roundFor(next, id).solvedAt !== null)) {
      next = { ...next, phaseEndsAt: Math.min(next.phaseEndsAt, ctx.now) }
    }

    return transition(next, [{ type: 'PLAYER_SCORED', data: { playerId, points, place } }], { [playerId]: points })
  },

  advance(state, ctx) {
    switch (state.phase) {
      case 'COUNTDOWN': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        return transition(
          {
            ...state,
            phase: 'QUESTION',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + state.questionSeconds * 1000,
            rounds: {},
            solvedCount: 0,
          },
          [{ type: 'ROUND_STARTED', data: { round: state.roundIndex + 1, total: state.questions.length } }],
        )
      }
      case 'QUESTION': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        return transition(
          { ...state, phase: 'REVEAL', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt + REVEAL_MS },
          [{ type: 'ROUND_ENDED', data: { round: state.roundIndex + 1 } }],
        )
      }
      case 'REVEAL': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        if (state.roundIndex + 1 >= state.questions.length) {
          return transition(
            { ...state, phase: 'FINISHED', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt },
            [{ type: 'GAME_COMPLETED', data: { rounds: state.questions.length } }],
          )
        }
        return transition(startCountdown({ ...state, roundIndex: state.roundIndex + 1 }, state.phaseEndsAt), [])
      }
      case 'FINISHED':
        return noChange(state)
    }
  },

  onPlayerInactive(state, _playerId, ctx) {
    if (state.phase !== 'QUESTION') return noChange(state)
    const everyone = activeIds(ctx)
    if (everyone.length === 0 || !everyone.every((id) => roundFor(state, id).solvedAt !== null)) return noChange(state)
    return transition({ ...state, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now) })
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    const question = currentQuestion(state)
    const mine = viewerId === null ? undefined : state.rounds[viewerId]

    const view: Record<string, unknown> = {
      emojis: question?.emojis ?? '',
      solvedPlayerIds: Object.entries(state.rounds)
        .filter(([, r]) => r.solvedAt !== null)
        .map(([id]) => id),
      activeCount: activeIds(ctx).length,
      maxAttempts: MAX_ATTEMPTS,
      cooldownMs: GUESS_COOLDOWN_MS,
    }

    if (state.phase === 'REVEAL' || state.phase === 'FINISHED') {
      if (question !== null) {
        view['answer'] = question.title
        view['year'] = question.year
        view['language'] = question.language
        // The label travels with the view: the web app depends on `shared`
        // only, and a reveal that says "Telugu" is how a room sees the
        // language filter actually working.
        view['languageLabel'] = MOVIE_LANGUAGE_LABELS[question.language]
      }
      view['results'] = Object.entries(state.rounds)
        .map(([playerId, r]) => ({
          playerId,
          solved: r.solvedAt !== null,
          points: r.points,
          place: r.place,
          attempts: r.attempts.length,
          // Everyone's near-misses are half the fun, but only after the round.
          lastGuess: r.attempts.at(-1)?.guess ?? null,
        }))
        .sort((a, b) => b.points - a.points)
    }

    if (mine !== undefined) {
      // A player's own attempt history, and nobody else's.
      view['yourAttempts'] = mine.attempts.map((a) => a.guess)
      view['yourSolved'] = mine.solvedAt !== null
      view['yourPoints'] = mine.points
      view['nextGuessAt'] = mine.lastAt === 0 ? 0 : mine.lastAt + GUESS_COOLDOWN_MS
    }

    return {
      gameId: 'emoji-movie',
      sessionId: state.sessionId,
      phase: state.phase,
      roundNumber: state.roundIndex + 1,
      totalRounds: state.questions.length,
      view,
    }
  },
})
