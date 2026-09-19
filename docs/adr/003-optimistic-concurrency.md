# 3. Compare-and-set, not distributed locks

## Context

Several server instances can mutate the same room concurrently — two players in
one room may be connected to different instances, and the scheduler on a third
may be advancing that room's round at the same moment. Something has to
serialise those writes.

## Decision

Optimistic concurrency. Read the room with its version, run pure reducers,
write claiming that version through a Lua script that only writes if the version
still matches. A refused write re-reads and re-runs.

## Alternatives

**A distributed lock (Redlock or similar).** Rejected on three counts. A lease
has to be long enough for the slowest mutation and short enough that a dead
holder does not stall the room — a tuning problem with no good answer. A crash
between acquiring and releasing strands the room for the lease duration. And
Redlock's correctness under partition is contested enough that using it for
something this simple is hard to justify.

**Routing each room to an owning instance.** Genuinely attractive: a single
owner needs no coordination at all. Rejected because it requires consistent
hashing, ownership transfer on scale events, and a story for what happens to a
room mid-transfer — which is a lot of machinery to avoid a conflict that
measurement shows is rare.

**Serialising everything through Lua.** The game reducers are thousands of
lines of TypeScript. Not portable to Lua, and not something anyone should want
to debug there.

## Consequences

Good: nothing to expire, nothing to release, nothing stranded when an instance
dies mid-mutation. A losing write simply runs again against the state that won,
and because the reducers are pure that is exactly equivalent to having gone
second. The whole mechanism is one Lua script and a retry loop.

Good: the room write and its deadline-index update are one atomic operation, so
state and scheduling cannot disagree.

Bad: a pathologically contended room would retry repeatedly and eventually
return `CONFLICT_RETRY_EXHAUSTED` after eight attempts. The `cas_retries` metric
exists to make that visible before it matters.

Bad: purity is now load-bearing rather than stylistic. A reducer that performed
I/O or read a clock would be wrong in a way that only shows up under
concurrency. This is stated at the top of the `GameDefinition` contract.

## Measured

Conflicts scale with how many people touch one room simultaneously, and not at
all with how much play happens in it. Twenty rooms of five players produced 192;
the same twenty rooms with fifteen times the gameplay actions produced 193; the
same twenty rooms with one player each produced 0; a hundred rooms of five
produced 998 — about ten per room in every case.

They arrive at the two moments several players write to one room together:
everyone opening the shared link at once, and everyone's socket closing at once.
A room in ordinary play produces essentially none, because its players take
turns tapping things. That is precisely the profile optimistic concurrency
handles well, and the profile a lock would handle worst — the contention is a
brief burst, not a sustained queue.
