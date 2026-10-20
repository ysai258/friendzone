-- Drop the game history tables.
--
-- They were written on every game but read only by an admin route that was off
-- in production, so they cost writes and a database that outlives a free plan
-- for a record nobody looked at. Live state is in Redis; what stays here is the
-- content library.
--
-- Children first, so no foreign key is left pointing at a dropped table.
DROP TABLE IF EXISTS game_events;
DROP TABLE IF EXISTS game_results;
DROP TABLE IF EXISTS game_sessions;
DROP TABLE IF EXISTS room_players;
DROP TABLE IF EXISTS rooms;
