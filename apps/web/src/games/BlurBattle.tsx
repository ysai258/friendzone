import { useEffect, useRef, useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card, TextInput } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { AnsweredRow, Attribution, Banner, Countdown, GameHeader, PlayerName, readView } from './shared.tsx'

interface BlurView {
  imageUrl?: string
  stageIndex: number
  stageCount: number
  answeredPlayerIds: string[]
  activeCount: number
  category?: string
  difficulty?: string
  answer?: string
  attribution?: unknown
  results?: { playerId: string; guess: string; correct: boolean; points: number; place: number | null; stage: number }[]
  yourAnswer?: { guess: string; correct: boolean; points: number; locked: boolean }
}

export function BlurBattle({ connection, room }: GameProps) {
  const view = readView<BlurView>(room)
  const phase = room.game?.phase

  if (phase === 'COUNTDOWN') {
    return (
      <Countdown
        connection={connection}
        room={room}
        title={`Image ${room.game?.roundNumber} of ${room.game?.totalRounds}`}
        subtitle="Name it as early as you dare. You only get one guess."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="🌀 Blur Battle" accent="bg-violet-400" />
      <BlurImage view={view} phase={phase ?? ''} />
      {phase === 'QUESTION' ? (
        <GuessBox connection={connection} view={view} room={room} />
      ) : (
        <RevealPanel view={view} room={room} />
      )}
    </div>
  )
}

/**
 * The picture.
 *
 * Each reveal step is a separate file the server released when the round
 * reached it, so there is nothing sharper in the browser to uncover. The
 * previous step is kept underneath during the swap so the image never flashes
 * empty while the next one loads.
 */
function BlurImage({ view, phase }: { view: BlurView; phase: string }) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const previous = useRef<string | null>(null)

  useEffect(() => {
    if (view.imageUrl !== undefined && loaded !== null && loaded !== view.imageUrl) previous.current = loaded
  }, [view.imageUrl, loaded])

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-3xl border border-white/10 bg-black/40">
      {previous.current !== null && (
        <img src={previous.current} alt="" aria-hidden className="absolute inset-0 size-full object-cover" />
      )}
      {view.imageUrl !== undefined && (
        <img
          key={view.imageUrl}
          src={view.imageUrl}
          onLoad={() => setLoaded(view.imageUrl ?? null)}
          alt={phase === 'QUESTION' ? 'A blurred picture, sharpening as the round goes on' : (view.answer ?? 'The picture')}
          className="absolute inset-0 size-full object-cover transition-opacity duration-500"
        />
      )}

      {phase === 'QUESTION' && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-3">
          <span className="rounded-full bg-black/50 px-2.5 py-1 text-xs font-semibold capitalize text-chalk">
            {view.category ?? ''}
          </span>
          <div className="flex gap-1" aria-label={`Clarity ${view.stageIndex + 1} of ${view.stageCount}`}>
            {Array.from({ length: view.stageCount }, (_, i) => (
              <span key={i} className={`h-1.5 w-5 rounded-full ${i <= view.stageIndex ? 'bg-violet-300' : 'bg-white/25'}`} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function GuessBox({ connection, view, room }: { connection: GameProps['connection']; view: BlurView; room: PublicRoomView }) {
  const [guess, setGuess] = useState('')
  const locked = view.yourAnswer !== undefined

  const submit = () => {
    if (guess.trim().length === 0 || locked) return
    connection.send('blur/guess', { guess: guess.trim() })
    setGuess('')
  }

  return (
    <div className="flex flex-col gap-3">
      {locked ? (
        <Banner tone={view.yourAnswer?.correct === true ? 'good' : 'bad'}>
          {view.yourAnswer?.correct === true ? (
            <>Correct — {view.yourAnswer.points.toLocaleString()} points. Sit tight.</>
          ) : (
            <>“{view.yourAnswer?.guess}” wasn&rsquo;t it. Watch the reveal.</>
          )}
        </Banner>
      ) : (
        <div className="flex gap-2">
          <TextInput
            autoFocus
            value={guess}
            maxLength={80}
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="What is it?"
            onChange={(e) => setGuess(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
          <Button onClick={submit} disabled={guess.trim().length === 0}>Guess</Button>
        </div>
      )}
      <p className="text-center text-xs text-muted">One guess each — the earlier it lands, the more it pays.</p>
      <AnsweredRow players={room.players} answeredIds={view.answeredPlayerIds} />
    </div>
  )
}

function RevealPanel({ view, room }: { view: BlurView; room: PublicRoomView }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="animate-pop text-center">
        <p className="text-sm font-semibold text-muted">It was</p>
        <p className="text-3xl font-extrabold">{view.answer}</p>
        <Attribution value={view.attribution} />
      </div>

      {(view.results ?? []).length > 0 && (
        <Card className="flex flex-col gap-2">
          {(view.results ?? []).map((result) => (
            <div key={result.playerId} className="flex items-center gap-2 text-sm">
              <span className={result.correct ? 'text-emerald-300' : 'text-rose-300'} aria-hidden>
                {result.correct ? '✓' : '✗'}
              </span>
              <PlayerName room={room} playerId={result.playerId} />
              <span className="min-w-0 flex-1 truncate text-muted">“{result.guess}”</span>
              {result.correct && <span className="tabular font-bold text-emerald-300">+{result.points}</span>}
            </div>
          ))}
        </Card>
      )}

      <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />
    </div>
  )
}

export function BlurBattleEpilogue({ room }: { room: PublicRoomView }) {
  const view = readView<BlurView>(room)
  if (view.answer === undefined) return null
  return (
    <Card className="flex flex-col gap-2 text-center">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">Last image</p>
      <p className="text-lg font-bold">{view.answer}</p>
      <Attribution value={view.attribution} />
    </Card>
  )
}
