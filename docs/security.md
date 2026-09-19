# Security

## The threat model

There is no money and no personal data here. What people will actually try is
cheating: seeing an answer early, scoring more than they earned, starting a
game they do not host, or spoiling a round for everyone else. A modified client
is the expected adversary, not an exotic one — the whole game runs in a browser
someone owns.

So the rule is: the client is an input device and a renderer. It decides
nothing.

## Never trusted from a client

| Claimed by client | How it is actually determined |
| --- | --- |
| `playerId` | From the signed session on the socket, never from the payload |
| `score` | Computed server-side from the server's own receive time |
| answer correctness | Judged server-side against content the client has not been sent |
| round / phase | Read from stored state, not from the request |
| host status | Recomputed from join order and presence on every mutation |
| timer expiry | A stored deadline compared against the server clock |
| who was eliminated | Tallied server-side from recorded votes |

`tests/integration/security.test.ts` sends the frames a patched client would
send — an invented score, a payload claiming somebody else's `playerId`, a
non-host calling `start-game` — and asserts each is refused. Asserting that the
official UI has no such button would prove nothing.

## Identity without accounts

A player is a random UUID plus an HMAC-signed statement that it belongs to one
room:

```
v1.<playerId>.<roomCode>.<issuedAt>.<expiresAt>.<hmac-sha256>
```

The token carries no secret and grants nothing beyond a seat in one room, so
losing one costs a stranger exactly one nickname in one party game.

Why signed rather than a bare id in `localStorage`: the id is the only thing
between a player and someone else's score, and ids appear in payloads. Unsigned,
anyone who saw one could claim it.

Deliberately not JWT. There are no claims to negotiate, no `alg` field to
confuse, and no library to keep patched — three fields and one HMAC.

Verification compares in constant time and checks the room code against the
room actually being entered, so a valid token for room A cannot open room B.
Both cases are tested.

## Hidden information

Filtered by omission, in one place: `getPublicState(state, viewerId, ctx)`.

```ts
for (const [playerId, card] of Object.entries(state.identities)) {
  if (playerId === viewerId) continue     // your own card is never added
  others[playerId] = { name: card.name }
}
```

There is no `hidden: true`, no placeholder, nothing encoded. The field is not
in the object, so it is not in the JSON, so it is not in the browser.

Concretely protected:

- **Blur Battle** — only the reveal step the round has reached is sent. The
  sharper files exist on disk but their URLs are not in the payload. Shipping
  the whole ladder and blurring in CSS would put the answer one devtools panel
  away.
- **Who Am I?** — a player's own identity is absent from their payload. Tested
  by serialising it and searching for the string.
- **Movie Mafia** — each player receives their own clue and no one else's, and
  only the imposter's payload says they are the imposter.
- **Mind Meld** — while the prompt is live, no payload contains another
  player's answer, or even a length hint. Only who has locked in.
- **Everywhere** — answers, roles and votes appear only in the phase that
  reveals them.

## Input handling

**Everything is parsed at the boundary** by zod schemas shared between client
and server. Unknown keys are rejected rather than ignored (`z.strictObject`),
so a payload with extra fields fails loudly instead of being silently trusted
somewhere later.

**Prototype keys are rejected during parsing, not after.** This one was found by
a test that initially failed:

```ts
export function parseClientJson(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError(`forbidden key: ${key}`)
    return value
  })
}
```

The original guard was a zod refinement checking `Object.keys()`. It never
fired. `JSON.parse` does create `__proto__` as an ordinary own property, but the
moment that object is copied — by a validator, a spread, `Object.assign` — the
copy is built with `=`, and `target.__proto__ = value` sets the prototype
instead of storing a key. By the time any later check runs there is no own
`__proto__` left to find, and the assignment has already happened. A reviver
sees the key while it is still just a key. Both the WebSocket and HTTP paths go
through it.

**Names are normalised**, stripping control characters, zero-width spaces,
bidirectional overrides and the rest — so "Yash​wanth" cannot sit beside
"Yashwanth" as a second player.

**Frames are capped** at 8 KB, and an oversized one is refused without dropping
the connection.

**A failed `hello` closes the socket** rather than leaving an unauthenticated
connection open until a timeout.

## Rate limiting

Redis token buckets, so limits hold across instances — a per-process limiter
multiplies every quota by the instance count, and the instance count is exactly
what an attacker would find by trying.

| Bucket | Default | Subject |
| --- | --- | --- |
| Room creation | 5 burst, 1 per 10s | IP address |
| Room joining | 20 burst, 1 per 2s | IP address |
| Socket actions | 30 burst, 10/s | **player**, not connection |

Actions are limited per player so opening more sockets buys no more actions.

Buckets rather than fixed windows because the distinction matters: someone who
fumbles their name and retries should never be told to wait, while a script
firing continuously should be. A bucket allows the burst and then throttles to
the refill rate.

Games enforce their own limits too, where the rules need them — Emoji Movie
caps attempts per round and imposes a cooldown between guesses, so a title
cannot be brute-forced regardless of transport limits.

## Errors

Clients receive a code and a sentence a person can read. Nothing else:

```json
{ "error": { "code": "ROOM_FULL", "message": "This room is full." } }
```

Every failure funnels through one handler. Expected failures become their
`AppError` code; everything else collapses to `INTERNAL` with a fixed message,
while the real error and its correlation id go to the logs. Tested by asserting
that responses contain no stack frames and no mention of Postgres or Redis.

## Other measures

- **Helmet** with a restrictive CSP on the API, which serves JSON and a socket
  upgrade and has no HTML to frame.
- **CORS** allow-listed from configuration; production refuses to boot with an
  empty list.
- **Boot-time refusal** to start in production with the example session secret.
- **Admin routes are not registered at all** unless `ADMIN_TOKEN` is set. An
  admin surface that exists by default is one somebody forgets to lock. The
  token is compared in constant time, and the views return counts and health —
  never names, answers, or live game state.
- **No secrets in the repo.** `.env` is gitignored; `.env.example` carries
  placeholders and the command to generate a real secret.
- **Image URLs** are paths this project generated, not strings from a client.
- **`statement_timeout`** so no query can hang a handler.

## Known limits

- Room codes are 25^5 ≈ 9.8M. Someone determined could enumerate them to find
  live rooms; the join rate limit makes this slow, and the payoff is joining a
  stranger's party game. If that ever mattered, the fix is a per-IP failure
  budget on joins.
- Sessions do not survive a `SESSION_SECRET` rotation. Every player would be
  asked for their name again. Acceptable here; a real fix would accept the
  previous key during a rollover.
- There is no moderation of display names beyond length and invisible
  characters.
