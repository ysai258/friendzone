import { useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card, Pill, TextInput } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { Banner, GameHeader, PlayerName, readView } from './shared.tsx'

interface WhoAmIView {
  identities: Record<string, { name: string; category: string }>
  asker: string | null
  question: string | null
  votedPlayerIds: string[]
  turnsUsed: Record<string, number>
  solved: Record<string, { turnsUsed: number; points: number; place: number }>
  maxTurns: number
  remaining: number
  yourHints?: string[]
  yourHintsLeft?: number
  result?: { asker: string; question: string; yes: number; no: number; guess: string | null; correct: boolean }
  reveal?: Record<string, string>
}

export function WhoAmI({ connection, room }: GameProps) {
  const view = readView<WhoAmIView>(room)
  const phase = room.game?.phase
  const me = room.viewerId
  const myTurn = me !== null && view.asker === me

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🕵️ Who Am I?" accent="bg-amber-400" />

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
          Take a hint ({view.yourHintsLeft ?? 0} left) — costs a turn
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
