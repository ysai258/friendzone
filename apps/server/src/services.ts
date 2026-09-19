import type { GameRegistry } from '@friendzone/game-engine'
import type { Pool } from 'pg'
import type { Config } from './config.ts'
import type { Logger } from './logger.ts'
import type { Metrics } from './metrics.ts'
import type { RedisClients } from './redis/client.ts'
import type { RedisKeys } from './redis/keys.ts'
import type { RateLimiter } from './redis/ratelimit.ts'
import type { ContentProvider } from './content/provider.ts'
import type { RoomArchive } from './db/archive.ts'
import type { RoomService } from './rooms/service.ts'
import type { RoomStore } from './rooms/store.ts'
import type { SessionSigner } from './rooms/session.ts'
import type { Scheduler } from './rooms/scheduler.ts'
import type { Gateway } from './ws/gateway.ts'

/**
 * Everything wired together, passed explicitly rather than reached for through
 * a module-level singleton. It is what lets an integration test stand up a
 * complete server against a throwaway Redis prefix in a few lines.
 */
export interface AppServices {
  config: Config
  logger: Logger
  metrics: Metrics
  version: string

  pool: Pool
  redis: RedisClients
  keys: RedisKeys

  registry: GameRegistry
  content: ContentProvider
  archive: RoomArchive
  store: RoomStore
  signer: SessionSigner
  limiter: RateLimiter
  service: RoomService
  scheduler: Scheduler

  /** Lazily resolved: the gateway needs the service, which is built first. */
  gateway: () => Gateway
  shuttingDown: boolean
}
