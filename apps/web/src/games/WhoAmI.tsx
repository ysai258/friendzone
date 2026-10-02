import { useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card, Pill, TextInput } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { Banner, GameHeader, PlayerName, readView } from './shared.tsx'

interface WhoAmIView {
  identities: Record<string, { name: string; category: string }>
  categoryLabel?: string
  asker: string | null
  question: string | null
  votedPlayerIds: string[]
  turnsUsed: Record<string, number>
  solved: Record<string, { turnsUsed: number; points: number; place: number }>
  maxTurns: number
  remaining: number
  yourHints?: string[]
  yourHintsLeft?: number
  yourHintsTaken?: number
  hintCost?: number
  history?: TurnRecord[]
  result?: TurnRecord
  reveal?: Record<string, string>
}

interface TurnRecord {
  asker: string
  question: string
  yes: number
  no: number
  guess: string | null
  correct: boolean
}

export function WhoAmI({ connection, room }: GameProps) {
  const view = readView<WhoAmIView>(room)
  const phase = room.game?.phase
  const me = room.viewerId
  const myTurn = me !== null && view.asker === me

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🕵️ Who Am I?" accent="bg-amber-400" />

      {/* Everyone at the table is from one category, and knowing which one is
          half the game — it is the boundary your questions live inside. */}
      {view.categoryLabel !== undefined && (
        <p className="text-center text-sm text-muted">
          Everyone here is one of the <span className="font-bold text-chalk">{view.categoryLabel}</span>
        </p>
      )}

      {/* The board: everyone's card, face out. Yours is the one you cannot read. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {room.players
          .filter((p) => p.presence !== 'INACTIVE')
          .map((player) => {
            const identity = view.identities[player.id]
            const solved = view.solved[player.id] !== undefined
            const isYou = player.id === me
            const isAsker = player.id === view.asker
            return (
              <div
                key={player.id}
                className={`card flex flex-col gap-1 p-3 ${isAsker ? 'ring-2 ring-amber-400/50' : ''} ${solved ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  <span aria-hidden>{player.avatar}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{isYou ? 'You' : player.name}</span>
                  <span className="tabular">{view.turnsUsed[player.id] ?? 0}</span>
                </div>
                <p className={`truncate text-sm font-bold ${isYou ? 'text-muted' : ''}`}>
                  {solved ? '✓ solved' : isYou ? '· · · · ·' : (identity?.name ?? '—')}
                </p>
              </div>
            )
          })}
      </div>

      {view.yourHints !== undefined && view.yourHints.length > 0 && (
        <Card className="flex flex-col gap-1">
          <p className="text-xs font-bold uppercase tracking-wider text-muted">Your hints</p>
          {view.yourHints.map((hint) => (
            <p key={hint} className="text-sm">💡 {hint}</p>
          ))}
        </Card>
      )}

      {/* What is happening now, with everything already asked beside it — on a
          phone there is no "beside", so the log stacks underneath instead. */}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {phase === 'ASSIGN' && (
            <Card className="text-center">
              <p className="font-semibold">Everyone has a name on their forehead.</p>
              <p className="text-sm text-muted">You can see everyone&rsquo;s but your own.</p>
            </Card>
          )}

          {phase === 'ASK' && (myTurn ? <YourTurn connection={connection} view={view} /> : <TheirTurn room={room} view={view} />)}
          {phase === 'VOTE' && <Voting connection={connection} view={view} room={room} myTurn={myTurn} />}
          {phase === 'RESULT' && view.result !== undefined && <TurnResult result={view.result} room={room} />}
          {phase === 'FINISHED' && <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />}
        </div>

        {phase !== 'FINISHED' && <QuestionLog room={room} view={view} />}
      </div>
    </div>
  )
}

/**
 * Everything the table has asked, newest first, with your own turns marked.
 *
 * The answers used to live on screen for five seconds and then vanish, so by
 * your third turn you could not remember whether you had already asked
 * whether you were alive. Yours are marked because that is the question the
 * list is really answering: what have *I* already tried?
 */
function QuestionLog({ room, view }: { room: PublicRoomView; view: WhoAmIView }) {
  const history = view.history ?? []
  const [showAll, setShowAll] = useState(false)
  const newestFirst = [...history].reverse()
  const mine = room.viewerId === null ? [] : newestFirst.filter((entry) => entry.asker === room.viewerId)
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  const listed = scope === 'mine' ? mine : newestFirst
  const shown = showAll ? listed : listed.slice(0, 4)

  if (history.length === 0) {
    return (
      <div className="card p-4 sm:sticky sm:top-4">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">Asked so far</p>
        <p className="pt-2 text-sm text-muted">Nothing yet. The first question goes here.</p>
      </div>
    )
  }

  return (
    <div className="card flex flex-col gap-2 p-4 sm:sticky sm:top-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="whitespace-nowrap text-xs font-bold uppercase tracking-wider text-muted">Asked so far</p>
        {mine.length > 0 && (
          <button
            type="button"
            aria-pressed={scope === 'mine'}
            onClick={() => setScope((current) => (current === 'mine' ? 'all' : 'mine'))}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold transition ${
              scope === 'mine' ? 'bg-amber-500/25 text-amber-100' : 'bg-white/8 text-muted hover:text-chalk'
            }`}
          >
            Mine ({mine.length})
          </button>
        )}
      </div>

      <ol className="flex flex-col gap-2" aria-label="Questions asked so far">
        {shown.map((entry, index) => {
          const isMine = entry.asker === room.viewerId
          const verdict =
            entry.guess !== null
              ? entry.correct
                ? 'got it'
                : 'wrong'
              : entry.yes > entry.no
                ? 'Yes'
                : entry.no > entry.yes
                  ? 'No'
                  : 'Split'
          const tone =
            entry.guess !== null
              ? entry.correct
                ? 'text-emerald-300'
                : 'text-rose-300'
              : verdict === 'Yes'
                ? 'text-emerald-300'
                : verdict === 'No'
                  ? 'text-rose-300'
                  : 'text-amber-200'
          return (
            <li
              key={`${entry.asker}-${entry.question}-${entry.guess ?? ''}-${index}`}
              className={`rounded-lg px-2 py-1.5 text-xs leading-snug ${isMine ? 'bg-amber-500/10' : 'bg-white/[0.04]'}`}
            >
              <p className="flex items-baseline justify-between gap-2">
                <span className="truncate font-semibold text-muted">
                  {isMine ? 'You' : <PlayerName room={room} playerId={entry.asker} />}
                </span>
                <span className={`shrink-0 font-bold ${tone}`}>
                  {verdict}
                  {entry.guess === null && ` ${entry.yes}–${entry.no}`}
                </span>
              </p>
              <p className="break-words text-chalk">
                {entry.guess !== null ? <>&ldquo;{entry.guess}&rdquo;</> : entry.question}
              </p>
            </li>
          )
        })}
      </ol>

      {listed.length > 4 && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="min-h-9 text-xs font-semibold text-muted hover:text-chalk"
        >
          {showAll ? 'Show less' : `Show all ${listed.length}`}
        </button>
      )}
    </div>
  )
}

function YourTurn({ connection, view }: { connection: GameProps['connection']; view: WhoAmIView }) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'ask' | 'guess'>('ask')

  const submit = () => {
    if (text.trim().length === 0) return
    connection.send(mode === 'ask' ? 'whoami/ask' : 'whoami/guess', mode === 'ask' ? { question: text.trim() } : { guess: text.trim() })
    setText('')
  }

  return (
    <div className="flex flex-col gap-3">
      <Banner tone="neutral">Your turn — ask a yes/no question, or take a guess.</Banner>
      {(view.yourHintsTaken ?? 0) > 0 && (
        <p className="text-center text-xs text-muted">
          Hints taken: {view.yourHintsTaken} · your turn is still yours
        </p>
      )}

      <div className="flex gap-2">
        {(['ask', 'guess'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            onClick={() => setMode(option)}
            className={`min-h-11 flex-1 rounded-xl border text-sm font-semibold transition ${
              mode === option ? 'border-amber-400/60 bg-amber-500/20' : 'border-white/12 bg-white/5 text-muted'
            }`}
          >
            {option === 'ask' ? 'Ask a question' : 'Guess who I am'}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <TextInput
          autoFocus
          value={text}
          maxLength={mode === 'ask' ? 140 : 80}
          enterKeyHint="send"
          placeholder={mode === 'ask' ? 'Am I a real person?' : 'I am…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
        <Button onClick={submit} disabled={text.trim().length === 0}>Send</Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          className="min-h-10 text-sm"
          disabled={(view.yourHintsLeft ?? 0) <= 0}
          onClick={() => connection.send('whoami/hint', {})}
        >
          {/* A hint leaves your turn alone — you can still ask or guess after
              taking one. It comes off the score instead. */}
          Take a hint ({view.yourHintsLeft ?? 0} left) · −{view.hintCost ?? 0} pts
        </Button>
        <Button variant="subtle" className="min-h-10 text-sm" onClick={() => connection.send('whoami/pass', {})}>
          Pass
        </Button>
      </div>
    </div>
  )
}

function TheirTurn({ room, view }: { room: PublicRoomView; view: WhoAmIView }) {
  return (
    <Card className="text-center">
      <p className="font-semibold">
        {view.asker === null ? 'Waiting…' : <><PlayerName room={room} playerId={view.asker} /> is thinking of a question.</>}
      </p>
      <p className="pt-1 text-sm text-muted">{view.remaining} still guessing</p>
    </Card>
  )
}

function Voting({
  connection,
  view,
  room,
  myTurn,
}: {
  connection: GameProps['connection']
  view: WhoAmIView
  room: PublicRoomView
  myTurn: boolean
}) {
  const voted = room.viewerId !== null && view.votedPlayerIds.includes(room.viewerId)

  return (
    <div className="flex flex-col gap-3">
      <Card className="text-center">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">
          {view.asker !== null && <PlayerName room={room} playerId={view.asker} />} asks
        </p>
        <p className="pt-1 text-xl font-bold">{view.question}</p>
      </Card>

      {myTurn ? (
        <p className="text-center text-sm text-muted">Waiting for the table to answer…</p>
      ) : voted ? (
        <Banner tone="neutral">Vote cast.</Banner>
      ) : (
        <div className="flex gap-2">
          <Button className="flex-1" size="lg" onClick={() => connection.send('whoami/vote', { vote: 'yes' })}>Yes</Button>
          <Button className="flex-1" size="lg" variant="ghost" onClick={() => connection.send('whoami/vote', { vote: 'no' })}>No</Button>
        </div>
      )}

      <p className="text-center text-xs text-muted">{view.votedPlayerIds.length} voted</p>
    </div>
  )
}

function TurnResult({ result, room }: { result: NonNullable<WhoAmIView['result']>; room: PublicRoomView }) {
  if (result.guess !== null) {
    return (
      <Banner tone={result.correct ? 'good' : 'bad'}>
        <PlayerName room={room} playerId={result.asker} /> guessed “{result.guess}” — {result.correct ? 'correct!' : 'nope.'}
      </Banner>
    )
  }
  const verdict = result.yes > result.no ? 'Yes' : result.no > result.yes ? 'No' : 'Split'
  return (
    <Card className="animate-pop flex flex-col items-center gap-2 text-center">
      <p className="text-sm text-muted">“{result.question}”</p>
      <p className="text-4xl font-extrabold">{verdict}</p>
      <div className="flex gap-2">
        <Pill className="text-emerald-200">{result.yes} yes</Pill>
        <Pill className="text-rose-200">{result.no} no</Pill>
      </div>
    </Card>
  )
}

export function WhoAmIEpilogue({ room }: { room: PublicRoomView }) {
  const view = readView<WhoAmIView>(room)
  if (view.reveal === undefined) return null
  return (
    <Card className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">Who everyone was</p>
      {Object.entries(view.reveal).map(([playerId, name]) => (
        <div key={playerId} className="flex items-center justify-between gap-2 text-sm">
          <PlayerName room={room} playerId={playerId} />
          <span className="font-bold">{name}</span>
        </div>
      ))}
    </Card>
  )
}
