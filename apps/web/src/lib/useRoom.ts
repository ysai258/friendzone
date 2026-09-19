import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ClockSync,
  PROTOCOL_VERSION,
  type ByeReason,
  type PublicEvent,
  type PublicRoomView,
  type ServerMessage,
  type WireError,
} from '@friendzone/shared'
import type { StoredSession } from './session.ts'

/**
 * The room connection.
 *
 * Holds one socket, keeps it alive across the things that actually happen to
 * phones — a tunnel, a lock screen, a network switch — and exposes the room as
 * ordinary React state.
 *
 * Three decisions worth stating:
 *
 *  - Reconnects are automatic and backed off, and the socket is treated as a
 *    cache of the server's state rather than as the state itself. Every
 *    reconnect asks for a full snapshot, so there is no delta stream to fall
 *    out of step with.
 *
 *  - Actions carry an id generated once and reused on retry. If the socket
 *    dies mid-send, the same id goes out again and the server recognises it,
 *    which is what makes "tap answer, lose signal, reconnect" safe.
 *
 *  - Countdowns are drawn from the server's clock, never the device's. The
 *    offset is measured continuously by ping/pong.
 */

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface RoomConnection {
  room: PublicRoomView | null
  status: ConnectionStatus
  error: WireError | null
  /** Set when the server asked us to go away for good. */
  farewell: { reason: ByeReason; message: string } | null
  events: PublicEvent[]
  /** Best estimate of the server's clock right now. */
  serverNow: () => number
  latencyMs: number
  send: (type: string, payload?: Record<string, unknown>) => void
  dismissError: () => void
  reconnectNow: () => void
}

/** Backoff between reconnect attempts, with a little jitter so a server coming
 *  back does not meet every client at the same instant. */
function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 300 * 2 ** Math.min(attempt, 5))
  return base + Math.random() * 250
}

const PING_INTERVAL_MS = 5_000
/** How long an action waits for its socket before being retried on a new one. */
const PENDING_TTL_MS = 20_000

interface PendingAction {
  actionId: string
  type: string
  payload: Record<string, unknown>
  queuedAt: number
}

export function useRoom(session: StoredSession | null): RoomConnection {
  const [room, setRoom] = useState<PublicRoomView | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState<WireError | null>(null)
  const [farewell, setFarewell] = useState<{ reason: ByeReason; message: string } | null>(null)
  const [events, setEvents] = useState<PublicEvent[]>([])
  const [latencyMs, setLatencyMs] = useState(0)

  const socketRef = useRef<WebSocket | null>(null)
  const clockRef = useRef(new ClockSync())
  const attemptRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  const pingTimerRef = useRef<number | null>(null)
  const closedByUsRef = useRef(false)
  /** Actions sent but not yet known to have reached the server. */
  const pendingRef = useRef<PendingAction[]>([])
  /** Bumped to force the connection effect to run again. State, not a ref:
   *  a ref's current value does not re-trigger an effect. */
  const [reconnectNonce, setReconnectNonce] = useState(0)

  const serverNow = useCallback(() => clockRef.current.serverNow(), [])

  useEffect(() => {
    if (session === null) return
    closedByUsRef.current = false

    let disposed = false

    const clearTimers = () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current)
      retryTimerRef.current = null
      pingTimerRef.current = null
    }

    const scheduleReconnect = () => {
      if (disposed || closedByUsRef.current) return
      const wait = backoffMs(attemptRef.current++)
      setStatus('reconnecting')
      retryTimerRef.current = window.setTimeout(connect, wait)
    }

    const flushPending = (socket: WebSocket) => {
      const now = Date.now()
      // Drop anything so old the round it belonged to is certainly over.
      pendingRef.current = pendingRef.current.filter((a) => now - a.queuedAt < PENDING_TTL_MS)
      for (const action of pendingRef.current) {
        socket.send(JSON.stringify({ t: 'action', actionId: action.actionId, type: action.type, payload: action.payload }))
      }
    }

    function connect(): void {
      if (disposed || session === null) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/${session.roomCode}`)
      socketRef.current = socket
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting')

      socket.onopen = () => {
        socket.send(
          JSON.stringify({ t: 'hello', token: session.token, protocolVersion: PROTOCOL_VERSION, clientTime: Date.now() }),
        )
      }

      socket.onmessage = (raw: MessageEvent<string>) => {
        const message = JSON.parse(raw.data) as ServerMessage

        switch (message.t) {
          case 'welcome': {
            attemptRef.current = 0
            clockRef.current.seed(message.serverTime, Date.now())
            setRoom(message.room)
            setStatus('live')
            setError(null)
            // Anything queued while we were away goes out now, with the ids it
            // originally had, so the server can recognise a repeat.
            flushPending(socket)
            break
          }
          case 'state': {
            setRoom(message.room)
            if (message.events.length > 0) setEvents((previous) => [...previous, ...message.events].slice(-40))
            // The server confirmed a new version, so nothing older is still in
            // flight worth resending.
            pendingRef.current = []
            break
          }
          case 'pong': {
            const now = Date.now()
            clockRef.current.sample(message.clientTime, message.serverTime, now)
            setLatencyMs(Math.round(clockRef.current.roundTripMs))
            break
          }
          case 'error': {
            setError(message.error)
            // A refused action will not be applied, so stop trying to resend it.
            if (message.error.actionId !== undefined) {
              pendingRef.current = pendingRef.current.filter((a) => a.actionId !== message.error.actionId)
            }
            break
          }
          case 'bye': {
            setFarewell({ reason: message.reason, message: message.message })
            // A restart means come straight back; being replaced or removed
            // does not.
            if (message.reason === 'SERVER_SHUTDOWN') break
            closedByUsRef.current = true
            setStatus('closed')
            break
          }
        }
      }

      socket.onclose = () => {
        if (disposed) return
        clearTimers()
        if (closedByUsRef.current) {
          setStatus('closed')
          return
        }
        scheduleReconnect()
      }

      socket.onerror = () => {
        // onclose always follows; reconnecting is handled there.
      }

      pingTimerRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'ping', clientTime: Date.now() }))
        }
      }, PING_INTERVAL_MS)
    }

    connect()

    /**
     * A phone that was locked, or a laptop lid that was closed, comes back with
     * a socket the browser still calls open and the server stopped hearing from
     * minutes ago. Waking is the moment to check rather than wait for a
     * heartbeat to time out.
     */
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      const socket = socketRef.current
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        attemptRef.current = 0
        clearTimers()
        connect()
        return
      }
      // Alive as far as the browser knows: ask for the truth rather than trust
      // whatever was on screen when the device went to sleep.
      socket.send(JSON.stringify({ t: 'resync' }))
      socket.send(JSON.stringify({ t: 'ping', clientTime: Date.now() }))
    }

    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
      clearTimers()
      closedByUsRef.current = true
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [session, reconnectNonce])

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const action: PendingAction = {
      // Generated once. A retry reuses it, which is what the server's
      // idempotency check keys on.
      actionId: crypto.randomUUID(),
      type,
      payload,
      queuedAt: Date.now(),
    }
    pendingRef.current = [...pendingRef.current.slice(-8), action]

    const socket = socketRef.current
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: 'action', actionId: action.actionId, type, payload }))
    }
    // If the socket is not open the action waits in pendingRef and goes out on
    // the next welcome, rather than being silently dropped.
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  const reconnectNow = useCallback(() => {
    closedByUsRef.current = false
    attemptRef.current = 0
    setFarewell(null)
    setReconnectNonce((n) => n + 1)
  }, [])

  return useMemo(
    () => ({ room, status, error, farewell, events, serverNow, latencyMs, send, dismissError, reconnectNow }),
    [room, status, error, farewell, events, serverNow, latencyMs, send, dismissError, reconnectNow],
  )
}

/**
 * A countdown that ticks off the server's clock.
 *
 * Re-rendering ten times a second is enough for a smooth bar without making a
 * mid-range phone work for it, and every tick is recomputed from the absolute
 * deadline rather than by decrementing — so a dropped frame or a backgrounded
 * tab cannot make the timer drift.
 */
export function useCountdown(deadlineAt: number | null, serverNow: () => number): { msLeft: number; seconds: number } {
  const [msLeft, setMsLeft] = useState(() => (deadlineAt === null ? 0 : Math.max(0, deadlineAt - serverNow())))

  useEffect(() => {
    if (deadlineAt === null) {
      setMsLeft(0)
      return
    }
    const tick = () => setMsLeft(Math.max(0, deadlineAt - serverNow()))
    tick()
    const timer = window.setInterval(tick, 100)
    return () => window.clearInterval(timer)
  }, [deadlineAt, serverNow])

  return { msLeft, seconds: Math.ceil(msLeft / 1000) }
}
