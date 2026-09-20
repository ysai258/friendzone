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
  // Hosts that inject their own public URL (Render sets RENDER_EXTERNAL_URL)
  // save an operator from setting this by hand and getting it wrong.
  PUBLIC_WEB_ORIGIN: z.url().optional(),
  RENDER_EXTERNAL_URL: z.url().optional(),

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

  /**
   * Serve the built web app from this server.
   *
   * Set to the web app's dist directory to run the whole product as one
   * container on one origin — which removes the reverse proxy, and with it
   * CORS and cross-origin WebSocket concerns, from a small deployment. Leave
   * unset to serve the API alone behind a CDN.
   */
  WEB_DIST: z.string().default(''),

  /** Where the seed data lives, when this image carries it. */
  DATA_DIR: z.string().default(''),

  /**
   * Reconcile the game content library with this image's data files at boot.
   * Off by default, because a real deployment seeds deliberately; on, a
   * single-service host needs no second command to become playable, and a
   * redeploy is how new content reaches it.
   */
  SEED_ON_BOOT: z
    .string()
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
})

export type Config = Omit<z.infer<typeof schema>, 'PUBLIC_WEB_ORIGIN'> & {
  PUBLIC_WEB_ORIGIN: string
  isProduction: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`)
  }

  const config = {
    ...parsed.data,
    // Whatever the host says it is, then whatever was configured, then dev.
    PUBLIC_WEB_ORIGIN:
      parsed.data.PUBLIC_WEB_ORIGIN ?? parsed.data.RENDER_EXTERNAL_URL ?? 'http://localhost:5174',
    isProduction: parsed.data.NODE_ENV === 'production',
  }

  // A real deployment must not fall back to the example secret.
  if (config.isProduction && config.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('SESSION_SECRET is still the development placeholder. Generate a real one.')
  }

  // An allow-list is only meaningful when the web app is served from somewhere
  // else. When this process serves it too, every request is same-origin and an
  // empty list is the stricter setting — demanding one would only invite an
  // operator to paste a wrong value, or a wildcard.
  if (config.isProduction && config.CORS_ORIGINS.length === 0 && config.WEB_DIST.length === 0) {
    throw new Error('CORS_ORIGINS must list the site origin when the web app is served separately.')
  }

  return config
}
