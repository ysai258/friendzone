# FriendZone

Real-time multiplayer party games. Open a link, type a name, play.

No accounts, no downloads, no app store. The host creates a room, shares
`/r/AB7KQ`, and everyone is playing within a few seconds.

```
FRIENDZONE

Play stupid games with smart friends.

[ Create Room ]   [ Join Room ]

No signup. No downloads. Just friends.
```

## The games

| Game | What it is | Players |
| --- | --- | --- |
| 🌀 **Blur Battle** | A picture sharpens step by step. Name it early through the fog for more points — one guess each. | 1–12 |
| 🎬 **Emoji Movie** | A film as three emoji. Everyone races, wrong guesses only cost you time. | 1–12 |
| 🧠 **Mind Meld** | One prompt, everyone answers at once, points for agreeing. Being clever is a trap. | 2–16 |
| 🕵️ **Who Am I?** | A secret identity on your forehead that everyone but you can see. | 3–10 |
| 🎭 **Movie Mafia** | Everyone gets a clue about the same film. One clue is wrong, and its holder does not know. | 4–12 |

## Running it

```bash
git clone <this repo> && cd friendzone
npm install
cp .env.example .env
docker compose up -d          # PostgreSQL and Redis
npm run dataset:sample        # generated placeholder art, no network needed
npm run seed                  # loads all five games' content
npm run dev                   # http://localhost:5174
```

`npm run dev` checks that Postgres and Redis are reachable before starting, and
runs the API and the web app together with prefixed output.

For real photographs in Blur Battle instead of placeholders, set
`WIKIMEDIA_USER_AGENT` in `.env` to something with your contact details and run
`npm run dataset:fetch`. It pulls 78 freely licensed images from Wikimedia
Commons, generates the reveal ladders, and records each one's licence and
author — which the reveal screen shows.

## What it actually does

The interesting part is underneath. A summary, with the reasoning in
[`docs/`](docs/):

**The server decides everything.** Scores, timers, round transitions, who is
host, whether an answer is right. A client sends actions and renders what it is
told. [`docs/architecture.md`](docs/architecture.md)

**Secrets are absent, not hidden.** A payload is built per viewer. Your own
identity in Who Am I?, another player's clue in Movie Mafia, an unrevealed blur
step — none of it is in the bytes your browser receives, so there is nothing to
find in devtools. Asserted directly in the tests.
[`docs/security.md`](docs/security.md)

**Timers are absolute and server-owned.** Rounds end because a deadline in a
Redis sorted set passed, not because a `setTimeout` fired somewhere. A
backgrounded tab, a sleeping laptop or a device with the wrong clock all show
the same truth. [`docs/realtime.md`](docs/realtime.md)

**Concurrency is compare-and-set, not locks.** Read the room, run pure
reducers, write claiming the version you read. A losing write re-runs against
whichever state won. No leases to expire, nothing stranded when a server dies
mid-mutation. [`docs/adr/003-optimistic-concurrency.md`](docs/adr/003-optimistic-concurrency.md)

**Dropping out is not leaving.** A lost socket starts a grace period; the seat,
the score and any answer already locked in survive it. If the host is the one
who vanished, succession is deterministic, so every instance independently
computes the same new host. [`docs/reliability.md`](docs/reliability.md)

**Games are plugins.** The room service has no branch on which game is running.
A game declares its settings, its actions and how to build a view, and the
platform does the rest. [`docs/game-engine.md`](docs/game-engine.md)

## Measured, not estimated

On one developer machine (details and method in
[`docs/load-testing.md`](docs/load-testing.md)), with the load generator running
beside the server:

| | 1,000 rooms / 5,000 players | 2,000 rooms / 10,000 players |
| --- | --- | --- |
| Connection success | 100% | 100% |
| Action → broadcast, p50 | 1.9 ms | 1.8 ms |
| Action → broadcast, p99 | 4.3 ms | 61 ms |
| Server memory | 216 MB | 270 MB |
| Server CPU | ~0.5 core | ~0.7 core |
| Protocol errors | 0 | 0 |

The first version of that benchmark reported a p50 of 348 ms. That number was
the load generator firing every room's action in the same millisecond; a CPU
profile of the server under it came back 79% idle.
[`docs/performance.md`](docs/performance.md) has the whole investigation,
including the optimisation that turned out not to help.

## Putting it somewhere your friends can reach

The default Docker build produces one container that serves the app, the API and
the WebSocket on a single origin — so there is no proxy to configure and no CORS.
It migrates on boot and loads the game content if the database is empty.

```bash
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
export POSTGRES_PASSWORD=$(openssl rand -base64 24)
docker compose -f docker-compose.prod.yml up -d --build
```

On a platform like Railway or Fly, point it at this repo, add a Postgres and a
Redis, and set `SESSION_SECRET`, `DATABASE_URL` and `REDIS_URL`. Full steps,
including the split shape for scale, are in
[`docs/deployment.md`](docs/deployment.md).

## Commands

| | |
| --- | --- |
| `npm run dev` | API + web, with dependency checks |
| `npm test` | Unit and integration suites |
| `npm run test:e2e` | Playwright, real browsers |
| `npm run typecheck` | Strict TypeScript across every package |
| `npm run lint` | ESLint with type-aware rules |
| `npm run seed` | Load game content into Postgres |
| `npm run dataset:fetch` | Build Blur Battle images from Wikimedia Commons |
| `npm run loadtest -- --rooms=100 --players=5` | Measure it yourself |
| `npm run worker` | Background jobs (cleanup, image derivation) |

## Layout

```
apps/
  server/          Fastify + WebSockets. Rooms, scheduling, persistence.
  web/             React + Vite. One screen per game.
packages/
  shared/          Wire protocol, error codes, types both sides agree on.
  game-engine/     The GameDefinition contract and all five games. Pure.
scripts/
  dataset/         Content pipeline: fetch, validate, dedupe, derive.
  load/            Load generator.
tests/
  integration/     Real Redis, real Postgres, real sockets.
  multiplayer/     Five clients playing a real game.
  e2e/             Playwright, real browsers.
docs/              Architecture, decisions, and how the numbers were measured.
```

## Notes on content

Blur Battle images come from Wikimedia Commons under CC0, public domain, CC BY
or CC BY-SA. NonCommercial and NoDerivatives files are filtered out at fetch
time, because this project generates derivatives and cannot promise
non-commercial use on a deployer's behalf. Every image carries its author,
source and licence through to the reveal screen. The other four games' content
is original to this project.

The pipeline identifies itself to Wikimedia with a contact address, limits
concurrency, caches what it downloads, and uses the documented API. It does not
scrape.
