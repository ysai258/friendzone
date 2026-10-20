import clsx from 'clsx'
import { useMemo, useRef, useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { useYouTubeClip, type ClipStatus } from '../lib/youtubeClip.ts'
import { Banner, Countdown, GameHeader, PlayerName, readView } from './shared.tsx'

type Mark = 'correct' | 'wrong' | 'skipped'
type Status = 'playing' | 'won' | 'lost'

interface CatalogEntry {
  id: string
  title: string
  movie: string
  year: number | null
  aliases: string[]
}

interface PaataView {
  clipSeconds: number[]
  maxAttempts: number
  ladders: Record<string, { marks: Mark[]; status: Status }>
  activeCount: number
  clip?: { videoId: string; startOffsetMs: number }
  catalog?: CatalogEntry[]
  you?: { status: Status; points: number; attempts: { kind: Mark; title: string | null }[]; unlockedSeconds: number }
  answer?: { title: string; movie: string; year: number | null; youtubeUrl: string }
  results?: { playerId: string; marks: Mark[]; status: Status; points: number; place: number | null; picks: string[] }[]
}

export function PaataPattu({ connection, room }: GameProps) {
  const view = readView<PaataView>(room)
  const phase = room.game?.phase

  if (phase === 'COUNTDOWN') {
    return (
      <Countdown
        connection={connection}
        room={room}
        title={`Song ${room.game?.roundNumber} of ${room.game?.totalRounds}`}
        subtitle="Two seconds of intro. Name it, or skip for a longer listen."
      />
    )
  }

  const unlocked = view.you?.unlockedSeconds ?? view.clipSeconds[0] ?? 2
  return (
    <div className="flex flex-col gap-4">
      <GameHeader connection={connection} room={room} label="📼 Paata Pattu" accent="bg-amber-400" />
      <Deck view={view} />
      {phase === 'QUESTION' ? (
        <>
          <Ladder view={view} unlocked={unlocked} />
          <GuessPanel connection={connection} view={view} />
          <TableLadders room={room} view={view} />
        </>
      ) : (
        <RevealPanel view={view} room={room} />
      )}
    </div>
  )
}

// --- the cassette ------------------------------------------------------------

const STATUS_COPY: Record<ClipStatus, (seconds: number) => [string, string]> = {
  loading: () => ['Preparing audio', 'Loading the tape…'],
  ready: (s) => [`Play ${s} seconds`, 'Ready to play'],
  starting: () => ['Pause clue', 'Checking playback…'],
  playing: () => ['Pause clue', 'Playing the unlocked clue'],
  paused: () => ['Continue clue', 'Paused'],
  done: (s) => ['Replay from start', `${s}-second clue complete`],
  unavailable: () => ['Audio unavailable', 'This song will not play here. Skip it.'],
  error: () => ['Retry audio', 'Audio could not start'],
}

/**
 * The tape deck: a hidden YouTube player behind a cassette that is purely
 * decoration. The video never renders on screen, so its title and thumbnail
 * cannot give the song away.
 */
function Deck({ view }: { view: PaataView }) {
  const seconds = view.you?.unlockedSeconds ?? view.clipSeconds[0] ?? 2
  const clip = useYouTubeClip(view.clip?.videoId ?? null, view.clip?.startOffsetMs ?? 0, seconds)
  const [label, sub] = STATUS_COPY[clip.status](seconds)
  const spinning = clip.status === 'playing'
  const busy = clip.status === 'playing' || clip.status === 'starting'
  const progress = clip.limitMs > 0 ? clip.positionMs / clip.limitMs : 0

  return (
    <Card className="flex flex-col gap-4 border-[#e9a72b]/30 bg-[#f5e7cb]/[0.04]">
      <div
        aria-hidden
        className="relative mx-auto aspect-[320/205] w-full max-w-sm rounded-[13px] border-[3px] border-[#171513] bg-[#533287] shadow-[5px_5px_0_#171513]"
      >
        <span className="absolute left-2 top-2 size-2 rounded-full bg-[#f5e7cb]" />
        <span className="absolute right-2 top-2 size-2 rounded-full bg-[#f5e7cb]" />
        <span className="absolute left-1/4 top-3 h-1 w-1/2 bg-[#e9a72b]" />
        <div className="absolute inset-x-[9%] top-[17%] -rotate-[0.8deg] bg-[#fff8e9] px-2 py-1 text-right font-mono text-[10px] font-semibold tracking-wider text-[#b52f21]">
          SIDE A · PAATA PATTU
        </div>
        <div className="absolute inset-x-[15%] top-[38%] flex h-[34%] items-center justify-between rounded-[44px] border-2 border-[#171513] bg-[#f5e7cb] px-[6%]">
          <Reel spinning={spinning} />
          <span className="mx-1 h-1.5 flex-1 bg-[#b52f21]" />
          <Reel spinning={spinning} />
        </div>
        <div className="absolute inset-x-[22%] bottom-0 h-[16%] bg-[#146b68] [clip-path:polygon(8%_0,92%_0,100%_100%,0_100%)]" />
        <span className="absolute bottom-2 right-2 border-2 border-[#171513] bg-[#171513] px-1.5 font-mono text-sm font-semibold text-[#e9a72b]">
          00:{String(seconds).padStart(2, '0')}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => clip.toggle()}
          disabled={clip.status === 'loading' || clip.status === 'unavailable'}
          aria-label={label}
          className="flex size-16 shrink-0 items-center justify-center rounded-full border-[3px] border-[#171513] bg-[#e9a72b] text-2xl text-[#171513] shadow-[3px_3px_0_#171513] transition active:translate-x-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0_#171513] disabled:opacity-55"
        >
          {clip.status === 'loading' ? '…' : busy ? 'Ⅱ' : '▶'}
        </button>
        <div className="min-w-0">
          <p className="font-bold">{label}</p>
          <p className="text-sm text-muted" aria-live="polite">{sub}</p>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="h-2 w-full overflow-hidden rounded-full border border-white/15 bg-black/40">
          <div className="h-full bg-[#146b68] transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="flex justify-between font-mono text-xs text-muted">
          <span className="tabular">{(clip.positionMs / 1000).toFixed(1)}s</span>
          <span>{seconds}s</span>
        </div>
      </div>

      <p className="text-center text-[11px] text-muted">
        Audio via{' '}
        <a className="underline hover:text-chalk" href="https://www.youtube.com/" target="_blank" rel="noreferrer noopener">
          YouTube ↗
        </a>
      </p>

      {/* Off-screen rather than display:none: YouTube will not play a hidden iframe. */}
      <div
        ref={clip.hostRef}
        aria-hidden
        className="pointer-events-none fixed left-[-10000px] top-0 h-[270px] w-[480px] opacity-0"
      />
    </Card>
  )
}

function Reel({ spinning }: { spinning: boolean }) {
  return (
    <span
      className={clsx(
        'flex size-10 items-center justify-center rounded-full border-[6px] border-dotted border-[#171513] bg-[#e9a72b]',
        spinning && 'animate-[spin_1.8s_linear_infinite]',
      )}
    >
      <span className="size-3 rounded-full bg-[#fff8e9]" />
    </span>
  )
}

// --- the ladder --------------------------------------------------------------

const MARK_STYLE: Record<Mark, string> = {
  correct: 'border-emerald-300/60 bg-emerald-500/80 text-white',
  wrong: 'border-rose-300/60 bg-rose-500/80 text-white',
  skipped: 'border-violet-300/60 bg-violet-500/70 text-white',
}
const MARK_WORD: Record<Mark, string> = { correct: 'Correct', wrong: 'Wrong', skipped: 'Skipped' }

/** Your five clues: what each attempt was, and which one you are on. */
function Ladder({ view, unlocked }: { view: PaataView; unlocked: number }) {
  const attempts = view.you?.attempts ?? []
  const playing = view.you?.status === 'playing'
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Your clues">
      {view.clipSeconds.map((seconds, index) => {
        const attempt = attempts[index]
        const current = playing && index === attempts.length
        return (
          <li
            key={seconds}
            className={clsx(
              'flex min-h-14 flex-col items-center justify-center rounded-xl border text-center',
              attempt !== undefined && MARK_STYLE[attempt.kind],
              current && 'border-amber-300 bg-amber-400 text-ink-950 shadow-[2px_2px_0_#171513]',
              attempt === undefined && !current && 'border-dashed border-white/20 text-muted opacity-60',
            )}
          >
            <span className="font-mono text-[10px] opacity-70">{index + 1}</span>
            <span className="font-mono text-sm font-semibold">{seconds}s</span>
            <span className="text-[10px] font-bold">
              {attempt !== undefined ? MARK_WORD[attempt.kind] : current ? 'Current' : seconds <= unlocked ? '' : 'Locked'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Everyone's ladder at a glance. Marks only: nobody's pick is sent until the reveal. */
function TableLadders({ room, view }: { room: PublicRoomView; view: PaataView }) {
  const seated = room.players.filter((p) => p.presence !== 'INACTIVE')
  return (
    <Card className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">The table</p>
      {seated.map((player) => {
        const ladder = view.ladders[player.id]
        return (
          <div key={player.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <PlayerName room={room} playerId={player.id} />
            </span>
            <MiniLadder marks={ladder?.marks ?? []} total={view.maxAttempts} />
            <span className="w-5 text-center" aria-label={ladder?.status ?? 'playing'}>
              {ladder?.status === 'won' ? '✓' : ladder?.status === 'lost' ? '✗' : ''}
            </span>
          </div>
        )
      })}
    </Card>
  )
}

function MiniLadder({ marks, total }: { marks: Mark[]; total: number }) {
  return (
    <span className="flex gap-1" aria-label={marks.length === 0 ? 'No attempts yet' : marks.map((m) => MARK_WORD[m]).join(', ')}>
      {Array.from({ length: total }, (_, i) => {
        const mark = marks[i]
        return (
          <span
            key={i}
            className={clsx(
              'size-3.5 rounded-[3px] border',
              mark === undefined ? 'border-dashed border-white/25' : MARK_STYLE[mark],
            )}
          />
        )
      })}
    </span>
  )
}

// --- guessing ----------------------------------------------------------------

/** Lower-case, accents gone, punctuation to spaces: "Saahore Baahubali!" → "saahore baahubali". */
function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const MAX_RESULTS = 6

function GuessPanel({ connection, view }: { connection: GameProps['connection']; view: PaataView }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const you = view.you
  const attemptsUsed = you?.attempts.length ?? 0
  const lastAttempt = attemptsUsed >= view.maxAttempts - 1

  // Search once per catalog, not per keystroke.
  const index = useMemo(
    () => (view.catalog ?? []).map((entry) => ({ entry, haystack: normalize([entry.title, entry.movie, ...entry.aliases].join(' ')) })),
    [view.catalog],
  )
  const tried = useMemo(() => new Set((you?.attempts ?? []).map((a) => a.title)), [you?.attempts])

  const results = useMemo(() => {
    const terms = normalize(query).split(' ').filter((t) => t.length > 0)
    if (terms.length === 0 || selected !== null) return []
    return index
      .filter(({ entry, haystack }) => !tried.has(entry.title) && terms.every((t) => haystack.includes(t)))
      .slice(0, MAX_RESULTS)
      .map(({ entry }) => entry)
  }, [index, query, selected, tried])

  if (you === undefined) return null

  if (you.status !== 'playing') {
    const landed = you.attempts.length
    return (
      <Banner tone={you.status === 'won' ? 'good' : 'bad'}>
        {you.status === 'won' ? (
          <>Got it on the {view.clipSeconds[landed - 1]}-second clue — +{you.points.toLocaleString()}.</>
        ) : (
          <>Out of clues. The reveal is coming.</>
        )}
      </Banner>
    )
  }

  const choose = (entry: CatalogEntry) => {
    setSelected(entry)
    setQuery(entry.title)
    setOpen(false)
  }

  const reset = () => {
    setSelected(null)
    setQuery('')
    setHighlight(0)
  }

  const submit = () => {
    if (selected === null) return
    connection.send('song/guess', { trackId: selected.id })
    reset()
    inputRef.current?.focus()
  }

  const skip = () => {
    connection.send('song/skip', {})
    reset()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <label htmlFor="paata-guess" className="mb-1.5 block text-sm font-semibold">
          Your guess
        </label>
        <input
          ref={inputRef}
          id="paata-guess"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="paata-results"
          aria-autocomplete="list"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="send"
          value={query}
          maxLength={80}
          placeholder="Type a song or movie…"
          className="min-h-14 w-full rounded-2xl border border-white/15 bg-black/30 px-5 text-lg text-chalk placeholder:text-muted/60 focus:border-amber-400/60 focus:outline-none"
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(null)
            setHighlight(0)
            setOpen(e.target.value.trim().length > 0)
          }}
          onFocus={() => setOpen(query.trim().length > 0 && selected === null)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && results.length > 0) {
              e.preventDefault()
              setOpen(true)
              setHighlight((h) => (h + 1) % results.length)
            } else if (e.key === 'ArrowUp' && results.length > 0) {
              e.preventDefault()
              setHighlight((h) => (h - 1 + results.length) % results.length)
            } else if (e.key === 'Escape') {
              setOpen(false)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const pick = results[highlight]
              if (selected !== null) submit()
              else if (open && pick !== undefined) choose(pick)
            }
          }}
        />
        {open && query.trim().length > 0 && selected === null && (
          <ul
            id="paata-results"
            role="listbox"
            className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-72 overflow-y-auto rounded-2xl border border-white/15 bg-ink-850 shadow-xl"
          >
            {results.length === 0 ? (
              <li className="px-4 py-3 text-sm text-muted">No matching songs or movies</li>
            ) : (
              results.map((entry, i) => (
                <li
                  key={entry.id}
                  role="option"
                  aria-selected={i === highlight}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(entry)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={clsx(
                    'flex cursor-pointer flex-col border-b border-white/5 px-4 py-2.5 last:border-b-0',
                    i === highlight && 'bg-amber-400/20',
                  )}
                >
                  <span className="font-semibold">{entry.title}</span>
                  <span className="text-xs text-muted">
                    {entry.movie}
                    {entry.year !== null && <> · {entry.year}</>}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button onClick={submit} disabled={selected === null}>
          Guess song
        </Button>
        <Button variant="ghost" onClick={skip}>
          {lastAttempt ? 'Give up :(' : 'Unlock next clue'}
        </Button>
      </div>
      <p className="text-center text-xs text-muted">
        A wrong guess or a skip unlocks a longer clip. The fewer clues you need, the more it pays.
      </p>
    </div>
  )
}

// --- the reveal --------------------------------------------------------------

function RevealPanel({ view, room }: { view: PaataView; room: PublicRoomView }) {
  return (
    <div className="flex flex-col gap-4">
      {view.answer !== undefined && (
        <div className="animate-pop text-center">
          <p className="text-sm font-semibold text-muted">It was</p>
          <p className="text-3xl font-extrabold text-amber-200">{view.answer.title}</p>
          <p className="text-sm text-muted">
            {view.answer.movie}
            {view.answer.year !== null && <> · {view.answer.year}</>}
          </p>
          <a
            className="mt-1 inline-block text-sm text-violet-300 underline hover:text-chalk"
            href={view.answer.youtubeUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Listen on YouTube ↗
          </a>
        </div>
      )}

      {(view.results ?? []).length > 0 && (
        <Card className="flex flex-col gap-2">
          {(view.results ?? []).map((result) => (
            <div key={result.playerId} className="flex flex-col gap-0.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <PlayerName room={room} playerId={result.playerId} />
                </span>
                <MiniLadder marks={result.marks} total={view.maxAttempts} />
                <span className={clsx('tabular w-14 text-right font-bold', result.points > 0 ? 'text-emerald-300' : 'text-muted')}>
                  {result.points > 0 ? `+${result.points}` : '—'}
                </span>
              </div>
              {result.picks.length > 0 && (
                <p className="truncate pl-1 text-xs text-muted">{result.picks.map((p) => `“${p}”`).join(' → ')}</p>
              )}
            </div>
          ))}
        </Card>
      )}

      <Scoreboard entries={room.scoreboard} viewerId={room.viewerId} showDeltas compact />
    </div>
  )
}

export function PaataPattuEpilogue({ room }: { room: PublicRoomView }) {
  const view = readView<PaataView>(room)
  if (view.answer === undefined) return null
  return (
    <Card className="flex flex-col gap-1 text-center">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">Last song</p>
      <p className="text-lg font-bold">{view.answer.title}</p>
      <p className="text-sm text-muted">{view.answer.movie}</p>
    </Card>
  )
}
