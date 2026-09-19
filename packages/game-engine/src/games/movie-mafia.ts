import { z } from 'zod'
import {
  accept,
  createRng,
  reject,
  type GamePublicState,
  type PlayerId,
  type Result,
  type SettingField,
} from '@friendzone/shared'
import { expectItems, type ContentRequest, type MafiaSubject } from '../content.ts'
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
 * Movie Mafia.
 *
 * Everyone gets a clue about the same film — except one player, whose clue is
 * subtly wrong. Talk it out, then vote for whoever sounds like they are
 * bluffing. The imposter is trying to blend in without ever having seen the
 * real clue.
 *
 * Hidden state here is two-layered and both layers are filtered by omission:
 *
 *  - who the imposter is, which nobody learns until the vote resolves
 *  - which clue each player holds, which nobody but its owner ever learns
 *
 * A player's payload contains their own clue and no one else's, and carries no
 * field at all naming the imposter. Comparing clues is the game; being able to
 * read someone else's would end it.
 */

const ROLES_MS = 8_000
const RESULT_MS = 9_000
const IMPOSTER_SURVIVAL_POINTS = 900
const IMPOSTER_WIN_BONUS = 600
const FAN_CORRECT_POINTS = 500
const FAN_TEAM_BONUS = 300

type Phase = 'ROLES' | 'DISCUSSION' | 'VOTE' | 'RESULT' | 'FINISHED'

interface RoundResult {
  round: number
  votes: Record<PlayerId, PlayerId>
  tally: { playerId: PlayerId; votes: number }[]
  eliminated: PlayerId | null
  wasImposter: boolean
  tied: boolean
}

interface MafiaState {
  sessionId: string
  phase: Phase
  round: number
  totalRounds: number
  subject: MafiaSubject
  imposterId: PlayerId
  /** Clue text per player: the fan clue for everyone but the imposter. */
  clues: Record<PlayerId, string>
  alive: PlayerId[]
  votes: Record<PlayerId, PlayerId>
  history: RoundResult[]
  phaseStartedAt: number
  phaseEndsAt: number
  discussionSeconds: number
  voteSeconds: number
  /** Set once the game is decided, before the final RESULT phase plays out. */
  outcome: 'FANS_WIN' | 'IMPOSTER_WINS' | null
}

const settingsSchema = z.strictObject({
  discussionSeconds: z.int().min(30).max(240).default(90),
  voteSeconds: z.int().min(15).max(90).default(30),
  rounds: z.int().min(1).max(5).default(3),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
})

type MafiaSettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'discussionSeconds', label: 'Discussion', kind: 'int', min: 30, max: 240, step: 15, default: 90, unit: 's' },
  { key: 'voteSeconds', label: 'Voting', kind: 'int', min: 15, max: 90, step: 5, default: 30, unit: 's' },
  { key: 'rounds', label: 'Max rounds', kind: 'int', min: 1, max: 5, step: 1, default: 3 },
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
  z.strictObject({ type: z.literal('mafia/vote'), payload: z.strictObject({ targetId: z.string().min(1).max(64) }) }),
  z.strictObject({ type: z.literal('mafia/ready'), payload: z.strictObject({}) }),
])

type MafiaAction = z.infer<typeof actionSchema>

function parse(action: GameAction): MafiaAction | null {
  const result = actionSchema.safeParse(action)
  return result.success ? result.data : null
}

function aliveActive(state: MafiaState, ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  const active = new Set(ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id))
  return state.alive.filter((id) => active.has(id))
}

function validate(state: MafiaState, playerId: PlayerId, parsed: MafiaAction): Result<void> {
  if (!state.alive.includes(playerId)) return reject('INVALID_ACTION', 'You are out of this round.')
  switch (parsed.type) {
    case 'mafia/vote':
      if (state.phase !== 'VOTE') return reject('ROUND_CLOSED')
      if (state.votes[playerId] !== undefined) return reject('ALREADY_ANSWERED')
      if (!state.alive.includes(parsed.payload.targetId)) return reject('INVALID_ACTION', 'They are not in the vote.')
      if (parsed.payload.targetId === playerId) return reject('INVALID_ACTION', 'You cannot vote for yourself.')
      return accept
    case 'mafia/ready':
      if (state.phase !== 'DISCUSSION') return reject('ROUND_CLOSED')
      return accept
  }
}

/** Count the votes. A tie eliminates nobody — the table has to try again. */
function resolveVote(state: MafiaState): RoundResult {
  const counts = new Map<PlayerId, number>()
  for (const target of Object.values(state.votes)) counts.set(target, (counts.get(target) ?? 0) + 1)

  const tally = [...counts.entries()]
    .map(([playerId, votes]) => ({ playerId, votes }))
    .sort((a, b) => b.votes - a.votes || a.playerId.localeCompare(b.playerId))

  const top = tally[0]
  const tied = tally.length > 1 && tally[1]?.votes === top?.votes
  const eliminated = top === undefined || tied ? null : top.playerId

  return {
    round: state.round,
    votes: state.votes,
    tally,
    eliminated,
    wasImposter: eliminated !== null && eliminated === state.imposterId,
    tied,
  }
}

// ---------------------------------------------------------------------------

export const movieMafia: ErasedGameDefinition = defineGame<MafiaState, MafiaSettings>({
  id: 'movie-mafia',
  meta: {
    name: 'Movie Mafia',
    tagline: 'One of you got the wrong clue.',
    description:
      'Everybody holds a clue about the same film. One clue is a fake, and the person holding it does not know what the others were told. Talk, listen, and vote out the bluffer.',
    emoji: '🎭',
    accent: 'sky',
    estimatedMinutes: 12,
    playable: true,
  },
  minPlayers: 4,
  maxPlayers: 12,
  settingsSpec,
  settingsSchema,
  actionSchema,

  contentRequest: (settings): ContentRequest => ({
    kind: 'mafia',
    count: 12,
    difficulty: settings.difficulty,
    category: null,
  }),

  createGame(ctx: CreateContext<MafiaSettings>): MafiaState {
    const pool = expectItems(ctx.content, 'mafia')
    const rng = createRng(ctx.seed, 'movie-mafia', ctx.sessionId)
    const subject = rng.pick(pool)
    const ids = ctx.players.map((p) => p.id)
    const imposterId = rng.pick(ids)

    const clues: Record<PlayerId, string> = {}
    for (const id of ids) clues[id] = id === imposterId ? subject.imposterClue : subject.fanClue

    return {
      sessionId: ctx.sessionId,
      phase: 'ROLES',
      round: 1,
      totalRounds: ctx.settings.rounds,
      subject,
      imposterId,
      clues,
      alive: ids,
      votes: {},
      history: [],
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + ROLES_MS,
      discussionSeconds: ctx.settings.discussionSeconds,
      voteSeconds: ctx.settings.voteSeconds,
      outcome: null,
    }
  },

  getDeadline: (state) => (state.phase === 'FINISHED' ? null : state.phaseEndsAt),
  getPhase: (state) => state.phase,
  isGameOver: (state) => state.phase === 'FINISHED',

  validateAction(state, playerId, action): Result<void> {
    const parsed = parse(action)
    if (parsed === null) return reject('INVALID_ACTION')
    return validate(state, playerId, parsed)
  },

  applyAction(state, playerId, action, ctx) {
    const parsed = parse(action)
    if (parsed === null || !validate(state, playerId, parsed).ok) return noChange(state)

    switch (parsed.type) {
      case 'mafia/ready':
        // Any living player can shorten the discussion; it is a social game and
        // the table usually knows when it is done talking.
        return transition({ ...state, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now + 3_000) })

      case 'mafia/vote': {
        const votes = { ...state.votes, [playerId]: parsed.payload.targetId }
        const voters = aliveActive(state, ctx)
        const allIn = voters.length > 0 && voters.every((id) => votes[id] !== undefined)
        return transition(
          { ...state, votes, phaseEndsAt: allIn ? Math.min(state.phaseEndsAt, ctx.now) : state.phaseEndsAt },
          // That someone voted is public; who they voted for is not, until the reveal.
          [{ type: 'PLAYER_ANSWERED', data: { playerId } }],
        )
      }
    }
  },

  advance(state, ctx) {
    switch (state.phase) {
      case 'ROLES': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        return transition(
          {
            ...state,
            phase: 'DISCUSSION',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + state.discussionSeconds * 1000,
          },
          [{ type: 'ROUND_STARTED', data: { round: state.round } }],
        )
      }

      case 'DISCUSSION': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        return transition(
          {
            ...state,
            phase: 'VOTE',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + state.voteSeconds * 1000,
            votes: {},
          },
          [],
        )
      }

      case 'VOTE': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const result = resolveVote(state)
        const alive = result.eliminated === null ? state.alive : state.alive.filter((id) => id !== result.eliminated)

        // Fans win the moment the imposter is voted out. The imposter wins by
        // surviving every round, or by outlasting the table down to two.
        let outcome: MafiaState['outcome'] = null
        if (result.wasImposter) outcome = 'FANS_WIN'
        else if (state.round >= state.totalRounds) outcome = 'IMPOSTER_WINS'
        else if (alive.filter((id) => id !== state.imposterId).length <= 1) outcome = 'IMPOSTER_WINS'

        const deltas: Record<PlayerId, number> = {}
        if (outcome === 'FANS_WIN') {
          for (const [voter, target] of Object.entries(state.votes)) {
            if (target === state.imposterId) deltas[voter] = FAN_CORRECT_POINTS
          }
          for (const id of state.alive) {
            if (id === state.imposterId) continue
            deltas[id] = (deltas[id] ?? 0) + FAN_TEAM_BONUS
          }
        } else if (outcome === 'IMPOSTER_WINS') {
          deltas[state.imposterId] = IMPOSTER_SURVIVAL_POINTS + IMPOSTER_WIN_BONUS
        } else {
          // Survived another round without being caught.
          deltas[state.imposterId] = Math.round(IMPOSTER_SURVIVAL_POINTS / state.totalRounds)
        }

        return transition(
          {
            ...state,
            phase: 'RESULT',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + RESULT_MS,
            alive,
            history: [...state.history, result],
            outcome,
          },
          [{ type: 'ROUND_ENDED', data: { eliminated: result.eliminated, tied: result.tied } }],
          deltas,
        )
      }

      case 'RESULT': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        if (state.outcome !== null) {
          return transition(
            { ...state, phase: 'FINISHED', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt },
            [{ type: 'GAME_COMPLETED', data: { outcome: state.outcome } }],
          )
        }
        return transition(
          {
            ...state,
            round: state.round + 1,
            phase: 'DISCUSSION',
            phaseStartedAt: state.phaseEndsAt,
            phaseEndsAt: state.phaseEndsAt + state.discussionSeconds * 1000,
            votes: {},
          },
          [{ type: 'ROUND_STARTED', data: { round: state.round + 1 } }],
        )
      }

      case 'FINISHED':
        return noChange(state)
    }
  },

  onPlayerInactive(state, playerId, ctx) {
    if (state.phase === 'FINISHED') return noChange(state)

    // Losing the imposter would leave a game nobody can win. End it and say so
    // rather than let the table hunt a player who is no longer there.
    if (playerId === state.imposterId) {
      return transition(
        { ...state, phase: 'FINISHED', outcome: 'FANS_WIN', phaseStartedAt: ctx.now, phaseEndsAt: ctx.now },
        [{ type: 'GAME_COMPLETED', data: { outcome: 'FANS_WIN', reason: 'imposter-left' } }],
      )
    }

    const alive = state.alive.filter((id) => id !== playerId)
    if (alive.filter((id) => id !== state.imposterId).length <= 1) {
      return transition(
        { ...state, alive, phase: 'FINISHED', outcome: 'IMPOSTER_WINS', phaseStartedAt: ctx.now, phaseEndsAt: ctx.now },
        [{ type: 'GAME_COMPLETED', data: { outcome: 'IMPOSTER_WINS', reason: 'too-few-fans' } }],
        { [state.imposterId]: IMPOSTER_SURVIVAL_POINTS },
      )
    }

    if (state.phase !== 'VOTE') return transition({ ...state, alive })
    const votes = { ...state.votes }
    delete votes[playerId]
    const voters = aliveActive({ ...state, alive }, ctx)
    const allIn = voters.length > 0 && voters.every((id) => votes[id] !== undefined)
    return transition({ ...state, alive, votes, phaseEndsAt: allIn ? Math.min(state.phaseEndsAt, ctx.now) : state.phaseEndsAt })
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    const decided = state.phase === 'FINISHED' || (state.phase === 'RESULT' && state.outcome !== null)

    const view: Record<string, unknown> = {
      round: state.round,
      totalRounds: state.totalRounds,
      alive: state.alive,
      votedPlayerIds: Object.keys(state.votes),
      aliveCount: aliveActive(state, ctx).length,
    }

    // The viewer's own clue, and only theirs. Nobody else's clue text appears
    // anywhere in this object, so clues cannot be compared client-side.
    if (viewerId !== null) {
      const mine = state.clues[viewerId]
      if (mine !== undefined) view['yourClue'] = mine
      const myVote = state.votes[viewerId]
      if (myVote !== undefined) view['yourVote'] = myVote
      // A player is told they are the imposter, because playing the role
      // requires knowing it. Nobody else's payload carries this flag.
      if (viewerId === state.imposterId) view['youAreImposter'] = true
    }

    if (state.phase === 'RESULT' || state.phase === 'FINISHED') {
      const last = state.history.at(-1)
      if (last !== undefined) {
        view['lastRound'] = { tally: last.tally, eliminated: last.eliminated, tied: last.tied, votes: last.votes }
      }
    }

    if (decided) {
      // The reveal. Everything held back until now lands at once.
      view['outcome'] = state.outcome
      view['imposterId'] = state.imposterId
      view['subject'] = state.subject.title
      view['fanClue'] = state.subject.fanClue
      view['imposterClue'] = state.subject.imposterClue
    }

    return {
      gameId: 'movie-mafia',
      sessionId: state.sessionId,
      phase: state.phase,
      roundNumber: state.round,
      totalRounds: state.totalRounds,
      view,
    }
  },
})
