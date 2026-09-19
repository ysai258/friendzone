import { useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import { ROOM_ACTIONS } from '@friendzone/shared'
import type { RoomConnection } from '../lib/useRoom.ts'
import { Button, Card, Pill } from '../components/ui.tsx'
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
      <header className="animate-pop flex flex-col items-center gap-1 pt-4 text-center">
        <span className="text-5xl" aria-hidden>🏆</span>
        <h1 className="text-3xl font-extrabold">Final results</h1>
        {winner !== undefined && (
          <p className="text-lg font-semibold text-amber-200">
            {winner.avatar} {winner.name} wins
          </p>
        )}
        {you !== undefined && winner?.playerId !== you.playerId && (
          <Pill>You finished {ordinal(you.rank)}</Pill>
        )}
      </header>

      <Scoreboard entries={board} viewerId={room.viewerId} />

      <GameEpilogue room={room} />

      <div className="sticky bottom-4 flex flex-col gap-2">
        {isHost ? (
          <Button size="lg" onClick={() => connection.send(ROOM_ACTIONS.PLAY_AGAIN)}>Play again</Button>
        ) : (
          <Card className="text-center text-sm text-muted">
            Waiting for {room.players.find((p) => p.isHost)?.name ?? 'the host'} to start another…
          </Card>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => void shareResult()}>
            {copied ? 'Copied ✓' : 'Share results'}
          </Button>
          <Button variant="ghost" className="flex-1" onClick={() => { window.location.href = '/' }}>Leave</Button>
        </div>
      </div>
    </div>
  )
}

function ordinal(rank: number): string {
  const suffix = rank % 100 >= 11 && rank % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][rank % 10] ?? 'th'
  return `${rank}${suffix}`
}
