import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION, type PublicEvent, type PublicRoomView, type ServerMessage, type WireError } from '@friendzone/shared'

/**
 * A test player.
 *
 * Deliberately close to what the browser does: HTTP to get a seat, then a
 * socket with the token in the first frame, then actions with client-generated
 * ids. Assertions are written against what a real client would actually see.
 */
export class TestClient {
  private socket: WebSocket | null = null
  private readonly messages: ServerMessage[] = []
  private readonly waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = []

  room: PublicRoomView | null = null
  /**
   * Every room snapshot this client has been sent, in order.
   *
   * A live game does not pause while a test makes assertions, so anything
   * phase-specific is asserted over this record rather than by trying to catch
   * the phase as it goes past.
   */
  readonly snapshots: PublicRoomView[] = []
  playerId = ''
  token = ''
  readonly events: PublicEvent[] = []
  readonly errors: WireError[] = []
  closed = false
  byeReason: string | null = null

  constructor(
    readonly name: string,
    readonly httpUrl: string,
    private readonly wsUrl: string,
  ) {}

  // --- HTTP ---------------------------------------------------------------

  static async createRoom(httpUrl: string, wsUrl: string, name: string, gameId?: string): Promise<TestClient> {
    const client = new TestClient(name, httpUrl, wsUrl)
    const body: Record<string, unknown> = { name }
    if (gameId !== undefined) body['gameId'] = gameId
    const response = await fetch(`${httpUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await response.json()) as { roomCode: string; playerId: string; token: string; error?: WireError }
    if (!response.ok) throw new Error(`create failed: ${JSON.stringify(json)}`)
    client.playerId = json.playerId
    client.token = json.token
    client.roomCode = json.roomCode
    return client
  }

  static async join(httpUrl: string, wsUrl: string, roomCode: string, name: string, token?: string): Promise<TestClient> {
    const client = new TestClient(name, httpUrl, wsUrl)
    const response = await fetch(`${httpUrl}/api/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(token === undefined ? { name } : { name, token }),
    })
    const json = (await response.json()) as { playerId: string; token: string; error?: WireError }
    if (!response.ok) throw new Error(`join failed: ${JSON.stringify(json)}`)
    client.playerId = json.playerId
    client.token = json.token
    client.roomCode = roomCode
    return client
  }

  roomCode = ''

  // --- WebSocket -----------------------------------------------------------

  async connect(): Promise<void> {
    const socket = new WebSocket(`${this.wsUrl}/ws/${this.roomCode}`)
    this.socket = socket
    this.closed = false

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: socket did not open`)), 5_000)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    socket.on('message', (raw: Buffer) => this.receive(JSON.parse(raw.toString()) as ServerMessage))
    socket.on('close', () => {
      this.closed = true
    })

    socket.send(JSON.stringify({ t: 'hello', token: this.token, protocolVersion: PROTOCOL_VERSION, clientTime: Date.now() }))
    // A rejected hello is a legitimate outcome, not a hang.
    await this.waitFor((m) => m.t === 'welcome' || m.t === 'bye' || m.t === 'error')
  }

  private receive(message: ServerMessage): void {
    this.messages.push(message)
    if (message.t === 'welcome') {
      this.room = message.room
      this.snapshots.push(message.room)
    }
    if (message.t === 'state') {
      this.room = message.room
      this.snapshots.push(message.room)
      this.events.push(...message.events)
    }
    if (message.t === 'error') this.errors.push(message.error)
    if (message.t === 'bye') this.byeReason = message.reason

    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!
      if (safeMatch(waiter.predicate, message)) {
        clearTimeout(waiter.timer)
        this.waiters.splice(i, 1)
        waiter.resolve(message)
      }
    }
  }

  /** Resolve as soon as a matching frame arrives, or when one already has. */
  waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    const already = this.messages.find((m) => safeMatch(predicate, m))
    if (already !== undefined) return Promise.resolve(already)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`${this.name}: timed out waiting for a frame`))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  /**
   * Wait until the room reaches a condition.
   *
   * Checks the *current* room and then only future frames. Scanning the whole
   * history instead would let "wait for the lobby after Play Again" match the
   * lobby from before the game started, which is how this helper first lied to
   * us: every assertion after it was reading a snapshot from minutes earlier.
   */
  async waitForRoom(predicate: (room: PublicRoomView) => boolean, timeoutMs = 10_000): Promise<PublicRoomView> {
    if (this.room !== null && safeMatch(predicate, this.room)) return this.room

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`${this.name}: timed out waiting for a room condition (last status ${this.room?.status ?? 'none'}, phase ${this.room?.game?.phase ?? 'none'})`))
      }, timeoutMs)

      this.waiters.push({
        predicate: (m) => (m.t === 'state' || m.t === 'welcome') && safeMatch(predicate, m.room),
        resolve: (m) => resolve((m as { room: PublicRoomView }).room),
        reject,
        timer,
      })
    })
  }

  /** The game-specific slice of the current view, safe to read through. */
  viewOf<T extends Record<string, unknown>>(room: PublicRoomView | null = this.room): Partial<T> {
    return (room?.game?.view ?? {}) as Partial<T>
  }

  waitForPhase(phase: string, timeoutMs = 20_000): Promise<PublicRoomView> {
    return this.waitForRoom((room) => room.game?.phase === phase, timeoutMs)
  }

  /** Send an action. Returns the id so a test can replay the exact same one. */
  send(type: string, payload: Record<string, unknown> = {}, actionId: string = randomUUID()): string {
    this.socket?.send(JSON.stringify({ t: 'action', actionId, type, payload }))
    return actionId
  }

  sendRaw(data: unknown): void {
    this.socket?.send(typeof data === 'string' ? data : JSON.stringify(data))
  }

  /** Drop the socket the way a lost network does: no close frame. */
  kill(): void {
    this.socket?.terminate()
    this.closed = true
  }

  async close(): Promise<void> {
    if (this.socket === null) return
    for (const waiter of this.waiters) clearTimeout(waiter.timer)
    this.waiters.length = 0
    const socket = this.socket
    this.socket = null
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.close()
        setTimeout(resolve, 500)
      })
    }
  }

  get view(): Record<string, unknown> {
    return (this.room?.game?.view ?? {})
  }

  /** Snapshots this client saw in a given game phase. */
  snapshotsIn(phase: string): PublicRoomView[] {
    return this.snapshots.filter((s) => s.game?.phase === phase)
  }

  /** Distinct values a game-view field took across the whole session. */
  valuesOf(key: string): unknown[] {
    const seen: unknown[] = []
    for (const snapshot of this.snapshots) {
      const value = (snapshot.game?.view)?.[key]
      if (value === undefined) continue
      if (seen.at(-1) !== value) seen.push(value)
    }
    return seen
  }

  get me() {
    return this.room?.players.find((p) => p.id === this.playerId)
  }

  get lastError(): WireError | undefined {
    return this.errors.at(-1)
  }

  /** Everything this client has been sent, as one string. For leak assertions. */
  get transcript(): string {
    return JSON.stringify(this.messages)
  }
}

/** Run a predicate, treating a throw as a non-match. */
function safeMatch<T>(predicate: (value: T) => boolean, value: T): boolean {
  try {
    return predicate(value)
  } catch {
    return false
  }
}

export async function closeAll(...clients: TestClient[]): Promise<void> {
  await Promise.all(clients.map((c) => c.close()))
}
