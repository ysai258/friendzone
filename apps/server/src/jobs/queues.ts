import { Queue, type ConnectionOptions } from 'bullmq'
import type { Config } from '../config.ts'

/**
 * Background work.
 *
 * Nothing about playing a game goes through a queue. Rounds advance from a
 * Redis deadline index read by every instance, actions are applied inline, and
 * state is broadcast over pub/sub — putting any of that behind a job queue
 * would add latency and a second source of truth to a path that is already
 * correct and fast.
 *
 * What is here is work that is genuinely not part of a request:
 *
 *   housekeeping   Closing out rooms in Postgres long after everyone left,
 *                  and sweeping index entries whose rooms have expired. Runs
 *                  on a schedule, takes seconds, and nobody is waiting.
 *
 *   content        Deriving the reveal ladder for a new image. Each one is
 *                  several seconds of sharp resizing — enough to stall an
 *                  event loop that is also serving ten thousand sockets.
 *
 * Both are retried on failure and are safe to run twice, which is the real
 * test of whether something belongs in a queue.
 */

// BullMQ forbids ':' in a queue name; the namespace comes from the key prefix.
export const QUEUE_NAMES = {
  housekeeping: 'housekeeping',
  content: 'content',
} as const

export interface HousekeepingJob {
  kind: 'reap-rooms'
  /** Rooms untouched for longer than this are closed out. */
  idleMinutes: number
}

export interface ContentJob {
  kind: 'derive-image'
  questionId: string
  sourceUrl: string
}

export function connectionFor(config: Config): ConnectionOptions {
  return {
    url: config.REDIS_URL,
    // BullMQ keeps its own keyspace; the prefix keeps it beside ours rather
    // than mixed into it.
    keyPrefix: undefined,
  }
}

export function createQueues(config: Config): { housekeeping: Queue<HousekeepingJob>; content: Queue<ContentJob>; close: () => Promise<void> } {
  const connection = connectionFor(config)
  const defaults = {
    connection,
    prefix: `${config.REDIS_PREFIX}:bull`,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5_000 },
      // Keep a short tail for debugging; a queue is not an audit log.
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    },
  }

  const housekeeping = new Queue<HousekeepingJob>(QUEUE_NAMES.housekeeping, defaults)
  const content = new Queue<ContentJob>(QUEUE_NAMES.content, defaults)

  return {
    housekeeping,
    content,
    close: async () => {
      await Promise.allSettled([housekeeping.close(), content.close()])
    },
  }
}

/**
 * Schedule the recurring sweep. Idempotent: BullMQ keys a repeatable job by
 * its name, so every instance calling this at boot leaves exactly one.
 */
export async function scheduleHousekeeping(queue: Queue<HousekeepingJob>): Promise<void> {
  await queue.upsertJobScheduler(
    'reap-rooms',
    { pattern: '*/5 * * * *' },
    { name: 'reap-rooms', data: { kind: 'reap-rooms', idleMinutes: 60 } },
  )
}
