import type { PublicRoomView } from '@friendzone/shared'
import type { RoomConnection } from '../lib/useRoom.ts'
import { Card, Spinner } from '../components/ui.tsx'
import { BlurBattle, BlurBattleEpilogue } from './BlurBattle.tsx'
import { EmojiMovie } from './EmojiMovie.tsx'
import { MindMeld } from './MindMeld.tsx'
import { WhoAmI, WhoAmIEpilogue } from './WhoAmI.tsx'
import { MovieMafia, MovieMafiaEpilogue } from './MovieMafia.tsx'

export interface GameProps {
  connection: RoomConnection
  room: PublicRoomView
}

/**
 * The client-side mirror of the server's registry: one entry per game, and no
 * branching on game id anywhere else in the app.
 */
const SCREENS: Record<string, (props: GameProps) => React.ReactElement> = {
  'blur-battle': BlurBattle,
  'emoji-movie': EmojiMovie,
  'mind-meld': MindMeld,
  'who-am-i': WhoAmI,
  'movie-mafia': MovieMafia,
}

const EPILOGUES: Record<string, (props: { room: PublicRoomView }) => React.ReactElement | null> = {
  'blur-battle': BlurBattleEpilogue,
  'who-am-i': WhoAmIEpilogue,
  'movie-mafia': MovieMafiaEpilogue,
}

export function GameScreen({ connection, room }: GameProps) {
  const gameId = room.game?.gameId
  if (gameId === undefined) return <Spinner label="Starting…" />

  const Screen = SCREENS[gameId]
  if (Screen === undefined) {
    return <Card><p className="text-sm text-muted">This version of the app does not know how to show {gameId}. Reload to update.</p></Card>
  }
  return <Screen connection={connection} room={room} />
}

/** Whatever a game wants to say once it is over, shown under the leaderboard. */
export function GameEpilogue({ room }: { room: PublicRoomView }) {
  const gameId = room.game?.gameId
  if (gameId === undefined) return null
  const Epilogue = EPILOGUES[gameId]
  return Epilogue === undefined ? null : <Epilogue room={room} />
}
