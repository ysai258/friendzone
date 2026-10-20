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
      <GameHeader connection={connection} room={room} label="🎬 Emoji Movie" accent="bg-bubblegum" />

      <Card color="bubblegum" soft tilt="right" shadow="lg" className="flex min-h-44 items-center justify-center px-4 py-8">
        <p className="max-w-full animate-pop break-words text-center text-5xl leading-relaxed tracking-[0.12em] drop-shadow-[3px_3px_0_var(--color-ink)] min-[400px]:text-6xl sm:text-7xl" aria-label={`Emoji clue: ${view.emojis}`}>
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
          <p className="self-center rounded-full border-2 border-ink bg-sun px-3 py-1 font-display text-xs font-extrabold shadow-hard-sm">
            {left} {left === 1 ? 'guess' : 'guesses'} left
          </p>
        </>
      )}

      {attempts.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5">
          {attempts.map((attempt, i) => (
            <span key={`${attempt}-${i}`} className="max-w-full truncate rounded-full border-2 border-ink bg-tomato-soft px-2.5 py-1 text-xs font-semibold text-ink line-through decoration-2">
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
      <div className="flex animate-pop flex-col items-center gap-1 rotate-1 rounded-3xl border-3 border-ink bg-lime px-5 py-5 text-center shadow-hard-lg">
        <p className="rounded-full border-2 border-ink bg-white px-3 py-0.5 font-display text-xs font-extrabold uppercase tracking-wider">It was</p>
        <p className="max-w-full break-words font-display text-3xl font-extrabold leading-tight sm:text-4xl">{view.answer}</p>
        <p className="text-sm font-semibold text-ink">
          {[view.year, view.languageLabel].filter((part) => part != null && part !== '').join(' · ')}
        </p>
      </div>

      {(view.results ?? []).length > 0 && (
        <Card padding="sm" className="flex flex-col gap-2 px-4">
          {(view.results ?? []).map((result) => (
            <div key={result.playerId} className="flex min-w-0 items-center gap-2 text-sm">
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full border-2 border-ink text-xs font-extrabold ${result.solved ? 'bg-lime' : 'bg-tomato'}`}
                aria-hidden
              >
                {result.solved ? '✓' : '✗'}
              </span>
              <PlayerName room={room} playerId={result.playerId} />
              <span className="min-w-0 flex-1 truncate text-ink-soft">
                {result.solved ? `in ${result.attempts} ${result.attempts === 1 ? 'try' : 'tries'}` : `“${result.lastGuess ?? '—'}”`}
              </span>
              {result.solved && <span className="tabular shrink-0 rounded-full border-2 border-ink bg-lime px-2 py-0.5 font-display text-xs font-extrabold">+{result.points}</span>}
            </div>
          ))}
        </Card>
      )}

      <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />
    </div>
  )
}
