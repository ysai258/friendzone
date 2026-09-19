import type { GameCatalogEntry, RoomPeekResponse, SessionResponse, WireError } from '@friendzone/shared'

/**
 * HTTP calls. Every failure arrives as an ApiError carrying the server's own
 * code, so a screen can decide what to say — "that room is full" reads very
 * differently from "something went wrong".
 */
export class ApiError extends Error {
  constructor(
    readonly code: WireError['code'],
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch {
    // The network, not the server. Worth saying so plainly.
    throw new ApiError('SERVICE_UNAVAILABLE', "Can't reach the server. Check your connection.")
  }

  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const error = (body as { error?: WireError } | null)?.error
    throw new ApiError(
      error?.code ?? 'INTERNAL',
      error?.message ?? 'Something went wrong.',
      error?.retryAfter,
    )
  }
  return body as T
}

export const api = {
  createRoom: (name: string, gameId?: string) =>
    request<SessionResponse>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify(gameId === undefined ? { name } : { name, gameId }),
    }),

  joinRoom: (code: string, name: string, token?: string) =>
    request<SessionResponse>(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify(token === undefined ? { name } : { name, token }),
    }),

  peekRoom: (code: string) => request<RoomPeekResponse>(`/api/rooms/${code}`),

  games: () => request<GameCatalogEntry[]>('/api/games'),

  time: () => request<{ serverTime: number }>('/api/time'),
}
