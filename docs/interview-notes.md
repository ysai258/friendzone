# Interview notes

Short answers to the questions this project exists to provoke. Every number
here was measured; the method is in [load-testing.md](load-testing.md).

## Why WebSockets?

Because the server needs to push. A round ends because a deadline passed, not
because anybody asked — with polling, every player would learn at a different
moment, and the poll interval would become the game's precision. Long-polling
would work and costs a connection setup per message. SSE is one-directional, so
actions would still need a second channel.

## Why Redis?

Three jobs that all want the same properties — shared, fast, and fine to lose:

1. **Live room state.** Changes many times a second, must be visible to every
   instance, and is meaningless an hour later.
2. **The deadline index.** One sorted set any instance can claim from, which is
   what makes scheduling survive a restart.
3. **Rate limits.** Per-process limiters multiply every quota by the instance
   count.

Plus pub/sub for cross-instance fan-out, which is genuinely what it is for.

## Why PostgreSQL?

For everything worth keeping after the room is gone: who played, what they
scored, which questions were drawn, and the content library itself. It is never
on the realtime path — writes are fire-and-forget at lifecycle boundaries, so a
database outage costs history, not gameplay.

## Why server-authoritative state?

Because the client is the adversary. In a guessing game the answer *is* the
content, so any design where the client can judge an answer is a design where
the answer is already in the browser. Once that is settled, every other
authority follows: if the server owns correctness, it may as well own timing,
scoring and transitions, and then there is exactly one truth.

## How are timers synchronised?

They are not, in the sense of agreeing on a clock. The server stores absolute
timestamps; the client draws `deadline − serverNow()`, where `serverNow()` is
its own clock plus an offset measured continuously by ping/pong. The lowest
round trip wins, because on a symmetric path it carries the least one-way
error.

So a wrong client clock changes nothing, and a backgrounded tab that comes back
recomputes rather than resumes. The round ends when the server says it did.

## How does reconnection work?

A dropped socket is not a departure. The player enters a 45-second grace period
during which their seat, score and any locked-in answer survive. Their browser
still holds a signed session token, so it reclaims the same identity and
receives a full snapshot — including the fact that they already answered, so
reconnecting cannot buy a second guess.

There is no delta stream, so there is nothing to fall out of step. Waking is
handled explicitly: a locked phone comes back with a socket the browser still
calls open, so `visibilitychange` triggers a resync rather than waiting for a
heartbeat to time out.

## How does host migration work?

The connected player with the lowest join sequence. Deterministic on purpose —
every instance computes the same answer from the same stored state without
talking to any other instance, so there is no election and no window in which
two instances believe in different hosts.

One refinement: a host inside their grace period keeps the room unless someone
who joined earlier is actually connected. A ten-second tunnel should not hand
the party away.

## How is a duplicate action prevented?

Every action carries a client-generated id, reused on retry. The server records
recent ids **inside the room state**, so the duplicate check and the effect are
written under the same compare-and-set.

That detail is the whole answer. A separate "seen" key could be updated while
the state write lost its race — precisely the window a retry would slip through
and score twice. Because they are one atomic write, that window does not exist.
The memory is bounded to 256 ids; duplicates only arrive inside a retry window.

## How is hidden information protected?

By omission, in one function. `getPublicState(state, viewerId)` builds each
player's payload by skipping what they may not see. There is no `hidden: true`
flag, no placeholder, nothing encoded — the field is not in the object, so it is
not in the JSON, so it is not in the browser.

Blur Battle is the sharpest case: each reveal step is a separate file the server
releases when the round reaches it. Shipping the ladder and blurring it in CSS
would put the answer one devtools panel away.

The tests serialise real payloads and grep them for the strings that must not be
there, parameterised over the registry so a new game is covered the day it is
added.

## How would this scale to 100k concurrent users?

Measured today: 10,000 concurrent players on one instance on a laptop, at p50
1.8 ms action-to-broadcast, using about 0.7 of a core and 270 MB.

100k would be roughly ten instances behind a load balancer, which the
architecture already supports — instances are stateless, and the integration
tests cover two of them sharing a room. Redis becomes the next ceiling; the
answer is sharding by room code, which the key layout permits because every
operation is already scoped to one room.

Two things I would want before claiming that number: the load generator on
separate machines (at 10k sockets it is itself a bottleneck), and a real
multi-instance run rather than an extrapolation.

## What would break first?

The single-threaded event loop building per-viewer payloads. Every update costs
one `getPublicState` and one `JSON.stringify` per connected player, and that is
the work that grows fastest.

The fix in order of preference: add instances (free, already supported); then
build the shared part of a view once and splice the per-player section; then, if
it still mattered, move fan-out off the main thread.

## What would you change at 10x scale?

- **Shard Redis by room code.** The keyspace is already room-scoped.
- **Stop round-tripping publishes to yourself.** A single instance is subscribed
  to every channel it publishes to, so each broadcast comes back to be
  discarded. Cheap now, wasteful at scale.
- **Shrink the room state.** 5 KB parsed and re-serialised per action is fine at
  5 KB. The number to watch is a game that stores much more.
- **Separate the read path.** Nothing reads rooms except gameplay today, but an
  admin or spectator view would want a replica.

What I would *not* change: the compare-and-set model, which gets cheaper
relative to locking as instances multiply, and the deadline index, which is
already the shape that survives restarts.

## What metrics would you monitor?

Alert on: WebSocket connection failure rate, `cas_retries` rising in steady
state (rooms have become contended), `scheduler_errors` non-zero (rounds are not
advancing — the worst failure here), event-loop lag p99, and Redis reachability.

Watch: action duration by kind, broadcast fan-out size, reconnect rate, rooms
active, games started versus completed. That last ratio is the closest thing to
a product health metric — games started but never finished means people are
leaving mid-game.

Nothing is labelled by room code or player id. Those are unbounded label values,
which is the classic way to take down a Prometheus, and they would put player
data in a scrape endpoint.

## What are the major trade-offs?

**Per-viewer payloads cost CPU.** Accepted, because the alternative is a shared
payload with secrets in it and a client trusted not to look.

**Optimistic concurrency can retry.** Accepted, because measurement says
conflicts only occur during room formation and a retry is microseconds of pure
function.

**A 250 ms scheduler tick is a floor on precision.** Accepted; invisible in a
party game.

**Whole-room read-modify-write.** Accepted at 5 KB, and instrumented so it stays
visible.

**Rate limiting fails open when Redis is down.** Deliberate: a cache outage
should not become a full outage, and the limiter guards against abuse rather
than correctness.

## What did you get wrong?

Three things worth saying out loud, because they are in the git history anyway:

**The blur ladder didn't work and I didn't notice until I looked at it.**
Chaining two `.resize()` calls on one `sharp` pipeline does not downscale and
then upscale — the second call replaces the first. Every "blurred" stage was the
original image at full detail. The unit tests passed, because they asserted on
URLs and stage indices, not on pixels. It took rendering a contact sheet and
looking at it.

**My first dedupe pass called the Statue of Liberty a duplicate of the Eiffel
Tower.** Average hash asks "is this pixel brighter than the image mean", so two
photographs that are mostly bright sky over a dark subject score as
near-identical whatever the subject is. Switching to a difference hash, which
encodes local gradients, fixed it.

**The first load test measured itself.** Reported p50 348 ms; a CPU profile of
the server under that load came back 79% idle. The generator was firing every
room's action in the same millisecond. Spreading them took the same server, same
players, same rate, to p50 1.9 ms. I had also "optimised" the server in between,
which changed nothing — that fix is still in, because halving the Redis round
trips and making the limiter atomic with the read are worth having, but the
write-up says plainly that it was not a latency fix.

## What is missing?

- Multi-instance load numbers. The behaviour is tested; the throughput is not
  measured.
- Spectators. The engine could support it — `getPublicState(state, null)`
  already means "a viewer with no seat" — but nothing exposes it.
- Session key rotation. Rotating `SESSION_SECRET` logs everyone out.
- Moderation beyond name normalisation.
