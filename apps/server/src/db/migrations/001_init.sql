-- FriendZone initial schema.
--
-- What lives here is the durable record: things worth keeping after the room is
-- gone. Live game state does not — it changes many times a second and belongs
-- in Redis. See docs/database.md for the full durable / ephemeral split.

CREATE TABLE rooms (
  code             TEXT PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  -- The room's RNG seed. Kept so a finished game's question draw can be
  -- reproduced exactly when investigating a scoring dispute.
  seed             TEXT        NOT NULL,
  game_id          TEXT        NOT NULL,
  host_player_id   UUID,
  status           TEXT        NOT NULL,
  max_players      SMALLINT    NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rooms_open_idx ON rooms (last_activity_at) WHERE closed_at IS NULL;

-- A person, scoped to one room. There are no accounts: identity is a signed
-- token tied to this row, and it dies with the room.
CREATE TABLE room_players (
  id           UUID        PRIMARY KEY,
  room_code    TEXT        NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  join_seq     INTEGER     NOT NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at      TIMESTAMPTZ,
  -- Denormalised at game end so results survive without replaying events.
  final_score  INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX room_players_room_idx ON room_players (room_code);
-- Host succession reads this order, so it must be unique and stable per room.
CREATE UNIQUE INDEX room_players_seq_idx ON room_players (room_code, join_seq);

-- One playthrough. A room that uses Play Again produces several of these.
CREATE TABLE game_sessions (
  id            UUID        PRIMARY KEY,
  room_code     TEXT        NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  game_id       TEXT        NOT NULL,
  settings      JSONB       NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  -- Why it ended: COMPLETED, ABANDONED, or RESET by the host.
  end_reason    TEXT
);

CREATE INDEX game_sessions_room_idx ON game_sessions (room_code, started_at DESC);

CREATE TABLE game_results (
  session_id  UUID     NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  player_id   UUID     NOT NULL REFERENCES room_players(id) ON DELETE CASCADE,
  score       INTEGER  NOT NULL,
  rank        SMALLINT NOT NULL,
  PRIMARY KEY (session_id, player_id)
);

-- A deliberately narrow audit trail: lifecycle moments only, never every
-- WebSocket frame. Enough to answer "what happened in that room" without
-- turning the database into the hot path.
CREATE TABLE game_events (
  id         BIGSERIAL   PRIMARY KEY,
  room_code  TEXT        NOT NULL,
  session_id UUID,
  player_id  UUID,
  type       TEXT        NOT NULL,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX game_events_room_idx ON game_events (room_code, at DESC);

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------

CREATE TABLE datasets (
  id          TEXT        PRIMARY KEY,
  kind        TEXT        NOT NULL,
  version     TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  license     TEXT        NOT NULL,
  item_count  INTEGER     NOT NULL DEFAULT 0,
  built_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id          TEXT     PRIMARY KEY,
  dataset_id  TEXT     NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- Matches ContentItem['kind'] in the engine: image, emoji, identity, prompt, mafia.
  kind        TEXT     NOT NULL,
  category    TEXT     NOT NULL,
  difficulty  TEXT     NOT NULL,
  -- The engine's ContentItem, stored whole. The engine owns this shape; the
  -- database indexes only what selection needs.
  payload     JSONB    NOT NULL,
  -- Normalised answer, used to reject near-duplicate content at load time.
  answer_key  TEXT     NOT NULL,
  active      BOOLEAN  NOT NULL DEFAULT TRUE
);

-- Leading on kind, which is what the server actually queries: it loads a whole
-- kind once and caches it, then filters difficulty and category in memory so a
-- game can start without touching the database at all. The trailing columns are
-- there for ad-hoc queries and for the day selection moves back into SQL.
CREATE INDEX questions_pick_idx ON questions (kind, difficulty, category) WHERE active;
CREATE UNIQUE INDEX questions_answer_idx ON questions (kind, answer_key);
