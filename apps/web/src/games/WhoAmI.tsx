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
  hintsEnabled?: boolean
  hintCost?: number
  /** Only ever your own turns. Somebody else's questions are about somebody
   *  else's person. */
  yourHistory?: TurnRecord[]
  result?: TurnRecord
  stumbled?: boolean
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
              {phase === 'RESULT' && view.result !== undefined && (
            <TurnResult result={view.result} room={room} stumbled={view.stumbled === true} />
          )}
          {phase === 'FINISHED' && <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />}
        </div>

        {phase !== 'FINISHED' && <YourLog view={view} />}
      </div>
    </div>
  )
}

/**
 * Your own questions and guesses, newest first.
 *
 * Only yours: what you need while thinking is what you have already tried,
 * and the rest of the table's questions are about the rest of the table's
 * people. It is built per viewer on the server, so nobody else's turns are
 * even sent to this screen.
 */
function YourLog({ view }: { view: WhoAmIView }) {
  const history = view.yourHistory ?? []
  const [showAll, setShowAll] = useState(false)
  const newestFirst = [...history].reverse()
  const shown = showAll ? newestFirst : newestFirst.slice(0, 4)

  if (history.length === 0) {
    return (
      <div className="card p-4 sm:sticky sm:top-4">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">Your questions</p>
        <p className="pt-2 text-sm text-muted">Nothing yet. What you ask turns up here.</p>
      </div>
    )
  }

  return (
    <div className="card flex flex-col gap-2 p-4 sm:sticky sm:top-4">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">
        Your questions <span className="font-semibold normal-case tracking-normal">({history.length})</span>
      </p>

      <ol className="flex flex-col gap-2" aria-label="Your questions so far">
        {shown.map((entry, index) => {
          const isGuess = entry.guess !== null
          const verdict = isGuess
            ? entry.correct
              ? 'got it'
              : 'wrong'
            : entry.yes > entry.no
              ? 'Yes'
              : entry.no > entry.yes
                ? 'No'
                : 'Split'
          const tone = isGuess
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
              key={`${entry.question}-${entry.guess ?? ''}-${index}`}
              className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-xs leading-snug"
            >
              <p className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-muted">{isGuess ? 'Guessed' : 'Asked'}</span>
                <span className={`shrink-0 font-bold ${tone}`}>
                  {verdict}
                  {!isGuess && ` ${entry.yes}–${entry.no}`}
                </span>
              </p>
              <p className="break-words text-chalk">
                {isGuess ? <>&ldquo;{entry.guess}&rdquo;</> : entry.question}
              </p>
            </li>
          )
        })}
      </ol>

      {newestFirst.length > 4 && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="min-h-9 text-xs font-semibold text-muted hover:text-chalk"
        >
          {showAll ? 'Show less' : `Show all ${newestFirst.length}`}
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
        {view.hintsEnabled !== false && (
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
        )}
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
  const solvedMine = room.viewerId !== null && view.solved[room.viewerId] !== undefined

  return (
    <div className="flex flex-col gap-3">
      <Card className="text-center">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">
          {view.asker !== null && <PlayerName room={room} playerId={view.asker} />} asks
        </p>
        <p className="pt-1 text-xl font-bold">{view.question}</p>
      </Card>

      {solvedMine && !voted && (
        <p className="text-center text-xs text-muted">You know yours — now you answer for everyone else.</p>
      )}

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

function TurnResult({
  result,
  room,
  stumbled,
}: {
  result: NonNullable<WhoAmIView['result']>
  room: PublicRoomView
  stumbled: boolean
}) {
  if (stumbled) {
    // They were asking about somebody they thought was a different person.
    return (
      <Banner tone="good">
        <PlayerName room={room} playerId={result.asker} /> said the name in their own question — that counts. Solved!
      </Banner>
    )
  }
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
