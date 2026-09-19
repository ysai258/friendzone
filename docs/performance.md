# Performance

## The investigation

This is written up in full because the interesting part is not the final
number — it is that the first number was wrong, the first fix did not work, and
the profile disagreed with a plausible theory.

### The number that looked bad

At 1,000 rooms and 5,000 concurrent players, action-to-broadcast latency
measured:

```
p50 347ms   p95 481ms   p99 2,116ms
```

The p99 turned out to be a measurement bug: a single per-room timestamp stayed
open until the next action, so every scheduler-driven broadcast in between — a
reveal step unlocking, a round turning over — was recorded as if it were the
response to that action. Fixed by making the pending timestamp per player and
one-shot, cleared by the first frame that follows and by any rejection (a
refused action produces no broadcast at all, so nobody is waiting for one).

That left an honest-looking `p50 348ms   p95 496ms   p99 543ms`. Still bad.

### A plausible theory, and a fix that did nothing

The server's own histogram agreed — mean action duration 325 ms — so it was not
client-side noise. But server CPU sat at 0.46 of a core and Redis reported
33 µs per call. Not compute, not Redis. So: waiting.

Each action made three sequential Redis round trips (rate limit, read, write),
and measured event-loop lag was around 70 ms. Three awaits × 70 ms ≈ 210 ms,
close enough to 325 ms to be convincing.

So the limiter was folded into the read as a single Lua script — one round trip
instead of two, atomic, and a throttled client skips the read entirely.

Re-measured: **348.9 ms**, against 346.9 ms before. No change whatsoever.

### The profile

`node --cpu-prof` under 3,000 players:

```
total profiled: 62,754ms
  49,637ms  79.1%  (idle)
     810ms   1.3%  (program)
     777ms   1.2%  writev
     684ms   1.1%  (garbage collector)
     428ms   0.7%  sendRaw          ws/gateway.ts
     403ms   0.6%  read             rooms/store.ts
     345ms   0.5%  onRoomChange     ws/gateway.ts
```

**79% idle.** The server was doing essentially nothing. No hot function, no
blocking call, no GC pressure worth naming.

Which meant the latency was queueing — and the queue was mine. The generator
walked every room and then slept, firing a thousand actions in the same
millisecond and then nothing for three seconds. The last action of a burst was
answered several hundred milliseconds after the first, purely because 999
others were ahead of it. The server was idle 79% of the time because it did all
its work in a 600 ms burst every 3 seconds.

Real players are not synchronised. A load test that synchronises them measures
the harness.

### After spreading the load

Each room given its own timer at a random offset within the interval:

| | before | after |
| --- | --- | --- |
| p50 | 348 ms | **1.9 ms** |
| p95 | 496 ms | **2.6 ms** |
| p99 | 543 ms | **4.3 ms** |

Same server, same 5,000 players, same action rate. The entire figure had been
self-inflicted.

### What was kept

The combined limit-and-read script stayed, even though it did not move the
number. It halves the Redis round trips on the hottest path, it makes the
limiter and the read atomic — closing a small window where a request could pass
the limiter and then read a room that had just been deleted — and a throttled
client now costs strictly less than an accepted one. Those are worth having on
their own. It is simply not a latency fix, and the write-up says so.

## Measured results

Method, hardware and caveats in [load-testing.md](load-testing.md).

| | 1,000 rooms / 5,000 players | 2,000 rooms / 10,000 players |
| --- | --- | --- |
| WebSocket connection success | 100% | 100% |
| Protocol errors | 0 | 0 |
| HTTP join p50 / p99 | 33 / 140 ms | 47 / 154 ms |
| Socket connect p50 / p99 | 101 / 216 ms | 117 / 287 ms |
| **Action → broadcast p50** | **1.9 ms** | **1.8 ms** |
| **Action → broadcast p99** | **4.3 ms** | **61 ms** |
| Server RSS | 216 MB | 270 MB |
| Server CPU | ~0.5 core | ~0.7 core |
| Event loop lag p99 | 11.3 ms | 14.6 ms |

The p99 growing from 4 ms to 61 ms between the two runs is the tail, and the
generator is the most likely cause — one Node process holding 10,000 sockets
and parsing 150,000 frames is itself under strain. Separating the generator
onto another machine is the next thing to do before claiming a 10,000-player
number precisely.

## Hot paths, and what protects them

| Path | Design |
| --- | --- |
| Join a room | HTTP, rate limited, one Redis CAS, one fire-and-forget Postgres write |
| Send an action | Two Redis round trips. Nothing else awaits. |
| Broadcast state | Built synchronously per viewer; the cross-instance publish is fire-and-forget |
| Advance a round | One sorted-set range plus one CAS per due room, up to 200 rooms per tick |
| Start a game | The only place content is loaded — once, before the transaction opens |

Deliberate absences on the realtime path: no database query, no content lookup,
no unbounded loop, no synchronous image work, no awaited logging.

## Where the costs are

**Per-viewer payloads.** Every update costs one `getPublicState` and one
`JSON.stringify` per connected player. At 10,000 players it is not the
bottleneck, and it buys the security property the design rests on. If it ever
became one, the fix is to build the shared part of a view once and splice the
per-player section — more complexity, so not yet.

**Whole-room read-modify-write.** A room is about 5 KB, parsed and re-serialised
on every action. Fine at this size; the number to watch is a game that stores
much more per round.

**Self-addressed publishes.** A single instance is subscribed to every channel
it publishes to, so each broadcast round-trips through Redis and comes back to
be discarded on the origin check. Measurable but small, and removing it would
mean tracking which instances hold which rooms — more coordination than it
saves.

## What would break first

At roughly 10k concurrent players per instance the tail latency starts to
spread. The first real limit is the single-threaded event loop building
per-viewer payloads, and the answer is horizontal: instances are stateless, so
adding them is a load-balancer change. Redis becomes the next ceiling, and the
answer there is sharding by room code, which the key layout already permits
because every operation is scoped to one room.
