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
  /**
   * Groups the host joined by hand, as answer key -> the key it now counts as.
   *
   * No dictionary covers every way a table agrees — "petrol bunk" and "gas
   * station", an inside joke, a word in a language nobody wrote down — so the
   * host can merge what the key folder kept apart. Kept as a map from the
   * original keys rather than as rewritten answers so the automatic grouping
   * is never lost: clearing this map restores it exactly.
   */
  mergedInto: Record<string, string>
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

const submitSchema = z.strictObject({
  type: z.literal('meld/submit'),
  payload: z.strictObject({ answer: z.string().min(1).max(60) }),
})

/** Host only. The first key is the one the merged group keeps, so the host
 *  decides which wording ends up on screen. */
const mergeSchema = z.strictObject({
  type: z.literal('meld/merge'),
  payload: z.strictObject({ keys: z.array(z.string().min(1).max(120)).min(2).max(16) }),
})

/** Host only. Throws away every merge and restores the automatic grouping. */
const resetSchema = z.strictObject({
  type: z.literal('meld/unmerge'),
  payload: z.strictObject({}).default({}),
})

const actionSchema = z.discriminatedUnion('type', [submitSchema, mergeSchema, resetSchema])

function parseAnswer(action: GameAction): string | null {
  const parsed = submitSchema.safeParse(action)
  return parsed.success ? parsed.data.payload.answer : null
}

function parseMerge(action: GameAction): string[] | null {
  const parsed = mergeSchema.safeParse(action)
  return parsed.success ? parsed.data.payload.keys : null
}

function currentPrompt(state: MeldState): MeldPrompt | null {
  return state.prompts[state.roundIndex] ?? null
}

function activeIds(ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  return ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id)
}

function validate(
  state: MeldState,
  playerId: PlayerId,
  action: GameAction,
  ctx: { hostId: PlayerId },
  allowEdits: boolean,
): Result<void> {
  if (action.type === 'meld/merge' || action.type === 'meld/unmerge') {
    // Regrouping is a host call, and only while the results are on screen.
    if (playerId !== ctx.hostId) return reject('NOT_HOST')
    if (state.phase !== 'REVEAL') return reject('INVALID_ACTION', 'The results are not up yet.')
    if (action.type === 'meld/unmerge') {
      return Object.keys(state.mergedInto).length === 0
        ? reject('INVALID_ACTION', 'Nothing has been merged.')
        : accept
    }
    const keys = parseMerge(action)
    if (keys === null) return reject('INVALID_ACTION')
    const live = new Set(state.groups.map((g) => g.key))
    if (keys.some((key) => !live.has(key))) {
      // Two hosts cannot race here, but a stale screen can: the keys a client
      // is looking at may already have been merged away.
      return reject('INVALID_ACTION', 'Those groups have already changed.')
    }
    if (new Set(keys).size < 2) return reject('INVALID_ACTION', 'Pick two groups to join.')
    return accept
  }

  if (parseAnswer(action) === null) return reject('INVALID_ACTION')
  if (state.phase !== 'PROMPT') return reject('ROUND_CLOSED')
  if (currentPrompt(state) === null) return reject('INVALID_ROUND')
  if (!allowEdits && state.answers[playerId] !== undefined) return reject('ALREADY_ANSWERED')
  return accept
}

/**
 * Bucket the round's answers and price each group. A group of one earns
 * nothing: being original is its own reward.
 *
 * `mergedInto` is the host's own judgement, applied on top of the key folder:
 * an answer counts as whichever key its own key has been merged into.
 */
function scoreRound(
  answers: Record<PlayerId, MeldAnswer>,
  mergedInto: Record<string, string> = {},
): {
  groups: { key: string; label: string; playerIds: PlayerId[]; points: number }[]
  deltas: Record<PlayerId, number>
} {
  const buckets = new Map<string, { label: string; playerIds: PlayerId[] }>()
  for (const [playerId, answer] of Object.entries(answers)) {
    const key = mergedInto[answer.key] ?? answer.key
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { label: answer.text, playerIds: [playerId] })
    else bucket.playerIds.push(playerId)
  }

  // A merged group is labelled by the answer whose key it kept, which is the
  // one the host tapped first — not by whoever happened to answer earliest.
  for (const [key, bucket] of buckets) {
    const owner = Object.entries(answers).find(([, answer]) => answer.key === key)
    if (owner !== undefined) bucket.label = owner[1].text
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

/** What each player has already been paid for the round on screen. */
function awarded(groups: MeldState['groups']): Record<PlayerId, number> {
  const paid: Record<PlayerId, number> = {}
  for (const group of groups) for (const playerId of group.playerIds) paid[playerId] = group.points
  return paid
}

/**
 * Re-score the round on screen and pay only the difference.
 *
 * The round's points were applied when the reveal opened, and the room adds
 * deltas to a running total rather than replacing it, so a regroup has to
 * settle up: positive when a merge grows a group, negative when the host
 * undoes one.
 */
function regroup(state: MeldState, mergedInto: Record<string, string>) {
  const { groups } = scoreRound(state.answers, mergedInto)
  const before = awarded(state.groups)
  const after = awarded(groups)
  const deltas: Record<PlayerId, number> = {}
  for (const playerId of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[playerId] ?? 0) - (before[playerId] ?? 0)
    if (change !== 0) deltas[playerId] = change
  }
  return transition(
    { ...state, groups, mergedInto },
    [{ type: 'ROUND_ENDED' as const, data: { round: state.roundIndex + 1, groups: groups.length, regrouped: true } }],
    deltas,
  )
}

/**
 * Fold the listed keys together, keeping the first.
 *
 * Existing merges that pointed at one of the absorbed keys are repointed, so
 * the map stays one level deep and a chain of merges cannot build up.
 */
function mergeKeys(mergedInto: Record<string, string>, keys: string[]): Record<string, string> {
  const [target, ...absorbed] = keys
  if (target === undefined) return mergedInto
  const next = { ...mergedInto }
  for (const key of absorbed) {
    for (const [from, to] of Object.entries(next)) if (to === key) next[from] = target
    next[key] = target
  }
  return next
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
    // The host's merges belong to the round they were made in.
    mergedInto: {},
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
      mergedInto: {},
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

  validateAction: (state, playerId, action, ctx) => validate(state, playerId, action, ctx, true),

  applyAction(state, playerId, action, ctx) {
    if (!validate(state, playerId, action, ctx, true).ok) return noChange(state)

    // The host joining two groups the key folder kept apart, or undoing it.
    if (action.type === 'meld/unmerge') return regroup(state, {})
    const merging = parseMerge(action)
    if (merging !== null) return regroup(state, mergeKeys(state.mergedInto, merging))

    const text = parseAnswer(action)
    if (text === null) return noChange(state)

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
            mergedInto: {},
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
      // So the host's screen can offer to undo, and everyone's can say that
      // the grouping in front of them is not purely the machine's doing.
      view['merged'] = Object.keys(state.mergedInto).length > 0
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
