import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Play the first N seconds of a YouTube video, and not one more.
 *
 * The video is a hidden IFrame Player: nothing is ever shown, so the title and
 * thumbnail cannot give the song away. `loadVideoById` with an `endSeconds`
 * asks YouTube to stop at the clue's edge, and a 150 ms poll of the playhead
 * pauses it ourselves in case YouTube overshoots — on a two-second clue a
 * quarter-second of overrun is a lot of extra song.
 *
 * In a race the clip has to start when the clue opens, not whenever a phone
 * finishes loading it: a cold first play can take several seconds. So once the
 * player is ready it primes itself — plays muted until audio actually flows,
 * then pauses at the top — and the clue that follows starts from buffer.
 *
 * Only the minimal slice of the IFrame API this needs is typed here; pulling in
 * @types/youtube for a handful of methods is not worth a dependency.
 */

interface YTPlayer {
  loadVideoById(args: { videoId: string; startSeconds: number; endSeconds: number }): void
  cueVideoById(args: { videoId: string; startSeconds: number }): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  mute(): void
  unMute(): void
  getCurrentTime(): number
  getPlayerState(): number
  setVolume(volume: number): void
  destroy(): void
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      height: string
      width: string
      playerVars: Record<string, number | string>
      events: {
        onReady?: () => void
        onStateChange?: (event: { data: number }) => void
        onError?: (event: { data: number }) => void
      }
    },
  ) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

const YT_ENDED = 0
const YT_PLAYING = 1
const YT_BUFFERING = 3
/** "Not found", "embedding disabled", and its twin. Retrying will not help. */
const UNPLAYABLE_ERRORS = new Set([100, 101, 150])
/** Give up on a play that never starts, buffering or not. */
const START_TIMEOUT_MS = 8_000
/** An autoplay that is not even buffering by now was refused by the browser. */
const AUTOPLAY_GRACE_MS = 2_000
/** Stop priming and call the player ready anyway. Priming is an optimisation. */
const PRIME_TIMEOUT_MS = 6_000
const POLL_MS = 150

let apiPromise: Promise<YTNamespace> | null = null

/** Load the IFrame API once per page, however many players ask for it. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise !== null) return apiPromise
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player !== undefined) {
      resolve(window.YT)
      return
    }
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT !== undefined) resolve(window.YT)
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      apiPromise = null
      reject(new Error('YouTube player failed to load'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

export type ClipStatus =
  | 'loading'
  | 'ready'
  /** The browser refused to start audio on its own; it needs a tap. */
  | 'blocked'
  | 'starting'
  | 'playing'
  | 'paused'
  | 'done'
  | 'unavailable'
  | 'error'

export interface ClipPlayer {
  status: ClipStatus
  /** Milliseconds heard into the clue, 0..limit. */
  positionMs: number
  limitMs: number
  /** Play from the top, or carry on from a pause. */
  toggle(): void
  /** Ref for the hidden element the player mounts into. */
  hostRef: (element: HTMLDivElement | null) => void
}

/**
 * `autoplayKey` plays the clip from the top every time it changes to a new
 * non-null value — the room's new clue, heard by everyone at once. Browsers
 * may refuse audio that no tap started; that lands in 'blocked', and the next
 * toggle (a tap) plays it.
 */
export function useYouTubeClip(
  videoId: string | null,
  startOffsetMs: number,
  limitSeconds: number,
  autoplayKey: string | null = null,
): ClipPlayer {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const player = useRef<YTPlayer | null>(null)
  const [status, setStatus] = useState<ClipStatus>('loading')
  const [positionMs, setPositionMs] = useState(0)
  const poll = useRef<number | null>(null)
  const startTimer = useRef<number | null>(null)
  const statusRef = useRef<ClipStatus>('loading')
  const positionRef = useRef(0)
  /** True while the muted warm-up play is running. */
  const priming = useRef(false)
  /** An autoplay asked for before the player could take it. */
  const pendingAutoplay = useRef(false)
  const playRef = useRef<(from: number, auto: boolean) => void>(() => undefined)

  const limitMs = limitSeconds * 1000
  const offset = startOffsetMs / 1000
  // Read by player callbacks that outlive the render that created them.
  const limitRef = useRef(limitMs)
  limitRef.current = limitMs

  const update = useCallback((next: ClipStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const stopTimers = useCallback(() => {
    if (poll.current !== null) window.clearInterval(poll.current)
    if (startTimer.current !== null) window.clearTimeout(startTimer.current)
    poll.current = null
    startTimer.current = null
  }, [])

  /** The player can take a play now: honour one that was asked for meanwhile. */
  const becomeReady = useCallback(() => {
    update('ready')
    if (pendingAutoplay.current) {
      pendingAutoplay.current = false
      playRef.current(0, true)
    }
  }, [update])

  // One player per mounted screen and song.
  useEffect(() => {
    if (host === null || videoId === null) return
    let cancelled = false
    let primeTimer: number | null = null
    update('loading')
    positionRef.current = 0
    setPositionMs(0)
    const mount = document.createElement('div')
    host.appendChild(mount)

    const finishPriming = () => {
      if (!priming.current) return
      priming.current = false
      if (primeTimer !== null) window.clearTimeout(primeTimer)
      const yt = player.current
      if (yt === null) return
      yt.pauseVideo()
      yt.seekTo(offset, true)
      yt.unMute()
      becomeReady()
    }

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return
        player.current = new YT.Player(mount, {
          height: '270',
          width: '480',
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              const yt = player.current
              if (yt === null) return
              yt.setVolume(100)
              // Warm up silently. Muted playback is allowed without a tap, and
              // once audio has flowed the opening is in the buffer.
              priming.current = true
              yt.mute()
              yt.loadVideoById({ videoId, startSeconds: offset, endSeconds: offset + 30 })
              yt.playVideo()
              primeTimer = window.setTimeout(finishPriming, PRIME_TIMEOUT_MS)
            },
            onStateChange: (event) => {
              if (priming.current) {
                if (event.data === YT_PLAYING) finishPriming()
                return
              }
              if (event.data === YT_ENDED && (statusRef.current === 'playing' || statusRef.current === 'starting')) {
                stopTimers()
                positionRef.current = limitRef.current
                setPositionMs(limitRef.current)
                update('done')
              }
            },
            onError: (event) => {
              priming.current = false
              stopTimers()
              update(UNPLAYABLE_ERRORS.has(event.data) ? 'unavailable' : 'error')
            },
          },
        })
      })
      .catch(() => {
        if (!cancelled) update('error')
      })

    return () => {
      cancelled = true
      priming.current = false
      if (primeTimer !== null) window.clearTimeout(primeTimer)
      stopTimers()
      player.current?.destroy()
      player.current = null
      mount.remove()
    }
    // The player is built once per host and song; the clue length changing
    // must not tear it down, only reset the playhead (below).
  }, [host, videoId])

  // A longer clue unlocked: back to the top, ready to play.
  useEffect(() => {
    if (player.current === null || priming.current) return
    stopTimers()
    player.current.pauseVideo()
    positionRef.current = 0
    setPositionMs(0)
    if (statusRef.current !== 'unavailable' && statusRef.current !== 'loading') update('ready')
  }, [limitSeconds, stopTimers, update])

  // Never keep playing in a background tab: the clue is for this screen.
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden && (statusRef.current === 'playing' || statusRef.current === 'starting')) {
        stopTimers()
        player.current?.pauseVideo()
        update('paused')
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [stopTimers, update])

  const play = useCallback(
    (from: number, auto: boolean) => {
      const yt = player.current
      if (yt === null || videoId === null) return
      stopTimers()
      positionRef.current = from
      setPositionMs(from)
      yt.unMute()
      yt.loadVideoById({ videoId, startSeconds: offset + from / 1000, endSeconds: offset + limitMs / 1000 })
      yt.playVideo()
      update('starting')
      const startedAt = Date.now()

      // A refused autoplay sits there unstarted; a slow one is buffering.
      // Only the first needs a tap, so only it is called blocked.
      const check = () => {
        if (statusRef.current !== 'starting') return
        const waited = Date.now() - startedAt
        if (auto && yt.getPlayerState() !== YT_BUFFERING && waited >= AUTOPLAY_GRACE_MS) {
          stopTimers()
          yt.pauseVideo()
          update('blocked')
        } else if (waited >= START_TIMEOUT_MS) {
          stopTimers()
          yt.pauseVideo()
          update('error')
        } else {
          startTimer.current = window.setTimeout(check, 500)
        }
      }
      startTimer.current = window.setTimeout(check, auto ? AUTOPLAY_GRACE_MS : START_TIMEOUT_MS)

      poll.current = window.setInterval(() => {
        const heard = Math.max(0, (yt.getCurrentTime() - offset) * 1000)
        if (statusRef.current === 'starting' && heard > from) {
          if (startTimer.current !== null) window.clearTimeout(startTimer.current)
          update('playing')
        }
        if (statusRef.current !== 'playing') return
        const clamped = Math.min(heard, limitMs)
        positionRef.current = clamped
        setPositionMs(clamped)
        if (heard >= limitMs) {
          stopTimers()
          yt.pauseVideo()
          update('done')
        }
      }, POLL_MS)
    },
    [videoId, offset, limitMs, stopTimers, update],
  )
  playRef.current = play

  // A new clue for the room: everyone hears it from the top, together.
  useEffect(() => {
    if (autoplayKey === null) return
    if (player.current === null || priming.current || statusRef.current === 'loading') {
      pendingAutoplay.current = true
      return
    }
    if (statusRef.current !== 'unavailable') playRef.current(0, true)
  }, [autoplayKey])

  const toggle = useCallback(() => {
    const yt = player.current
    if (yt === null) return
    const current = statusRef.current
    if (current === 'unavailable' || current === 'loading') return

    if (current === 'playing' || current === 'starting') {
      stopTimers()
      yt.pauseVideo()
      update('paused')
      return
    }
    play(current === 'paused' && positionRef.current < limitMs ? positionRef.current : 0, false)
  }, [limitMs, play, stopTimers, update])

  return { status, positionMs, limitMs, toggle, hostRef: setHost }
}
