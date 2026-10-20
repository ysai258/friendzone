import type { PublicRoomView } from '@friendzone/shared'
import { ROOM_ACTIONS } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Badge, Button, Card } from '../components/ui.tsx'
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
      <GameHeader connection={connection} room={room} label="🎭 Movie Mafia" accent="bg-sky" />

      {view.yourClue !== undefined && (
        <Card
          color={view.youAreImposter === true ? 'tomato' : 'grape'}
          soft
          tilt="left"
          shadow="lg"
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">Your clue</p>
            {view.youAreImposter === true && (
              <Badge color="tomato" size="md" className="animate-wiggle shadow-hard-sm">you are the imposter</Badge>
            )}
          </div>
          <p className="break-words rounded-2xl border-2 border-ink bg-white px-4 py-3 font-display text-xl font-extrabold leading-snug shadow-hard-sm">{view.yourClue}</p>
          {view.youAreImposter === true && (
            <p className="text-xs font-semibold text-ink">
              Everyone else was told something more specific. Blend in, and do not be the first to commit.
            </p>
          )}
        </Card>
      )}

      {phase === 'ROLES' && (
        <Card className="text-center">
          <p className="font-display text-lg font-extrabold">Read your clue.</p>
          <p className="text-sm text-ink-soft">One of you was told something different. Nobody knows who.</p>
        </Card>
      )}

      {phase === 'DISCUSSION' && (
        <div className="flex flex-col gap-3">
          <Card color="sky" soft tilt="right" className="text-center">
            <p className="font-display text-lg font-extrabold">Talk it out.</p>
            <p className="pt-1 text-sm text-ink-soft">
              Describe your clue without giving it away word for word. The imposter is doing the same.
            </p>
          </Card>
          {alive && (
            <Button variant="primary" size="lg" block onClick={() => connection.send('mafia/ready', {})}>
              Ready to vote
            </Button>
          )}
        </div>
      )}

      {phase === 'VOTE' && <Voting connection={connection} view={view} room={room} alive={alive} />}

      {(phase === 'RESULT' || phase === 'FINISHED') && <Result view={view} room={room} />}

      {phase === 'RESULT' && isHost && view.outcome === undefined && (
        <Button variant="primary" size="lg" block onClick={() => connection.send(ROOM_ACTIONS.CONTINUE, {})}>
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
      <p className="text-center font-display text-2xl font-extrabold">Who is bluffing?</p>

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
                className={`flex min-h-14 min-w-0 items-center gap-2 rounded-2xl border-ink p-3 text-left transition-[transform,box-shadow] duration-100 ${
                  chosen
                    ? 'animate-pop border-3 bg-tomato shadow-hard-lg'
                    : 'border-2 bg-white shadow-hard-sm disabled:opacity-55 enabled:hover:-translate-y-px enabled:hover:bg-sun-soft enabled:hover:shadow-hard enabled:active:translate-y-0.5 enabled:active:shadow-none'
                }`}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full border-2 border-ink bg-white text-xl" aria-hidden>{player.avatar}</span>
                <span className="min-w-0 flex-1 truncate font-display font-extrabold text-ink">{player.name}</span>
                {view.votedPlayerIds.includes(player.id) && <span className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-ink bg-lime text-xs font-bold text-ink" title="has voted">✓</span>}
              </button>
            )
          })}
      </div>

      {voted && <Banner tone="neutral">Vote locked in. Nobody can see it yet.</Banner>}
      {!alive && <p className="text-center text-sm font-medium text-ink-soft">You were voted out — watch it play out.</p>}
      <p className="text-center text-xs font-semibold text-ink-soft">{view.votedPlayerIds.length} of {view.aliveCount} voted</p>
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
            <p className="text-center font-display text-xl font-extrabold">Tied — nobody goes.</p>
          ) : last.eliminated !== null ? (
            <p className="text-center font-display text-xl font-extrabold">
              <PlayerName room={room} playerId={last.eliminated} /> was voted out.
            </p>
          ) : (
            <p className="text-center font-display text-xl font-extrabold">No votes were cast.</p>
          )}

          <div className="flex flex-col gap-2">
            {last.tally.map((entry) => (
              <div key={entry.playerId} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="w-28 min-w-0 shrink-0 truncate sm:w-36"><PlayerName room={room} playerId={entry.playerId} /></span>
                <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-full border-2 border-ink bg-paper-deep">
                  <div
                    className="h-full bg-sky"
                    style={{ width: `${(entry.votes / Math.max(1, view.aliveCount)) * 100}%` }}
                  />
                </div>
                <span className="tabular w-6 shrink-0 text-right font-chunky text-base">{entry.votes}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {view.outcome !== undefined && (
        <Card
          color={view.outcome === 'FANS_WIN' ? 'lime' : 'tomato'}
          tilt="right"
          shadow="lg"
          className="animate-pop flex flex-col gap-3 text-center"
        >
          <p className="break-words font-display text-3xl font-extrabold leading-tight sm:text-4xl">
            {view.outcome === 'FANS_WIN' ? 'The fans got them' : 'The imposter got away with it'}
          </p>
          {view.imposterId !== undefined && (
            <p className="font-display text-lg font-bold">
              The imposter was{' '}
              <span className="inline-block -rotate-2 rounded-2xl border-3 border-ink bg-white px-3 py-1 text-xl font-extrabold shadow-hard">
                <PlayerName room={room} playerId={view.imposterId} />
              </span>
            </p>
          )}
          {view.subject !== undefined && (
            <div className="flex flex-col gap-2 pt-2 text-left">
              <p className="text-center text-sm font-medium text-ink">
                The film was <span className="font-display font-extrabold text-ink">{view.subject}</span>
                {view.languageLabel !== undefined && ` (${view.languageLabel})`}
              </p>
              <div className="flex flex-col items-start gap-1.5 rounded-2xl border-2 border-ink bg-white p-3 shadow-hard-sm">
                <p className="rounded-full border-2 border-ink bg-sky px-2 py-0.5 font-display text-xs font-extrabold uppercase tracking-wider text-ink">Everyone else read</p>
                <p className="break-words text-sm font-medium text-ink">{view.fanClue}</p>
              </div>
              <div className="flex flex-col items-start gap-1.5 rounded-2xl border-2 border-ink bg-white p-3 shadow-hard-sm">
                <p className="rounded-full border-2 border-ink bg-tomato px-2 py-0.5 font-display text-xs font-extrabold uppercase tracking-wider text-ink">The imposter read</p>
                <p className="break-words text-sm font-medium text-ink">{view.imposterClue}</p>
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
    <Card color="sky" soft tilt="left" className="flex flex-col items-center gap-1 text-center">
      <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">The film was</p>
      <p className="break-words font-display text-2xl font-extrabold leading-tight">{view.subject}</p>
      {view.languageLabel !== undefined && <p className="text-xs font-semibold text-ink-soft">{view.languageLabel}</p>}
      {view.imposterId !== undefined && (
        <p className="mt-1 rounded-full border-2 border-ink bg-tomato-soft px-3 py-1 text-sm text-ink">
          Imposter: <PlayerName room={room} playerId={view.imposterId} />
        </p>
      )}
    </Card>
  )
}
