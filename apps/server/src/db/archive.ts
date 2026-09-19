import type { Pool } from 'pg'
import type { Logger } from '../logger.ts'
import { buildScoreboard } from '../rooms/views.ts'
import { playersByJoinSeq, type RoomRecord } from '../rooms/state.ts'

export interface RecentSession {
  id: string
  room_code: string
  game_id: string
  started_at: Date
  ended_at: Date | null
  players: string
}

/**
 * The durable record of what happened.
 *
 * Every method here is called without being awaited by the realtime path. That
 * is the whole design: a round must not get slower because Postgres is having a
 * moment, and it must not fail because Postgres is down. What is lost in that
 * case is history, which is recoverable, rather than the game, which is not.
 *
 * What gets written is deliberately narrow — room created, game started, game
 * finished, and a short list of lifecycle events. Persisting every WebSocket
 * frame would turn a party game into a write-heavy analytics pipeline and buy
 * nothing anybody would read.
 */
export class RoomArchive {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  async recordRoomCreated(room: RoomRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO rooms (code, seed, game_id, host_player_id, status, max_players, created_at, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($7 / 1000.0))
       ON CONFLICT (code) DO NOTHING`,
      [room.code, room.seed, room.config.gameId, room.hostId, room.status, room.config.maxPlayers, room.createdAt],
    )
    await this.syncPlayers(room)
  }

  async recordGameStarted(room: RoomRecord, sessionId: string, settings: unknown): Promise<void> {
    await this.syncPlayers(room)
    await this.pool.query(
      `INSERT INTO game_sessions (id, room_code, game_id, settings, started_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [sessionId, room.code, room.config.gameId, JSON.stringify(settings), room.session?.startedAt ?? Date.now()],
    )
    await this.recordEvent(room.code, sessionId, null, 'GAME_STARTED', { gameId: room.config.gameId })
  }

  async recordGameFinished(room: RoomRecord, sessionId: string): Promise<void> {
    await this.syncPlayers(room)
    const scoreboard = buildScoreboard(room)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE game_sessions SET ended_at = now(), end_reason = 'COMPLETED' WHERE id = $1 AND ended_at IS NULL`,
        [sessionId],
      )
      for (const entry of scoreboard) {
        await client.query(
          `INSERT INTO game_results (session_id, player_id, score, rank)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id, player_id) DO UPDATE SET score = EXCLUDED.score, rank = EXCLUDED.rank`,
          [sessionId, entry.playerId, entry.score, entry.rank],
        )
        await client.query(`UPDATE room_players SET final_score = $1 WHERE id = $2`, [entry.score, entry.playerId])
      }
      await client.query(`UPDATE rooms SET status = $1, last_activity_at = now() WHERE code = $2`, ['GAME_OVER', room.code])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    await this.recordEvent(room.code, sessionId, null, 'GAME_COMPLETED', { players: scoreboard.length })
  }

  async recordEvent(
    roomCode: string,
    sessionId: string | null,
    playerId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO game_events (room_code, session_id, player_id, type, data) VALUES ($1, $2, $3, $4, $5)`,
      [roomCode, sessionId, playerId, type, JSON.stringify(data)],
    )
  }

  /**
   * Upsert the current roster. Called at lifecycle boundaries rather than on
   * every join, because a player's row only has to exist before a result
   * references it.
   */
  private async syncPlayers(room: RoomRecord): Promise<void> {
    const players = playersByJoinSeq(room)
    if (players.length === 0) return

    const values: unknown[] = []
    const tuples = players.map((p, i) => {
      const base = i * 4
      values.push(p.id, room.code, p.name, p.joinSeq)
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`
    })

    await this.pool.query(
      `INSERT INTO room_players (id, room_code, name, join_seq)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      values,
    )
  }

  /** Recent finished games, for the admin page. */
  async recentSessions(limit = 25): Promise<RecentSession[]> {
    const { rows } = await this.pool.query<RecentSession>(
      `SELECT s.id, s.room_code, s.game_id, s.started_at, s.ended_at,
              (SELECT count(*) FROM game_results r WHERE r.session_id = s.id) AS players
         FROM game_sessions s
        ORDER BY s.started_at DESC
        LIMIT $1`,
      [limit],
    )
    return rows
  }

  /** Used by the readiness probe. Cheap on purpose. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  logFailure(error: unknown, context: Record<string, unknown>): void {
    this.logger.error({ err: error, ...context }, 'archive write failed')
  }
}
