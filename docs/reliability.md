# Reliability

Every scenario below has a test. The file is named beside each one.

## A player's network drops

`tests/integration/reliability.test.ts`

The socket closes, the player becomes `DISCONNECTED`, and a 45-second grace
clock starts. Their seat, their score and any answer they already locked in are
untouched. The room shows them as reconnecting rather than removing them.

On return, the browser presents the session token it already holds, reclaims
the same `playerId`, and receives a full snapshot. Mid-round, that includes the
fact that they had already answered — so they cannot answer twice by
reconnecting.

If the grace expires first they become `INACTIVE`, the game is told, and a
round that was only waiting on them ends immediately.

## A tab is refreshed

`tests/e2e/play.spec.ts`

Indistinguishable from a brief disconnect. The session lives in `localStorage`
keyed by room code, so the join screen is skipped entirely and the player lands
back in the round. Tested in a real browser because that is the only place the
storage and reload behaviour is real.

## A second tab is opened

One seat, one socket. The newer connection wins and the older is sent a `bye`
explaining why, rather than being left silently dead. Without this, one person
counts twice toward "has everybody answered".

## The host disappears

`tests/integration/reliability.test.ts`

Succession is deterministic — the connected player with the lowest join
sequence — so every instance computes the same answer from the same stored
state without coordinating. There is no election and therefore no window in
which two instances believe in different hosts.

A host inside their grace period keeps the room unless someone who joined
earlier is actually connected. A brief tunnel does not hand the party away.

## A server instance dies

`tests/integration/reliability.test.ts` — "keeps the game running when the
instance holding a player goes away"

Players on that instance reconnect elsewhere within their grace period and
resume the same round at the same deadline, because the state was never in that
process. Rooms it would have advanced are still in the deadline index, and
another instance claims them on its next tick.

On a clean shutdown the sequence is deliberate:

1. Fail readiness, so the load balancer stops sending new players while
   everything still works.
2. Stop the scheduler; its rooms are in Redis and another instance takes them.
3. Send every socket a `bye` and close. Clients treat it as "come straight
   back" and reconnect elsewhere inside their grace period, so nobody is marked
   inactive and no round is lost.
4. Stop accepting HTTP and let in-flight requests finish.
5. Close Redis, then Postgres.

A second signal exits immediately, and a drain that hangs is killed after 15
seconds rather than wedging the process.

## An action is sent twice

`tests/multiplayer/blur-battle.test.ts`

Every action carries a client-generated id, kept for retry. The server records
recent ids **inside the room state**, so the duplicate check and the effect are
written under the same compare-and-set. A separate "seen" key could be updated
while the state write lost its race — exactly the window a retry would slip
through and score twice.

The memory is bounded to the last 256 ids. Duplicates only ever arrive inside a
retry window, and an unbounded list would slow every read of the room.

A replay is not an error. The client asked for something that has already
happened, so it gets current state back rather than a rejection it would have
to interpret.

## An action arrives late

Each game validates against its own phase. A guess after the round closed is
`ROUND_CLOSED`; an answer from a player already locked in is
`ALREADY_ANSWERED`. Because scoring uses the server's receive time, a delayed
action cannot claim to have been earlier than it was.

## Postgres goes down

Games keep running. Every archive write is fire-and-forget with its own catch,
so the effect is lost history, not lost gameplay. New rooms are still created —
the Redis write is what makes a room exist, and the Postgres row is a record of
it. `/ready` fails, so the instance leaves rotation.

## Redis goes down

Covered in [redis.md](redis.md). In short: play stops, nothing corrupts,
everything resumes when it returns, and rate limiting fails open on purpose.

## Content is missing

Starting a game with an empty question table returns `CONTENT_UNAVAILABLE` with
a message naming `npm run seed`, rather than a stack trace. The content cache
serves stale entries if a refresh fails, so a database blip between rounds does
not stop the next game starting.

## Rooms that nobody ends

Redis TTLs, refreshed on every write: 30 minutes for a lobby, 15 for a finished
game. A room nobody touches stops existing. The worker sweeps index entries
left behind by expired rooms and closes the Postgres rows, on a five-minute
schedule. Nothing grows without bound.
