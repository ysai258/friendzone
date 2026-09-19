import { Worker } from 'bullmq'
import { loadConfig } from '../config.ts'
import { createLogger } from '../logger.ts'
import { createPool } from '../db/pool.ts'
import { createRedis } from '../redis/client.ts'
import { RedisKeys } from '../redis/keys.ts'
import { defineScripts } from '../redis/scripts.ts'
import { RoomStore } from '../rooms/store.ts'
import { connectionFor, createQueues, scheduleHousekeeping, QUEUE_NAMES, type ContentJob, type HousekeepingJob } from './queues.ts'

/**
 * The worker process.
 *
 * Runs separately from the game servers on purpose: image derivation is
 * CPU-bound and would otherwise block an event loop that is also holding
 * thousands of WebSockets. Scale it independently, or do not run it at all —
 * the game works without it, it just accumulates stale rows.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config).child({ process: 'worker' })
  const pool = createPool(config, logger)
  const redis = await createRedis(config, logger)
  const keys = new RedisKeys(config.REDIS_PREFIX)
  const store = new RoomStore(redis.command, defineScripts(redis.command), keys, {
    lobbyTtlSeconds: config.ROOM_LOBBY_TTL_SECONDS,
    finishedTtlSeconds: config.ROOM_FINISHED_TTL_SECONDS,
    maxRetries: 4,
  })

  const queues = createQueues(config)
  await scheduleHousekeeping(queues.housekeeping)

  const connection = connectionFor(config)
  const prefix = `${config.REDIS_PREFIX}:bull`

  const housekeeping = new Worker<HousekeepingJob>(
    QUEUE_NAMES.housekeeping,
    async (job) => {
      const startedAt = Date.now()

      // 1. Rooms whose Redis state has expired but whose codes still sit in
      //    the index. Left alone these accumulate for as long as the process
      //    runs, and the scheduler re-claims them on every tick.
      const pruned = await store.pruneActiveSet(1_000)

      // 2. Postgres rows for rooms nobody has touched in an hour. The live
      //    state is long gone; this is only closing the books.
      const { rowCount } = await pool.query(
        `UPDATE rooms
            SET closed_at = now(), status = 'CLOSED'
          WHERE closed_at IS NULL
            AND last_activity_at < now() - make_interval(mins => $1::int)`,
        [job.data.idleMinutes],
      )

      // 3. Sessions that were never finished, so a crashed game does not look
      //    like one still in progress forever.
      const { rowCount: abandoned } = await pool.query(
        `UPDATE game_sessions
            SET ended_at = now(), end_reason = 'ABANDONED'
          WHERE ended_at IS NULL
            AND started_at < now() - make_interval(mins => $1::int)`,
        [job.data.idleMinutes],
      )

      logger.info(
        { pruned, roomsClosed: rowCount, sessionsAbandoned: abandoned, ms: Date.now() - startedAt },
        'housekeeping complete',
      )
      return { pruned, roomsClosed: rowCount, sessionsAbandoned: abandoned }
    },
    { connection, prefix, concurrency: 1 },
  )

  const content = new Worker<ContentJob>(
    QUEUE_NAMES.content,
    async (job) => {
      // Imported lazily so the worker does not load sharp — tens of megabytes
      // of native code — unless there is actually an image to process.
      const { deriveImage } = await import('../../../../scripts/dataset/images.ts')
      const response = await fetch(job.data.sourceUrl)
      if (!response.ok) throw new Error(`source fetch failed: ${response.status}`)
      const derived = await deriveImage(Buffer.from(await response.arrayBuffer()))
      logger.info({ questionId: job.data.questionId, stages: derived.stages.length }, 'derived image')
      return { stages: derived.stages.length }
    },
    // One at a time: sharp is already multi-threaded internally, and a second
    // concurrent derivation mostly contends for the same cores.
    { connection, prefix, concurrency: 1 },
  )

  for (const worker of [housekeeping, content]) {
    worker.on('failed', (job, error) => {
      logger.error({ err: error, jobId: job?.id, queue: worker.name, attempts: job?.attemptsMade }, 'job failed')
    })
  }

  logger.info('worker ready')

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down')
    // close() waits for the job in flight, so a half-derived image is never
    // left behind.
    await Promise.allSettled([housekeeping.close(), content.close()])
    await queues.close()
    await redis.close()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error('worker failed to start:', error)
  process.exit(1)
})
