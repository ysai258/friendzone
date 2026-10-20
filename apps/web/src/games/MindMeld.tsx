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
  /** Set on a custom prompt: who wrote it. */
  authorId?: string
  canSkip?: boolean
  // While questions are being collected.
  collecting?: boolean
  submittedPlayerIds?: string[]
  yourQuestion?: string
}

export function MindMeld({ connection, room }: GameProps) {
  const view = readView<MeldView>(room)
  const phase = room.game?.phase
  const isHost = room.viewerId === room.hostId

  if (phase === 'COLLECT') return <Collecting connection={connection} view={view} room={room} />

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
      <GameHeader connection={connection} room={room} label="🧠 Mind Meld" accent="bg-lime" />

      <Card color="sun" tilt="left" shadow="lg" className="animate-pop flex flex-col items-center gap-3 px-5 py-8 text-center">
        <p className="max-w-full break-words font-display text-2xl font-extrabold leading-tight sm:text-3xl">{view.prompt}</p>
        {view.authorId !== undefined && (
          <p className="max-w-full rounded-full border-2 border-ink bg-white px-3 py-1 text-xs font-semibold text-ink">
            ✍️ Asked by <PlayerName room={room} playerId={view.authorId} />
          </p>
        )}
      </Card>

      {phase === 'PROMPT' ? (
        <>
          <Answering connection={connection} view={view} room={room} />
          {/* For the prompt the table has already played: a fresh one takes
              its place, so the game stays the same length. */}
          {isHost && view.canSkip === true && (
            <Button variant="ghost" onClick={() => connection.send('meld/skip')}>
              Skip this question ⏭
            </Button>
          )}
        </>
      ) : (
        <Groups connection={connection} view={view} room={room} />
      )}
    </div>
  )
}

/** Before the first prompt: everyone writes one of their own. */
function Collecting({ connection, view, room }: { connection: GameProps['connection']; view: MeldView; room: PublicRoomView }) {
  const [question, setQuestion] = useState('')
  const sent = view.yourQuestion
  const isHost = room.viewerId === room.hostId
  const ready = question.trim().length >= 5

  const submit = () => {
    if (!ready) return
    connection.send('meld/question', { question: question.trim() })
    setQuestion('')
  }

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🧠 Mind Meld" accent="bg-lime" />

      <Card color="grape" soft tilt="right" shadow="lg" className="flex flex-col gap-2 py-6 text-center">
        <p className="font-display text-xl font-extrabold leading-tight sm:text-2xl">Write a question for the table</p>
        <p className="text-sm font-medium text-ink-soft">
          One with an obvious answer — &ldquo;Name a fruit that&rsquo;s yellow&rdquo;. It gets mixed in with the rest.
        </p>
      </Card>

      <div className="flex gap-2">
        <TextInput
          autoFocus
          value={question}
          maxLength={140}
          enterKeyHint="send"
          placeholder={sent === undefined ? 'Your question' : 'Change your question'}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <Button onClick={submit} disabled={!ready}>
          {sent === undefined ? 'Send' : 'Change'}
        </Button>
      </div>

      {sent !== undefined && (
        <p className="animate-pop break-words text-center text-sm font-medium">
          You asked <span className="rounded-lg border-2 border-ink bg-lime px-1.5 font-display font-extrabold [box-decoration-break:clone]">{sent}</span>
        </p>
      )}
      <p className="text-center text-xs font-medium text-ink-soft">Nobody sees your question until it comes up.</p>
      <AnsweredRow players={room.players} answeredIds={view.submittedPlayerIds ?? []} />

      {isHost && (
        <Button size="lg" onClick={() => connection.send('meld/close-questions')}>
          Start now →
        </Button>
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
        <p className="animate-pop break-words text-center text-sm font-medium">
          You said <span className="rounded-lg border-2 border-ink bg-lime px-1.5 font-display font-extrabold [box-decoration-break:clone]">{submitted}</span>
        </p>
      )}
      <p className="text-center text-xs font-medium text-ink-soft">Nobody can see anybody&rsquo;s answer until the clock stops.</p>
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
                <p className="flex min-w-0 items-center gap-2 font-display text-lg font-extrabold">
                  {selected && (
                    <span className="grid size-6 shrink-0 animate-pop place-items-center rounded-full border-2 border-ink bg-grape text-xs leading-none text-ink" aria-hidden>
                      {order + 1}
                    </span>
                  )}
                  <span className="truncate">{group.label}</span>
                </p>
                {group.points > 0 ? (
                  <span className="tabular shrink-0 -rotate-3 rounded-full border-2 border-ink bg-sun px-2.5 py-0.5 font-chunky text-sm shadow-hard-sm">+{group.points}</span>
                ) : (
                  <span className="shrink-0 rounded-full border-2 border-ink bg-paper-deep px-2 py-0.5 text-xs font-bold text-ink-soft">alone</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.playerIds.map((id) => (
                  <span key={id} className="max-w-full truncate rounded-full border-2 border-ink bg-white px-2.5 py-1 text-xs">
                    <PlayerName room={room} playerId={id} />
                  </span>
                ))}
              </div>
            </>
          )

          if (!canRegroup) {
            // Staggered so the big matches land first and it reads as a reveal.
            return (
              <Card
                key={group.key}
                color={matched ? 'lime' : 'white'}
                padding="sm"
                shadow={matched ? 'md' : 'sm'}
                className="animate-rise flex flex-col gap-2 rounded-2xl px-4"
              >
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
              className={`animate-rise flex min-h-11 flex-col gap-2 rounded-2xl border-3 border-ink px-4 py-3 text-left transition-[transform,box-shadow] duration-100 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none ${
                matched ? 'bg-lime' : 'bg-white'
              } ${selected ? 'shadow-hard-lg ring-4 ring-grape ring-offset-2 ring-offset-paper' : 'shadow-hard'}`}
            >
              {body}
            </button>
          )
        })}
        {groups.length === 0 && <p className="rounded-2xl border-3 border-dashed border-ink bg-white py-6 text-center font-display text-sm font-bold text-ink-soft">Nobody answered in time.</p>}
      </div>

      {/* The machine folds "phone" and "mobile" together on its own; this is
          for everything it cannot know — an inside joke, a word in another
          language, two spellings nobody has written down. */}
      {canRegroup && groups.length > 1 && (
        <p className="text-center text-xs font-semibold text-ink-soft">
          {picked.length === 0
            ? 'Tap two answers that meant the same thing to join them.'
            : picked.length === 1
              ? 'Now tap the one it should join.'
              : `${picked.length} answers selected.`}
        </p>
      )}

      {view.merged === true && !canRegroup && (
        <p className="text-center text-xs font-semibold text-ink-soft">{hostName} joined some of these answers.</p>
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
            <p className="rounded-full border-2 border-ink bg-sun-soft px-4 py-2 text-center text-sm font-semibold shadow-hard-sm">
              Talk it over — {hostName} moves it on when you&rsquo;re done.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
