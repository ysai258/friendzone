# 2. The server decides everything

## Context

The client could reasonably own some of this. Running the round timer locally
would make countdowns perfectly smooth. Judging an answer locally would make
feedback instant. Both are tempting, and both are how cheating gets in.

## Decision

The server owns scores, timers, round transitions, answer correctness, host
status, elimination and game completion. The client sends actions and renders
what it is told.

## Alternatives

**Client-side timers with server reconciliation.** Smoother, and wrong in a way
that shows: two players would disagree about when a round ended, and the
disagreement would be visible as one player's answer being accepted and
another's refused at the same apparent moment.

**Client-side answer checking, server verification.** Would mean shipping the
answer to the client. In a guessing game the answer *is* the content. This is
not a trade-off; it is the whole product.

**Trusting the client and validating suspicious cases.** "Suspicious" is not
definable here. A player who answers in 200 ms might be fast or might be
patched, and no heuristic separates them.

## Consequences

Good: cheating requires breaking the server, not the browser. Every player sees
the same round ending at the same instant because they are all reading the same
absolute timestamp. A player who modifies their client gains nothing — the tests
send exactly those frames and assert they are refused.

Bad: every action costs a round trip before its effect is visible. Measured at
p50 1.9 ms locally, which is well under the threshold where it is noticeable,
but it is a real cost and would grow with distance from the server.

Bad: the server does more work. Payloads are built per viewer rather than once
per room, which is the price of filtering secrets by omission rather than by
asking the client not to look.

## Note

The one thing the client does compute is the countdown *display*, from
`deadline − serverNow()`. That is presentation, not truth: the round ends when
the server says it did, whatever any client has drawn.
