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
import { expectItems, type ContentRequest, type IdentityCard } from '../content.ts'
import { clamp } from '../scoring.ts'
import {
  defineGame,
  noChange,
  transition,
  type CreateContext,
  type ErasedGameDefinition,
  type GameAction,
  type TurnContext,
  type ViewContext,
} from '../types.ts'

/**
 * Who Am I?
 *
 * Everyone wears a name they cannot see. On your turn you ask the table one
 * yes/no question, they vote, and you either narrow it down or take a swing at
 * the answer. Fewer turns used, more points.
 *
 * The security property is the whole game: a player's own identity must not be
 * in the bytes their browser receives. getPublicState builds the identity map
 * by omitting the viewer rather than by marking their entry hidden, so there is
 * nothing to read out of the payload. The test suite asserts this directly.
 */

const ASSIGN_MS = 4_000
const RESULT_MS = 5_000
const MAX_POINTS = 1_000
const TURN_COST = 60
const MIN_POINTS = 250
const SOLVE_BONUS = [200, 100, 50]

type Phase = 'ASSIGN' | 'ASK' | 'VOTE' | 'RESULT' | 'FINISHED'
type Vote = 'yes' | 'no'

interface Solved {
  turnsUsed: number
  points: number
  place: number
}

interface WhoAmIState {
  sessionId: string
  phase: Phase
  /** Identity per player. Never sent whole to anybody. */
  identities: Record<PlayerId, IdentityCard>
  /** Fixed turn order, so a reconnect cannot reshuffle whose turn it is. */
  order: PlayerId[]
  turnIndex: number
  /** Turns each player has spent, which is what their score is priced on. */
  turnsUsed: Record<PlayerId, number>
  solved: Record<PlayerId, Solved>
  /** How many hints the current asker has unlocked this turn. */
  hintsShown: Record<PlayerId, number>
  question: string | null
  votes: Record<PlayerId, Vote>
  lastResult: { asker: PlayerId; question: string; yes: number; no: number; guess: string | null; correct: boolean } | null
  phaseStartedAt: number
  phaseEndsAt: number
  askSeconds: number
  voteSeconds: number
  maxTurns: number
}

const settingsSchema = z.strictObject({
  askSeconds: z.int().min(15).max(120).default(45),
  voteSeconds: z.int().min(5).max(45).default(15),
  maxTurns: z.int().min(3).max(20).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
})

type WhoAmISettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'askSeconds', label: 'Time to ask', kind: 'int', min: 15, max: 120, step: 5, default: 45, unit: 's' },
  { key: 'voteSeconds', label: 'Time to vote', kind: 'int', min: 5, max: 45, step: 5, default: 15, unit: 's' },
  { key: 'maxTurns', label: 'Turns each', kind: 'int', min: 3, max: 20, step: 1, default: 10 },
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

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('whoami/ask'), payload: z.strictObject({ question: z.string().min(1).max(140) }) }),
  z.strictObject({ type: z.literal('whoami/vote'), payload: z.strictObject({ vote: z.enum(['yes', 'no']) }) }),
  z.strictObject({ type: z.literal('whoami/guess'), payload: z.strictObject({ guess: z.string().min(1).max(80) }) }),
  z.strictObject({ type: z.literal('whoami/hint'), payload: z.strictObject({}) }),
  z.strictObject({ type: z.literal('whoami/pass'), payload: z.strictObject({}) }),
])

type WhoAmIAction = z.infer<typeof actionSchema>

function parse(action: GameAction): WhoAmIAction | null {
  const result = actionSchema.safeParse(action)
  return result.success ? result.data : null
}

// ---------------------------------------------------------------------------

function unsolvedOrder(state: WhoAmIState, activeIds: Set<PlayerId>): PlayerId[] {
  return state.order.filter((id) => state.solved[id] === undefined && activeIds.has(id))
}

function currentAsker(state: WhoAmIState): PlayerId | null {
  return state.order[state.turnIndex] ?? null
}

function activeIdSet(ctx: { players: { id: PlayerId; presence: string }[] }): Set<PlayerId> {
  return new Set(ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id))
}

/**
 * Hand the turn to the next player who is still playing. Returns null when
 * nobody is left to ask, which ends the game.
 */
function nextTurn(state: WhoAmIState, ctx: TurnContext): WhoAmIState | null {
  const active = activeIdSet(ctx)
  const remaining = unsolvedOrder(state, active)
  if (remaining.length === 0) return null
  if (remaining.every((id) => (state.turnsUsed[id] ?? 0) >= state.maxTurns)) return null

  // Walk forward from the current seat until we land on someone eligible.
  for (let step = 1; step <= state.order.length; step++) {
    const index = (state.turnIndex + step) % state.order.length
    const candidate = state.order[index]
    if (candidate === undefined) continue
    if (state.solved[candidate] !== undefined) continue
    if (!active.has(candidate)) continue
    if ((state.turnsUsed[candidate] ?? 0) >= state.maxTurns) continue
    return {
      ...state,
      turnIndex: index,
      phase: 'ASK',
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + state.askSeconds * 1000,
      question: null,
      votes: {},
    }
  }
  return null
}

function finish(state: WhoAmIState, now: number): WhoAmIState {
  return { ...state, phase: 'FINISHED', phaseStartedAt: now, phaseEndsAt: now }
}

function scoreFor(turnsUsed: number, place: number): number {
  const base = clamp(MAX_POINTS - turnsUsed * TURN_COST, MIN_POINTS, MAX_POINTS)
  return base + (SOLVE_BONUS[place - 1] ?? 0)
}

// ---------------------------------------------------------------------------

export const whoAmI: ErasedGameDefinition = defineGame<WhoAmIState, WhoAmISettings>({
  id: 'who-am-i',
  meta: {
    name: 'Who Am I?',
    tagline: 'Everyone can see your name except you.',
    description:
      'A secret identity is pinned to your forehead. Ask the table one yes/no question per turn, read the vote, and guess before anyone else works theirs out.',
    emoji: '🕵️',
    accent: 'amber',
    estimatedMinutes: 10,
    playable: true,
  },
  minPlayers: 3,
  maxPlayers: 10,
  settingsSpec,
  settingsSchema,
  actionSchema,

  contentRequest(settings): ContentRequest {
    // One card per seat, with headroom so a late joiner does not exhaust the pool.
    return { kind: 'identity', count: 24, difficulty: settings.difficulty, category: null }
  },

  createGame(ctx: CreateContext<WhoAmISettings>): WhoAmIState {
    const pool = expectItems(ctx.content, 'identity')
    const rng = createRng(ctx.seed, 'who-am-i', ctx.sessionId)
    const order = ctx.players.map((p) => p.id)
    const cards = rng.sample(pool, order.length)

    const identities: Record<PlayerId, IdentityCard> = {}
    const turnsUsed: Record<PlayerId, number> = {}
    const hintsShown: Record<PlayerId, number> = {}
    order.forEach((id, i) => {
      const card = cards[i] ?? pool[i % pool.length]
      if (card !== undefined) identities[id] = card
      turnsUsed[id] = 0
      hintsShown[id] = 0
    })

    return {
      sessionId: ctx.sessionId,
      phase: 'ASSIGN',
      identities,
      order,
      turnIndex: 0,
      turnsUsed,
      solved: {},
      hintsShown,
      question: null,
      votes: {},
      lastResult: null,
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + ASSIGN_MS,
      askSeconds: ctx.settings.askSeconds,
      voteSeconds: ctx.settings.voteSeconds,
      maxTurns: ctx.settings.maxTurns,
    }
  },

  getDeadline: (state) => (state.phase === 'FINISHED' ? null : state.phaseEndsAt),
  getPhase: (state) => state.phase,
  isGameOver: (state) => state.phase === 'FINISHED',

  validateAction(state, playerId, action): Result<void> {
    const parsed = parse(action)
    if (parsed === null) return reject('INVALID_ACTION')
    if (state.solved[playerId] !== undefined) return reject('INVALID_ACTION', 'You already guessed yours.')

    switch (parsed.type) {
      case 'whoami/vote':
        if (state.phase !== 'VOTE') return reject('ROUND_CLOSED')
        if (playerId === currentAsker(state)) return reject('INVALID_ACTION', 'You asked the question.')
        if (state.votes[playerId] !== undefined) return reject('ALREADY_ANSWERED')
        return accept
      case 'whoami/ask':
      case 'whoami/guess':
      case 'whoami/hint':
      case 'whoami/pass':
        if (state.phase !== 'ASK') return reject('ROUND_CLOSED')
        if (playerId !== currentAsker(state)) return reject('NOT_YOUR_TURN')
        return accept
    }
  },

  applyAction(state, playerId, action, ctx) {
    const parsed = parse(action)
    if (parsed === null) return noChange(state)
    if (!whoAmIValidate(state, playerId, parsed).ok) return noChange(state)

    switch (parsed.type) {
      case 'whoami/ask': {
        return transition(
          {
            ...state,
            phase: 'VOTE',
            question: parsed.payload.question,
            votes: {},
            phaseStartedAt: ctx.now,
            phaseEndsAt: ctx.now + state.voteSeconds * 1000,
            turnsUsed: { ...state.turnsUsed, [playerId]: (state.turnsUsed[playerId] ?? 0) + 1 },
          },
          [{ type: 'ROUND_STARTED', data: { asker: playerId, question: parsed.payload.question } }],
        )
      }

      case 'whoami/vote': {
        const votes = { ...state.votes, [playerId]: parsed.payload.vote }
        const eligible = ctx.players.filter(
          (p) => p.presence !== 'INACTIVE' && p.id !== currentAsker(state) && state.solved[p.id] === undefined,
        )
        const everyoneVoted = eligible.length > 0 && eligible.every((p) => votes[p.id] !== undefined)
        const next: WhoAmIState = everyoneVoted
          ? { ...state, votes, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now) }
          : { ...state, votes }
        return transition(next, [{ type: 'PLAYER_ANSWERED', data: { playerId } }])
      }

      case 'whoami/hint': {
        const shown = state.hintsShown[playerId] ?? 0
        const card = state.identities[playerId]
        if (card === undefined || shown >= card.hints.length) return noChange(state)
        // A hint costs a turn; that is the whole price of taking one.
        return transition({
          ...state,
          hintsShown: { ...state.hintsShown, [playerId]: shown + 1 },
          turnsUsed: { ...state.turnsUsed, [playerId]: (state.turnsUsed[playerId] ?? 0) + 1 },
        })
      }

      case 'whoami/guess': {
        const card = state.identities[playerId]
        if (card === undefined) return noChange(state)
        const match = matchAnswer(parsed.payload.guess, [card.name, ...card.aliases])
        const turns = (state.turnsUsed[playerId] ?? 0) + 1
        const withTurn = { ...state.turnsUsed, [playerId]: turns }

        if (!match.correct) {
          return transition(
            {
              ...state,
              turnsUsed: withTurn,
              lastResult: { asker: playerId, question: 'Guess', yes: 0, no: 0, guess: parsed.payload.guess, correct: false },
              phase: 'RESULT',
              phaseStartedAt: ctx.now,
              phaseEndsAt: ctx.now + RESULT_MS,
            },
            [{ type: 'PLAYER_ANSWERED', data: { playerId, correct: false } }],
          )
        }

        const place = Object.keys(state.solved).length + 1
        const points = scoreFor(turns, place)
        return transition(
          {
            ...state,
            turnsUsed: withTurn,
            solved: { ...state.solved, [playerId]: { turnsUsed: turns, points, place } },
            lastResult: { asker: playerId, question: 'Guess', yes: 0, no: 0, guess: parsed.payload.guess, correct: true },
            phase: 'RESULT',
            phaseStartedAt: ctx.now,
            phaseEndsAt: ctx.now + RESULT_MS,
          },
          [{ type: 'PLAYER_SCORED', data: { playerId, points, identity: card.name } }],
          { [playerId]: points },
        )
      }

      case 'whoami/pass': {
        return transition({ ...state, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now) })
      }
    }
  },

  advance(state, ctx) {
    switch (state.phase) {
      case 'ASSIGN': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const started = nextTurnFromStart(state, ctx)
        return started === null
          ? transition(finish(state, state.phaseEndsAt), [{ type: 'GAME_COMPLETED', data: {} }])
          : transition(started, [{ type: 'ROUND_STARTED', data: { asker: currentAsker(started) } }])
      }

      case 'ASK': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        // Ran the clock down without asking: the turn is spent regardless.
        const asker = currentAsker(state)
        const spent = asker === null
          ? state
          : { ...state, turnsUsed: { ...state.turnsUsed, [asker]: (state.turnsUsed[asker] ?? 0) + 1 } }
        const next = nextTurn(spent, { ...ctx, now: state.phaseEndsAt })
        return next === null
          ? transition(finish(spent, state.phaseEndsAt), [{ type: 'GAME_COMPLETED', data: {} }])
          : transition(next, [])
      }

      case 'VOTE': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const asker = currentAsker(state)
        const tally = Object.values(state.votes)
        const yes = tally.filter((v) => v === 'yes').length
        const no = tally.length - yes
        return transition(
          {
            ...state,
            phase: 'RESULT',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + RESULT_MS,
            lastResult: { asker: asker ?? '', question: state.question ?? '', yes, no, guess: null, correct: false },
          },
          [{ type: 'ROUND_ENDED', data: { yes, no } }],
        )
      }

      case 'RESULT': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const next = nextTurn(state, { ...ctx, now: state.phaseEndsAt })
        return next === null
          ? transition(finish(state, state.phaseEndsAt), [{ type: 'GAME_COMPLETED', data: {} }])
          : transition(next, [])
      }

      case 'FINISHED':
        return noChange(state)
    }
  },

  onPlayerInactive(state, playerId, ctx) {
    // If the player who left was holding the turn, move it along rather than
    // letting the table wait out a clock for an empty chair.
    if (state.phase === 'FINISHED') return noChange(state)
    if (currentAsker(state) !== playerId) return noChange(state)
    const next = nextTurn(state, ctx)
    return next === null
      ? transition(finish(state, ctx.now), [{ type: 'GAME_COMPLETED', data: {} }])
      : transition(next, [])
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    // Built by omission. The viewer's own card is never added to the object, so
    // there is no field to inspect, decode or toggle on the client.
    const others: Record<PlayerId, { name: string; category: string }> = {}
    for (const [playerId, card] of Object.entries(state.identities)) {
      if (playerId === viewerId) continue
      others[playerId] = { name: card.name, category: card.category }
    }

    const asker = currentAsker(state)
    const myCard = viewerId === null ? undefined : state.identities[viewerId]
    const myHints = viewerId === null ? 0 : (state.hintsShown[viewerId] ?? 0)

    const view: Record<string, unknown> = {
      identities: others,
      asker,
      question: state.question,
      votedPlayerIds: Object.keys(state.votes),
      turnsUsed: state.turnsUsed,
      solved: Object.fromEntries(
        Object.entries(state.solved).map(([id, s]) => [id, { turnsUsed: s.turnsUsed, points: s.points, place: s.place }]),
      ),
      maxTurns: state.maxTurns,
      remaining: unsolvedOrder(state, activeIdSet(ctx)).length,
    }

    // Hints describe the viewer's own identity without naming it, so they are
    // safe to send to exactly one person: the one who paid a turn for them.
    if (myCard !== undefined) view['yourHints'] = myCard.hints.slice(0, myHints)
    if (myCard !== undefined) view['yourHintsLeft'] = myCard.hints.length - myHints

    if (state.phase === 'RESULT' && state.lastResult !== null) view['result'] = state.lastResult

    if (state.phase === 'FINISHED') {
      // Only now does everyone learn what they were wearing.
      view['reveal'] = Object.fromEntries(Object.entries(state.identities).map(([id, c]) => [id, c.name]))
    }

    return {
      gameId: 'who-am-i',
      sessionId: state.sessionId,
      phase: state.phase,
      // The turn the player holding the floor is on, out of the turns they
      // get. Summing everybody's turns against the table's total read as
      // "Round 0 / 40" at the start, which tells a player nothing.
      roundNumber: Math.min(state.maxTurns, (state.turnsUsed[currentAsker(state) ?? ''] ?? 0) + 1),
      totalRounds: state.maxTurns,
      view,
    }
  },
})

/** Local mirror of validateAction so applyAction does not round-trip through
 *  the erased definition just to re-check itself. */
function whoAmIValidate(state: WhoAmIState, playerId: PlayerId, parsed: WhoAmIAction): Result<void> {
  if (state.solved[playerId] !== undefined) return reject('INVALID_ACTION')
  switch (parsed.type) {
    case 'whoami/vote':
      if (state.phase !== 'VOTE') return reject('ROUND_CLOSED')
      if (playerId === currentAsker(state)) return reject('INVALID_ACTION')
      if (state.votes[playerId] !== undefined) return reject('ALREADY_ANSWERED')
      return accept
    case 'whoami/ask':
    case 'whoami/guess':
    case 'whoami/hint':
    case 'whoami/pass':
      if (state.phase !== 'ASK') return reject('ROUND_CLOSED')
      if (playerId !== currentAsker(state)) return reject('NOT_YOUR_TURN')
      return accept
  }
}

/** First turn of the game: start at the top of the order rather than stepping
 *  past it, which is what nextTurn does. */
function nextTurnFromStart(state: WhoAmIState, ctx: TurnContext): WhoAmIState | null {
  const active = activeIdSet(ctx)
  for (let index = 0; index < state.order.length; index++) {
    const candidate = state.order[index]
    if (candidate === undefined || !active.has(candidate)) continue
    return {
      ...state,
      turnIndex: index,
      phase: 'ASK',
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + state.askSeconds * 1000,
      question: null,
      votes: {},
    }
  }
  return null
}
