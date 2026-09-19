import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { isValidRoomCode, normalizeRoomCode, type RoomPeekResponse } from '@friendzone/shared'
import { api, ApiError } from '../lib/api.ts'
import { loadSession, saveSession, type StoredSession } from '../lib/session.ts'
import { useRoom } from '../lib/useRoom.ts'
import { ConnectionBanner } from '../components/ConnectionBanner.tsx'
import { Button, Card, Logo, Screen, Spinner, TextInput } from '../components/ui.tsx'
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
      const response = await api.joinRoom(code, name.trim())
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
        <div className="text-5xl" aria-hidden>🤷</div>
        <p className="text-lg font-semibold">{peekError}</p>
        <p className="text-sm text-muted">Rooms close a while after everyone leaves.</p>
        <Button size="lg" onClick={() => { window.location.href = '/' }}>Start a new one</Button>
      </Screen>
    )
  }

  if (peek === null) return <Screen><Spinner label="Finding the room…" /></Screen>

  return (
    <Screen className="pt-12">
      <header className="flex flex-col items-center gap-2 text-center">
        <Logo compact as="div" />
        <h1 className="font-mono text-4xl font-bold tracking-[0.25em]">{code}</h1>
        <p className="text-sm text-muted">
          {peek.playerCount} {peek.playerCount === 1 ? 'person is' : 'people are'} in here playing {peek.gameName}
        </p>
      </header>

      <Card className="animate-rise flex flex-col gap-4">
        {peek.joinable ? (
          <>
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-muted">What&rsquo;s your name?</span>
              <TextInput
                autoFocus
                value={name}
                maxLength={20}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && name.trim().length > 0) void join() }}
              />
            </label>
            {error !== null && <p className="text-sm font-semibold text-rose-300">{error}</p>}
            <Button size="lg" loading={busy} disabled={name.trim().length === 0} onClick={() => void join()}>
              Join room
            </Button>
          </>
        ) : (
          <div className="flex flex-col gap-3 text-center">
            <p className="font-semibold">This game is already under way.</p>
            <p className="text-sm text-muted">You can join when this round finishes — keep this page open.</p>
            <Button variant="ghost" onClick={() => window.location.reload()}>Check again</Button>
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
        <div role="alert" className="animate-pop rounded-2xl border border-rose-400/30 bg-rose-500/15 px-4 py-3 text-sm font-semibold text-rose-100">
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
