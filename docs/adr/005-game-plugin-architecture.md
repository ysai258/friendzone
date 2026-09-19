# 5. Games as plugins behind one interface

## Context

Five games with genuinely different shapes: simultaneous racing, turn-taking,
hidden-role deduction, answer clustering. The brief asked specifically that the
room infrastructure not accumulate `if (game === "blur-battle")` branches, and
that new games be addable without rewriting the platform.

## Decision

Every game implements one interface. The room service resolves a definition from
a registry by id and calls it. There is no branch on game id anywhere in
`apps/server`.

Games declare their own settings schema and a declarative field spec, so the
host's configuration form renders generically from data the game supplies.

## Alternatives

**A shared base class with hooks.** Inheritance would have forced the five games
into one lifecycle. Movie Mafia has no rounds in the sense Blur Battle does, and
Who Am I? is turn-based while Mind Meld is simultaneous. Any base class general
enough for all of them would be an interface with extra steps.

**Game-specific endpoints.** Rejected; it just moves the branching into routing
and duplicates presence, scoring and reconnection per game.

**A rules DSL.** Would need to express turn order, hidden roles, voting,
clustering and progressive disclosure. That is a programming language, and
TypeScript is already here.

## Consequences

Good: adding a game touches one array in the registry and one entry in the web
app's screen map. Presence, reconnection, host migration, scoring, persistence,
the leaderboard and Play Again all work immediately, because none of them knows
what game is running.

Good: the games are pure functions, so a complete playthrough is a unit test
with no server, no Redis and no clock. All five are tested to termination that
way.

Good: the hidden-information suite is parameterised over the registry, so a game
added tomorrow is covered by the generic assertions the day it is registered.

Bad: TypeScript has no existential types, so the registry holds definitions with
their state type erased to `unknown`. Safe in practice because a state never
leaves the definition that produced it — the game id is stored beside the state
and resolved before every call — but it is a real seam and it is documented at
the point where it happens.

Bad: some cross-game features would need interface changes rather than a quick
edit. Adding a "spectator" concept, for example, would touch every definition.
That is the correct cost of the boundary, but it is a cost.
