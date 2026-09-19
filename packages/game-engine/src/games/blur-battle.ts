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
import { expectItems, type ContentRequest, type ImageQuestion } from '../content.ts'
import { placementBonus, speedScore } from '../scoring.ts'
import {
  defineGame,
  noChange,
  transition,
  type CreateContext,
  type EngineEvent,
  type ErasedGameDefinition,
  type GameAction,
  type ViewContext,
} from '../types.ts'

/**
 * Blur Battle.
 *
 * An image is revealed in steps across the round; the first person to name it
 * wins the most points. The round's elapsed fraction drives both how much of
 * the picture is visible and what a correct answer pays, so "guess early
 * through the blur" is the same lever as "score more" — there is no second
 * bonus to balance.
 *
 * Two rules keep it honest:
 *
 *  - Only the stages already unlocked are sent. A clear image is the answer, so
 *    shipping the whole ladder up front and blurring it in CSS would put the
 *    answer one devtools panel away. Each unlock is a server transition.
 *  - One guess per round. That removes any value in machine-gunning submissions
 *    and makes the risk real: commit early for points, or wait and be sure.
 */

const COUNTDOWN_MS = 3_000
const DEFAULT_REVEAL_MS = 7_000
/** How many reveal steps a round is cut into. Matches the pipeline's output. */
const STAGE_COUNT = 5

type Phase = 'COUNTDOWN' | 'QUESTION' | 'REVEAL' | 'FINISHED'

interface BlurAnswer {
  guess: string
  /** Server receive time. A client timestamp is never trusted for scoring. */
  at: number
  correct: boolean
  points: number
  /** Placement among correct answers this round, 1-based. */
  place: number | null
  /** Which reveal step was on screen when they committed — shown at reveal. */
  stage: number
}

interface BlurState {
  sessionId: string
  phase: Phase
  roundIndex: number
  questions: ImageQuestion[]
  phaseStartedAt: number
  phaseEndsAt: number
  /** Reveal steps unlocked so far in this round, 1..STAGE_COUNT. */
  stagesRevealed: number
  answers: Record<PlayerId, BlurAnswer>
  correctSoFar: number
  revealMs: number
  /** Fixed at creation so every transition reads the same number. */
  questionSeconds: number
}

const settingsSchema = z.strictObject({
  questions: z.int().min(3).max(15).default(6),
  seconds: z.int().min(10).max(60).default(25),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
  category: z.string().min(1).max(32).default('any'),
})

type BlurSettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'questions', label: 'Images', kind: 'int', min: 3, max: 15, step: 1, default: 6 },
  { key: 'seconds', label: 'Time per image', kind: 'int', min: 10, max: 60, step: 5, default: 25, unit: 's' },
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
  {
    key: 'category',
    label: 'Category',
    kind: 'choice',
    default: 'any',
    options: [
      { value: 'any', label: 'Anything' },
      { value: 'landmark', label: 'Landmarks' },
      { value: 'animal', label: 'Animals' },
      { value: 'artwork', label: 'Art' },
      { value: 'food', label: 'Food' },
    ],
  },
]

const actionSchema = z.strictObject({
  type: z.literal('blur/guess'),
  payload: z.strictObject({ guess: z.string().min(1).max(80) }),
})

// ---------------------------------------------------------------------------

function currentQuestion(state: BlurState): ImageQuestion | null {
  return state.questions[state.roundIndex] ?? null
}

/** Players who can still act: a dropped socket keeps its seat until the room
 *  service declares the player inactive, so we do not end a round early on a
 *  brief Wi-Fi blip. */
function activePlayerIds(ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  return ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id)
}

/** Epoch ms at which reveal step `n` (1-based) unlocks. */
function stageBoundary(state: BlurState, n: number): number {
  const span = state.phaseEndsAt - state.phaseStartedAt
  return state.phaseStartedAt + Math.round((span * n) / STAGE_COUNT)
}

function startCountdown(state: BlurState, now: number): BlurState {
  return {
    ...state,
    phase: 'COUNTDOWN',
    phaseStartedAt: now,
    phaseEndsAt: now + COUNTDOWN_MS,
    stagesRevealed: 1,
    answers: {},
    correctSoFar: 0,
  }
}

function startQuestion(state: BlurState, now: number, seconds: number): BlurState {
  return {
    ...state,
    phase: 'QUESTION',
    phaseStartedAt: now,
    phaseEndsAt: now + seconds * 1000,
    stagesRevealed: 1,
    answers: {},
    correctSoFar: 0,
  }
}

/** The typed guess, or null when the frame does not match this game's schema. */
function parseGuess(action: GameAction): string | null {
  const parsed = actionSchema.safeParse(action)
  return parsed.success ? parsed.data.payload.guess : null
}

function validate(state: BlurState, playerId: PlayerId, action: GameAction): Result<void> {
  if (parseGuess(action) === null) return reject('INVALID_ACTION')
  if (state.phase !== 'QUESTION') return reject('ROUND_CLOSED')
  if (state.answers[playerId] !== undefined) return reject('ALREADY_ANSWERED')
  if (currentQuestion(state) === null) return reject('INVALID_ROUND')
  return accept
}

// ---------------------------------------------------------------------------

export const blurBattle: ErasedGameDefinition = defineGame<BlurState, BlurSettings>({
  id: 'blur-battle',
  meta: {
    name: 'Blur Battle',
    tagline: 'Name it before it comes into focus.',
    description:
      'A picture sharpens step by step. Shout it out early through the fog for big points, or wait for clarity and settle for scraps. One guess each — choose your moment.',
    emoji: '🌀',
    accent: 'violet',
    estimatedMinutes: 5,
    playable: true,
  },
  minPlayers: 1,
  maxPlayers: 12,
  settingsSpec,
  settingsSchema,
  actionSchema,

  contentRequest(settings): ContentRequest {
    return {
      kind: 'image',
      count: settings.questions,
      difficulty: settings.difficulty,
      category: settings.category === 'any' ? null : settings.category,
    }
  },

  createGame(ctx: CreateContext<BlurSettings>): BlurState {
    const pool = expectItems(ctx.content, 'image')
    const rng = createRng(ctx.seed, 'blur-battle', ctx.sessionId)
    const questions = rng.sample(pool, ctx.settings.questions)

    const base: BlurState = {
      sessionId: ctx.sessionId,
      phase: 'COUNTDOWN',
      roundIndex: 0,
      questions,
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + COUNTDOWN_MS,
      stagesRevealed: 1,
      answers: {},
      correctSoFar: 0,
      revealMs: DEFAULT_REVEAL_MS,
      questionSeconds: ctx.settings.seconds,
    }
    return base
  },

  getDeadline(state): number | null {
    if (state.phase === 'FINISHED') return null
    if (state.phase === 'QUESTION') {
      // Wake for whichever comes first: the next reveal step or the round's end.
      if (state.stagesRevealed < STAGE_COUNT) {
        return Math.min(stageBoundary(state, state.stagesRevealed), state.phaseEndsAt)
      }
      return state.phaseEndsAt
    }
    return state.phaseEndsAt
  },

  getPhase: (state) => state.phase,
  isGameOver: (state) => state.phase === 'FINISHED',

  validateAction(state, playerId, action, _ctx): Result<void> {
    if (action.type !== 'blur/guess') return reject('INVALID_ACTION')
    if (state.phase !== 'QUESTION') return reject('ROUND_CLOSED')
    if (state.answers[playerId] !== undefined) return reject('ALREADY_ANSWERED')
    if (currentQuestion(state) === null) return reject('INVALID_ROUND')
    return accept
  },

  applyAction(state, playerId, action, ctx) {
    if (!validate(state, playerId, action).ok) return noChange(state)

    const question = currentQuestion(state)
    const raw = parseGuess(action)
    if (question === null || raw === null) return noChange(state)
    const match = matchAnswer(raw, [question.title, ...question.aliases])

    const events: EngineEvent[] = []
    let points = 0
    let place: number | null = null

    if (match.correct) {
      place = state.correctSoFar + 1
      points =
        speedScore({ startedAt: state.phaseStartedAt, endsAt: state.phaseEndsAt, answeredAt: ctx.now }) +
        placementBonus(place)
    }

    const answer: BlurAnswer = {
      guess: raw.slice(0, 80),
      at: ctx.now,
      correct: match.correct,
      points,
      place,
      stage: state.stagesRevealed,
    }

    let next: BlurState = {
      ...state,
      answers: { ...state.answers, [playerId]: answer },
      correctSoFar: match.correct ? state.correctSoFar + 1 : state.correctSoFar,
    }

    // Broadcast that somebody locked in, never what they wrote.
    events.push({ type: 'PLAYER_ANSWERED', data: { playerId, correct: match.correct } })

    // Everyone still in the room has committed: stop the clock rather than make
    // them watch it run down. Expiring the deadline lets the room service's
    // advance loop fold straight into the reveal.
    const active = activePlayerIds(ctx)
    const allAnswered = active.length > 0 && active.every((id) => next.answers[id] !== undefined)
    if (allAnswered) next = { ...next, phaseEndsAt: Math.min(next.phaseEndsAt, ctx.now) }

    return match.correct
      ? transition(next, events, { [playerId]: points })
      : transition(next, events)
  },

  advance(state, ctx) {
    switch (state.phase) {
      case 'COUNTDOWN': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const next = startQuestion(state, state.phaseEndsAt, state.questionSeconds)
        return transition(next, [
          {
            type: 'ROUND_STARTED',
            data: { round: next.roundIndex + 1, total: next.questions.length },
          },
        ])
      }

      case 'QUESTION': {
        // Unlock the next reveal step without ending the round.
        if (ctx.now < state.phaseEndsAt && state.stagesRevealed < STAGE_COUNT) {
          if (ctx.now >= stageBoundary(state, state.stagesRevealed)) {
            return transition({ ...state, stagesRevealed: state.stagesRevealed + 1 }, [])
          }
          return noChange(state)
        }
        if (ctx.now < state.phaseEndsAt) return noChange(state)

        return transition(
          {
            ...state,
            phase: 'REVEAL',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + state.revealMs,
            stagesRevealed: STAGE_COUNT,
          },
          [{ type: 'ROUND_ENDED', data: { round: state.roundIndex + 1 } }],
        )
      }

      case 'REVEAL': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const isLast = state.roundIndex + 1 >= state.questions.length
        if (isLast) {
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
    // Their seat is gone, so the round may now be fully answered by whoever is
    // left. Re-check rather than let everyone wait out a clock for nobody.
    if (state.phase !== 'QUESTION') return noChange(state)
    const active = activePlayerIds(ctx)
    const allAnswered = active.length > 0 && active.every((id) => state.answers[id] !== undefined)
    if (!allAnswered) return noChange(state)
    return transition({ ...state, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now) }, [])
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    const question = currentQuestion(state)
    const answered = Object.keys(state.answers)
    const mine = viewerId === null ? undefined : state.answers[viewerId]

    const view: Record<string, unknown> = {
      stageIndex: state.stagesRevealed - 1,
      stageCount: STAGE_COUNT,
      answeredPlayerIds: answered,
      activeCount: activePlayerIds(ctx).length,
    }

    if (question !== null) {
      view['category'] = question.category
      view['difficulty'] = question.difficulty
    }

    if (state.phase === 'QUESTION' && question !== null) {
      // Exactly one image: the step currently unlocked. The sharper files exist
      // on disk but their URLs are not in this payload, so they are not
      // fetchable ahead of time by guessing the shape of the response.
      view['imageUrl'] = question.stageUrls[state.stagesRevealed - 1] ?? question.stageUrls[0] ?? null
    }

    if (state.phase === 'REVEAL' || state.phase === 'FINISHED') {
      if (question !== null) {
        view['imageUrl'] = question.fullUrl
        view['answer'] = question.title
        view['attribution'] = question.attribution
      }
      view['results'] = Object.entries(state.answers)
        .map(([playerId, a]) => ({
          playerId,
          guess: a.guess,
          correct: a.correct,
          points: a.points,
          place: a.place,
          stage: a.stage,
        }))
        .sort((a, b) => b.points - a.points)
    }

    if (mine !== undefined) {
      // Personal feedback only. Nobody else's payload carries this.
      view['yourAnswer'] = { guess: mine.guess, correct: mine.correct, points: mine.points, locked: true }
    }

    return {
      gameId: 'blur-battle',
      sessionId: state.sessionId,
      phase: state.phase,
      roundNumber: state.roundIndex + 1,
      totalRounds: state.questions.length,
      view,
    }
  },
})

