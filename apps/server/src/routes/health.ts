import type { FastifyInstance } from 'fastify'
import type { AppServices } from '../services.ts'

/**
 * Two probes with deliberately different jobs.
 *
 *  /health  Is this process alive? It touches nothing external. A liveness
 *           probe that checked the database would restart every healthy
 *           instance during a database blip — turning one outage into two.
 *
 *  /ready   Should traffic be sent here? This one does check dependencies,
 *           because an instance that cannot reach Redis cannot serve a game
 *           and should be taken out of rotation until it can.
 */
export function registerHealthRoutes(app: FastifyInstance, services: AppServices): void {
  const startedAt = Date.now()

  app.get('/health', () => ({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    version: services.version,
  }))

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {}

    checks['redis'] = await timed(async () => {
      await services.redis.command.ping()
    })
    checks['postgres'] = await timed(async () => {
      await services.archive.ping()
    })

    // Content is a soft dependency: an instance with an empty question table
    // can still run a lobby, so it is reported rather than failing readiness.
    const content = await services.content.summary().catch((): Record<string, number> => ({}))

    const ready = Object.values(checks).every((c) => c.ok)
    if (services.shuttingDown) {
      // Draining. Fail readiness first so the load balancer stops sending new
      // players here while in-flight rounds finish.
      return reply.code(503).send({ status: 'draining', checks, content })
    }
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks, content })
  })
}

async function timed(fn: () => Promise<void>): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const startedAt = process.hrtime.bigint()
  try {
    await fn()
    return { ok: true, latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown' }
  }
}
