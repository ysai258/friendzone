import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { pino } from 'pino'
import { buildApp } from '@friendzone/server/app.ts'
import { loadConfig } from '@friendzone/server/config.ts'
import type { AppServices } from '@friendzone/server/services.ts'

/**
 * Stand up a real server for a test: real Fastify, real Redis, real Postgres,
 * real WebSockets. Nothing is stubbed, because the behaviour under test —
 * compare-and-set retries, cross-instance fan-out, scheduler leases — only
 * exists when those pieces are real.
 *
 * Isolation comes from a per-instance Redis key prefix rather than from a
 * separate server, which also makes it cheap to run two instances at once and
 * check that a player on one sees a player on the other.
 */
export interface TestServer {
  services: AppServices
  port: number
  httpUrl: string
  wsUrl: string
  close: () => Promise<void>
}

export interface TestServerOptions {
  /** Share a prefix between two servers to make them one logical cluster. */
  redisPrefix?: string
  graceSeconds?: number
  schedulerTickMs?: number
  env?: Record<string, string>
}

/**
 * How many live servers share each prefix. Two instances of one logical
 * cluster share their Redis keyspace, so the keys must only be swept once the
 * last of them has gone — otherwise shutting down one instance deletes the room
 * the other is still serving.
 */
const prefixUsers = new Map<string, number>()

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const prefix = options.redisPrefix ?? `fztest:${randomUUID().slice(0, 8)}`
  prefixUsers.set(prefix, (prefixUsers.get(prefix) ?? 0) + 1)

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env['TEST_LOG'] ?? 'silent',
    PORT: '0',
    HOST: '127.0.0.1',
    REDIS_PREFIX: prefix,
    SESSION_SECRET: process.env['SESSION_SECRET'] ?? 'test-secret-that-is-long-enough-000',
    PLAYER_GRACE_SECONDS: String(options.graceSeconds ?? 45),
    SCHEDULER_TICK_MS: String(options.schedulerTickMs ?? 100),
    CORS_ORIGINS: 'http://localhost:5173',
    ...options.env,
  })

  const logger = pino({ level: config.LOG_LEVEL })
  const { app, services, shutdown } = await buildApp({ config, logger })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address() as AddressInfo
  const port = address.port

  return {
    services,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await shutdown()
      const remaining = (prefixUsers.get(prefix) ?? 1) - 1
      prefixUsers.set(prefix, remaining)
      // Leave no keys behind for the next file, but only once nobody else is
      // still using this keyspace.
      if (remaining <= 0) {
        prefixUsers.delete(prefix)
        await cleanupPrefix(config.REDIS_URL, prefix).catch(() => undefined)
      }
    },
  }
}

async function cleanupPrefix(redisUrl: string, prefix: string): Promise<void> {
  const { Redis } = await import('ioredis')
  const redis = new Redis(redisUrl)
  try {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500)
      cursor = next
      if (keys.length > 0) await redis.del(...keys)
    } while (cursor !== '0')
  } finally {
    await redis.quit()
  }
}
