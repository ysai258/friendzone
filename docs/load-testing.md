# Load testing

## Running it

```bash
# Room creation is rate limited per address, and a load generator is one
# address. Start the server with limits suited to the test.
RL_ROOM_CREATE=100000:1000 RL_ROOM_JOIN=100000:1000 npm run dev:server

npm run loadtest -- --rooms=1000 --players=5 --duration=45 --ramp=100
```

If the limiter does refuse rooms, the tool says so and tells you what to do,
rather than printing a confident chart of rejections.

| Flag | Default | |
| --- | --- | --- |
| `--rooms` | 50 | Rooms to create |
| `--players` | 5 | Players per room |
| `--duration` | 30 | Seconds of steady traffic after the ramp |
| `--ramp` | 40 | New rooms per second while ramping |
| `--interval` | 3 | Seconds between one player in a room acting |
| `--url` | `http://localhost:8080` | Target |
| `--out` | `load-results/run-<ts>.json` | Report path |

## What it simulates

Whole rooms, not bare sockets. A bare socket measures nothing interesting — the
expensive path is one player acting and everyone else in their room being told,
and that only exists if the room exists.

Each simulated room creates itself over HTTP, joins its players, opens a real
WebSocket each, authenticates, starts a game of Emoji Movie with long rounds,
and then has one player at a time submit a wrong guess. A wrong guess is
accepted by the game, scores nothing, and costs the server exactly what a real
one does.

Rooms act on independent timers at random offsets. This matters more than
anything else in the tool — see [performance.md](performance.md) for what
happened when they did not.

## What it measures

- **`httpJoin`** — round trip for room creation and joining.
- **`socketConnect`** — socket open to authenticated `welcome`.
- **`actionToBroadcast`** — one player in a room sending an action, to each
  player in that room receiving the resulting state frame. Measured per player
  and cleared by the first frame that follows, so scheduler-driven broadcasts
  are never attributed to an action.

Every sample is kept, so the percentiles are exact rather than estimated.

It also scrapes the server's own `/metrics` before, at peak and after, so the
report carries what the server saw — RSS, CPU, event-loop lag, CAS retries —
alongside what the client measured. When those two disagree, the disagreement
is the finding.

## The environment these numbers came from

```
Linux 6.8, x86_64
Node v22.23.1
PostgreSQL 17 and Redis 7 in Docker, on the same machine
One server instance, one generator process, also on the same machine
```

This is a developer laptop, not a deployment. Read the numbers as a **lower
bound on a small machine**, not as capacity:

- The generator competes with the server for CPU. At 10,000 sockets it is
  itself substantial, and its own queueing is inside the client-side
  measurement.
- One instance was tested. The architecture is horizontal; multi-instance
  behaviour is covered by the integration tests, not by these numbers.
- Redis and Postgres were containers sharing the same disk and CPU.

Every figure in [performance.md](performance.md) came from these runs. The raw
reports are written to `load-results/`. Nothing there is estimated,
extrapolated, or rounded in a flattering direction.

## Reading a report

```json
{
  "environment": { "node": "v22.23.1", "cpus": 8, "note": "Generator and server share this machine..." },
  "counters": { "socketsOpened": 5000, "socketsFailed": 0, "protocolErrors": 0 },
  "latencyMs": { "actionToBroadcast": { "p50": 1.9, "p95": 2.6, "p99": 4.3, "max": 107.4 } },
  "server": { "peak": { "friendzone_players_connected": 5000 } }
}
```

`protocolErrors` should be zero. Anything else means the generator is sending
something the server rejects, and the numbers are measuring the rejection path
— the report breaks them down by error code so it is obvious which.
