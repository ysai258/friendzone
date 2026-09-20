import { useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card, TextInput } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { AnsweredRow, Banner, Countdown, GameHeader, PlayerName, readView } from './shared.tsx'

interface EmojiView {
  emojis: string
  solvedPlayerIds: string[]
  activeCount: number
  maxAttempts: number
  cooldownMs: number
  answer?: string
  year?: number | null
  languageLabel?: string
  results?: { playerId: string; solved: boolean; points: number; place: number | null; attempts: number; lastGuess: string | null }[]
  yourAttempts?: string[]
  yourSolved?: boolean
  yourPoints?: number
  nextGuessAt?: number
}

export function EmojiMovie({ connection, room }: GameProps) {
  const view = readView<EmojiView>(room)
  const phase = room.game?.phase

  if (phase === 'COUNTDOWN') {
    return (
      <Countdown
        connection={connection}
        room={room}
        title={`Movie ${room.game?.roundNumber} of ${room.game?.totalRounds}`}
        subtitle="Keep guessing — wrong answers only cost you time."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🎬 Emoji Movie" accent="bg-rose-400" />

      <Card className="flex min-h-40 items-center justify-center py-8">
        <p className="animate-pop text-center text-6xl leading-relaxed tracking-[0.15em] sm:text-7xl" aria-label={`Emoji clue: ${view.emojis}`}>
          {view.emojis}
        </p>
      </Card>

      {phase === 'QUESTION' ? <Race connection={connection} view={view} room={room} /> : <Reveal view={view} room={room} />}
    </div>
  )
}

function Race({ connection, view, room }: { connection: GameProps['connection']; view: EmojiView; room: PublicRoomView }) {
  const [guess, setGuess] = useState('')
  const attempts = view.yourAttempts ?? []
  const left = view.maxAttempts - attempts.length
  const solved = view.yourSolved === true

  const submit = () => {
    if (guess.trim().length === 0 || solved || left <= 0) return
    connection.send('emoji/guess', { guess: guess.trim() })
    setGuess('')
  }

  return (
    <div className="flex flex-col gap-3">
      {solved ? (
        <Banner tone="good">Got it — {(view.yourPoints ?? 0).toLocaleString()} points.</Banner>
      ) : left <= 0 ? (
        <Banner tone="bad">Out of guesses for this one.</Banner>
      ) : (
        <>
          <div className="flex gap-2">
            <TextInput
              autoFocus
              value={guess}
              maxLength={80}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="Name the film"
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
            <Button onClick={submit} disabled={guess.trim().length === 0}>Go</Button>
          </div>
          <p className="text-center text-xs text-muted">
            {left} {left === 1 ? 'guess' : 'guesses'} left
          </p>
        </>
      )}

      {attempts.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5">
          {attempts.map((attempt, i) => (
            <span key={`${attempt}-${i}`} className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-muted line-through">
              {attempt}
            </span>
          ))}
        </div>
      )}

      <AnsweredRow players={room.players} answeredIds={view.solvedPlayerIds} />
    </div>
  )
}

function Reveal({ view, room }: { view: EmojiView; room: PublicRoomView }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="animate-pop text-center">
        <p className="text-sm font-semibold text-muted">It was</p>
        <p className="text-3xl font-extrabold">{view.answer}</p>
        <p className="text-sm text-muted">
          {[view.year, view.languageLabel].filter((part) => part != null && part !== '').join(' · ')}
        </p>
      </div>

      {(view.results ?? []).length > 0 && (
        <Card className="flex flex-col gap-2">
          {(view.results ?? []).map((result) => (
            <div key={result.playerId} className="flex items-center gap-2 text-sm">
              <span className={result.solved ? 'text-emerald-300' : 'text-rose-300'} aria-hidden>
                {result.solved ? '✓' : '✗'}
              </span>
              <PlayerName room={room} playerId={result.playerId} />
              <span className="min-w-0 flex-1 truncate text-muted">
                {result.solved ? `in ${result.attempts} ${result.attempts === 1 ? 'try' : 'tries'}` : `“${result.lastGuess ?? '—'}”`}
              </span>
              {result.solved && <span className="tabular font-bold text-emerald-300">+{result.points}</span>}
            </div>
          ))}
        </Card>
      )}

      <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />
    </div>
  )
}
