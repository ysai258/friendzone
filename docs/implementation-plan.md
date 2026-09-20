# Implementation plan

Written at the start, annotated afterwards. The annotations are the useful
part: they mark where the plan was wrong.

## Discovery

**Existing code.** The repository sat beside an unrelated single-player game
(`evaru-ra`, a daily blurred-face guessing game). It shares a mechanic with
Blur Battle but nothing else — no backend, no rooms, no realtime. Decision:
build FriendZone standalone and leave it untouched, including writing an
independent content pipeline rather than borrowing its dataset.

**Ambiguities resolved without asking**, because a reasonable default existed:

- *Can people join mid-game?* No — a latecomer would have no score, no role and
  nothing to do until the round ended. They can join between games.
- *One guess or many?* Per game. Blur Battle gives one, because the tension is
  committing early through heavy blur. Emoji Movie gives eight with a cooldown,
  because the tension is a race. If both worked the same way one of them would
  not need to exist.
- *What happens to a disconnected player's score?* Kept. Anything else punishes
  people for bad Wi-Fi.
- *Does the host keep the room during a brief drop?* Yes, for their grace
  period. A ten-second tunnel should not hand the party away.

**Risks identified up front**, and what happened to each:

| Risk | Outcome |
| --- | --- |
| Hidden information leaking through public state | Addressed by filtering by omission; tests grep real payloads |
| Concurrent writes from several instances | Compare-and-set; measured conflicts confined to room formation |
| Timers lost on restart | Shared deadline index; tested by killing an instance mid-game |
| Duplicate actions double-scoring | Idempotency inside the CAS'd state; tested |
| Content licensing | Allow-list at fetch time; attribution carried to the reveal screen |
| Load numbers being fiction | Real generator, real sockets — and it still misled me once. See below. |

## Architecture as proposed

- Modular monolith: HTTP + WebSocket + scheduler in one process; a separate
  worker only for CPU-bound and scheduled work.
- Redis for live state, the deadline index, pub/sub and rate limits.
- Postgres for durable records and content.
- Games behind one interface, resolved from a registry, with no branching on
  game id in the server.
- Server-authoritative everything.

All of this survived contact with the implementation. What changed was smaller
and is listed under *Where the plan was wrong*.

## Data model as proposed

Durable: rooms, room_players, game_sessions, game_results, game_events,
datasets, questions.

Deliberately not persisted: individual answers, every WebSocket frame, presence
transitions. Persisting them would turn a party game into a write-heavy
pipeline for data nobody reads.

## Phases

| Phase | Deliverable | Result |
| --- | --- | --- |
| 1 | Discovery, this document | |
| 2 | Monorepo, strict TypeScript, Docker, CI, shared protocol | |
| 3 | Room system: create, join, presence, host migration, reconnect | |
| 4 | Game engine: the contract, pure reducers, deadline scheduling | |
| 5 | Five games | All five, each with its own mechanic |
| 6 | Content pipeline and seeds | 79 images + 839 authored items |
| 7 | Reliability: idempotency, grace, graceful shutdown, rate limits | |
| 8 | Observability: structured logs, metrics, admin views | |
| 9 | Performance: measure, profile, fix what is actually slow | Two findings, one non-fix |
| 10 | Review, fix, re-validate | |

## Where the plan was wrong

**TypeScript 7 was the plan.** It is the current stable release and the fastest
compiler. It also hard-refuses to work with typescript-eslint, which means no
type-aware linting — and `no-floating-promises` alone is worth more than compile
speed in an async WebSocket server. Pinned to TypeScript 6.

**BullMQ was in the original stack list for the core.** It was cut from the
realtime path before any of it was written: rounds advance from a Redis deadline
index that every instance reads, and putting that behind a job queue would add
latency and a second source of truth to a path that is already correct. BullMQ
is used for exactly two things — the housekeeping sweep and image derivation —
both genuinely off the request path.

**The plan assumed the load test would be the easy part.** It produced a
confident p50 of 348 ms, an optimisation that changed nothing, and a CPU profile
that came back 79% idle before it became clear the generator was firing every
room's action in the same millisecond. The real figure is 1.9 ms. Written up in
[performance.md](performance.md), including the fix that did not work.

**The plan did not anticipate needing to look at the output.** The blur ladder
was broken — two chained `.resize()` calls on one sharp pipeline do not
downscale then upscale, the second replaces the first — and every test passed,
because they asserted on URLs and stage indices rather than pixels. It took
rendering a contact sheet and looking at it.

**Near-duplicate answers were not on the risk list.** A test failure exposed
that the typo allowance made two fixture titles interchangeable; in the real
dataset the same rule made "Great Wave" and "Great Wall" one edit apart. The
pipeline now rejects any subject whose accepted answers fall within the
allowance of another's.
