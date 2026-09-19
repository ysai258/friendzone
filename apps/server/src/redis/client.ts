import { Redis } from 'ioredis'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'

/**
 * Two connections, because a Redis client in subscriber mode cannot issue
 * ordinary commands. Everything else shares the command connection.
 *
 * Both are configured to keep retrying rather than throw: a Redis blip should
 * degrade the room (no cross-instance fan-out, no new state writes) and recover
 * on its own, not tear down every socket on the box. What actually degrades is
 * documented in docs/redis.md.
 */
export interface RedisClients {
  command: Redis
  subscriber: Redis
  close(): Promise<void>
}

function build(url: string, logger: Logger, role: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    reconnectOnError: (error) => {
      // A failover promotes a replica; reconnecting is the correct response.
      if (error.message.includes('READONLY')) return true
      return false
    },
  })

  client.on('error', (error: Error) => logger.warn({ err: error, role }, 'redis error'))
  client.on('reconnecting', () => logger.warn({ role }, 'redis reconnecting'))
  client.on('ready', () => logger.info({ role }, 'redis ready'))
  return client
}

export async function createRedis(config: Config, logger: Logger): Promise<RedisClients> {
  const command = build(config.REDIS_URL, logger, 'command')
  const subscriber = build(config.REDIS_URL, logger, 'subscriber')
  await Promise.all([command.connect(), subscriber.connect()])

  return {
    command,
    subscriber,
    async close() {
      await Promise.allSettled([command.quit(), subscriber.quit()])
    },
  }
}
