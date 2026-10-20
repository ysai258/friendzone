import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PublicRoomView } from '@friendzone/shared'
import type { GameProps } from './index.tsx'
import { Button, Card } from '../components/ui.tsx'
import { Scoreboard } from '../components/Scoreboard.tsx'
import { api, type SongCatalogEntry } from '../lib/api.ts'
import { useYouTubeClip, type ClipStatus } from '../lib/youtubeClip.ts'
import { Banner, Countdown, GameHeader, PlayerName, readView } from './shared.tsx'

type GuessKind = 'correct' | 'movie' | 'wrong'

type CatalogEntry = SongCatalogEntry

/**
 * The guess list, fetched once per page and shared by every round. It is the
 * whole song pool, so it comes over HTTP rather than in each room update.
 */
let catalogRequest: Promise<CatalogEntry[]> | null = null

function useSongCatalog(): CatalogEntry[] {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  useEffect(() => {
    let live = true
    catalogRequest ??= api.songs().catch((error: unknown) => {
      catalogRequest = null // let the next mount try again
      throw error
    })
    catalogRequest.then((entries) => live && setCatalog(entries)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return catalog
}

interface Pick {
  title: string | null
  kind: GuessKind
  stage: number
}

interface PaataView {
  clipSeconds: number[]
  stage: number
  unlockedSeconds: number
  audio: 'everyone' | 'host'
  board: Record<string, { solvedStage: number | null; place: number | null; misses: number; usedStage: boolean }>
  activeCount: number
  clip?: { videoId: string; startOffsetMs: number }
  you?: { solvedStage: number | null; place: number | null; points: number; canGuess: boolean; guesses: Pick[] }
  answer?: { title: string; movie: string; year: number | null; youtubeUrl: string }
  results?: { playerId: string; solvedStage: number | null; place: number | null; points: number; picks: Pick[] }[]
}

const ORDINAL = ['1st', '2nd', '3rd']
const ordinal = (place: number) => ORDINAL[place - 1] ?? `${place}th`

export function PaataPattu({ connection, room }: GameProps) {
  // Start loading the guess list during the countdown, not at the first clue.
  useSongCatalog()
  const view = readView<PaataView>(room)
  const phase = room.game?.phase

  const counting = phase === 'COUNTDOWN'
  const hostName = room.players.find((p) => p.id === room.hostId)?.name ?? 'the host'
  const playsHere = view.audio === 'everyone' || room.viewerId === room.hostId
  // Every new clue, and the reveal, plays from the top for the whole room.
  const autoplayKey = phase === 'QUESTION' || phase === 'REVEAL' ? `${room.game?.roundNumber}:${phase}:${view.stage}` : null

  // The deck stays mounted across the countdown, hidden, so the song is loaded
  // and buffered by the time the first clue opens.
  return (
    <div className="flex flex-col gap-4">
      {counting ? (
        <Countdown
          connection={connection}
          room={room}
          title={`Song ${room.game?.roundNumber} of ${room.game?.totalRounds}`}
          subtitle="Everyone hears the same intro. One guess per clue — get it before your friends do."
        />
      ) : (
        <GameHeader connection={connection} room={room} label="📼 Paata Pattu" accent="bg-amber-400" />
      )}
      {playsHere ? (
        <Deck view={view} autoplayKey={autoplayKey} hidden={counting} />
      ) : (
        !counting && <SpeakerNote hostName={hostName} seconds={view.unlockedSeconds} />
      )}
      {counting ? null : phase === 'QUESTION' ? (
        <>
          <ClueRail view={view} />
          <GuessPanel connection={connection} view={view} />
          <RaceBoard room={room} view={view} />
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
  blocked: (s) => [`Tap to play ${s} seconds`, 'Your browser wants a tap before it plays audio'],
  starting: () => ['Pause', 'Starting the tape…'],
  playing: () => ['Pause', 'Playing the clue'],
  paused: () => ['Continue', 'Paused'],
  done: (s) => ['Replay', `${s}-second clue played`],
  unavailable: () => ['Audio unavailable', 'This song will not play here'],
  error: () => ['Retry audio', 'Audio could not start'],
}

function Cassette({ seconds, spinning }: { seconds: number; spinning: boolean }) {
  return (
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
  )
}

/**
 * The tape deck: a hidden YouTube player behind a cassette that is purely
 * decoration. The video never renders on screen, so its title and thumbnail
 * cannot give the song away.
 */
function Deck({ view, autoplayKey, hidden }: { view: PaataView; autoplayKey: string | null; hidden: boolean }) {
  const seconds = view.unlockedSeconds
  const clip = useYouTubeClip(view.clip?.videoId ?? null, view.clip?.startOffsetMs ?? 0, seconds, autoplayKey)
  const [label, sub] = STATUS_COPY[clip.status](seconds)
  const busy = clip.status === 'playing' || clip.status === 'starting'
  const progress = clip.limitMs > 0 ? clip.positionMs / clip.limitMs : 0

  // Off-screen rather than display:none: YouTube will not play a hidden iframe.
  const playerHost = (
    <div
      ref={clip.hostRef}
      aria-hidden
      className="pointer-events-none fixed left-[-10000px] top-0 h-[270px] w-[480px] opacity-0"
    />
  )
  // The player's element sits outside the card, always in the same place, so
  // showing the card after the countdown does not remount the primed player.
  return (
    <>
      {!hidden && (
        <Card className="flex flex-col gap-4 border-[#e9a72b]/30 bg-[#f5e7cb]/[0.04]">
          <Cassette seconds={seconds} spinning={clip.status === 'playing'} />

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => clip.toggle()}
              disabled={clip.status === 'loading' || clip.status === 'unavailable'}
              aria-label={label}
              className={clsx(
                'flex size-16 shrink-0 items-center justify-center rounded-full border-[3px] border-[#171513] bg-[#e9a72b] text-2xl text-[#171513] shadow-[3px_3px_0_#171513] transition active:translate-x-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0_#171513] disabled:opacity-55',
                clip.status === 'blocked' && 'animate-soft-pulse',
              )}
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
            <a className="underline hover:text-chalk" href="https://music.youtube.com/" target="_blank" rel="noreferrer noopener">
              YouTube Music ↗
            </a>
          </p>
        </Card>
      )}
      {playerHost}
    </>
  )
}

/** For everyone but the host, when the music plays on one speaker for the room. */
function SpeakerNote({ hostName, seconds }: { hostName: string; seconds: number }) {
  return (
    <Card className="flex flex-col gap-3 border-[#e9a72b]/30 bg-[#f5e7cb]/[0.04]">
      <Cassette seconds={seconds} spinning={false} />
      <p className="text-center font-semibold">🔊 Listen to {hostName}&rsquo;s speaker</p>
      <p className="text-center text-xs text-muted">The music plays on the host&rsquo;s device so the whole room hears it together.</p>
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

// --- the clue rail -----------------------------------------------------------

const KIND_MARK: Record<GuessKind, string> = { correct: '✓', movie: '🎬', wrong: '✗' }

/** The room's five clues, and what you did with each. */
function ClueRail({ view }: { view: PaataView }) {
  const mine = view.you?.guesses ?? []
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Clues">
      {view.clipSeconds.map((seconds, index) => {
        const current = index === view.stage
        const past = index < view.stage
        const pick = mine.find((g) => g.stage === index)
        return (
          <li
            key={seconds}
            className={clsx(
              'flex min-h-14 flex-col items-center justify-center rounded-xl border text-center',
              current && 'border-amber-300 bg-amber-400 text-ink-950 shadow-[2px_2px_0_#171513]',
              past && 'border-amber-300/30 bg-amber-400/15 text-amber-100',
              !current && !past && 'border-dashed border-white/20 text-muted opacity-60',
            )}
          >
            <span className="font-mono text-sm font-semibold">{seconds}s</span>
            <span className="text-[11px] font-bold">
              {pick !== undefined ? KIND_MARK[pick.kind] : current ? 'Now' : past ? '' : 'Locked'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The race as the table sees it: who has it, on which clue, and how many misses. */
function RaceBoard({ room, view }: { room: PublicRoomView; view: PaataView }) {
  const seated = room.players.filter((p) => p.presence !== 'INACTIVE')
  return (
    <Card className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">The race</p>
      {seated.map((player) => {
        const entry = view.board[player.id]
        const solved = entry?.solvedStage ?? null
        return (
          <div key={player.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <PlayerName room={room} playerId={player.id} />
            </span>
            {Array.from({ length: entry?.misses ?? 0 }, (_, i) => (
              <span key={i} className="text-rose-300" aria-hidden>✗</span>
            ))}
            {solved !== null ? (
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-200">
                ✓ {view.clipSeconds[solved]}s{entry?.place != null && <> · {ordinal(entry.place)}</>}
              </span>
            ) : entry?.usedStage === true ? (
              <span className="text-xs text-muted">waiting for next clue</span>
            ) : (
              <span className="text-xs text-muted animate-soft-pulse">listening…</span>
            )}
          </div>
        )
      })}
    </Card>
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

  const catalog = useSongCatalog()
  // Search once per catalog, not per keystroke.
  const index = useMemo(
    () => catalog.map((entry) => ({ entry, haystack: normalize([entry.title, entry.movie, ...entry.aliases].join(' ')) })),
    [catalog],
  )
  const tried = useMemo(() => new Set((you?.guesses ?? []).map((g) => g.title)), [you?.guesses])

  const results = useMemo(() => {
    const terms = normalize(query).split(' ').filter((t) => t.length > 0)
    if (terms.length === 0 || selected !== null) return []
    return index
      .filter(({ entry, haystack }) => !tried.has(entry.title) && terms.every((t) => haystack.includes(t)))
      .slice(0, MAX_RESULTS)
      .map(({ entry }) => entry)
  }, [index, query, selected, tried])

  if (you === undefined) return null

  if (you.solvedStage !== null) {
    return (
      <Banner tone="good">
        Got it on the {view.clipSeconds[you.solvedStage]}-second clue
        {you.place !== null && <> — {ordinal(you.place)}!</>} +{you.points.toLocaleString()}
      </Banner>
    )
  }

  if (!you.canGuess) {
    const last = you.guesses.at(-1)
    const next = view.clipSeconds[view.stage + 1]
    return (
      <Banner tone={last?.kind === 'movie' ? 'neutral' : 'bad'}>
        {last?.kind === 'movie' ? <>🎬 Right movie, wrong song! +100. </> : <>“{last?.title}” isn&rsquo;t it. </>}
        {next !== undefined ? <>Your next guess opens with the {next}-second clue.</> : <>That was your last clue.</>}
      </Banner>
    )
  }

  const choose = (entry: CatalogEntry) => {
    setSelected(entry)
    setQuery(entry.title)
    setOpen(false)
  }

  const submit = () => {
    if (selected === null) return
    connection.send('song/guess', { trackId: selected.id })
    setSelected(null)
    setQuery('')
    setHighlight(0)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <label htmlFor="paata-guess" className="mb-1.5 block text-sm font-semibold">
          Your guess <span className="font-normal text-muted">— one per clue</span>
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

      <Button onClick={submit} disabled={selected === null}>
        Lock it in
      </Button>
      <p className="text-center text-xs text-muted">
        Wrong, and you sit out until the next clue. Right movie, wrong song still earns 100.
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
        <Card className="flex flex-col gap-2.5">
          {(view.results ?? []).map((result) => (
            <div key={result.playerId} className="flex flex-col gap-0.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <PlayerName room={room} playerId={result.playerId} />
                </span>
                {result.solvedStage !== null && (
                  <span className="text-xs font-bold text-emerald-200">
                    {view.clipSeconds[result.solvedStage]}s{result.place !== null && <> · {ordinal(result.place)}</>}
                  </span>
                )}
                <span className={clsx('tabular w-14 text-right font-bold', result.points > 0 ? 'text-emerald-300' : 'text-muted')}>
                  {result.points > 0 ? `+${result.points}` : '—'}
                </span>
              </div>
              {result.picks.length > 0 && (
                <p className="truncate pl-1 text-xs text-muted">
                  {result.picks.map((p) => `${KIND_MARK[p.kind]} ${p.title ?? '?'} (${view.clipSeconds[p.stage]}s)`).join('  ·  ')}
                </p>
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
