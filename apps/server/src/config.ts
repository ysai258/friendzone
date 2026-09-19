import { z } from 'zod'

/**
 * Configuration is parsed once, at boot, and the process refuses to start if it
 * is wrong. Nothing downstream reads process.env, so a missing variable is a
 * startup failure with a readable message rather than an undefined that
 * surfaces an hour later inside a WebSocket handler.
 */

/**
 * "capacity:refillPerSecond", e.g. "20:0.5" — 20 requests of burst, one token
 * back every two seconds. The fallback is applied to the raw string so the
 * documented default travels through exactly the same parser as a real value.
 */
const rateLimit = (fallback: string) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/, 'expected "capacity:refillPerSecond"')
    .default(fallback)
    .transform((value) => {
      const [capacity, refillPerSecond] = value.split(':')
      return { capacity: Number(capacity), refillPerSecond: Number(refillPerSecond) }
    })

const csvSchema = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((s) => s.trim()).filter((s) => s.length > 0))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // 0 asks the OS for any free port, which is how the integration tests run
  // several servers at once without coordinating.
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: csvSchema,
  PUBLIC_WEB_ORIGIN: z.url().default('http://localhost:5173'),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(86_400),

  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/).default('fz'),

  PLAYER_GRACE_SECONDS: z.coerce.number().int().min(1).max(600).default(45),
  ROOM_LOBBY_TTL_SECONDS: z.coerce.number().int().min(60).default(1_800),
  ROOM_FINISHED_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(50).max(5_000).default(250),

  RL_ROOM_CREATE: rateLimit('5:0.1'),
  RL_ROOM_JOIN: rateLimit('20:0.5'),
  RL_WS_ACTION: rateLimit('30:10'),

  ADMIN_TOKEN: z.string().default(''),
})

export type Config = z.infer<typeof schema> & { isProduction: boolean }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`)
  }

  const config = { ...parsed.data, isProduction: parsed.data.NODE_ENV === 'production' }

  // A real deployment must not fall back to the example secret.
  if (config.isProduction && config.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('SESSION_SECRET is still the development placeholder. Generate a real one.')
  }
  if (config.isProduction && config.CORS_ORIGINS.length === 0) {
    throw new Error('CORS_ORIGINS must list the site origin in production.')
  }

  return config
}
