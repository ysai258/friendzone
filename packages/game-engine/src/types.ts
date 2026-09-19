import type { z } from 'zod'
import type { GamePublicState, PlayerId, PresenceState, PublicEventType, Result, SettingField } from '@friendzone/shared'
import type { ContentPack, ContentRequest } from './content.ts'

/**
 * The contract every game implements.
 *
 * The room service knows only this interface. It routes actions, applies score
 * deltas, schedules deadlines and broadcasts per-viewer state without a single
 * branch on which game is running — adding a sixth game touches the registry
 * and nothing else.
 *
 * Every method is pure. Given the same state, action and context they produce
 * the same transition, which is what lets a round be replayed in a test, and
 * what makes the compare-and-set retry in the room store safe: a retry simply
 * re-runs the reducer against the state that actually won.
 */
export interface GameDefinition<S, Cfg extends Record<string, unknown>> {
  readonly id: string
  readonly meta: GameMeta
  readonly minPlayers: number
  readonly maxPlayers: number

  /** Drives the host's settings form. The web app renders it generically. */
  readonly settingsSpec: SettingField[]
  readonly settingsSchema: z.ZodType<Cfg>
  /** Union of every action this game accepts. Parsed before the reducer sees it. */
  readonly actionSchema: z.ZodType<GameAction>

  /** What to load before a session can be created. */
  contentRequest(settings: Cfg): ContentRequest

  createGame(ctx: CreateContext<Cfg>): S

  /**
   * Build the payload for one specific viewer.
   *
   * This is the only place hidden information is filtered, and it filters by
   * omission: a secret a viewer may not have is absent from the object, not
   * flagged as hidden. There is nothing in the payload for a modified client
   * to read.
   */
  getPublicState(state: S, viewerId: PlayerId | null, ctx: ViewContext): GamePublicState

  /** Cheap legality check. Never mutates; used for early rejection and tests. */
  validateAction(state: S, playerId: PlayerId, action: GameAction, ctx: TurnContext): Result<void>

  applyAction(state: S, playerId: PlayerId, action: GameAction, ctx: TurnContext): Transition<S>

  /**
   * Move the game forward because its deadline has passed. Called in a loop
   * until `getDeadline` returns null or a time still in the future, so a
   * transition may legitimately expire immediately to chain into the next phase.
   */
  advance(state: S, ctx: TurnContext): Transition<S>

  /** A player's grace period ran out. The game decides how to stop waiting. */
  onPlayerInactive(state: S, playerId: PlayerId, ctx: TurnContext): Transition<S>

  /**
   * Epoch ms at which this state must be advanced, or null when the game is
   * waiting on a person rather than a clock. The single scheduling primitive:
   * the room service stores it in Redis and every instance watches that index.
   */
  getDeadline(state: S): number | null

  getPhase(state: S): string
  isGameOver(state: S): boolean
}

export interface GameMeta {
  name: string
  tagline: string
  description: string
  emoji: string
  /** Tailwind-friendly accent token used by the web app's game cards. */
  accent: string
  estimatedMinutes: number
  /** Present in the registry but hidden from the lobby while incomplete. */
  playable: boolean
}

/** A parsed, validated action. `type` is game-specific and never `room/`-prefixed. */
export interface GameAction {
  type: string
  payload: Record<string, unknown>
}

export interface EnginePlayer {
  id: PlayerId
  name: string
  joinSeq: number
  presence: PresenceState
}

interface BaseContext {
  /** Authoritative server clock. Reducers never call Date.now themselves. */
  now: number
  /** Per-room seed. All randomness derives from it, so draws are reproducible. */
  seed: string
  /** Everyone holding a seat, ordered by joinSeq. Includes disconnected players:
   *  a dropped socket does not forfeit a turn until the grace period expires. */
  players: EnginePlayer[]
}

export interface CreateContext<Cfg> extends BaseContext {
  sessionId: string
  settings: Cfg
  content: ContentPack
}

export interface ViewContext extends BaseContext {
  roomCode: string
}

export interface TurnContext extends BaseContext {
  /** Set only for an action; absent when advancing on a deadline. */
  actionId?: string
}

/**
 * The result of a reducer step.
 *
 * `scoreDeltas` is how a game moves the scoreboard without owning it. The room
 * service holds cumulative scores so the leaderboard, the final results screen
 * and Play Again work identically for every game.
 */
export interface Transition<S> {
  state: S
  events: EngineEvent[]
  scoreDeltas?: Record<PlayerId, number>
}

export interface EngineEvent {
  type: PublicEventType
  data: Record<string, unknown>
}

export function transition<S>(
  state: S,
  events: EngineEvent[] = [],
  scoreDeltas?: Record<PlayerId, number>,
): Transition<S> {
  return scoreDeltas === undefined ? { state, events } : { state, events, scoreDeltas }
}

/** No-op step, for when an advance finds nothing left to do. */
export function noChange<S>(state: S): Transition<S> {
  return { state, events: [] }
}

/**
 * A definition with its state type erased, which is what the registry and the
 * room service hold. TypeScript has no existential types, so the erased form is
 * simply `unknown` state; method parameter bivariance lets a concrete
 * definition widen into it without an assertion.
 *
 * The widening is safe in practice because a state never leaves the definition
 * that produced it: the game id is stored beside the state, and the room
 * service resolves the definition from that id before every call. Routing a
 * state to the wrong game is therefore impossible without first corrupting the
 * stored id, which is validated on read.
 *
 * `defineGame` exists to force that check at the definition site, so a game
 * that drifts from the contract fails here rather than at a call site.
 */
export type ErasedGameDefinition = GameDefinition<unknown, Record<string, unknown>>

export function defineGame<S, Cfg extends Record<string, unknown>>(
  def: GameDefinition<S, Cfg>,
): ErasedGameDefinition {
  return def
}
