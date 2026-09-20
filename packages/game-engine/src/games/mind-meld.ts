import { z } from 'zod'
import {
  accept,
  createRng,
  meldKey,
  reject,
  type GamePublicState,
  type PlayerId,
  type Result,
  type SettingField,
} from '@friendzone/shared'
import { expectItems, type ContentRequest, type MeldPrompt } from '../content.ts'
import { pickFresh } from '../selection.ts'
import { meldScore } from '../scoring.ts'
import {
  defineGame,
  noChange,
  transition,
  type CreateContext,
  type ErasedGameDefinition,
  type GameAction,
  type ViewContext,
} from '../types.ts'

/**
 * Mind Meld.
 *
 * One prompt, everyone answers at the same time, and you score for every other
 * person who wrote the same thing. There is no correct answer — only the
 * obvious one.
 *
 * Simultaneity is the mechanic, so it is enforced rather than requested: while
 * the prompt is live, no payload contains anyone else's answer, or even a
 * length hint. All a player sees is who has locked in. If answers leaked, the
 * game would collapse into copying the first person to type.
 *
 * Answers are bucketed by meldKey, which folds case, punctuation, word order,
 * plurals and gerunds together — so "sleeping" and "Sleep!" land in the same
 * group — and then folds a curated list of equivalents, so "phone", "mobile"
 * and "cell phone" do too. Agreeing is the whole game; losing points because
 * two people picked different words for one thing is the software's fault.
 */

const COUNTDOWN_MS = 3_000

type Phase = 'COUNTDOWN' | 'PROMPT' | 'REVEAL' | 'FINISHED'

interface MeldAnswer {
  text: string
  key: string
  at: number
}

interface MeldState {
  sessionId: string
  phase: Phase
  roundIndex: number
  prompts: MeldPrompt[]
  phaseStartedAt: number
  phaseEndsAt: number
  answers: Record<PlayerId, MeldAnswer>
  /** Scored groups for the round being revealed. */
  groups: { key: string; label: string; playerIds: PlayerId[]; points: number }[]
  promptSeconds: number
}

const settingsSchema = z.strictObject({
  rounds: z.int().min(3).max(12).default(5),
  seconds: z.int().min(10).max(60).default(20),
  allowEdits: z.boolean().default(true),
})

type MeldSettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'rounds', label: 'Prompts', kind: 'int', min: 3, max: 12, step: 1, default: 5 },
  { key: 'seconds', label: 'Time to answer', kind: 'int', min: 10, max: 60, step: 5, default: 20, unit: 's' },
  {
    key: 'allowEdits',
    label: 'Allow changing your answer',
    help: 'Until the clock runs out. Nobody can see what you wrote either way.',
    kind: 'bool',
    default: true,
  },
]

const actionSchema = z.strictObject({
  type: z.literal('meld/submit'),
  payload: z.strictObject({ answer: z.string().min(1).max(60) }),
})

function parseAnswer(action: GameAction): string | null {
  const parsed = actionSchema.safeParse(action)
  return parsed.success ? parsed.data.payload.answer : null
}

function currentPrompt(state: MeldState): MeldPrompt | null {
  return state.prompts[state.roundIndex] ?? null
}

function activeIds(ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  return ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id)
}

function validate(state: MeldState, playerId: PlayerId, action: GameAction, allowEdits: boolean): Result<void> {
  if (parseAnswer(action) === null) return reject('INVALID_ACTION')
  if (state.phase !== 'PROMPT') return reject('ROUND_CLOSED')
  if (currentPrompt(state) === null) return reject('INVALID_ROUND')
  if (!allowEdits && state.answers[playerId] !== undefined) return reject('ALREADY_ANSWERED')
  return accept
}

/**
 * Bucket the round's answers and price each group. A group of one earns
 * nothing: being original is its own reward.
 */
function scoreRound(answers: Record<PlayerId, MeldAnswer>): {
  groups: { key: string; label: string; playerIds: PlayerId[]; points: number }[]
  deltas: Record<PlayerId, number>
} {
  const buckets = new Map<string, { label: string; playerIds: PlayerId[] }>()
  for (const [playerId, answer] of Object.entries(answers)) {
    const bucket = buckets.get(answer.key)
    if (bucket === undefined) buckets.set(answer.key, { label: answer.text, playerIds: [playerId] })
    else bucket.playerIds.push(playerId)
  }

  const total = Object.keys(answers).length
  const deltas: Record<PlayerId, number> = {}
  const groups = [...buckets.entries()]
    .map(([key, bucket]) => {
      const points = meldScore(bucket.playerIds.length, total)
      for (const playerId of bucket.playerIds) if (points > 0) deltas[playerId] = points
      return { key, label: bucket.label, playerIds: bucket.playerIds, points }
    })
    .sort((a, b) => b.playerIds.length - a.playerIds.length || a.label.localeCompare(b.label))

  return { groups, deltas }
}

/** Where the game goes when the host leaves the results screen. */
function nextAfterReveal(state: MeldState, now: number): MeldState {
  if (state.roundIndex + 1 >= state.prompts.length) {
    return { ...state, phase: 'FINISHED', phaseStartedAt: now, phaseEndsAt: now }
  }
  return {
    ...state,
    roundIndex: state.roundIndex + 1,
    phase: 'COUNTDOWN',
    phaseStartedAt: now,
    phaseEndsAt: now + COUNTDOWN_MS,
    answers: {},
    groups: [],
  }
}

function revealExitEvents(state: MeldState) {
  return state.roundIndex + 1 >= state.prompts.length
    ? [{ type: 'GAME_COMPLETED' as const, data: { rounds: state.prompts.length } }]
    : []
}

// ---------------------------------------------------------------------------

export const mindMeld: ErasedGameDefinition = defineGame<MeldState, MeldSettings>({
  id: 'mind-meld',
  meta: {
    name: 'Mind Meld',
    tagline: 'Think like everybody else.',
    description:
      'One prompt, everyone answers at once, and points go to whoever agreed. Being clever is a trap — you want the answer the whole room reached for.',
    emoji: '🧠',
    accent: 'emerald',
    estimatedMinutes: 6,
    playable: true,
  },
  minPlayers: 2,
  maxPlayers: 16,
  settingsSpec,
  settingsSchema,
  actionSchema,

  contentRequest: (settings): ContentRequest => ({
    kind: 'prompt',
    // Far more than a game needs, so the draw has room to avoid repeats.
    count: Math.max(settings.rounds * 12, 80),
    difficulty: 'mixed',
    category: null,
  }),

  createGame(ctx: CreateContext<MeldSettings>): MeldState {
    const pool = expectItems(ctx.content, 'prompt')
    const rng = createRng(ctx.seed, 'mind-meld', ctx.sessionId)
    const drawn = pickFresh(pool, { count: ctx.settings.rounds, recentIds: ctx.recentContentIds, rng })
    return {
      sessionId: ctx.sessionId,
      phase: 'COUNTDOWN',
      roundIndex: 0,
      prompts: drawn.items,
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + COUNTDOWN_MS,
      answers: {},
      groups: [],
      promptSeconds: ctx.settings.seconds,
    }
  },

  /**
   * No clock on the reveal.
   *
   * The whole point of this game is the argument that follows — who said what,
   * and who was being clever instead of obvious. A timer cut that short every
   * time, so the results screen now waits for the host.
   */
  getDeadline: (state) =>
    state.phase === 'FINISHED' || state.phase === 'REVEAL' ? null : state.phaseEndsAt,
  getPhase: (state) => state.phase,
  isGameOver: (state) => state.phase === 'FINISHED',
  usedContentIds: (state) => state.prompts.map((p) => p.id),

  /**
   * Host pressed Next Question.
   *
   * Returns null unless the reveal is actually on screen, which is what makes
   * a double-tap or a held button harmless: the second call finds the game
   * already in the next countdown and does nothing.
   */
  hostAdvance(state, ctx) {
    if (state.phase !== 'REVEAL') return null
    return transition(nextAfterReveal(state, ctx.now), revealExitEvents(state))
  },

  validateAction: (state, playerId, action) => validate(state, playerId, action, true),

  applyAction(state, playerId, action, ctx) {
    const text = parseAnswer(action)
    if (text === null || !validate(state, playerId, action, true).ok) return noChange(state)

    const answer: MeldAnswer = { text: text.trim().slice(0, 60), key: meldKey(text), at: ctx.now }
    let next: MeldState = { ...state, answers: { ...state.answers, [playerId]: answer } }

    const everyone = activeIds(ctx)
    if (everyone.length > 0 && everyone.every((id) => next.answers[id] !== undefined)) {
      // Everyone has committed. Cutting the clock here is safe precisely
      // because nobody could see anybody else's answer while it ran.
      next = { ...next, phaseEndsAt: Math.min(next.phaseEndsAt, ctx.now) }
    }

    return transition(next, [{ type: 'PLAYER_ANSWERED', data: { playerId } }])
  },

  advance(state, ctx) {
    switch (state.phase) {
      case 'COUNTDOWN': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        return transition(
          {
            ...state,
            phase: 'PROMPT',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + state.promptSeconds * 1000,
            answers: {},
            groups: [],
          },
          [{ type: 'ROUND_STARTED', data: { round: state.roundIndex + 1, total: state.prompts.length } }],
        )
      }

      case 'PROMPT': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const { groups, deltas } = scoreRound(state.answers)
        return transition(
          // phaseEndsAt equals phaseStartedAt: there is nothing to count down
          // here, and getDeadline returning null keeps the room from
          // publishing a deadline at all, so no screen draws a dead timer.
          { ...state, phase: 'REVEAL', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt, groups },
          [{ type: 'ROUND_ENDED', data: { round: state.roundIndex + 1, groups: groups.length } }],
          deltas,
        )
      }

      case 'REVEAL':
        // Waits for the host. getDeadline returns null here, so the scheduler
        // never calls this; the branch exists so the switch stays exhaustive.
        return noChange(state)

      case 'FINISHED':
        return noChange(state)
    }
  },

  onPlayerInactive(state, playerId, ctx) {
    if (state.phase !== 'PROMPT') return noChange(state)
    // Drop a departed player's answer so it cannot pad a group they are no
    // longer part of, then see whether the rest have all finished.
    const answers = { ...state.answers }
    delete answers[playerId]
    const everyone = activeIds(ctx)
    const done = everyone.length > 0 && everyone.every((id) => answers[id] !== undefined)
    return transition({
      ...state,
      answers,
      phaseEndsAt: done ? Math.min(state.phaseEndsAt, ctx.now) : state.phaseEndsAt,
    })
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    const prompt = currentPrompt(state)
    const mine = viewerId === null ? undefined : state.answers[viewerId]

    const view: Record<string, unknown> = {
      prompt: prompt?.prompt ?? '',
      // Who has locked in. Not what they wrote, not how long it is.
      answeredPlayerIds: Object.keys(state.answers),
      activeCount: activeIds(ctx).length,
    }

    if (mine !== undefined) view['yourAnswer'] = mine.text

    if (state.phase === 'REVEAL' || state.phase === 'FINISHED') {
      view['groups'] = state.groups
      view['loners'] = state.groups.filter((g) => g.playerIds.length === 1).length
    }
    if (state.phase === 'REVEAL') {
      // Drives the host's button, and tells everyone else what they are
      // waiting for rather than leaving the screen looking stuck.
      view['awaitingHost'] = true
      view['isLastRound'] = state.roundIndex + 1 >= state.prompts.length
    }

    return {
      gameId: 'mind-meld',
      sessionId: state.sessionId,
      phase: state.phase,
      roundNumber: state.roundIndex + 1,
      totalRounds: state.prompts.length,
      view,
    }
  },
})
