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
  type TurnContext,
  type ViewContext,
} from '../types.ts'

/**
 * Paata Pattu.
 *
 * Name the Telugu song from its opening seconds, as a room. Everyone hears the
 * same intro at the same moment, and it grows for everyone on one clock: two
 * seconds, then four, seven, ten and fifteen. It is Name That Tune rather than
 * the daily puzzle it started from, because what makes a song game fun with
 * friends is the shared "I know this" moment, and a ladder each player climbs
 * alone never produces one.
 *
 * The rules that make it a race:
 *
 *  - One guess per clue. A wrong pick locks you out until the next clue opens,
 *    so guessing on two seconds is a real bet, not a free look.
 *  - What a right answer pays depends on the clue it landed on, plus a bonus
 *    for being first, second or third.
 *  - A pick from the right film but the wrong song says so, privately, and
 *    pays a little once. Plenty of people know the movie before the song.
 *  - Nobody waits on a clock for nothing. When everyone has used this clue's
 *    guess, the next clue opens now; when everyone has it, the round ends.
 *
 * A guess is a pick from the catalog, never free text: song titles are
 * transliterated a dozen ways, and matching typed text would make it a spelling
 * game. The catalog is the whole pool, so the list gives nothing away.
 *
 * The clip limit is enforced by the player in the browser: YouTube streams the
 * whole video, so a determined player could always listen on. The answer's
 * title stays out of the payload until the reveal; the video id cannot.
 */

const COUNTDOWN_MS = 3_000
/** Long enough to hear the full fifteen seconds together at the reveal. */
const REVEAL_MS = 16_000
/** Seconds of audio each clue plays. */
export const CLIP_SECONDS = [2, 4, 7, 10, 15] as const
export const STAGE_COUNT = CLIP_SECONDS.length
/** Thinking time after a clue has finished playing, before the next opens. */
export const THINK_MS = 6_000
/** What a right answer pays, by the clue it landed on. */
export const STAGE_POINTS = [1000, 800, 600, 400, 250] as const
/** Right film, wrong song. Paid once a round. */
export const MOVIE_POINTS = 100
/**
 * How a Mixed game is made up. The pool runs back to the 1950s, and a uniform
 * draw would hand a room of twenty-somethings two songs older than their
 * parents every game; mostly songs they know, with a classic or two, is the mix.
 */
export const MIXED_SHARE = { easy: 0.45, medium: 0.4, hard: 0.15 } as const

type Phase = 'COUNTDOWN' | 'QUESTION' | 'REVEAL' | 'FINISHED'
type GuessKind = 'correct' | 'movie' | 'wrong'
type AudioMode = 'everyone' | 'host'

interface Guess {
  trackId: string
  /** Which clue was open, 0-based. */
  stage: number
  /** Server receive time. */
  at: number
  kind: GuessKind
}

interface PlayerRound {
  guesses: Guess[]
  solvedStage: number | null
  /** Order among the players who got it this round, 1-based. */
  place: number | null
  points: number
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
  /** In QUESTION these bound the clue currently open: the room's timer
   *  counts down to the next clue, not to the end of the song. */
  phaseStartedAt: number
  phaseEndsAt: number
  /** The clue currently open, 0-based. Meaningful in QUESTION. */
  stage: number
  rounds: Record<PlayerId, PlayerRound>
  solvedCount: number
  audio: AudioMode
}

const settingsSchema = z.strictObject({
  songs: z.int().min(3).max(15).default(8),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
  audio: z.enum(['everyone', 'host']).default('everyone'),
})

type PaataSettings = z.infer<typeof settingsSchema>

const settingsSpec: SettingField[] = [
  { key: 'songs', label: 'Songs', kind: 'int', min: 3, max: 15, step: 1, default: 8 },
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
  {
    key: 'audio',
    label: 'Music plays on',
    help: 'One speaker for the room, or the host sharing audio on a call: pick the host. Everyone apart: every phone.',
    kind: 'choice',
    default: 'everyone',
    options: [
      { value: 'everyone', label: 'Every phone' },
      { value: 'host', label: "Host's device only" },
    ],
  },
]

const actionSchema = z.strictObject({
  type: z.literal('song/guess'),
  payload: z.strictObject({ trackId: z.string().min(1).max(80) }),
})

// ---------------------------------------------------------------------------

function currentSong(state: PaataState): SongQuestion | null {
  return state.songs[state.roundIndex] ?? null
}

function roundFor(state: PaataState, playerId: PlayerId): PlayerRound {
  return state.rounds[playerId] ?? { guesses: [], solvedStage: null, place: null, points: 0 }
}

function activePlayerIds(ctx: { players: { id: PlayerId; presence: string }[] }): PlayerId[] {
  return ctx.players.filter((p) => p.presence !== 'INACTIVE').map((p) => p.id)
}

function usedThisStage(round: PlayerRound, stage: number): boolean {
  return round.solvedStage !== null || round.guesses.some((g) => g.stage === stage)
}

function everyoneSolved(state: PaataState, ctx: { players: { id: PlayerId; presence: string }[] }): boolean {
  const active = activePlayerIds(ctx)
  return active.length > 0 && active.every((id) => roundFor(state, id).solvedStage !== null)
}

function everyoneUsedStage(state: PaataState, ctx: { players: { id: PlayerId; presence: string }[] }): boolean {
  const active = activePlayerIds(ctx)
  return active.length > 0 && active.every((id) => usedThisStage(roundFor(state, id), state.stage))
}

/** How long clue `stage` stays open: the clip itself, then time to think. */
export function stageWindowMs(stage: number): number {
  return (CLIP_SECONDS[stage] ?? 0) * 1000 + THINK_MS
}

/** Pull the clock in when nobody is left to act on this clue. */
function settleEarly(state: PaataState, ctx: TurnContext): PaataState {
  if (state.phase !== 'QUESTION') return state
  if (everyoneSolved(state, ctx) || everyoneUsedStage(state, ctx)) {
    return { ...state, phaseEndsAt: Math.min(state.phaseEndsAt, ctx.now) }
  }
  return state
}

function parseGuess(action: GameAction): string | null {
  const parsed = actionSchema.safeParse(action)
  return parsed.success ? parsed.data.payload.trackId : null
}

function validate(state: PaataState, playerId: PlayerId, action: GameAction): Result<void> {
  const trackId = parseGuess(action)
  if (trackId === null) return reject('INVALID_ACTION')
  if (state.phase !== 'QUESTION') return reject('ROUND_CLOSED')
  if (currentSong(state) === null) return reject('INVALID_ROUND')
  if (usedThisStage(roundFor(state, playerId), state.stage)) return reject('ALREADY_ANSWERED')
  if (!state.catalog.some((entry) => entry.id === trackId)) return reject('INVALID_ACTION')
  return accept
}

function entryOf(state: PaataState, trackId: string): CatalogEntry | null {
  return state.catalog.find((entry) => entry.id === trackId) ?? null
}

function startCountdown(state: PaataState, now: number): PaataState {
  return {
    ...state,
    phase: 'COUNTDOWN',
    phaseStartedAt: now,
    phaseEndsAt: now + COUNTDOWN_MS,
    stage: 0,
    rounds: {},
    solvedCount: 0,
  }
}

function toReveal(state: PaataState, at: number): Transition<PaataState> {
  return transition(
    { ...state, phase: 'REVEAL', phaseStartedAt: at, phaseEndsAt: at + REVEAL_MS },
    [{ type: 'ROUND_ENDED', data: { round: state.roundIndex + 1 } }],
  )
}

// ---------------------------------------------------------------------------

/**
 * The guess box's list: every song in the pool, by title. The server also hands
 * this out over HTTP (GET /api/songs), once per page, because at a thousand
 * songs it is too big to ride along in every room update.
 */
export function songCatalog(pool: readonly SongQuestion[]): CatalogEntry[] {
  return pool
    .map((song) => ({ id: song.id, title: song.title, movie: song.movie, year: song.year, aliases: song.aliases }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

type DrawOptions = Parameters<typeof pickFresh>[1]

/** One difficulty. A thin one widens to everything rather than play a short game. */
function drawOne(pool: SongQuestion[], difficulty: SongQuestion['difficulty'], options: DrawOptions): SongQuestion[] {
  const matching = pool.filter((song) => song.difficulty === difficulty)
  return pickFresh(matching.length >= options.count ? matching : pool, options).items
}

/** Each difficulty's share of the game, then any shortfall from the rest of the pool. */
function drawMixed(pool: SongQuestion[], options: DrawOptions): SongQuestion[] {
  const drawn: SongQuestion[] = []
  for (const [difficulty, share] of Object.entries(MIXED_SHARE)) {
    const matching = pool.filter((song) => song.difficulty === difficulty)
    drawn.push(...pickFresh(matching, { ...options, count: Math.round(options.count * share) }).items)
  }
  const taken = new Set(drawn.map((song) => song.id))
  const rest = pool.filter((song) => !taken.has(song.id))
  drawn.push(...pickFresh(rest, { ...options, count: Math.max(0, options.count - drawn.length) }).items)
  return options.rng.shuffle(drawn.slice(0, options.count))
}

export const paataPattu: ErasedGameDefinition = defineGame<PaataState, PaataSettings>({
  id: 'paata-pattu',
  meta: {
    name: 'Paata Pattu',
    tagline: 'Name the Telugu song before your friends do.',
    description:
      'The whole room hears the same intro: two seconds, then four, seven, ten, fifteen. One guess per clue, and a wrong one locks you out till the next. Get it first, on the shortest clue, for the most points.',
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

    const options = { count: ctx.settings.songs, recentIds: ctx.recentContentIds, rng }
    const drawn =
      ctx.settings.difficulty === 'mixed' ? drawMixed(pool, options) : drawOne(pool, ctx.settings.difficulty, options)

    const catalog = songCatalog(pool)

    return {
      sessionId: ctx.sessionId,
      phase: 'COUNTDOWN',
      roundIndex: 0,
      songs: drawn,
      catalog,
      phaseStartedAt: ctx.now,
      phaseEndsAt: ctx.now + COUNTDOWN_MS,
      stage: 0,
      rounds: {},
      solvedCount: 0,
      audio: ctx.settings.audio,
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
    const trackId = parseGuess(action)
    const picked = trackId === null ? null : entryOf(state, trackId)
    if (song === null || trackId === null || picked === null) return noChange(state)

    const mine = roundFor(state, playerId)
    // Picking a song you already tried is a slip, not a new bet. Swallow it so
    // it cannot spend this clue's guess.
    if (mine.guesses.some((g) => g.trackId === trackId)) return noChange(state)

    // The year tells apart two films of one name (Adavi Ramudu, 1977 and 2004);
    // a song whose year is unknown is taken at its film's word.
    const sameFilm =
      picked.movie === song.movie && (picked.year === null || song.year === null || picked.year === song.year)
    const kind: GuessKind =
      trackId === song.id ? 'correct' : sameFilm && !mine.guesses.some((g) => g.kind === 'movie') ? 'movie' : 'wrong'
    const guesses = [...mine.guesses, { trackId, stage: state.stage, at: ctx.now, kind }]

    const events: EngineEvent[] = []
    let round: PlayerRound = { ...mine, guesses }
    let solvedCount = state.solvedCount
    let points = 0

    if (kind === 'correct') {
      const place = state.solvedCount + 1
      points = (STAGE_POINTS[state.stage] ?? 0) + placementBonus(place)
      round = { ...round, solvedStage: state.stage, place, points: round.points + points }
      solvedCount = place
      events.push({ type: 'PLAYER_ANSWERED', data: { playerId, correct: true } })
    } else if (kind === 'movie') {
      points = MOVIE_POINTS
      round = { ...round, points: round.points + points }
    }

    const next = settleEarly({ ...state, rounds: { ...state.rounds, [playerId]: round }, solvedCount }, ctx)
    return points > 0 ? transition(next, events, { [playerId]: points }) : transition(next, events)
  },

  advance(state, ctx) {
    switch (state.phase) {
      case 'COUNTDOWN': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const start = state.phaseEndsAt
        return transition(
          { ...state, phase: 'QUESTION', phaseStartedAt: start, phaseEndsAt: start + stageWindowMs(0), stage: 0 },
          [{ type: 'ROUND_STARTED', data: { round: state.roundIndex + 1, total: state.songs.length } }],
        )
      }

      case 'QUESTION': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
        const at = state.phaseEndsAt
        if (everyoneSolved(state, ctx) || state.stage + 1 >= STAGE_COUNT) return toReveal(state, at)
        // The next clue opens for everyone at once, with everyone's guess back.
        const stage = state.stage + 1
        return transition({ ...state, stage, phaseStartedAt: at, phaseEndsAt: at + stageWindowMs(stage) }, [])
      }

      case 'REVEAL': {
        if (ctx.now < state.phaseEndsAt) return noChange(state)
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
    // Their seat is gone, so whoever is left may now all be done with this clue.
    const next = settleEarly(state, ctx)
    return next === state ? noChange(state) : transition(next, [])
  },

  getPublicState(state, viewerId, ctx: ViewContext): GamePublicState {
    const song = currentSong(state)
    const revealed = state.phase === 'REVEAL' || state.phase === 'FINISHED'

    // The race, as everyone sees it: who has it and on which clue, and how many
    // misses. Never which songs anybody picked — that waits for the reveal.
    const board: Record<string, { solvedStage: number | null; place: number | null; misses: number; usedStage: boolean }> = {}
    for (const [playerId, round] of Object.entries(state.rounds)) {
      board[playerId] = {
        solvedStage: round.solvedStage,
        place: round.place,
        misses: round.guesses.filter((g) => g.kind !== 'correct').length,
        usedStage: usedThisStage(round, state.stage),
      }
    }

    const view: Record<string, unknown> = {
      clipSeconds: CLIP_SECONDS,
      stage: state.stage,
      // The whole last clue opens up at the reveal, for everyone to hear together.
      unlockedSeconds: revealed ? CLIP_SECONDS[STAGE_COUNT - 1] : CLIP_SECONDS[state.stage],
      audio: state.audio,
      board,
      activeCount: activePlayerIds(ctx).length,
    }

    if (song !== null && state.phase !== 'FINISHED') {
      // Sent from the countdown on so a player can load before the clock
      // starts. The clip limit itself is the client's job; see the header.
      view['clip'] = { videoId: song.videoId, startOffsetMs: song.startOffsetMs }
    }


    if (viewerId !== null) {
      const mine = roundFor(state, viewerId)
      view['you'] = {
        solvedStage: mine.solvedStage,
        place: mine.place,
        points: mine.points,
        canGuess: state.phase === 'QUESTION' && !usedThisStage(mine, state.stage),
        guesses: mine.guesses.map((g) => ({ title: entryOf(state, g.trackId)?.title ?? null, kind: g.kind, stage: g.stage })),
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
          solvedStage: round.solvedStage,
          place: round.place,
          points: round.points,
          picks: round.guesses.map((g) => ({ title: entryOf(state, g.trackId)?.title ?? null, kind: g.kind, stage: g.stage })),
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
