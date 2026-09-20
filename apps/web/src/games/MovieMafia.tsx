import type { PublicRoomView } from '@friendzone/shared'
import { ROOM_ACTIONS } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card, Pill } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { Banner, GameHeader, PlayerName, readView } from './shared.tsx'

interface MafiaView {
  round: number
  totalRounds: number
  alive: string[]
  votedPlayerIds: string[]
  aliveCount: number
  yourClue?: string
  yourVote?: string
  youAreImposter?: boolean
  lastRound?: {
    tally: { playerId: string; votes: number }[]
    eliminated: string | null
    tied: boolean
    votes: Record<string, string>
  }
  outcome?: 'FANS_WIN' | 'IMPOSTER_WINS'
  imposterId?: string
  subject?: string
  languageLabel?: string
  fanClue?: string
  imposterClue?: string
}

export function MovieMafia({ connection, room }: GameProps) {
  const view = readView<MafiaView>(room)
  const phase = room.game?.phase
  const me = room.viewerId
  const alive = me !== null && view.alive.includes(me)
  const isHost = room.viewerId === room.hostId

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🎭 Movie Mafia" accent="bg-sky-400" />

      {view.yourClue !== undefined && (
        <Card
          className={`flex flex-col gap-2 ${view.youAreImposter === true ? 'border-rose-400/40 bg-rose-500/10' : 'border-sky-400/30 bg-sky-500/10'}`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">Your clue</p>
            {view.youAreImposter === true && <Pill className="text-rose-200">you are the imposter</Pill>}
          </div>
          <p className="text-lg font-semibold leading-snug">{view.yourClue}</p>
          {view.youAreImposter === true && (
            <p className="text-xs text-rose-200/80">
              Everyone else was told something more specific. Blend in, and do not be the first to commit.
            </p>
          )}
        </Card>
      )}

      {phase === 'ROLES' && (
        <Card className="text-center">
          <p className="font-semibold">Read your clue.</p>
          <p className="text-sm text-muted">One of you was told something different. Nobody knows who.</p>
        </Card>
      )}

      {phase === 'DISCUSSION' && (
        <div className="flex flex-col gap-3">
          <Card className="text-center">
            <p className="font-semibold">Talk it out.</p>
            <p className="pt-1 text-sm text-muted">
              Describe your clue without giving it away word for word. The imposter is doing the same.
            </p>
          </Card>
          {alive && (
            <Button variant="ghost" onClick={() => connection.send('mafia/ready', {})}>
              Ready to vote
            </Button>
          )}
        </div>
      )}

      {phase === 'VOTE' && <Voting connection={connection} view={view} room={room} alive={alive} />}

      {(phase === 'RESULT' || phase === 'FINISHED') && <Result view={view} room={room} />}

      {phase === 'RESULT' && isHost && view.outcome === undefined && (
        <Button variant="ghost" onClick={() => connection.send(ROOM_ACTIONS.CONTINUE, {})}>
          Next round
        </Button>
      )}

      {phase === 'FINISHED' && <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />}
    </div>
  )
}

function Voting({
  connection,
  view,
  room,
  alive,
}: {
  connection: GameProps['connection']
  view: MafiaView
  room: PublicRoomView
  alive: boolean
}) {
  const voted = view.yourVote !== undefined

  return (
    <div className="flex flex-col gap-3">
      <p className="text-center font-semibold">Who is bluffing?</p>

      <div className="grid grid-cols-2 gap-2">
        {room.players
          .filter((p) => view.alive.includes(p.id))
          .map((player) => {
            const isYou = player.id === room.viewerId
            const chosen = view.yourVote === player.id
            return (
              <button
                key={player.id}
                type="button"
                disabled={!alive || voted || isYou}
                aria-pressed={chosen}
                onClick={() => connection.send('mafia/vote', { targetId: player.id })}
                className={`card flex items-center gap-2 p-3 text-left transition disabled:opacity-45 ${
                  chosen ? 'ring-2 ring-sky-400/60' : 'hover:bg-white/[0.06]'
                }`}
              >
                <span className="text-xl" aria-hidden>{player.avatar}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{player.name}</span>
                {view.votedPlayerIds.includes(player.id) && <span className="text-xs text-muted" title="has voted">✓</span>}
              </button>
            )
          })}
      </div>

      {voted && <Banner tone="neutral">Vote locked in. Nobody can see it yet.</Banner>}
      {!alive && <p className="text-center text-sm text-muted">You were voted out — watch it play out.</p>}
      <p className="text-center text-xs text-muted">{view.votedPlayerIds.length} of {view.aliveCount} voted</p>
    </div>
  )
}

function Result({ view, room }: { view: MafiaView; room: PublicRoomView }) {
  const last = view.lastRound

  return (
    <div className="flex flex-col gap-3">
      {last !== undefined && (
        <Card className="animate-pop flex flex-col gap-3">
          {last.tied ? (
            <p className="text-center text-lg font-bold">Tied — nobody goes.</p>
          ) : last.eliminated !== null ? (
            <p className="text-center text-lg font-bold">
              <PlayerName room={room} playerId={last.eliminated} /> was voted out.
            </p>
          ) : (
            <p className="text-center text-lg font-bold">No votes were cast.</p>
          )}

          <div className="flex flex-col gap-1.5">
            {last.tally.map((entry) => (
              <div key={entry.playerId} className="flex items-center gap-2 text-sm">
                <PlayerName room={room} playerId={entry.playerId} />
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-sky-400"
                    style={{ width: `${(entry.votes / Math.max(1, view.aliveCount)) * 100}%` }}
                  />
                </div>
                <span className="tabular w-5 text-right font-bold">{entry.votes}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {view.outcome !== undefined && (
        <Card
          className={`animate-pop flex flex-col gap-3 text-center ${
            view.outcome === 'FANS_WIN' ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-rose-400/40 bg-rose-500/10'
          }`}
        >
          <p className="text-2xl font-extrabold">
            {view.outcome === 'FANS_WIN' ? 'The fans got them' : 'The imposter got away with it'}
          </p>
          {view.imposterId !== undefined && (
            <p className="text-lg">
              The imposter was <PlayerName room={room} playerId={view.imposterId} />
            </p>
          )}
          {view.subject !== undefined && (
            <div className="flex flex-col gap-2 pt-2 text-left">
              <p className="text-center text-sm text-muted">
                The film was <span className="font-bold text-chalk">{view.subject}</span>
                {view.languageLabel !== undefined && ` (${view.languageLabel})`}
              </p>
              <div className="rounded-xl bg-black/25 p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-sky-300">Everyone else read</p>
                <p className="text-sm">{view.fanClue}</p>
              </div>
              <div className="rounded-xl bg-black/25 p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-rose-300">The imposter read</p>
                <p className="text-sm">{view.imposterClue}</p>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

export function MovieMafiaEpilogue({ room }: { room: PublicRoomView }) {
  const view = readView<MafiaView>(room)
  if (view.subject === undefined) return null
  return (
    <Card className="flex flex-col gap-1 text-center">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">The film was</p>
      <p className="text-lg font-bold">{view.subject}</p>
      {view.languageLabel !== undefined && <p className="text-xs text-muted">{view.languageLabel}</p>}
      {view.imposterId !== undefined && (
        <p className="text-sm text-muted">
          Imposter: <PlayerName room={room} playerId={view.imposterId} />
        </p>
      )}
    </Card>
  )
}
