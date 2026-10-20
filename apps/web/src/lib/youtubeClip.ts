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
 * Only the minimal slice of the IFrame API this needs is typed here; pulling in
 * @types/youtube for five methods is not worth a dependency.
 */

interface YTPlayer {
  loadVideoById(args: { videoId: string; startSeconds: number; endSeconds: number }): void
  cueVideoById(args: { videoId: string; startSeconds: number }): void
  playVideo(): void
  pauseVideo(): void
  getCurrentTime(): number
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
/** "Not found", "embedding disabled", and its twin. Retrying will not help. */
const UNPLAYABLE_ERRORS = new Set([100, 101, 150])
const START_TIMEOUT_MS = 7_000
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

export type ClipStatus = 'loading' | 'ready' | 'starting' | 'playing' | 'paused' | 'done' | 'unavailable' | 'error'

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

export function useYouTubeClip(videoId: string | null, startOffsetMs: number, limitSeconds: number): ClipPlayer {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const player = useRef<YTPlayer | null>(null)
  const [status, setStatus] = useState<ClipStatus>('loading')
  const [positionMs, setPositionMs] = useState(0)
  const poll = useRef<number | null>(null)
  const startTimer = useRef<number | null>(null)
  const statusRef = useRef<ClipStatus>('loading')
  const positionRef = useRef(0)

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

  // One player per mounted screen; a new song re-cues it rather than rebuilding.
  useEffect(() => {
    if (host === null || videoId === null) return
    let cancelled = false
    const mount = document.createElement('div')
    host.appendChild(mount)

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return
        player.current = new YT.Player(mount, {
          height: '270',
          width: '480',
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              player.current?.setVolume(100)
              player.current?.cueVideoById({ videoId, startSeconds: offset })
              update('ready')
            },
            onStateChange: (event) => {
              if (event.data === YT_ENDED && (statusRef.current === 'playing' || statusRef.current === 'starting')) {
                stopTimers()
                positionRef.current = limitRef.current
                setPositionMs(limitRef.current)
                update('done')
              }
            },
            onError: (event) => {
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
      stopTimers()
      player.current?.destroy()
      player.current = null
      mount.remove()
    }
    // The player is built once per host and song; the clue length changing
    // must not tear it down, only reset the playhead (below).
  }, [host, videoId])

  // A longer clue unlocked, or the song changed: back to the top, ready to play.
  useEffect(() => {
    stopTimers()
    player.current?.pauseVideo()
    positionRef.current = 0
    setPositionMs(0)
    if (player.current !== null && statusRef.current !== 'unavailable') update('ready')
  }, [videoId, limitSeconds, stopTimers, update])

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

  const toggle = useCallback(() => {
    const yt = player.current
    if (yt === null || videoId === null) return
    const current = statusRef.current
    if (current === 'unavailable' || current === 'loading') return

    if (current === 'playing' || current === 'starting') {
      stopTimers()
      yt.pauseVideo()
      update('paused')
      return
    }

    const from = current === 'paused' && positionRef.current < limitMs ? positionRef.current : 0
    positionRef.current = from
    setPositionMs(from)
    yt.loadVideoById({ videoId, startSeconds: offset + from / 1000, endSeconds: offset + limitMs / 1000 })
    yt.playVideo()
    update('starting')

    startTimer.current = window.setTimeout(() => {
      if (statusRef.current === 'starting') {
        stopTimers()
        yt.pauseVideo()
        update('error')
      }
    }, START_TIMEOUT_MS)

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
  }, [videoId, offset, limitMs, stopTimers, update])

  return { status, positionMs, limitMs, toggle, hostRef: setHost }
}
