import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GameCatalogEntry } from '@friendzone/shared'
import { normalizeRoomCode } from '@friendzone/shared'
import { api, ApiError } from '../lib/api.ts'
import { rememberedName, saveSession } from '../lib/session.ts'
import { accentOf, Button, Card, Logo, Screen, TextInput } from '../components/ui.tsx'

/**
 * The front door. One decision to make — host or join — and a name to type.
 * Everything else can wait until there are people in the room.
 */
export function Landing() {
  const navigate = useNavigate()
  const [games, setGames] = useState<GameCatalogEntry[] | null>(null)
  const [mode, setMode] = useState<'idle' | 'create' | 'join'>('idle')
  const [name, setName] = useState(rememberedName())
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
      const session = await api.createRoom(name.trim(), pickedGame ?? undefined)
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
    <Screen className="pt-10">
      <header className="flex flex-col items-center gap-3 text-center">
        <Logo />
        <p className="text-lg font-semibold text-muted">Play stupid games with smart friends.</p>
      </header>

      {mode === 'idle' && (
        <div className="animate-rise flex flex-col gap-3">
          <Button size="lg" onClick={() => setMode('create')}>Create Room</Button>
          <Button size="lg" variant="ghost" onClick={() => setMode('join')}>Join Room</Button>
          <p className="pt-1 text-center text-sm text-muted">No signup. No downloads. Just friends.</p>
        </div>
      )}

      {mode === 'create' && (
        <Card className="animate-rise flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted">What should we call you?</span>
            <TextInput
              autoFocus
              value={name}
              maxLength={20}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim().length > 0) void create() }}
            />
          </label>
          {error !== null && <p className="text-sm font-semibold text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setMode('idle'); setError(null) }}>Back</Button>
            <Button className="flex-1" loading={busy} disabled={name.trim().length === 0} onClick={() => void create()}>
              {pickedGame === null ? 'Create room' : `Create ${games?.find((g) => g.id === pickedGame)?.name ?? 'room'}`}
            </Button>
          </div>
          <p className="text-xs text-muted">You can pick the game and settings once your friends are in.</p>
        </Card>
      )}

      {mode === 'join' && (
        <Card className="animate-rise flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted">Room code</span>
            <TextInput
              autoFocus
              value={code}
              maxLength={12}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="AB7KQ"
              className="text-center font-mono text-3xl tracking-[0.3em] uppercase"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') join() }}
            />
          </label>
          {error !== null && <p className="text-sm font-semibold text-rose-300">{error}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setMode('idle'); setError(null) }}>Back</Button>
            <Button className="flex-1" onClick={join}>Join room</Button>
          </div>
        </Card>
      )}

      <section className="flex flex-col gap-3 pt-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted">The games</h2>
        {games === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-white/5" />)}
          </div>
        ) : games.length === 0 ? (
          <Card><p className="text-sm text-muted">Could not load the game list. The server may be starting up.</p></Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {games.map((game) => {
              const accent = accentOf(game.accent)
              const selected = pickedGame === game.id
              return (
                <button
                  key={game.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => { setPickedGame(selected ? null : game.id); setMode('create') }}
                  className={`card animate-rise flex flex-col gap-1.5 p-4 text-left transition hover:bg-white/[0.06] ${
                    selected ? `ring-2 ${accent.ring}` : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-2xl" aria-hidden>{game.emoji}</span>
                    <span className="font-bold">{game.name}</span>
                  </div>
                  <p className={`text-sm font-semibold ${accent.text}`}>{game.tagline}</p>
                  <p className="text-xs text-muted">
                    {game.minPlayers}–{game.maxPlayers} players · about {game.estimatedMinutes} min
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </Screen>
  )
}
