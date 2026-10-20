import { useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import { ROOM_ACTIONS } from '@friendzone/shared'
import type { RoomConnection } from '../lib/useRoom.ts'
import { Badge, BigText, Button, Card } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { GameEpilogue } from '../games/index.tsx'

/**
 * The final screen. Who won, what the last game's secrets were, and — the part
 * that decides whether anyone plays twice — a way to go again without anybody
 * leaving the room or reopening a link.
 */
export function Results({ connection, room }: { connection: RoomConnection; room: PublicRoomView }) {
  const [copied, setCopied] = useState(false)
  const isHost = room.viewerId === room.hostId
  const board = room.scoreboard
  const winner = board[0]
  const you = board.find((entry) => entry.playerId === room.viewerId)

  const shareResult = async () => {
    const lines = [
      `FriendZone — ${room.code}`,
      ...board.slice(0, 5).map((e) => `${e.rank}. ${e.name} ${e.score.toLocaleString()}`),
      window.location.origin,
    ].join('\n')
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'FriendZone results', text: lines })
        return
      }
      await navigator.clipboard.writeText(lines)
    } catch {
      // Cancelled or blocked; the board is on screen regardless.
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col items-center gap-3 pt-4 text-center">
        <span className="animate-float text-7xl" aria-hidden>🏆</span>
        <h1 className="-rotate-2 rounded-2xl border-3 border-ink bg-ink px-4 py-1.5 font-chunky text-base text-sun shadow-hard-sm">
          Final results
        </h1>
        {winner !== undefined && (
          <BigText as="p" color="sun" size="lg">
            {winner.avatar} {winner.name} wins
          </BigText>
        )}
        {you !== undefined && winner?.playerId !== you.playerId && (
          <Badge size="md" color="bubblegum">You finished {ordinal(you.rank)}</Badge>
        )}
      </header>

      <Scoreboard entries={board} viewerId={room.viewerId} />

      <GameEpilogue room={room} />

      <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 bg-gradient-to-t from-paper via-paper/90 to-transparent px-1 pb-4 pt-6">
        {isHost ? (
          <Button size="xl" block icon="🔁" onClick={() => connection.send(ROOM_ACTIONS.PLAY_AGAIN)}>Play again</Button>
        ) : (
          <Card color="sun" soft padding="sm" className="text-center font-display font-extrabold">
            Waiting for {room.players.find((p) => p.isHost)?.name ?? 'the host'} to start another…
          </Card>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" icon="📤" className="flex-1" onClick={() => void shareResult()}>
            {copied ? 'Copied ✓' : 'Share results'}
          </Button>
          <Button variant="secondary" icon="👋" className="flex-1" onClick={() => { window.location.href = '/' }}>Leave</Button>
        </div>
      </div>
    </div>
  )
}

function ordinal(rank: number): string {
  const suffix = rank % 100 >= 11 && rank % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][rank % 10] ?? 'th'
  return `${rank}${suffix}`
}
