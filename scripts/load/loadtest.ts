import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { PROTOCOL_VERSION, type ServerMessage } from '@friendzone/shared'

/**
 * Load generator.
 *
 * Simulates whole rooms rather than bare sockets, because bare sockets measure
 * nothing interesting: the expensive path is one player acting and everyone
 * else in their room being told about it, and that only exists if the room
 * exists. Every number it prints is measured, and the report records the
 * machine it was measured on — a latency figure without its hardware is a
 * decoration.
 *
 *   npm run loadtest -- --rooms=100 --players=5
 *   npm run loadtest -- --rooms=1000 --players=5 --duration=60
 */

interface Options {
  baseUrl: string
  rooms: number
  playersPerRoom: number
  /** Seconds of steady-state traffic after everyone has joined. */
  durationSeconds: number
  /** New rooms opened per second while ramping up. */
  rampRoomsPerSecond: number
  /** Seconds between one player in a room acting. */
  actionIntervalSeconds: number
  out: string | null
}

function parseOptions(argv: string[]): Options {
  const args = new Map(
    argv.map((arg) => {
      const [key, value] = arg.replace(/^--/, '').split('=')
      return [key ?? '', value ?? 'true'] as const
    }),
  )
  const num = (key: string, fallback: number) => Number(args.get(key) ?? fallback)
  return {
    baseUrl: args.get('url') ?? 'http://localhost:8080',
    rooms: num('rooms', 50),
    playersPerRoom: num('players', 5),
    durationSeconds: num('duration', 30),
    rampRoomsPerSecond: num('ramp', 40),
    actionIntervalSeconds: num('interval', 3),
    out: args.get('out') ?? null,
  }
}

// --- measurement -----------------------------------------------------------

/** Keeps every sample. At these volumes the memory is trivial and the
 *  percentiles are exact rather than estimated. */
class Samples {
  private readonly values: number[] = []

  add(value: number): void {
    this.values.push(value)
  }

  get count(): number {
    return this.values.length
  }

  percentiles(): { p50: number; p95: number; p99: number; max: number; mean: number } | null {
    if (this.values.length === 0) return null
    const sorted = [...this.values].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number
    return {
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted.at(-1) as number,
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    }
  }
}

/** Set once teardown begins, so closing 500 sockets is not reported as 500 drops. */
let tearingDown = false
/** Which errors the server sent back, so a surprise is diagnosable. */
const errorCodes = new Map<string, number>()

const connectLatency = new Samples()
/** Action sent by one player -> state frame received by a player in that room. */
const broadcastLatency = new Samples()
const httpLatency = new Samples()

const counters = {
  roomsCreated: 0,
  roomsFailed: 0,
  joinsOk: 0,
  joinsFailed: 0,
  socketsOpened: 0,
  socketsFailed: 0,
  socketsClosedEarly: 0,
  actionsSent: 0,
  framesReceived: 0,
  protocolErrors: 0,
  rateLimited: 0,
  gamesStarted: 0,
}

// --- one simulated player --------------------------------------------------

interface VirtualPlayer {
  socket: WebSocket
  playerId: string
  room: VirtualRoom
  ready: boolean
  /**
   * When an action was sent to this player's room, cleared by the first state
   * frame that follows.
   *
   * Per player and one-shot on purpose. Holding a single room-level timestamp
   * open until the next action meant every scheduler-driven broadcast in
   * between — a reveal step unlocking, a round turning over — was recorded as
   * if it were the response to that action, which put seconds into the tail of
   * a measurement that is really tens of milliseconds.
   */
  awaitingSince: number | null
}

interface VirtualRoom {
  code: string
  players: VirtualPlayer[]
  /** Last phase seen, so the generator only acts when the game will accept it. */
  phase: string | null
  /** Rotates the actor within this room. Per room rather than global, so no
   *  single player runs out of guesses while others never take a turn. */
  turn: number
}

class RateLimitedError extends Error {
  constructor() {
    super('rate limited')
    this.name = 'RateLimitedError'
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  httpLatency.add(performance.now() - startedAt)
  // Every request here comes from one address, so the room-creation limiter
  // will refuse almost all of them against a normally configured server. That
  // is the limiter working; it is also a load test measuring nothing, so say
  // so loudly rather than print a confident graph of rejections.
  if (response.status === 429) throw new RateLimitedError()
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

function openSocket(options: Options, room: VirtualRoom, token: string, playerId: string): Promise<VirtualPlayer> {
  const wsUrl = options.baseUrl.replace(/^http/, 'ws')
  const startedAt = performance.now()

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}/ws/${room.code}`)
    const player: VirtualPlayer = { socket, playerId, room, ready: false, awaitingSince: null }

    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('socket open timed out'))
    }, 20_000)

    socket.on('open', () => {
      socket.send(JSON.stringify({ t: 'hello', token, protocolVersion: PROTOCOL_VERSION, clientTime: Date.now() }))
    })

    socket.on('message', (raw: Buffer) => {
      counters.framesReceived++
      let message: ServerMessage
      try {
        message = JSON.parse(raw.toString()) as ServerMessage
      } catch {
        counters.protocolErrors++
        return
      }

      if (message.t === 'welcome') {
        clearTimeout(timer)
        connectLatency.add(performance.now() - startedAt)
        room.phase = message.room.game?.phase ?? null
        player.ready = true
        resolve(player)
        return
      }

      if (message.t === 'state') room.phase = message.room.game?.phase ?? null

      if (message.t === 'state' && player.awaitingSince !== null) {
        // The interesting number: one player acted, and this player — possibly
        // on another server instance — has now been told.
        broadcastLatency.add(performance.now() - player.awaitingSince)
        player.awaitingSince = null
        return
      }

      if (message.t === 'error') {
        counters.protocolErrors++
        errorCodes.set(message.error.code, (errorCodes.get(message.error.code) ?? 0) + 1)
        // A refused action produces no broadcast, so nobody in the room is
        // waiting for one. Leaving these pending would attribute the next
        // scheduler transition — seconds away — to this action.
        for (const other of room.players) other.awaitingSince = null
      }
    })

    socket.on('close', () => {
      if (!player.ready) {
        clearTimeout(timer)
        reject(new Error('socket closed before welcome'))
      } else if (!tearingDown) {
        // Only a close we did not ask for counts as a drop.
        counters.socketsClosedEarly++
      }
    })

    socket.on('error', (error: Error) => {
      clearTimeout(timer)
      if (!player.ready) reject(error)
    })
  })
}

async function buildRoom(options: Options, index: number): Promise<VirtualRoom | null> {
  const room: VirtualRoom = { code: '', players: [], phase: null, turn: 0 }

  try {
    const host = await postJson<{ roomCode: string; token: string; playerId: string }>(`${options.baseUrl}/api/rooms`, {
      name: `Host ${index}`,
    })
    room.code = host.roomCode
    counters.roomsCreated++
    room.players.push(await openSocket(options, room, host.token, host.playerId))
    counters.socketsOpened++
  } catch (error) {
    counters.roomsFailed++
    if (error instanceof RateLimitedError) counters.rateLimited++
    return null
  }

  for (let i = 1; i < options.playersPerRoom; i++) {
    try {
      const guest = await postJson<{ token: string; playerId: string }>(
        `${options.baseUrl}/api/rooms/${room.code}/join`,
        { name: `P${index}-${i}` },
      )
      counters.joinsOk++
      room.players.push(await openSocket(options, room, guest.token, guest.playerId))
      counters.socketsOpened++
    } catch {
      counters.joinsFailed++
      counters.socketsFailed++
    }
  }

  // Start a game so the load is the real hot path — action validation, a state
  // mutation under compare-and-set, and a fan-out to everyone in the room —
  // rather than a lobby setting nobody but the host may change.
  const host = room.players[0]
  if (host !== undefined && host.socket.readyState === WebSocket.OPEN) {
    host.socket.send(
      JSON.stringify({
        t: 'action',
        actionId: randomUUID(),
        type: 'room/update-config',
        // Long rounds and many of them, so a run of any length stays inside
        // one game instead of measuring the lobby between games.
        payload: { gameId: 'emoji-movie', settings: { questions: 15, seconds: 90 } },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 120))
    host.socket.send(JSON.stringify({ t: 'action', actionId: randomUUID(), type: 'room/start-game', payload: {} }))
    counters.gamesStarted++
  }

  return room
}

// --- server-side observation ----------------------------------------------

/** Scrape the server's own metrics, so the report says what the server saw as
 *  well as what the client did. */
async function scrape(options: Options): Promise<Record<string, number>> {
  try {
    const response = await fetch(`${options.baseUrl}/metrics`)
    const text = await response.text()
    const wanted = [
      'friendzone_rooms_active',
      'friendzone_players_connected',
      'friendzone_cas_retries_total',
      'friendzone_scheduler_errors_total',
      'friendzone_rooms_advanced_total',
      // The default Node metrics carry the same prefix as the app's own.
      'friendzone_process_resident_memory_bytes',
      'friendzone_process_cpu_seconds_total',
      'friendzone_nodejs_eventloop_lag_p99_seconds',
    ]
    const out: Record<string, number> = {}
    for (const line of text.split('\n')) {
      if (line.startsWith('#')) continue
      const [name, value] = line.split(' ')
      if (name === undefined || value === undefined) continue
      const bare = name.split('{')[0] ?? name
      if (wanted.includes(bare)) out[bare] = (out[bare] ?? 0) + Number(value)
    }
    return out
  } catch {
    return {}
  }
}

// --- run -------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))

  console.log('\nFriendZone load test')
  console.log(`  target      ${options.baseUrl}`)
  console.log(`  rooms       ${options.rooms}`)
  console.log(`  players     ${options.playersPerRoom} per room (${options.rooms * options.playersPerRoom} total)`)
  console.log(`  duration    ${options.durationSeconds}s of steady traffic\n`)

  const before = await scrape(options)
  const startedAt = performance.now()

  // --- ramp ---------------------------------------------------------------
  const rooms: VirtualRoom[] = []
  const batchSize = Math.max(1, Math.round(options.rampRoomsPerSecond))
  for (let i = 0; i < options.rooms; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, options.rooms - i) }, (_, k) => buildRoom(options, i + k))
    const built = await Promise.all(batch)
    for (const room of built) if (room !== null) rooms.push(room)
    process.stdout.write(`\r  ramping ${rooms.length}/${options.rooms} rooms`)
    // Pace the ramp so the measurement is of a running system rather than of a
    // thundering herd, which is a different (and less useful) question.
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const rampSeconds = (performance.now() - startedAt) / 1000
  console.log(`\n  ramped in ${rampSeconds.toFixed(1)}s\n`)

  const peak = await scrape(options)

  // --- steady state -------------------------------------------------------
  // Let every room settle into a live round before measuring anything.
  await new Promise((resolve) => setTimeout(resolve, 4_000))

  /**
   * Each room acts on its own timer, at a random offset inside the interval.
   *
   * The first version of this loop walked every room and then slept, which
   * fired every room's action in the same millisecond. The resulting latency
   * was almost entirely the generator's own queue: with a thousand rooms, the
   * last action of a burst was answered several hundred milliseconds after the
   * first, and the profile of the server under that load was 79% idle. Real
   * players are not synchronised, and a load test that synchronises them
   * measures the harness rather than the system.
   */
  const stopAt = Date.now() + options.durationSeconds * 1000
  let skippedRooms = 0
  const intervalMs = options.actionIntervalSeconds * 1000

  const timers = rooms.map((room, index) =>
    setTimeout(
      function fire() {
        if (Date.now() >= stopAt) return
        const timer = setTimeout(fire, intervalMs)
        timer.unref()

        if (room.phase !== 'QUESTION') {
          skippedRooms++
          return
        }
        const actor = room.players[room.turn++ % room.players.length]
        if (actor === undefined || actor.socket.readyState !== WebSocket.OPEN) return

        const sentAt = performance.now()
        for (const player of room.players) {
          if (player.socket.readyState === WebSocket.OPEN) player.awaitingSince = sentAt
        }
        // A wrong guess: accepted by the game, scores nothing, and costs the
        // server exactly what a real one does.
        actor.socket.send(
          JSON.stringify({
            t: 'action',
            actionId: randomUUID(),
            type: 'emoji/guess',
            payload: { guess: `guess ${room.turn} ${actor.playerId.slice(0, 6)}` },
          }),
        )
        counters.actionsSent++
      },
      // Spread the first action of each room evenly, then let each run free.
      Math.round((index / Math.max(1, rooms.length)) * intervalMs) + Math.random() * 50,
    ),
  )

  while (Date.now() < stopAt) {
    process.stdout.write(`\r  steady ${Math.max(0, Math.round((stopAt - Date.now()) / 1000))}s left`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  for (const timer of timers) clearTimeout(timer)

  const after = await scrape(options)
  console.log('\n')

  // --- teardown -----------------------------------------------------------
  tearingDown = true
  for (const room of rooms) for (const player of room.players) player.socket.close()
  await new Promise((resolve) => setTimeout(resolve, 1_000))

  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: (await import('node:os')).cpus().length,
      totalMemoryGb: Math.round(((await import('node:os')).totalmem() / 1024 ** 3) * 10) / 10,
      note: 'Generator and server share this machine, so these are lower bounds, not capacity figures.',
    },
    options,
    counters,
    errorCodes: Object.fromEntries(errorCodes),
    rampSeconds: Number(rampSeconds.toFixed(1)),
    skippedRoomTicks: skippedRooms,
    latencyDefinition:
      'actionToBroadcast is measured per player: the interval between one player in the room sending an action and each player in that room receiving the resulting state frame.',
    latencyMs: {
      httpJoin: httpLatency.percentiles(),
      socketConnect: connectLatency.percentiles(),
      actionToBroadcast: broadcastLatency.percentiles(),
    },
    server: { before, peak, after },
  }

  print(report)

  const outPath = options.out ?? join(new URL('../../', import.meta.url).pathname, 'load-results', `run-${Date.now()}.json`)
  await mkdir(join(outPath, '..'), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`  written ${outPath}\n`)
}

function print(report: {
  counters: typeof counters
  errorCodes: Record<string, number>
  latencyMs: Record<string, ReturnType<Samples['percentiles']>>
  server: { before: Record<string, number>; peak: Record<string, number>; after: Record<string, number> }
}): void {
  const line = '-'.repeat(64)
  console.log(line)

  const attempted = report.counters.socketsOpened + report.counters.socketsFailed
  const successRate = attempted === 0 ? 0 : (report.counters.socketsOpened / attempted) * 100

  console.log(`  sockets opened        ${report.counters.socketsOpened} (${successRate.toFixed(2)}% of attempts)`)
  console.log(`  sockets failed        ${report.counters.socketsFailed}`)
  console.log(`  dropped mid-run       ${report.counters.socketsClosedEarly}`)
  console.log(`  rooms created         ${report.counters.roomsCreated} (${report.counters.roomsFailed} failed)`)
  console.log(`  actions sent          ${report.counters.actionsSent}`)
  console.log(`  frames received       ${report.counters.framesReceived}`)
  console.log(`  protocol errors       ${report.counters.protocolErrors}`)
  console.log(`  games started         ${report.counters.gamesStarted}`)
  if (Object.keys(report.errorCodes).length > 0) {
    console.log(`  error codes           ${Object.entries(report.errorCodes).map(([c, n]) => `${c}×${n}`).join(', ')}`)
  }
  console.log(line)

  if (report.counters.rateLimited > 0) {
    console.log('')
    console.log(`  ${report.counters.rateLimited} room creations were rate limited.`)
    console.log('  These numbers are not a capacity measurement. Restart the server with a')
    console.log('  limit that suits a load test, then run again:')
    console.log('')
    console.log('    RL_ROOM_CREATE=100000:1000 RL_ROOM_JOIN=100000:1000 npm run dev:server')
    console.log('')
    console.log(line)
  }

  for (const [name, stats] of Object.entries(report.latencyMs)) {
    if (stats === null) continue
    console.log(
      `  ${name.padEnd(20)} p50 ${stats.p50.toFixed(1)}ms  p95 ${stats.p95.toFixed(1)}ms  p99 ${stats.p99.toFixed(1)}ms  max ${stats.max.toFixed(1)}ms`,
    )
  }
  console.log(line)

  const cpuUsed = (report.server.after['friendzone_process_cpu_seconds_total'] ?? 0) - (report.server.before['friendzone_process_cpu_seconds_total'] ?? 0)
  console.log(`  server rooms active   ${report.server.peak['friendzone_rooms_active'] ?? '?'}`)
  console.log(`  server sockets        ${report.server.peak['friendzone_players_connected'] ?? '?'}`)
  console.log(`  server rss            ${formatBytes(report.server.peak['friendzone_process_resident_memory_bytes'] ?? 0)}`)
  console.log(`  server cpu seconds    ${cpuUsed.toFixed(1)}`)
  console.log(`  event loop lag p99    ${((report.server.after['friendzone_nodejs_eventloop_lag_p99_seconds'] ?? 0) * 1000).toFixed(1)}ms`)
  // Scraped before teardown, so this excludes the burst of conflicts caused
  // by every socket in every room closing at once. Compare the counter
  // yourself across the whole run if that burst is what you are measuring.
  console.log(`  cas retries (to here) ${report.server.after['friendzone_cas_retries_total'] ?? 0}`)
  console.log(`${line}\n`)
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
