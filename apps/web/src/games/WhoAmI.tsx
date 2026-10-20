import { useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Badge, BigText, Button, Card, TextInput } from '../components/ui.tsx'
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
      <GameHeader connection={connection} room={room} label="🕵️ Who Am I?" accent="bg-sun" />

      {/* Everyone at the table is from one category, and knowing which one is
          half the game — it is the boundary your questions live inside. */}
      {view.categoryLabel !== undefined && (
        <p className="mx-auto max-w-full rounded-full border-2 border-ink bg-white px-4 py-1.5 text-center text-sm font-medium text-ink-soft shadow-hard-sm">
          Everyone here is one of the <span className="font-display font-extrabold text-ink">{view.categoryLabel}</span>
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
                className={`flex min-w-0 flex-col gap-1 rounded-2xl border-ink p-3 transition ${
                  isAsker ? 'border-3 bg-sun shadow-hard -rotate-1' : 'border-2 shadow-hard-sm'
                } ${!isAsker && solved ? 'bg-lime-soft' : ''} ${!isAsker && !solved && isYou ? 'bg-grape-soft' : ''} ${
                  !isAsker && !solved && !isYou ? 'bg-white' : ''
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
                  <span aria-hidden>{player.avatar}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{isYou ? 'You' : player.name}</span>
                  <span className="tabular shrink-0 rounded-full border-2 border-ink bg-white px-1.5 font-display font-extrabold leading-tight text-ink">{view.turnsUsed[player.id] ?? 0}</span>
                </div>
                <p data-testid="identity-card" className={`truncate font-display text-base font-extrabold ${isYou && !solved ? 'tracking-widest text-grape' : 'text-ink'}`}>
                  {solved ? '✓ solved' : isYou ? '· · · · ·' : (identity?.name ?? '—')}
                </p>
              </div>
            )
          })}
      </div>

      {view.yourHints !== undefined && view.yourHints.length > 0 && (
        <Card color="sun" soft tilt="right" padding="sm" className="flex flex-col gap-1.5">
          <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">Your hints</p>
          {view.yourHints.map((hint) => (
            <p key={hint} className="text-sm font-semibold text-ink">💡 {hint}</p>
          ))}
        </Card>
      )}

      {/* What is happening now, with everything already asked beside it — on a
          phone there is no "beside", so the log stacks underneath instead. */}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {phase === 'ASSIGN' && (
            <Card color="grape" soft tilt="left" className="text-center">
              <p className="font-display text-lg font-extrabold">Everyone has a name on their forehead.</p>
              <p className="text-sm text-ink-soft">You can see everyone&rsquo;s but your own.</p>
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
      <div className="rounded-3xl border-3 border-ink bg-white p-4 shadow-hard sm:sticky sm:top-4">
        <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">Your questions</p>
        <p className="pt-2 text-sm text-ink-soft">Nothing yet. What you ask turns up here.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-3xl border-3 border-ink bg-white p-4 shadow-hard sm:sticky sm:top-4">
      <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">
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
              ? 'bg-lime'
              : 'bg-tomato'
            : verdict === 'Yes'
              ? 'bg-lime'
              : verdict === 'No'
                ? 'bg-tomato'
                : 'bg-sun'
          return (
            <li
              key={`${entry.question}-${entry.guess ?? ''}-${index}`}
              className="rounded-xl border-2 border-ink bg-paper px-2.5 py-2 text-xs leading-snug"
            >
              <p className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-ink-soft">{isGuess ? 'Guessed' : 'Asked'}</span>
                <span className={`shrink-0 rounded-full border-2 border-ink px-2 py-0.5 font-display font-extrabold text-ink ${tone}`}>
                  {verdict}
                  {!isGuess && ` ${entry.yes}–${entry.no}`}
                </span>
              </p>
              <p className="break-words pt-1 font-medium text-ink">
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
          className="min-h-11 font-display text-xs font-bold text-ink-soft underline decoration-2 underline-offset-4 hover:text-ink"
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
        <p className="text-center text-xs font-medium text-ink-soft">
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
            className={`min-h-12 min-w-0 flex-1 rounded-2xl border-3 border-ink px-2 font-display text-sm font-extrabold transition-[transform,box-shadow] duration-100 ${
              mode === option ? 'translate-x-0.5 translate-y-0.5 bg-sun text-ink shadow-hard-sm' : 'bg-white text-ink-soft shadow-hard hover:text-ink'
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        {view.hintsEnabled !== false && (
          <Button
            variant="ghost"
            size="sm"
            disabled={(view.yourHintsLeft ?? 0) <= 0}
            onClick={() => connection.send('whoami/hint', {})}
          >
            {/* A hint leaves your turn alone — you can still ask or guess after
                taking one. It comes off the score instead. */}
            Take a hint ({view.yourHintsLeft ?? 0} left) · −{view.hintCost ?? 0} pts
          </Button>
        )}
        <Button variant="subtle" size="sm" onClick={() => connection.send('whoami/pass', {})}>
          Pass
        </Button>
      </div>
    </div>
  )
}

function TheirTurn({ room, view }: { room: PublicRoomView; view: WhoAmIView }) {
  return (
    <Card className="text-center">
      <p className="font-display text-lg font-extrabold">
        {view.asker === null ? 'Waiting…' : <><PlayerName room={room} playerId={view.asker} /> is thinking of a question.</>}
      </p>
      <p className="pt-2 text-sm text-ink-soft">
        <span className="inline-flex items-center rounded-full border-2 border-ink bg-sun-soft px-2.5 py-0.5 font-display font-bold text-ink">{view.remaining} still guessing</span>
      </p>
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
      <Card color="sky" soft tilt="left" shadow="lg" className="text-center">
        <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">
          {view.asker !== null && <PlayerName room={room} playerId={view.asker} />} asks
        </p>
        <p className="break-words pt-2 font-display text-2xl font-extrabold leading-tight">{view.question}</p>
      </Card>

      {solvedMine && !voted && (
        <p className="text-center text-xs font-medium text-ink-soft">You know yours — now you answer for everyone else.</p>
      )}

      {myTurn ? (
        <p className="text-center text-sm font-medium text-ink-soft">Waiting for the table to answer…</p>
      ) : voted ? (
        <Banner tone="neutral">Vote cast.</Banner>
      ) : (
        <div className="flex gap-2">
          <Button className="flex-1" size="lg" variant="success" onClick={() => connection.send('whoami/vote', { vote: 'yes' })}>Yes</Button>
          <Button className="flex-1" size="lg" variant="danger" onClick={() => connection.send('whoami/vote', { vote: 'no' })}>No</Button>
        </div>
      )}

      <p className="text-center text-xs font-semibold text-ink-soft">{view.votedPlayerIds.length} voted</p>
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
    <Card
      color={verdict === 'Yes' ? 'lime' : verdict === 'No' ? 'tomato' : 'sun'}
      soft
      shadow="lg"
      className="animate-pop flex flex-col items-center gap-3 text-center"
    >
      <p className="break-words text-sm font-medium text-ink-soft">“{result.question}”</p>
      <BigText color={verdict === 'Yes' ? 'lime' : verdict === 'No' ? 'tomato' : 'sun'} size="xl" as="p">{verdict}</BigText>
      <div className="flex flex-wrap justify-center gap-2">
        <Badge color="lime" size="md">{result.yes} yes</Badge>
        <Badge color="tomato" size="md">{result.no} no</Badge>
      </div>
    </Card>
  )
}

export function WhoAmIEpilogue({ room }: { room: PublicRoomView }) {
  const view = readView<WhoAmIView>(room)
  if (view.reveal === undefined) return null
  return (
    <Card color="grape" soft tilt="left" shadow="lg" className="flex flex-col gap-2">
      <p className="font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">Who everyone was</p>
      {Object.entries(view.reveal).map(([playerId, name]) => (
        <div key={playerId} className="flex min-w-0 items-center justify-between gap-2 rounded-2xl border-2 border-ink bg-white px-3 py-2 text-sm shadow-hard-sm">
          <span className="min-w-0 truncate"><PlayerName room={room} playerId={playerId} /></span>
          <span className="min-w-0 break-words text-right font-display font-extrabold">{name}</span>
        </div>
      ))}
    </Card>
  )
}
