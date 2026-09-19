import type { ErasedGameDefinition } from '@friendzone/game-engine'
import type { RoomRecord } from './state.ts'

/**
 * When this room next needs the server's attention.
 *
 * Everything time-driven in the system funnels through this one number: the
 * end of a round, the moment a reveal should flip to the next question, the
 * instant a disconnected player's grace period runs out. It is stored in a
 * single Redis sorted set, so any instance can notice any room is due.
 *
 * Having one index rather than a timer per room is what makes the design
 * survive a restart. A process holding setTimeout handles loses every pending
 * transition when it dies; a sorted set does not care which box is alive.
 */
export function computeDeadline(room: RoomRecord, definition: ErasedGameDefinition | null): number | null {
  const candidates: number[] = []

  if (room.session !== null && definition !== null) {
    const gameDeadline = definition.getDeadline(room.session.state)
    if (gameDeadline !== null) candidates.push(gameDeadline)
  }

  for (const player of Object.values(room.players)) {
    if (player.presence === 'DISCONNECTED' && player.graceEndsAt !== null) {
      candidates.push(player.graceEndsAt)
    }
  }

  if (candidates.length === 0) return null
  return Math.min(...candidates)
}
