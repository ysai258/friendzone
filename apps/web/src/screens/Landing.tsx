import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GameCatalogEntry } from '@friendzone/shared'
import { normalizeRoomCode, randomAvatar } from '@friendzone/shared'
import { api, ApiError } from '../lib/api.ts'
import { rememberAvatar, rememberedAvatar, rememberedName, saveSession } from '../lib/session.ts'
import { AvatarPicker, AvatarShuffle, Badge, Button, Card, COLOR, colorOf, Logo, TextInput } from '../components/ui.tsx'

const FLOATERS: { e: string; cls: string; delay: string }[] = [
  { e: '🎬', cls: 'left-[2%] top-[2%] -rotate-12', delay: '0s' },
  { e: '🎵', cls: 'right-[4%] top-[0%] rotate-12', delay: '0.6s' },
  { e: '🧠', cls: 'left-[0%] bottom-[4%] rotate-6', delay: '1.2s' },
  { e: '🕵️', cls: 'right-[0%] bottom-[8%] -rotate-6', delay: '0.3s' },
]

const TILTS = ['-rotate-1', 'rotate-1', 'rotate-0', '-rotate-2', 'rotate-2', '-rotate-1']

/**
 * The front door. One decision to make (host or join), a name to type and a
 * face to pick. Everything else can wait until there are people in the room.
 */
export function Landing() {
  const navigate = useNavigate()
  const [games, setGames] = useState<GameCatalogEntry[] | null>(null)
  const [mode, setMode] = useState<'idle' | 'create' | 'join'>('idle')
  const [name, setName] = useState(rememberedName())
  const [avatar, setAvatar] = useState(rememberedAvatar)
  const [code, setCode] = useState('')
  const [pickedGame, setPickedGame] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.games().then(setGames, () => setGames([]))
  }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await api.createRoom(name.trim(), avatar, pickedGame ?? undefined)
      rememberAvatar(avatar)
      saveSession(session, name.trim())
      void navigate(`/r/${session.roomCode}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create a room.')
      setBusy(false)
    }
  }

  const join = () => {
    const normalized = normalizeRoomCode(code)
    if (normalized.length === 0) {
      setError('Enter the room code your friend sent you.')
      return
    }
    void navigate(`/r/${normalized}`)
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-10 px-4 pb-16 pt-5">
      <header className="flex items-center justify-between">
        <Logo compact as="div" />
        <Badge size="md" color="sun">No signup · No app</Badge>
      </header>

      <section className="relative px-2 pb-2 pt-4 text-center">
        <div className="relative">
          <h1 aria-label="FRIENDZONE">
            <Logo as="div" />
          </h1>
          {FLOATERS.map((f) => (
            <span
              key={f.e}
              aria-hidden
              className={clsx('pointer-events-none absolute animate-float text-3xl sm:text-4xl', f.cls)}
              style={{ animationDelay: f.delay }}
            >
              {f.e}
            </span>
          ))}
        </div>
        <p className="relative mx-auto mt-8 max-w-sm font-display text-xl font-bold leading-snug">
          Play stupid games with smart friends.
          <br />
          <span className="box-decoration-clone rounded-md bg-sun px-1">Open a link, type a name, play.</span>
        </p>
      </section>

      {mode === 'idle' && (
        <Card padding="lg" className="animate-rise flex flex-col gap-4">
          <Button size="xl" block icon="🎉" className="animate-wiggle" onClick={() => setMode('create')}>
            Create Room
          </Button>
          <div className="flex items-center gap-3 text-sm font-bold uppercase tracking-widest text-ink-soft" aria-hidden>
            <span className="h-[3px] flex-1 rounded bg-ink/15" /> or <span className="h-[3px] flex-1 rounded bg-ink/15" />
          </div>
          <Button size="lg" block variant="dark" icon="🚪" onClick={() => setMode('join')}>
            Join Room
          </Button>
          <p className="text-center text-sm font-semibold text-ink-soft">No signup. No downloads. Just friends.</p>
        </Card>
      )}

      {mode === 'create' && (
        <Card padding="lg" className="animate-rise flex flex-col gap-5">
          <div className="flex items-end gap-3">
            <AvatarShuffle value={avatar} onShuffle={() => setAvatar(randomAvatar())} />
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="font-display text-sm font-bold uppercase tracking-wide">What should we call you?</span>
              <TextInput
                autoFocus
                value={name}
                maxLength={20}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim().length > 0) void create() }}
              />
            </label>
          </div>
          <AvatarPicker value={avatar} onChange={setAvatar} />
          {error !== null && <p className="animate-shake font-bold text-tomato">{error}</p>}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { setMode('idle'); setError(null) }}>Back</Button>
            <Button className="flex-1" icon="🎉" loading={busy} disabled={name.trim().length === 0} onClick={() => void create()}>
              {pickedGame === null ? 'Create room' : `Create ${games?.find((g) => g.id === pickedGame)?.name ?? 'room'}`}
            </Button>
          </div>
          <p className="text-sm text-ink-soft">You can pick the game and settings once your friends are in.</p>
        </Card>
      )}

      {mode === 'join' && (
        <Card padding="lg" className="animate-rise flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-display text-sm font-bold uppercase tracking-wide">Room code</span>
            <TextInput
              autoFocus
              value={code}
              maxLength={12}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="AB7KQ"
              className="text-center font-chunky !text-2xl uppercase tracking-[0.25em]"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') join() }}
            />
          </label>
          {error !== null && <p className="animate-shake font-bold text-tomato">{error}</p>}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { setMode('idle'); setError(null) }}>Back</Button>
            <Button className="flex-1" variant="dark" onClick={join}>Join room →</Button>
          </div>
        </Card>
      )}

      <section className="flex flex-col gap-5">
        <h2 className="text-3xl">
          Tonight&apos;s lineup <span aria-hidden>🍿</span>
        </h2>
        {games === null ? (
          <div className="grid gap-5 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-32 animate-pulse rounded-3xl border-3 border-ink/20 bg-white/60" />)}
          </div>
        ) : games.length === 0 ? (
          <Card color="tomato" soft><p className="font-semibold">Could not load the game list. The server may be starting up.</p></Card>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {games.map((game, i) => {
              const selected = pickedGame === game.id
              return (
                <button
                  key={game.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => { setPickedGame(selected ? null : game.id); setMode('create') }}
                  className={clsx(
                    'animate-rise block w-full rounded-3xl border-3 border-ink p-4 text-left transition-transform duration-150',
                    'active:translate-x-1 active:translate-y-1 active:shadow-none',
                    COLOR[colorOf(game.accent)].bg,
                    selected ? 'rotate-0 shadow-hard-lg outline-3 outline-offset-3 outline-ink' : clsx('shadow-hard', TILTS[i % TILTS.length]),
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-14 shrink-0 place-items-center rounded-2xl border-3 border-ink bg-white text-3xl leading-none" aria-hidden>
                      {game.emoji}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xl leading-tight">{game.name}</h3>
                      <p className="mt-0.5 text-sm font-medium leading-snug">{game.tagline}</p>
                    </div>
                    {selected && <span className="shrink-0 animate-pop text-2xl" aria-label="selected">✅</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge>👥 {game.minPlayers}–{game.maxPlayers}</Badge>
                    <Badge>⏱ ~{game.estimatedMinutes} min</Badge>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-3xl">How it works <span aria-hidden>🤙</span></h2>
        {(
          [
            ['📲', 'Create a room', 'Pick a face, type a name. That is the whole signup.'],
            ['🔗', 'Send the link', 'Friends open it on their phones. No apps.'],
            ['🏆', 'Play, then play again', 'Same room, next game, until somebody sulks.'],
          ] as const
        ).map(([emoji, title, body], i) => (
          <Card
            key={title}
            color={(['sun', 'bubblegum', 'lime'] as const)[i] ?? 'sun'}
            soft
            tilt={i % 2 === 1 ? 'right' : 'left'}
            className="flex items-center gap-4"
          >
            <span className="grid size-12 shrink-0 place-items-center rounded-full border-3 border-ink bg-white font-chunky text-lg">{i + 1}</span>
            <div className="min-w-0">
              <p className="font-display text-lg font-extrabold">{title} <span aria-hidden>{emoji}</span></p>
              <p className="text-ink-soft">{body}</p>
            </div>
          </Card>
        ))}
      </section>

      <footer className="text-center text-sm font-medium text-ink-soft">
        Made for loud friends. No sign-ups, no ads. <span aria-hidden>💥</span>
      </footer>
    </main>
  )
}
