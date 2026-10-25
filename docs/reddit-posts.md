# Reddit posts for FriendZone

Drafts for sharing FriendZone, ranked best first. Rules were read from each
subreddit's live rules page on 2026-10-25 (read-only; nothing was posted).

- **Link:** https://friendzone-n75y.onrender.com (responded 200 on 2026-10-25)
- **Repo (public):** https://github.com/ysai258/friendzone
- **Posting account:** u/Original-Fall6524, 17 post karma and 1 comment karma.
- **Video:** none in the repo. No `.mp4`, `.webm`, `.gif` or `.mov` exists outside
  `node_modules`. A 20–40 s phone recording of a real round (lobby → join by link →
  one Emoji Movie round → scoreboard) would help on every sub below, and
  r/IndieDev's sidebar says images and GIFs are what get attention there.

## Before posting

1. **Open the link yourself a minute before you post.** The Render free plan
   sleeps after 15 minutes idle and takes about a minute to wake. The first
   Redditor to click otherwise gets a blank wait and leaves.
2. **Spread the posts out.** The account posted to six subs in the last two days
   and was auto-removed from r/WebGames. Post one of these per day, starting with
   #1. Don't paste the same body everywhere; each draft below is written for its
   own sub.
3. **Be upfront about AI.** All 35 commits are co-authored by Claude. r/playmygame
   removes "false claims about your game", and a commenter will ask. Each draft
   has one plain line about it. Don't post to r/indiegames, r/DestroyMyGame,
   r/jackboxgames, r/Telugu or r/tollywood: they ban generative-AI work, and
   r/tollywood also needs 100 post karma.
4. **Stay in the thread for the first couple of hours** and answer every comment.
   That also builds the comment karma the account lacks.

---

## 1. r/playmygame (149k members)

**Why it fits.** The sub is "a place for indie developers to share their freely
playable games for feedback". FriendZone is free, playable now in a browser, and
we want feedback.

**Rules that apply**
- *Your game must be playable for free*: it is, with no sign-up.
- *Include a (brief) description of your game / your participation in development*:
  say you made it.
- *Include a direct link to the game*: the game link goes first, before any other links.
- *Be Truthful / No false claims*: hence the AI line.
- *1 post per month*: one post only. Don't repost if it sinks.
- The pinned mod post says the sub is for feedback, not self-promotion, so the
  post asks for feedback.

**Karma.** No minimum is stated. Of the 15 newest posts, 8 came from accounts
with 1–4 post karma and stayed up, so 17 should be fine.

**Post type:** text post with the link in the body (use the sub's own "Make a
Post" button if it shows one). **Flair:** `[Mobile] (Web)`. It's played on phones
around a room. `[PC] (Web)` is the fallback.

**Title**
> FriendZone – free party games for your friend group, played on your phones in the browser (no sign-up)

**Body**
> I made FriendZone to play with my friends when we meet up. Somebody opens the
> link, creates a room and shares it. Everyone opens it on their phone, types a
> name, and you're playing. No accounts, no app, no ads.
>
> **Play:** https://friendzone-n75y.onrender.com
>
> There are six games:
> - **Blur Battle**: a picture sharpens step by step. Name it early for more points. You get one guess.
> - **Emoji Movie**: a film as three emoji. Race to name it. The host picks Telugu, Hindi, Tamil, Malayalam or English films.
> - **Mind Meld**: one prompt, everyone answers at once, and you score for matching each other.
> - **Who Am I?**: everyone can see your secret identity except you (3–10 players).
> - **Movie Mafia**: everyone gets a clue about the same film. One clue is wrong, and the person holding it doesn't know (4–12 players).
> - **Paata Pattu**: name that tune with Telugu songs. Every phone plays the same intro, getting longer each clue.
>
> Most games work with 1–12 players. It's best with 4–8 people in the same room
> or on a call. The server keeps time and score, so a phone that drops out can
> rejoin and keep its seat.
>
> I'm the only developer. I built it with a lot of help from an AI coding
> assistant (Claude). The song clips play from YouTube, and the Blur Battle photos
> are freely licensed from Wikimedia Commons.
>
> It runs on a free server, so if it's been idle the first load can take about a
> minute. After that it's fast.
>
> Two things I'd love to know:
> 1. Could you get a room going with your friends without anyone explaining it?
>    Where did people get stuck?
> 2. Which game did your group want to play again, and which one fell flat?

**First comment (optional)**
> If you're playing solo to try it out, Blur Battle and Emoji Movie both work
> with one player. Mind Meld and Movie Mafia need a group. Open the room link on
> a second phone or tab to see what your friends would see.

---

## 2. r/developersIndia (1.6M members), flair "I Made This"

**Why it fits.** It's an Indian community, and the game is built for Indian
friend groups: films in five languages and Telugu songs. The flair rules invite
you to "share projects you have built". A recent post, *"I made Mr. Black: an
open-source Indian social deduction game"*, shows party games are welcome here.

**Rules that apply**
- *Always use the right flair*: use `I Made This`.
- Extended flair rules: *Add GitHub URL or deployed project URL while posting*.
  Include both.
- *"I made this" posts should be taken as public launch… avoid posting the same
  project multiple times*: post it once.
- *Don't create Low-Quality Posts*: give the technical detail. This audience is
  developers.

**Karma.** No minimum is stated. Recent `I Made This` posts include accounts
with 11 and 15 post karma.

**Post type:** text post. **Flair:** `I Made This :snoo_wink:`

**Title**
> I made FriendZone, a no-signup party game site for Indian friend groups (Emoji Movie in 5 languages, Telugu Name That Tune), open source

**Body**
> I built this to play with my friends at get-togethers. We kept wanting
> something like Jackbox, but with Telugu and Hindi films and songs instead of
> American trivia, and something that works on everyone's phone without
> installing anything.
>
> **Play:** https://friendzone-n75y.onrender.com
> **Code:** https://github.com/ysai258/friendzone
>
> The host creates a room and shares a `/r/AB7KQ`-style link. Everyone types a
> name and joins. There are six games: Emoji Movie (Telugu, Hindi, Tamil,
> Malayalam or English), Paata Pattu (Telugu song intros: 2 s, then 4, 7, 10,
> 15), Blur Battle, Mind Meld, Who Am I? and Movie Mafia (a spot-the-wrong-clue
> game).
>
> The parts I enjoyed building:
> - **The server decides everything.** Scores, timers and right answers are all
>   decided on the server. Each player is sent only what they're allowed to see,
>   so your secret identity in Who Am I? is never in your own browser's network
>   tab.
> - **Timers live in Redis.** A round ends when a deadline in a sorted set passes,
>   not when a `setTimeout` fires. A phone that sleeps mid-round rejoins and
>   still sees the same truth.
> - **No locks.** Room writes use compare-and-set: read, run pure reducers, write
>   with the version you read, and retry if you lose.
> - **Load test on one laptop:** 2,000 rooms and 10,000 simulated players, with a
>   1.8 ms p50 from an action to everyone receiving it.
>
> Stack: Fastify + WebSockets, Redis, Postgres, React, TypeScript. It's one
> Docker container on Render's free plan, so the first load after it's been idle
> takes about a minute.
>
> I wrote it with heavy help from an AI coding assistant (Claude). The design
> calls and the testing are mine, and the reasoning is in `docs/`.
>
> Feedback I'd really like:
> 1. Try it with your group. Does the language picker give you films you
>    actually know, or does it need more regional variety?
> 2. Anything in the architecture you'd have done differently?

**First comment (optional)**
> Each game is a plugin: it declares its settings, its actions and how to build
> each player's view, and the room service never checks which game is running.
> `docs/game-engine.md` covers it if you want to add a game.

---

## 3. r/IndieDev (464k members)

**Why it fits.** The only rule is about capsule-art comparisons. Free games and
feedback requests are normal here and have their own flairs (`Free Game!`,
`Feedback?`).

**Rules that apply**
- *Capsule Comparison Post Ban, Except on Wednesdays*: doesn't apply.
- Sidebar: *"GIFs and images are the community-preferred medium… this is a
  community of developers… more like a room full of peers."* Lead with a
  screenshot or short clip of a round if you can, and pitch it to peers rather
  than players.

**Karma.** No minimum is stated. I couldn't sample poster karma because Reddit
rate-limited the check.

**Post type:** an image or video post with a screenshot or clip is best. A text
post with the link also works. **Flair:** `Free Game!`. `Feedback?` is the
alternative if you'd rather lean on the questions.

**Title**
> I made a free browser party game for my friend group: one link, everyone plays on their phone, no sign-up

**Body**
> FriendZone started as something to play with my friends when we're together.
> One person creates a room and shares the link, everyone joins from their phone
> browser, and the server runs the round: timers, scoring, who's host if the
> host's phone dies.
>
> **Play:** https://friendzone-n75y.onrender.com (free server, so the first load
> after idle takes about a minute)
>
> There are six short games. The ones my friends ask for most are **Emoji Movie**
> (guess the film from three emoji, in Telugu/Hindi/Tamil/Malayalam/English) and
> **Movie Mafia** (everyone gets a clue about the same film, one clue is secretly
> wrong, and its holder doesn't know). There's also a Telugu name-that-tune game,
> a blurred-picture guessing game, a "think alike" game and Who Am I?.
>
> Solo dev. I built it with a lot of help from an AI coding assistant. Code's
> public: https://github.com/ysai258/friendzone
>
> I'd value a dev's eye on two things:
> 1. The first 30 seconds: create a room, share the link, start. Is anything
>    confusing?
> 2. Does a game feel too long or too short per round?

**First comment (optional)**
> If you open the room on two devices (or two tabs), you'll see the per-player
> view. In Who Am I?, your own identity never reaches your browser at all, not
> even hidden in the payload.

---

## 4. r/FreeGames (118k members), link post

**Why it fits.** The sub covers "standalone freeware… indie… open source… new
and old" and has a `Browser Game` flair. FriendZone is free forever, with no
trial and nothing to buy.

**Rules that apply**
- *Free Games* / *Forever Free*: it is.
- *No warez, trials… link to the original content*: link straight to the game.
- The sidebar says your own extra content is "welcome in the comment section of
  the submission".
- The sub takes **link posts only**, so the description goes in the first comment.

**Karma.** No minimum is stated. I couldn't sample poster karma because Reddit
rate-limited the check. This sub is the most likely of the four to have an
unstated karma filter, so post it last. If it's removed, leave it.

**Post type:** link post to `https://friendzone-n75y.onrender.com`.
**Flair:** `Browser Game`.

**Title**
> FriendZone – free no-signup party games for friends on their phones (Emoji Movie, Who Am I?, Movie Mafia, Telugu Name That Tune) [Browser]

**First comment**
> I made this to play with my friends. Somebody creates a room and shares the
> link, everyone joins from their phone browser with just a name, and you play.
> No accounts, no download, no ads, nothing to buy.
>
> Six games, mostly for 3–12 people: guess the film from emoji (Telugu, Hindi,
> Tamil, Malayalam or English), a blurred picture that sharpens, a "think alike"
> answer game, Who Am I?, a spot-the-wrong-clue game, and a Telugu song intro
> game.
>
> It's on a free server, so the first load after it's been idle takes about a
> minute. Built solo with help from an AI coding assistant. Source:
> https://github.com/ysai258/friendzone
>
> If you play it with your group, I'd love to hear which game you came back to,
> and whether anything was confusing when joining.

---

## Checked and not recommended

| Subreddit | Why not |
| --- | --- |
| r/WebGames, r/SideProject, r/microsaas, r/buildinpublic, r/indiehackers, r/IMadeThis, r/betatests | Excluded: already posted, or auto-removed. |
| r/tollywood | Needs 100 post karma. Also bans self-promotion and AI posts. |
| r/indiegames | Bans generative-AI posts, needs gameplay media, and doesn't allow questions in promo titles. |
| r/DestroyMyGame | Video-only, and its no-AI rule names Claude. |
| r/jackboxgames | Posts must be about Jackbox. No self-promotion, no AI. |
| r/Telugu | No AI content, and no promotion unless it's about the Telugu language. |
| r/IndieGaming | Wants an established posting history and a GenAI declaration. One post per two weeks. Maybe later. |
| r/playtesters | No self-promotion. It's for recruiting testers. |
| r/hyderabad | No advertising without mod permission. Ask the mods first if you want it. |
| r/IndianGaming | No ban on promotion, but it's PC, console and sales talk, and there's no fitting flair. A possible later option, with no emojis in the title (rule 3.2). |
| r/partygames, r/BrowserGames | Not accessible (HTTP 403). |
| r/html5games | Restricted: only approved users can post. |
