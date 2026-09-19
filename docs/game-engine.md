# The game engine

## The claim

The room infrastructure does not know the rules of any game. It routes actions,
applies score deltas, schedules deadlines and broadcasts per-viewer state
without branching on which game is running.

That is checkable rather than aspirational:

```bash
grep -rn "blur-battle\|who-am-i\|emoji-movie\|mind-meld\|movie-mafia" apps/server/src
```

returns nothing outside the registry wiring. Adding a sixth game touches one
array in `packages/game-engine/src/index.ts` and adds one component to the web
app's screen map.

## The contract

```ts
interface GameDefinition<S, Cfg> {
  id: string
  meta: GameMeta                    // name, tagline, emoji, accent, minutes
  minPlayers: number
  maxPlayers: number

  settingsSpec: SettingField[]      // drives the host's form, generically
  settingsSchema: z.ZodType<Cfg>    // the same settings, validated server-side
  actionSchema: z.ZodType<GameAction>

  contentRequest(settings): ContentRequest
  createGame(ctx): S

  getPublicState(state, viewerId, ctx): GamePublicState
  validateAction(state, playerId, action, ctx): Result<void>
  applyAction(state, playerId, action, ctx): Transition<S>
  advance(state, ctx): Transition<S>
  onPlayerInactive(state, playerId, ctx): Transition<S>

  getDeadline(state): number | null
  getPhase(state): string
  isGameOver(state): boolean
}
```

### Every method is pure

Given the same state, action and context, a reducer produces the same
transition. That is not a style preference — it is what makes the
compare-and-set retry in the room store correct. When a write loses its race,
the reducer is simply re-run against whichever state won, and the result is
identical to having gone second in the first place. There is no partial
mutation to unwind because nothing was mutated.

It also means a whole game can be played in a unit test with no server, no
Redis and no clock: pass timestamps in, get transitions out.

### Randomness is derived, not drawn

`Math.random()` would break purity, so every draw comes from the room's stored
seed plus a label describing what is being drawn:

```ts
const rng = createRng(ctx.seed, 'blur-battle', ctx.sessionId)
const questions = rng.sample(pool, settings.questions)
```

There is no generator state to persist. The same seed rebuilds the same stream,
which makes a session reproducible — useful in a test, and useful when someone
disputes a score six hours later, because the seed is in Postgres.

### Content is baked in at creation

`createGame` receives the questions it will use and stores them in the session
state. Nothing queries a database mid-round. Two things follow: a round never
blocks on I/O while players are waiting, and re-deriving a session after a
restart cannot accidentally draw different questions.

### Scores are deltas, not state

A game returns `scoreDeltas` and the room applies them. The room owns
cumulative scores, which is why the leaderboard, the final results screen and
Play Again work identically for all five games without any of them implementing
a scoreboard.

## Hidden information

`getPublicState(state, viewerId, ctx)` is the only place a secret can be
withheld, and it withholds by **omission**:

```ts
// Who Am I? — build the identity map by skipping the viewer.
const others: Record<PlayerId, { name: string }> = {}
for (const [playerId, card] of Object.entries(state.identities)) {
  if (playerId === viewerId) continue
  others[playerId] = { name: card.name }
}
```

There is no `hidden: true` flag, no redacted placeholder, nothing encoded. The
field is not in the object, so it is not in the JSON, so it is not in the
browser. A modified client has nothing to read.

`tests/.../hidden-information.test.ts` is parameterised over the registry, so a
game added tomorrow is covered by the generic assertions the day it is
registered — and the per-game cases serialise a real payload and grep it for
the string that must not be there.

## The scheduling primitive

`getDeadline` is the whole of a game's relationship with time. The room service
runs this loop after every mutation:

```ts
while (guard++ < MAX_ADVANCE_STEPS) {
  const deadline = definition.getDeadline(state)
  if (deadline === null || deadline > now) break
  ;({ state, events } = definition.advance(state, ctx))
}
```

A transition may deliberately expire immediately in order to chain — which is
how "round ends → reveal → countdown → next round" happens in a single write.
The guard is there because a game with a bug that never settles would otherwise
take the instance with it.

## The five games

| Game | Phases | What it exercises |
| --- | --- | --- |
| Blur Battle | COUNTDOWN → QUESTION → REVEAL → … | Progressive disclosure, speed scoring, one-shot commitment |
| Emoji Movie | COUNTDOWN → QUESTION → REVEAL → … | Open racing with per-player cooldowns and attempt caps |
| Mind Meld | COUNTDOWN → PROMPT → REVEAL → … | Simultaneous submission, answer clustering, no right answer |
| Who Am I? | ASSIGN → ASK → VOTE → RESULT → … | Turn order, per-player secrets, voting, hint economy |
| Movie Mafia | ROLES → DISCUSSION → VOTE → RESULT → … | Asymmetric secrets, elimination, team scoring |

They are deliberately different shapes. Blur Battle and Emoji Movie look
similar but differ where it matters: Blur Battle gives one guess, because the
tension is committing early through heavy blur; Emoji Movie gives eight with a
cooldown, because the tension is a race. If both worked the same way, one of
them would not need to exist.

## Scoring

Timed games share one curve:

```
score = BASE × (FLOOR + (1 − FLOOR) × (1 − elapsed)^CURVE)
        BASE = 1000, FLOOR = 0.25, CURVE = 1.6

elapsed   0%     25%    50%    75%    100%
points    1000   734    497    332    250
```

Answering early pays roughly four times what answering at the buzzer does,
while a late correct answer still beats a wrong one by a wide margin.

In Blur Battle the same elapsed fraction drives how much of the image is
visible, so risk and reward are literally the same number and there is no
separate "blur bonus" to keep in sync. A small placement bonus (150 / 75 / 25)
rewards being first without letting the fastest typist dominate a lobby of
eight.

Mind Meld scores agreement instead: a group of *n* out of *t* answers earns
`1000 × (0.35 + 0.65 × n/t)`, and a unique answer earns nothing.

## Adding a game

1. Write a definition in `packages/game-engine/src/games/`.
2. Add it to the registry array in `index.ts`.
3. Add a screen to `apps/web/src/games/` and its entry in the screen map.

Nothing else changes. The lobby picks it up from `/api/games`, the host's
settings form renders from `settingsSpec`, the scheduler handles its deadlines,
and the hidden-information suite starts asserting against it.
