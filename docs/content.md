# Content

Four of the five games play from hand-written datasets in `data/seed/`; Blur
Battle plays from images the pipeline fetches and derives. This is what is in
them, the rules they were written to, and how to change them.

## The files

```
data/seed/
  movies/telugu.json      135   Emoji Movie — one file per language
  movies/hindi.json        72
  movies/english.json      60
  movies/tamil.json        48
  movies/malayalam.json    36
  mafia.json               90   Movie Mafia subjects with two clues each
  prompts.json            221   Mind Meld, 17 themes
  identities.json         177   Who Am I?, 7 categories
  image-subjects.json      79   Blur Battle subjects; the pipeline does the rest
```

Each file is `{ "$comment": …, "items": [ … ] }`, and the movie files also
carry `"language"`, which is where an Emoji Movie item's language comes from —
a film is Telugu because it is in `telugu.json`, not because someone remembered
to type a field.

```jsonc
// movies/telugu.json
{ "id": "te-baahubali", "title": "Baahubali", "year": 2015, "difficulty": "easy",
  "emojis": "👑 🏔️ ⚔️",
  "aliases": ["Baahubali The Beginning", "Bahubali", "Baahubali 2"] }

// mafia.json — the imposter's clue must fit the film without naming it
{ "id": "mf-te-baahubali", "language": "telugu", "title": "Baahubali", "difficulty": "easy",
  "fanClue": "A waterfall, a kingdom, and a question the sequel took two years to answer.",
  "imposterClue": "A warrior learns who his parents were and goes to take back what is his." }

// identities.json — three hints, first vague, last nearly a giveaway
{ "id": "id-prabhas", "name": "Prabhas", "category": "telugu-actors", "difficulty": "medium",
  "aliases": [], "hints": ["I carried a very large lingam up a lot of steps.", …] }

// prompts.json
{ "id": "mm-name-something-people-do-every-morning-without-think",
  "prompt": "Name something people do every morning without thinking.",
  "category": "everyday", "difficulty": "easy" }
```

## What gets in

**Recognition, not count.** Every title in the movie files is one a group of
friends who watch films in that language would name without hesitation. A
larger library of films nobody recognises makes a worse game than a smaller one
of films everybody does: a round where nobody guesses is a round where nobody
had fun.

**No invented popularity scores.** There is no `famousness: 0.87` anywhere. The
selection criterion is editorial and is recorded in each file's `$comment`
rather than dressed up as data. Difficulty is a three-way judgement — `easy` is
a film almost anyone would place, `hard` is one that needs the right crowd —
and it degrades gracefully: the provider widens a difficulty filter rather than
failing, so a mis-labelled item costs nothing.

**Telugu first.** The default room is Telugu + Hindi, and Telugu has the
largest pool by a distance. The rest of the languages exist for rooms that ask
for them.

**Spread.** Within a language the list runs from the 1980s to now and across
stars, directors and genres, so a room that plays six games does not spend all
six in one decade.

**Clues never spell the title.** An Emoji Movie clue is themes, characters,
objects, plot beats. `🅱️🅰️🅷🆄` is not a clue, it is a crossword. The same rule
holds for Who Am I? hints and Mafia clues: they describe, they do not encode.

**A Mafia imposter clue must be plausible.** It has to describe a film loosely
enough that its holder can bluff, and it must not be a description of a
different film — that would make the imposter's job impossible rather than
hard.

**Who Am I? categories must seat a table.** Every category carries at least
`maxPlayers` (10) people, because the game deals one each and refuses to mix
categories. Current categories: Telugu actors (32), Indian actors (30), Telugu
actresses (25), Indian cricketers (25), world figures (25), Indian actresses
(20), Indian singers (20).

**Mind Meld prompts have no right answer.** A prompt that does — "name the
capital of France" — scores everyone the same and teaches nothing about the
room. Every prompt must have several answers a reasonable person might give,
and the bank spans 17 themes (everyday, food, Telugu culture, Indian culture,
movies, travel, school and college, work, friendship, funny, hypothetical,
preferences, association, cricket and sport, technology, childhood, festivals
and family) so a long evening does not circle one topic.

## Answers that mean the same thing

`packages/shared/src/synonyms.ts` is a curated list of groups whose members
Mind Meld treats as one answer — `phone`/`mobile`/`cell phone`,
`tea`/`chai`, `biryani`/`biriyani`, `amma`/`mother`/`mom`. Scoring rewards
agreement, so two people who picked different words for the same thing have
been cheated by the software rather than out-guessed by each other.

The rules it is written to:

- **Only true equivalence.** `tea`/`chai` yes, `tea`/`coffee` no. If a group
  would merge two answers a player could have deliberately chosen between, it
  does not belong.
- **No ambiguous words.** Indian English uses *picture* for both a photo and a
  film, and *hotel* for both a place to sleep and a place to eat. Neither is in
  the list: an unmerged pair costs one round, a wrongly merged pair is a bug
  nobody at the table can see.
- **Spellings count.** Half the value is `chapati`/`chapathi` and
  `colour`/`color` — one word typed by two people.
- **One group per word**, or the fold would depend on which group was read
  first. A test enforces it, along with "every variant reaches its leader" and
  "no two groups collapse into one key".

Plurals, gerunds and `-y`/`-ie` endings need no entry: the stemmer already
folds `phones`, `mobiles` and `idly`.

Adding a group is one line in that file. Nothing else changes — the tests will
tell you if the new group overlaps an existing one.

The list is not the last line of defence, though, and it is not meant to be:
during the results the host can join any two answers by hand and undo it. That
covers what a dictionary cannot — an inside joke, a word in a language nobody
wrote down, a phrase one table uses and another does not. If a pair comes up
often enough to be worth automating, it belongs in a group here.

## What the seed refuses

Both checks are in `apps/server/src/content/seed.ts` and both fail the seed
rather than warn:

- **Identical answers.** `questions(kind, answer_key)` is unique on the
  normalised answer, so two items a player could not tell apart cannot coexist.
- **Confusable answers.** The games forgive typos, so two answers within the
  typo allowance mean one is silently accepted for the other. `Gamyam` and
  `Gaayam` are both real Telugu films one edit apart; `Drishyam` exists in both
  Hindi and Malayalam. `findConfusableAnswers` catches these across every
  dataset of a kind, including across language files.

An item whose answer normalises to nothing is skipped and counted rather than
inserted.

## Changing content

```bash
# 1. Edit or add a file under data/seed/
# 2. Load it
npm run seed
```

The seed is idempotent and scoped per dataset: it upserts what the file
contains and deletes rows carrying that dataset's id that the file no longer
lists — before the inserts, so a renamed item does not collide with its own
previous answer key. Nothing outside the dataset being loaded is touched.

Adding a language is a new file in `data/seed/movies/` plus its entry in
`MOVIE_LANGUAGES` and `MOVIE_LANGUAGE_LABELS` in
`packages/game-engine/src/content.ts`. The lobby's language picker, the
settings schema and the server-side filter all read from that list, so nothing
else changes.

Adding a Who Am I? category is an entry in `IDENTITY_CATEGORIES` and at least
ten people in `identities.json`.

On a deployment with no release step — Render, or the `allinone` image —
`SEED_ON_BOOT` runs this reconciliation at startup, so pushing a content change
and letting the service rebuild is the whole update procedure. See
[deployment.md](deployment.md#updating-content-on-a-live-deployment).

## Blur Battle images

`image-subjects.json` lists subjects; the pipeline in `scripts/dataset/` turns
each into a five-step reveal ladder:

```bash
npm run dataset:sample    # generated placeholder art, no network
npm run dataset:fetch     # real photographs from Wikimedia Commons
npm run seed
```

`dataset:fetch` needs `WIKIMEDIA_USER_AGENT` in `.env` with a contact address,
as Wikimedia asks of automated clients. It filters out NonCommercial and
NoDerivatives files (this project makes derivatives), deduplicates by
difference hash, derives the ladder with `sharp`, and carries each image's
author, source and licence through to the reveal screen. Subjects it rejects
simply do not appear in `data/out/image.json`, which is what the seed reads —
so the image count can be lower than the subject count.

Derivation is the one genuinely batch workload in the system, and is therefore
the one thing that runs through BullMQ; see
[architecture.md](architecture.md).
