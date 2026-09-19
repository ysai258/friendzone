import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import { AppError, isValidRoomCode, normalizeRoomCode, parseClientJson } from '@friendzone/shared'
import { gameRegistry } from '@friendzone/game-engine'
import { loadConfig, type Config } from './config.ts'
import { createLogger, type Logger } from './logger.ts'
import { createMetrics } from './metrics.ts'
import { createPool, type Pool } from './db/pool.ts'
import { runMigrations } from './db/migrate.ts'
import { RoomArchive } from './db/archive.ts'
import { createRedis } from './redis/client.ts'
import { RedisKeys } from './redis/keys.ts'
import { defineScripts } from './redis/scripts.ts'
import { RateLimiter } from './redis/ratelimit.ts'
import { ContentProvider } from './content/provider.ts'
import { RoomStore } from './rooms/store.ts'
import { RoomService } from './rooms/service.ts'
import { SessionSigner } from './rooms/session.ts'
import { Scheduler } from './rooms/scheduler.ts'
import { Gateway } from './ws/gateway.ts'
import { registerErrorHandler } from './errors.ts'
import { registerRoomRoutes } from './routes/rooms.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { registerAdminRoutes } from './routes/admin.ts'
import { contentCounts, seedContent } from './content/seed.ts'
import { resolveDataDir } from './content/data-dir.ts'
import type { AppServices } from './services.ts'

export const VERSION = '1.0.0'

export interface BuiltApp {
  app: FastifyInstance
  services: AppServices
  shutdown: () => Promise<void>
}

export interface BuildOptions {
  config?: Config
  logger?: Logger
  /** Tests skip this; a running server always migrates on boot. */
  migrate?: boolean
}

/**
 * Build a fully wired server without listening on a port. The entry point and
 * the integration tests share this, so what the tests exercise is the real
 * assembly rather than a lookalike.
 */
export async function buildApp(options: BuildOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig()
  const logger = options.logger ?? createLogger(config)
  const metrics = createMetrics()

  const pool = createPool(config, logger)
  if (options.migrate !== false) await runMigrations(pool, logger)

  if (config.SEED_ON_BOOT) await seedIfEmpty(pool, config, logger)

  const redis = await createRedis(config, logger)
  const scripts = defineScripts(redis.command)
  const keys = new RedisKeys(config.REDIS_PREFIX)

  const archive = new RoomArchive(pool, logger)
  const content = new ContentProvider(pool, logger)
  const limiter = new RateLimiter(scripts, keys, metrics)
  const store = new RoomStore(
    redis.command,
    scripts,
    keys,
    {
      lobbyTtlSeconds: config.ROOM_LOBBY_TTL_SECONDS,
      finishedTtlSeconds: config.ROOM_FINISHED_TTL_SECONDS,
      maxRetries: 8,
    },
    () => metrics.casRetries.inc(),
  )
  const signer = new SessionSigner(config.SESSION_SECRET, config.SESSION_TTL_SECONDS)

  const service = new RoomService({ store, registry: gameRegistry, content, archive, config, logger })
  const scheduler = new Scheduler(service, store, logger, metrics, config.SCHEDULER_TICK_MS)

  let gateway: Gateway | null = null

  const services: AppServices = {
    config,
    logger,
    metrics,
    version: VERSION,
    pool,
    redis,
    keys,
    registry: gameRegistry,
    content,
    archive,
    store,
    signer,
    limiter,
    service,
    scheduler,
    gateway: () => {
      if (gateway === null) throw new Error('gateway not initialised')
      return gateway
    },
    shuttingDown: false,
  }

  // Handed over as the base logger type on purpose: passing pino's own type
  // would parameterise every FastifyInstance in the app with it, and each
  // route module would then have to name that exact instantiation.
  const baseLogger: FastifyBaseLogger = logger

  const app = Fastify({
    loggerInstance: baseLogger,
    // Fastify's own per-request lines would double every log this app already
    // writes with richer correlation fields. Configured through logController
    // rather than the deprecated top-level flag.
    logController: new LogController({ disableRequestLogging: true }),
    // Set explicitly: behind a proxy this decides what request.ip means, and
    // request.ip is the rate limiter's subject.
    trustProxy: config.isProduction,
    bodyLimit: 16 * 1024,
    requestIdHeader: 'x-request-id',
  })

  // Whether this process will also serve the web app decides the whole content
  // security policy, so it is settled before helmet rather than after.
  const webRoot = config.WEB_DIST.length === 0 ? null : resolve(config.WEB_DIST)
  const willServeWeb = webRoot !== null && existsSync(join(webRoot, 'index.html'))

  await app.register(helmet, {
    contentSecurityPolicy: {
      // Serving only JSON and a socket upgrade: nothing may load, nothing may
      // frame it. Serving the app too: it needs to load its own bundle, talk to
      // its own origin over HTTP and WebSocket, and show its own images. Both
      // policies deny everything else, including any third-party script.
      directives: willServeWeb
        ? {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            // Tailwind ships a stylesheet, but the app also sets inline styles
            // for timer widths, which cannot be hashed ahead of time.
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            // Same origin over both schemes: the socket is same-origin by
            // construction in this deployment shape.
            connectSrc: ["'self'", 'ws:', 'wss:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            // Helmet adds upgrade-insecure-requests by default, which rewrites
            // this app's own asset URLs to https. Behind TLS that is redundant
            // — every URL here is relative, so it is already https — and over
            // plain http it is fatal: the browser upgrades the bundle request
            // and gets ERR_SSL_PROTOCOL_ERROR against a server with no TLS.
            // That breaks sharing over a LAN address or a plain-http host.
            upgradeInsecureRequests: null,
          }
        : { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })

  await app.register(cors, {
    origin: config.CORS_ORIGINS.length === 0 ? true : config.CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: false,
    maxAge: 600,
  })

  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
      // Rooms are small and updates are frequent; compression would cost CPU
      // per broadcast for payloads that are already a few kilobytes.
      perMessageDeflate: false,
    },
  })

  // The same prototype-key guard the WebSocket path uses. Fastify's built-in
  // JSON parser would happily hand a body carrying __proto__ to a schema, and
  // the first copy of that object silently becomes a prototype assignment.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseClientJson(body as string))
    } catch {
      done(new AppError('VALIDATION_FAILED', 'The request body could not be read.'), undefined)
    }
  })

  // Static files are registered before the error handler, because whether an
  // unmatched GET is a 404 or the app shell depends on whether we serve one.
  // willServeWeb already implies a non-null root; TypeScript cannot see that
  // through the boolean, so the root is re-read here rather than asserted.
  if (webRoot !== null) {
    if (willServeWeb) await registerWebApp(app, webRoot, logger)
    else logger.warn({ webRoot }, 'WEB_DIST holds no index.html; serving the API only')
  }
  registerErrorHandler(app, logger, { spaFallback: willServeWeb })

  gateway = new Gateway({
    service,
    store,
    signer,
    redis: redis.command,
    subscriber: redis.subscriber,
    keys,
    limiter,
    config,
    logger,
    metrics,
  })
  gateway.start()

  registerRoomRoutes(app, services)
  registerHealthRoutes(app, services)
  registerAdminRoutes(app, services)

  app.get('/metrics', async (_request, reply) => {
    // Keep the gauges honest at scrape time rather than on every mutation.
    metrics.roomsActive.set(await store.activeRoomCount().catch(() => 0))
    metrics.playersConnected.set(services.gateway().connectionCount)
    return reply.header('content-type', metrics.registry.contentType).send(await metrics.registry.metrics())
  })

  /**
   * The only WebSocket route. The room code is in the path so a connection can
   * be attributed before authentication; the session token arrives in the
   * first frame rather than the query string, which keeps it out of access
   * logs and browser history.
   */
  app.get('/ws/:code', { websocket: true }, (socket, request) => {
    const raw = (request.params as { code?: string }).code ?? ''
    const code = normalizeRoomCode(raw)
    if (!isValidRoomCode(code)) {
      socket.close(4404, 'invalid room code')
      return
    }
    services.gateway().handleConnection(socket, code)
  })

  scheduler.start()

  const shutdown = async (): Promise<void> => {
    services.shuttingDown = true
    await gracefulShutdown(app, services, logger)
  }

  return { app, services, shutdown }
}

/**
 * Serve the built web app from this process.
 *
 * Optional, and off unless WEB_DIST points somewhere. With it, the whole
 * product is one container on one origin: no reverse proxy to configure, no
 * CORS, and a WebSocket that is same-origin by construction. Without it, this
 * is an API and the web app is static files behind a CDN.
 */
async function registerWebApp(app: FastifyInstance, root: string, logger: Logger): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    // Hashed asset names can be cached hard; the shell must not be, or a
    // deploy leaves people running the previous bundle.
    maxAge: '1y',
    setHeaders: (response, path) => {
      if (path.endsWith('index.html')) void response.header('cache-control', 'no-cache')
    },
  })

  logger.info({ root }, 'serving the web app from this process')
}

/**
 * Load content if there is none.
 *
 * For hosts that run one service and offer no release step. Deliberately
 * opt-in and deliberately conditional: an existing library is never touched,
 * and a failure is logged rather than fatal, because a server with no
 * questions can still run a lobby and say so.
 */
async function seedIfEmpty(pool: Pool, config: Config, logger: Logger): Promise<void> {
  try {
    const counts = await contentCounts(pool)
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (total > 0) {
      logger.info({ counts }, 'content already loaded; skipping boot seed')
      return
    }
    logger.info('no content found; seeding')
    const results = await seedContent(pool, { dataDir: resolveDataDir(config.DATA_DIR) })
    logger.info({ loaded: results.map((r) => `${r.kind}:${r.loaded}`) }, 'content seeded')
  } catch (error) {
    logger.error({ err: error }, 'boot seed failed; start the server with content already loaded')
  }
}

/**
 * Shutdown order matters, and this is the reasoning for it.
 *
 *  1. Fail readiness. The load balancer stops sending new players here while
 *     everything below is still fully working.
 *  2. Stop the scheduler. Rooms this instance would have advanced are still in
 *     the Redis deadline index, so another instance picks them up immediately.
 *  3. Tell sockets to reconnect and close them. Clients reconnect elsewhere
 *     within their grace period, so nobody is marked inactive and no round is
 *     lost — the state lives in Redis, not in this process.
 *  4. Stop accepting HTTP and let in-flight requests finish.
 *  5. Close Redis, then Postgres, once nothing can still want them.
 */
async function gracefulShutdown(app: FastifyInstance, services: AppServices, logger: Logger): Promise<void> {
  logger.info('shutdown: draining')
  services.scheduler.stop()

  try {
    await services.gateway().shutdown('SERVER_SHUTDOWN')
  } catch (error) {
    logger.warn({ err: error }, 'shutdown: gateway close failed')
  }

  try {
    await app.close()
  } catch (error) {
    logger.warn({ err: error }, 'shutdown: http close failed')
  }

  await services.redis.close().catch(() => undefined)
  await services.pool.end().catch(() => undefined)
  logger.info('shutdown: complete')
}
