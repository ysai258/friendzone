# 1. A modular monolith, not services

## Context

FriendZone has several concerns that could plausibly be separate deployables: an
HTTP API, a WebSocket gateway, a scheduler that advances rounds, game logic, and
background image processing. The brief explicitly warned against complexity for
its own sake, and equally explicitly asked for something that would hold up to a
senior engineer's questioning.

## Decision

One server process containing the HTTP API, the WebSocket gateway, the room
service and the scheduler. One separate worker process for background jobs.
Everything else is a package in the same repository.

## Alternatives

**Separate gateway and game service.** A common shape: the gateway owns sockets,
a game service owns rules, they talk over a message bus. Rejected because the
gateway and the room service share the same state and the same tick. Splitting
them adds a network hop to a path measured in single-digit milliseconds, plus a
second failure mode to every transition, in exchange for the ability to scale
two things separately that scale together anyway.

**A separate scheduler service.** Rejected for a better reason: it would be
worse, not merely unnecessary. A single scheduler is a single point of failure
and a coordination problem. Every instance running the same loop against a
shared, leased index has no leader to elect and no failover to get wrong.

**Serverless functions.** Rejected outright. WebSockets are long-lived
connections with per-connection state; this is the workload function runtimes
are least suited to.

## Consequences

Good: one process to run locally, one to deploy, one set of logs. A round trip
from socket to state and back stays in-process. The integration tests can stand
up the entire system in a few lines, which is why there are so many of them.

Bad: the API and the WebSocket layer scale together whether or not they want to,
and a memory leak anywhere affects sockets. Both are acceptable at this size and
both are visible in the metrics.

The one split that was made — the worker — was made for a concrete reason rather
than symmetry: deriving a blur ladder is several seconds of CPU-bound `sharp`
work, and an event loop holding ten thousand sockets should not be doing it.
That is the test a split has to pass here.
