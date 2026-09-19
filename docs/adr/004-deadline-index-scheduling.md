# 4. One shared deadline index instead of timers

## Context

Rounds end, reveals advance, countdowns finish and grace periods expire. All of
it is time-driven, and all of it must keep happening when the process that was
going to do it goes away.

## Decision

Every room publishes a single number — when it next needs attention — into one
Redis sorted set. Every instance ticks every 250 ms, atomically claims due rooms
with a five-second lease, and advances them.

## Alternatives

**`setTimeout` per round.** The obvious approach, and it loses every pending
transition when a process restarts. A deploy would strand every game in
progress.

**A cron-style sweep of all rooms.** Correct but wasteful: scanning every room
every tick to find the few that are due, when a sorted set answers exactly that
question in one range query.

**Redis keyspace notifications on expiring keys.** Delivery is best-effort. A
missed notification is a round that never ends, which is the worst possible
failure for this system.

**A dedicated scheduler process.** A single point of failure and a leader
election to get wrong, in exchange for nothing the shared index does not already
provide.

## Consequences

Good: a room whose server vanished mid-round is picked up by another instance
within a tick, because the pending work is a row in a sorted set rather than a
handle in a dead process. Claiming leases rather than removing means a crash
mid-transition is retried instead of lost.

Good: correctness does not depend on tick punctuality. Transitions are computed
from stored timestamps, so a late tick produces exactly the state a punctual one
would.

Good: one primitive covers more than it was designed for. Chaining phases is a
transition that expires immediately. Ending a round early when everyone has
answered is pulling the deadline back to now. "Host skips the results screen" is
settling the room as though the phase's clock had run out — no game-specific
hook at all.

Bad: transitions land up to one tick late. At 250 ms that is invisible in a
party game, and it is a floor on precision.

Bad: a room can briefly be claimed by an instance that then dies, delaying its
transition by the lease. Five seconds, once, in the rare case.
