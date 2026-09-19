import type { ConnectionStatus } from '../lib/useRoom.ts'
import { Button } from './ui.tsx'

/**
 * The reconnect indicator.
 *
 * Deliberately non-blocking: a dropped socket does not lose the round, so the
 * screen behind stays visible and usable-looking rather than being replaced by
 * an error page. It says what is happening and gets out of the way.
 */
export function ConnectionBanner({
  status,
  farewell,
  onReconnect,
}: {
  status: ConnectionStatus
  farewell: { reason: string; message: string } | null
  onReconnect: () => void
}) {
  if (farewell !== null && farewell.reason !== 'SERVER_SHUTDOWN') {
    const permanent = farewell.reason === 'KICKED' || farewell.reason === 'ROOM_CLOSED'
    return (
      <div className="sticky top-0 z-30 -mx-4 mb-1 border-b border-white/10 bg-ink-850/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <p className="text-sm font-semibold">{farewell.message}</p>
          {farewell.reason === 'PROTOCOL_MISMATCH' ? (
            <Button size="md" onClick={() => window.location.reload()}>Reload</Button>
          ) : permanent ? (
            <Button variant="ghost" onClick={() => { window.location.href = '/' }}>Home</Button>
          ) : (
            <Button variant="ghost" onClick={onReconnect}>Rejoin</Button>
          )}
        </div>
      </div>
    )
  }

  if (status === 'live') return null

  const message =
    status === 'connecting' ? 'Connecting…' : status === 'reconnecting' ? 'Reconnecting — your place is saved' : 'Disconnected'

  return (
    <div
      role="status"
      className="sticky top-0 z-30 -mx-4 mb-1 border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 backdrop-blur"
    >
      <div className="mx-auto flex max-w-2xl items-center gap-2 text-sm font-semibold text-amber-200">
        <span className="size-2 animate-soft-pulse rounded-full bg-amber-300" aria-hidden />
        {message}
        {status === 'closed' && (
          <Button variant="subtle" className="ml-auto text-amber-200" onClick={onReconnect}>
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}
