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
import { expectItems, type ContentRequest, type SongQuestion } from '../content.ts'
import { placementBonus } from '../scoring.ts'
import { pickFresh } from '../selection.ts'
import {
  defineGame,
  noChange,
  transition,
  type CreateContext,
  type EngineEvent,
  type ErasedGameDefinition,
  type GameAction,
  type Transition,
  type ViewContext,
} from '../types.ts'

/**
 * Paata Pattu.
 *
 * Name the Telugu song from its opening seconds. Everyone hears the same song,
 * but each player climbs their own ladder of clues: two seconds, then four,
 * seven, ten and fifteen. A wrong guess or a skip unlocks the next, longer clip
 * for that player alone, so a confident ear can win the round on the first
 * clue while the rest of the table is still listening.
 *
 * Three rules shape it:
 *
 *  - A guess is a pick from the catalog, never free text. Song titles are
 *    transliterated a dozen ways ("Yentha" / "Entha"), so matching typed text
 *    would turn a music game into a spelling game. The catalog is the whole
 *    pool, not just this session's songs, so the list itself gives nothing away.
 *  - What you earn depends on which clue you needed, not on the clock. The
 *    round timer only stops a table from waiting forever on one person.
 *  - Everyone sees everyone's ladder — wrong, skipped, solved — but not what
 *    anybody picked until the reveal. Watching a friend go green on the first
 *    clue is the whole point; seeing their pick would hand you the answer.
 *
 * The clip limit is enforced by the player in the browser: YouTube streams the
 * whole video, so a determined player could always listen further. That is the
 * same trade the daily original makes, and the reason there is no anti-cheat
 * theatre here beyond keeping the title out of the payload.
 */

const COUNTDOWN_MS = 3_000
const REVEAL_MS = 10_000
/** Seconds of audio each attempt unlocks. The last clue is the most you get. */
export const CLIP_SECONDS = [2, 4, 7, 10, 15] as const
export const MAX_ATTEMPTS = CLIP_SECONDS.length
/** Points by the attempt that landed, first clue first. */
export const ATTEMPT_POINTS = [1000, 750, 550, 400, 250] as const

type Phase = 'COUNTDOWN' | 'QUESTION' | 'REVEAL' | 'FINISHED'
type Mark = 'correct' | 'wrong' | 'skipped'
type Status = 'playing' | 'won' | 'lost'

interface Attempt {
  kind: Mark
  /** The catalog entry picked; null for a skip. */
  trackId: string | null
  /** Server receive time. */
  at: number
}

interface PlayerRound {
  attempts: Attempt[]
  status: Status
  points: number
  /** Order among the players who solved it this round, 1-based. */
  place: number | null
}

/** What the guess box searches. Deliberately carries no clip and no difficulty. */
export interface CatalogEntry {
  id: string
  title: string
  movie: string
  year: number | null
  aliases: string[]
}

interface PaataState {
  sessionId: string
  phase: Phase
  roundIndex: number
  songs: SongQuestion[]
  catalog: CatalogEntry[]
  phaseStartedAt: number
  phaseEndsAt: number
  rounds: Record<PlayerId, PlayerRound>
  solvedCount: number
  /** Fixed at creation so every transition reads the same number. */
  roundSeconds: number
}

const settingsSchema = z.strictObject({
  songs: z.int().min(3).max(15).default(8),
  seconds: z.int().min(30).max(120).default(60),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
})

type PaataSettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'songs', label: 'Songs', kind: 'int', min: 3, max: 15, step: 1, default: 8 },
  {
    key: 'seconds',
    label: 'Time per song',
    help: 'How long the table has to work through its five clues.',
    kind: 'int',
    min: 30,
    max: 120,
    step: 10,
    default: 60,
    unit: 's',
  },
  {
    key: 'difficulty',
    label: 'Difficulty',
    kind: 'choice',
    default: 'mixed',
    options: [
      { value: 'easy', label: 'Chartbusters' },
      { value: 'medium', label: 'Hits' },
      { value: 'hard', label: 'Classics & deep cuts' },
      { value: 'mixed', label: 'Mixed' },
    ],
  },
]

const guessSchema = z.strictObject({
  type: z.literal('song/guess'),
  payload: z.strictObject({ trackId: z.string().min(1).max(80) }),
})
const skipSchema = z.strictObject({
  type: z.literal('song/skip'),
  payload: z.strictObject({}),
})
const actionSchema = z.union([guessSchema, skipSchema])

// ---------------------------------------------------------------------------

function currentSong(state: PaataState): SongQuestion | null {
  return state.songs[state.roundIndex] ?? null
}

function roundFor(state: PaataState, playerId: PlayerId): PlayerRound {
  return state.rounds[playerId] ?? { attempts: [], status: 'playing', points: 0, place: null }
}

function activePlayerIds(ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  return ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id)
}

function everyoneDone(state: PaataState, ctx: { players: { id: PlayerId; presence: string }[] }): boolean {
  const active = activePlayerIds(ctx)
  return active.length > 0 && active.every((id) => roundFor(state, id).status !== 'playing')
}

/** Seconds of audio a player may hear, given how many attempts they have spent. */
export function clipSecondsFor(attemptsUsed: number): number {
  return CLIP_SECONDS[Math.min(attemptsUsed, MAX_ATTEMPTS - 1)] as number
}

/** The picked track id, `null` for a skip, or undefined when the frame is not ours. */
function parseAction(action: GameAction): string | null | undefined {
  const parsed = actionSchema.safeParse(action)
  if (!parsed.success) return undefined
  return parsed.data.type === 'song/guess' ? parsed.data.payload.trackId : null
}

function validate(state: PaataState, playerId: PlayerId, action: GameAction): Result<void> {
  const trackId = parseAction(action)
  if (trackId === undefined) return reject('INVALID_ACTION')
  if (state.phase !== 'QUESTION') return reject('ROUND_CLOSED')
  if (currentSong(state) === null) return reject('INVALID_ROUND')
  if (roundFor(state, playerId).status !== 'playing') return reject('ALREADY_ANSWERED')
  if (trackId !== null && !state.catalog.some((entry) => entry.id === trackId)) return reject('INVALID_ACTION')
  return accept
}

function startCountdown(state: PaataState, now: number): PaataState {
  return { ...state, phase: 'COUNTDOWN', phaseStartedAt: now, phaseEndsAt: now + COUNTDOWN_MS, rounds: {}, solvedCount: 0 }
}

function titleOf(state: PaataState, trackId: string | null): string | null {
  if (trackId === null) return null
  return state.catalog.find((entry) => entry.id === trackId)?.title ?? null
}

// ---------------------------------------------------------------------------

export const paataPattu: ErasedGameDefinition = defineGame<PaataState, PaataSettings>({
  id: 'paata-pattu',
  meta: {
    name: 'Paata Pattu',
    tagline: 'Name the Telugu song from its first two seconds.',
    description:
      'Everyone hears the same intro. Guess it on two seconds for big points, or skip and earn four, then seven, ten, fifteen. Five tries each, and the whole table watches your ladder fill up.',
    emoji: '📼',
    accent: 'amber',
    estimatedMinutes: 8,
    playable: true,
  },
  minPlayers: 1,
  maxPlayers: 12,
  settingsSpec,
  settingsSchema,
  actionSchema,

  contentRequest(settings): ContentRequest {
    // Always the whole pool: it doubles as the catalog the guess box searches,
    // and a catalog narrowed to one difficulty would narrow the answer with it.
    // Difficulty is applied to the draw in createGame instead.
    return { kind: 'song', count: settings.songs, difficulty: 'mixed', category: null }
  },

  createGame(ctx: CreateContext<PaataSettings>): PaataState {
    const pool = expectItems(ctx.content, 'song')
    const rng = createRng(ctx.seed, 'paata-pattu', ctx.sessionId)

    const byDifficulty =
      ctx.settings.difficulty === 'mixed' ? pool : pool.filter((song) => song.difficulty === ctx.settings.difficulty)
    // A thin difficulty widens to everything rather than playing a short game.
    const eligible = byDifficulty.length >= ctx.settings.songs ? byDifficulty : pool
    const drawn = pickFresh(eligible, { count: ctx.settings.songs, recentIds: ctx.recentContentIds, rng })

    const catalog: CatalogEntry[] = pool
      .map((song) => ({ id: song.id, title: song.title, movie: song.movie, year: song.year, aliases: song.aliases }))
      .sort((a, b) => a.title.localeCompare(b.title))

    return {
      sessionId: ctx.sessionId,
      phase: 'COUNTDOWN',
      roundIndex: 0,
      songs: drawn.items,
      catalog,
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + COUNTDOWN_MS,
      rounds: {},
      solvedCount: 0,
      roundSeconds: ctx.settings.seconds,
    }
  },

  getDeadline: (state) => (state.phase === 'FINISHED' ? null : state.phaseEndsAt),
  getPhase: (state) => state.phase,
  isGameOver: (state) => state.phase === 'FINISHED',
  usedContentIds: (state) => state.songs.map((song) => song.id),

  validateAction: (state, playerId, action) => validate(state, playerId, action),

  applyAction(state, playerId, action, ctx): Transition<PaataState> {
    if (!validate(state, playerId, action).ok) return noChange(state)
    const song = currentSong(state)
    const trackId = parseAction(action)
    if (song === null || trackId === undefined) return noChange(state)

    const mine = roundFor(state, playerId)

    // Picking a song you already tried is a double-tap or a slip, not a new
    // attempt. Swallow it so it cannot burn a clue.
    if (trackId !== null && mine.attempts.some((a) => a.trackId === trackId)) return noChange(state)

    const kind: Mark = trackId === null ? 'skipped' : trackId === song.id ? 'correct' : 'wrong'
    const attempts = [...mine.attempts, { kind, trackId, at: ctx.now }]
    const events: EngineEvent[] = []
    let round: PlayerRound = { ...mine, attempts }
    let solvedCount = state.solvedCount
    let points = 0

    if (kind === 'correct') {
      const place = state.solvedCount + 1
      points = (ATTEMPT_POINTS[attempts.length - 1] ?? 0) + placementBonus(place)
      round = { ...round, status: 'won', points, place }
      solvedCount = place
      events.push({ type: 'PLAYER_ANSWERED', data: { playerId, correct: true } })
    } else if (attempts.length >= MAX_ATTEMPTS) {
      round = { ...round, status: 'lost' }
      events.push({ type: 'PLAYER_ANSWERED', data: { playerId, correct: false } })
    }

    let next: PaataState = { ...state, rounds: { ...state.rounds, [playerId]: round }, solvedCount }

    // Everyone still seated has finished their ladder: stop the clock rather
    // than make them watch it run down.
    if (everyoneDone(next, ctx)) next = { ...next, phaseEndsAt: Math.min(next.phaseEndsAt, ctx.now) }

    return points > 0 ? transition(next, events, { [playerId]: points }) : transition(next, events)
  },

  advance(state, ctx) {
    if (ctx.now < state.phaseEndsAt) return noChange(state)
    switch (state.phase) {
      case 'COUNTDOWN':
        return transition(
          { ...state, phase: 'QUESTION', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt + state.roundSeconds * 1000 },
          [{ type: 'ROUND_STARTED', data: { round: state.roundIndex + 1, total: state.songs.length } }],
        )

      case 'QUESTION':
        return transition(
          { ...state, phase: 'REVEAL', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt + REVEAL_MS },
          [{ type: 'ROUND_ENDED', data: { round: state.roundIndex + 1 } }],
        )

      case 'REVEAL': {
        if (state.roundIndex + 1 >= state.songs.length) {
          return transition(
            { ...state, phase: 'FINISHED', phaseStartedAt: state.phaseEndsAt, phaseEndsAt: state.phaseEndsAt },
            [{ type: 'GAME_COMPLETED', data: { rounds: state.songs.length } }],
          )
        }
        return transition(startCountdown({ ...state, roundIndex: state.roundIndex + 1 }, state.phaseEndsAt), [])
      }

      case 'FINISHED':
        return noChange(state)
    }
  },

  onPlayerInactive(state, _playerId, ctx) {
    if (state.phase !== 'QUESTION' || !everyoneDone(state, ctx)) return noChange(state)
    return transition({ ...state, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now) }, [])
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    const song = currentSong(state)
    const revealed = state.phase === 'REVEAL' || state.phase === 'FINISHED'

    // Everyone's ladder, as marks only. Which song a player picked is the one
    // thing that would give the answer away, so it waits for the reveal.
    const ladders: Record<string, { marks: Mark[]; status: Status }> = {}
    for (const [playerId, round] of Object.entries(state.rounds)) {
      ladders[playerId] = { marks: round.attempts.map((a) => a.kind), status: round.status }
    }

    const view: Record<string, unknown> = {
      clipSeconds: CLIP_SECONDS,
      maxAttempts: MAX_ATTEMPTS,
      ladders,
      activeCount: activePlayerIds(ctx).length,
    }

    if (song !== null && state.phase !== 'FINISHED') {
      // Sent from the countdown on so the player can load before the clock
      // starts. The clip limit itself is the client's job; see the header.
      view['clip'] = { videoId: song.videoId, startOffsetMs: song.startOffsetMs }
    }

    if (state.phase === 'QUESTION') view['catalog'] = state.catalog

    if (viewerId !== null) {
      const mine = roundFor(state, viewerId)
      view['you'] = {
        status: mine.status,
        points: mine.points,
        attempts: mine.attempts.map((a) => ({ kind: a.kind, title: titleOf(state, a.trackId) })),
        // At the reveal the whole last clue opens up, whatever you managed.
        unlockedSeconds: revealed ? CLIP_SECONDS[MAX_ATTEMPTS - 1] : clipSecondsFor(mine.attempts.length),
      }
    }

    if (revealed && song !== null) {
      view['answer'] = {
        title: song.title,
        movie: song.movie,
        year: song.year,
        youtubeUrl: `https://www.youtube.com/watch?v=${song.videoId}`,
      }
      view['results'] = Object.entries(state.rounds)
        .map(([playerId, round]) => ({
          playerId,
          marks: round.attempts.map((a) => a.kind),
          status: round.status,
          points: round.points,
          place: round.place,
          picks: round.attempts.map((a) => titleOf(state, a.trackId)).filter((t): t is string => t !== null),
        }))
        .sort((a, b) => b.points - a.points)
    }

    return {
      gameId: 'paata-pattu',
      sessionId: state.sessionId,
      phase: state.phase,
      roundNumber: state.roundIndex + 1,
      totalRounds: state.songs.length,
      view,
    }
  },
})
