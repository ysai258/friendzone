import { useEffect, useState } from 'react'
import { ROOM_ACTIONS, type PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card, TextInput } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { AnsweredRow, Countdown, GameHeader, PlayerName, readView } from './shared.tsx'

interface MeldView {
  prompt: string
  answeredPlayerIds: string[]
  activeCount: number
  yourAnswer?: string
  groups?: { key: string; label: string; playerIds: string[]; points: number }[]
  loners?: number
  awaitingHost?: boolean
  isLastRound?: boolean
  merged?: boolean
}

export function MindMeld({ connection, room }: GameProps) {
  const view = readView<MeldView>(room)
  const phase = room.game?.phase

  if (phase === 'COUNTDOWN') {
    return (
      <Countdown
        connection={connection}
        room={room}
        title={`Prompt ${room.game?.roundNumber} of ${room.game?.totalRounds}`}
        subtitle="Points for agreeing. Don't be clever."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🧠 Mind Meld" accent="bg-emerald-400" />

      <Card className="py-7 text-center">
        <p className="text-2xl font-bold leading-snug">{view.prompt}</p>
      </Card>

      {phase === 'PROMPT' ? (
        <Answering connection={connection} view={view} room={room} />
      ) : (
        <Groups connection={connection} view={view} room={room} />
      )}
    </div>
  )
}

function Answering({ connection, view, room }: { connection: GameProps['connection']; view: MeldView; room: PublicRoomView }) {
  const [answer, setAnswer] = useState('')
  const submitted = view.yourAnswer

  const submit = () => {
    if (answer.trim().length === 0) return
    connection.send('meld/submit', { answer: answer.trim() })
    setAnswer('')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <TextInput
          autoFocus
          value={answer}
          maxLength={60}
          enterKeyHint="send"
          autoCapitalize="off"
          placeholder={submitted === undefined ? 'Your answer' : 'Change your answer'}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <Button onClick={submit} disabled={answer.trim().length === 0}>
          {submitted === undefined ? 'Lock in' : 'Change'}
        </Button>
      </div>

      {submitted !== undefined && (
        <p className="animate-pop text-center text-sm">
          You said <span className="font-bold text-emerald-300">{submitted}</span>
        </p>
      )}
      <p className="text-center text-xs text-muted">Nobody can see anybody&rsquo;s answer until the clock stops.</p>
      <AnsweredRow players={room.players} answeredIds={view.answeredPlayerIds} />
    </div>
  )
}

function Groups({
  connection,
  view,
  room,
}: {
  connection: GameProps['connection']
  view: MeldView
  room: PublicRoomView
}) {
  const groups = view.groups ?? []
  const isHost = room.viewerId === room.hostId
  const hostName = room.players.find((p) => p.isHost)?.name ?? 'the host'
  const awaiting = view.awaitingHost === true

  // Groups the host has picked out to join together. Cleared whenever the
  // round moves on or the grouping changes underneath it, so a stale
  // selection can never be applied to groups that are no longer on screen.
  const [picked, setPicked] = useState<string[]>([])
  const signature = `${room.game?.roundNumber ?? 0}:${groups.map((g) => g.key).join('|')}`
  useEffect(() => setPicked([]), [signature])

  const canRegroup = isHost && awaiting
  const toggle = (key: string) =>
    setPicked((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]))

  const join = () => {
    if (picked.length < 2) return
    // The first one picked keeps its wording, which is why order matters here.
    connection.send('meld/merge', { keys: picked })
    setPicked([])
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {groups.map((group, index) => {
          const matched = group.playerIds.length > 1
          const order = picked.indexOf(group.key)
          const selected = order >= 0
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3" style={{ animationDelay: `${index * 60}ms` }}>
                <p className="flex min-w-0 items-baseline gap-2 text-lg font-bold">
                  {selected && (
                    <span className="shrink-0 rounded-full bg-violet-500 px-2 text-xs leading-5 text-white" aria-hidden>
                      {order + 1}
                    </span>
                  )}
                  <span className="truncate">{group.label}</span>
                </p>
                {group.points > 0 ? (
                  <span className="tabular shrink-0 font-bold text-emerald-300">+{group.points}</span>
                ) : (
                  <span className="shrink-0 text-xs font-semibold text-muted">alone</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.playerIds.map((id) => (
                  <span key={id} className="rounded-full bg-white/8 px-2.5 py-1 text-xs">
                    <PlayerName room={room} playerId={id} />
                  </span>
                ))}
              </div>
            </>
          )

          const tone = matched ? 'border-emerald-400/40 bg-emerald-500/10' : ''
          if (!canRegroup) {
            // Staggered so the big matches land first and it reads as a reveal.
            return (
              <Card key={group.key} className={`animate-rise flex flex-col gap-2 ${tone}`}>
                {body}
              </Card>
            )
          }
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={selected}
              aria-label={`${group.label}, ${group.playerIds.length} ${group.playerIds.length === 1 ? 'player' : 'players'}`}
              onClick={() => toggle(group.key)}
              className={`card animate-rise flex flex-col gap-2 p-4 text-left transition ${tone} ${
                selected ? 'ring-2 ring-violet-400' : ''
              }`}
            >
              {body}
            </button>
          )
        })}
        {groups.length === 0 && <p className="py-6 text-center text-sm text-muted">Nobody answered in time.</p>}
      </div>

      {/* The machine folds "phone" and "mobile" together on its own; this is
          for everything it cannot know — an inside joke, a word in another
          language, two spellings nobody has written down. */}
      {canRegroup && groups.length > 1 && (
        <p className="text-center text-xs text-muted">
          {picked.length === 0
            ? 'Tap two answers that meant the same thing to join them.'
            : picked.length === 1
              ? 'Now tap the one it should join.'
              : `${picked.length} answers selected.`}
        </p>
      )}

      {view.merged === true && !canRegroup && (
        <p className="text-center text-xs text-muted">{hostName} joined some of these answers.</p>
      )}

      <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />

      {/* No timer here on purpose: the argument about who said what is the
          best part of this game, so the round ends when the host says so. */}
      {awaiting && (
        <div className="sticky bottom-4 flex flex-col gap-2">
          {isHost ? (
            <>
              {picked.length >= 2 && (
                <Button size="lg" variant="ghost" onClick={join}>
                  Join {picked.length} answers
                </Button>
              )}
              {view.merged === true && picked.length < 2 && (
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={() => connection.send('meld/unmerge')}
                >
                  Undo joins
                </Button>
              )}
              <Button size="lg" onClick={() => connection.send(ROOM_ACTIONS.CONTINUE)}>
                {view.isLastRound === true ? 'See final results →' : 'Next question →'}
              </Button>
            </>
          ) : (
            <p className="py-2 text-center text-sm text-muted">
              Talk it over — {hostName} moves it on when you&rsquo;re done.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
