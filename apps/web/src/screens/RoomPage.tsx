import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { isValidRoomCode, normalizeRoomCode, randomAvatar, type RoomPeekResponse } from '@friendzone/shared'
import { api, ApiError } from '../lib/api.ts'
import { loadSession, rememberAvatar, rememberedAvatar, saveSession, type StoredSession } from '../lib/session.ts'
import { useRoom } from '../lib/useRoom.ts'
import { ConnectionBanner } from '../components/ConnectionBanner.tsx'
import { AvatarPicker, AvatarShuffle, Badge, Button, Card, Logo, Screen, Spinner, TextInput } from '../components/ui.tsx'
import { rememberedName } from '../lib/session.ts'
import { Lobby } from './Lobby.tsx'
import { Results } from './Results.tsx'
import { GameScreen } from '../games/index.tsx'
import { NotFound } from './NotFound.tsx'

/**
 * Everything that happens at /r/CODE.
 *
 * Two jobs: get this browser a seat, then render whatever the room says is
 * happening. The room is the single source of truth for which screen shows —
 * there is no client-side notion of "what phase we are in" that could drift
 * from the server's.
 */
export function RoomPage() {
  const params = useParams<{ code: string }>()
  const code = normalizeRoomCode(params.code ?? '')

  const [session, setSession] = useState<StoredSession | null>(() => (code === '' ? null : loadSession(code)))
  const onSeated = useCallback((seated: StoredSession) => setSession(seated), [])

  if (!isValidRoomCode(code)) return <NotFound />
  if (session === null) return <JoinGate code={code} onSeated={onSeated} />
  return <ConnectedRoom session={session} />
}

// ---------------------------------------------------------------------------

/** "What's your name?" — the only thing between a link and playing. */
function JoinGate({ code, onSeated }: { code: string; onSeated: (session: StoredSession) => void }) {
  const [peek, setPeek] = useState<RoomPeekResponse | null>(null)
  const [peekError, setPeekError] = useState<string | null>(null)
  const [name, setName] = useState(rememberedName())
  const [avatar, setAvatar] = useState(rememberedAvatar)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.peekRoom(code).then(setPeek, (err: unknown) => {
      setPeekError(err instanceof ApiError ? err.message : 'Could not find that room.')
    })
  }, [code])

  const join = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await api.joinRoom(code, name.trim(), avatar)
      rememberAvatar(avatar)
      onSeated(saveSession(response, name.trim()))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join.')
      setBusy(false)
    }
  }

  if (peekError !== null) {
    return (
      <Screen className="items-center pt-16 text-center">
        <Logo compact as="div" />
        <Card color="tomato" soft padding="lg" tilt="left" className="flex flex-col items-center gap-3">
          <div className="animate-float text-6xl" aria-hidden>🕳️</div>
          <p className="font-display text-2xl font-extrabold">{peekError}</p>
          <p className="text-ink-soft">Rooms close a while after everyone leaves.</p>
        </Card>
        <Button size="lg" icon="🏠" onClick={() => { window.location.href = '/' }}>Start a new one</Button>
      </Screen>
    )
  }

  if (peek === null) return <Screen><Spinner label="Finding the room…" /></Screen>

  return (
    <Screen className="max-w-md pt-6">
      <header className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => { window.location.href = '/' }}
          className="min-h-11 font-display font-extrabold underline decoration-3 underline-offset-4"
        >
          ← FriendZone
        </button>
        <Logo compact as="div" />
      </header>

      <div className="flex flex-col items-center gap-3 text-center">
        <p className="font-display text-lg font-bold">You&rsquo;re joining room</p>
        <h1 className="-rotate-2 rounded-2xl border-4 border-ink bg-sun px-5 py-2 font-chunky text-4xl tracking-widest shadow-hard-lg">{code}</h1>
        <Badge size="md">
          👥 {peek.playerCount} {peek.playerCount === 1 ? 'person is' : 'people are'} in here playing {peek.gameName}
        </Badge>
      </div>

      <Card padding="lg" className="animate-rise flex flex-col gap-5">
        {peek.joinable ? (
          <>
            <div className="flex items-end gap-3">
              <AvatarShuffle value={avatar} onShuffle={() => setAvatar(randomAvatar())} />
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="font-display text-sm font-bold uppercase tracking-wide">What&rsquo;s your name?</span>
                <TextInput
                  autoFocus
                  value={name}
                  maxLength={20}
                  placeholder="Your name"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && name.trim().length > 0) void join() }}
                />
              </label>
            </div>
            <AvatarPicker value={avatar} onChange={setAvatar} />
            {error !== null && <p className="animate-shake font-bold text-tomato">{error}</p>}
            <Button size="xl" block icon="🚪" loading={busy} disabled={name.trim().length === 0} onClick={() => void join()}>
              Join room
            </Button>
          </>
        ) : (
          <div className="flex flex-col gap-3 text-center">
            <div className="text-5xl" aria-hidden>🎮</div>
            <p className="font-display text-xl font-extrabold">This game is already under way.</p>
            <p className="text-ink-soft">You can join when this round finishes — keep this page open.</p>
            <Button variant="secondary" onClick={() => window.location.reload()}>Check again</Button>
          </div>
        )}
      </Card>
    </Screen>
  )
}

// ---------------------------------------------------------------------------

function ConnectedRoom({ session }: { session: StoredSession }) {
  const connection = useRoom(session)
  const { room, status, error, farewell, dismissError, reconnectNow } = connection

  // Errors are transient notices, not screens. Clear them on their own.
  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(dismissError, 4_000)
    return () => window.clearTimeout(timer)
  }, [error, dismissError])

  return (
    <Screen>
      <ConnectionBanner status={status} farewell={farewell} onReconnect={reconnectNow} />

      {error !== null && (
        <div role="alert" className="animate-shake rounded-2xl border-3 border-ink bg-tomato px-4 py-3 font-display font-extrabold shadow-hard-sm">
          {error.message}
        </div>
      )}

      {room === null ? (
        <Spinner label="Joining the room…" />
      ) : room.status === 'LOBBY' ? (
        <Lobby connection={connection} room={room} />
      ) : room.status === 'GAME_OVER' ? (
        <Results connection={connection} room={room} />
      ) : (
        <GameScreen connection={connection} room={room} />
      )}
    </Screen>
  )
}
