import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, httpStatusFor, toWireError } from '@friendzone/shared'
import type { Logger } from './logger.ts'

/**
 * One error handler for every route.
 *
 * Two rules. A client receives a code it can branch on and a sentence it can
 * show a person — never a stack, a driver message, or a SQL fragment. And an
 * unexpected failure is logged in full with its correlation id, so the detail
 * that was withheld from the response is one search away in the logs.
 */
/** Fastify hands the handler an `unknown`; read its status without asserting. */
function readStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null
  const { statusCode: value } = error
  return typeof value === 'number' ? value : null
}

export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id

    if (error instanceof AppError) {
      // Expected: the caller did something the rules disallow.
      logger.debug({ requestId, code: error.code, context: error.context }, 'request rejected')
      if (error.retryAfter !== undefined) void reply.header('retry-after', String(error.retryAfter))
      return reply.code(error.status).send({ error: error.toWire() })
    }

    if (error instanceof ZodError) {
      const issue = error.issues[0]
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          // The field name helps; the received value is not echoed back.
          message: issue === undefined ? 'The request was malformed.' : `${issue.path.join('.') || 'body'}: ${issue.message}`,
        },
      })
    }

    // Fastify's own validation and payload errors arrive carrying a statusCode.
    const status = readStatusCode(error) ?? 500
    if (status < 500) {
      return reply.code(status).send({ error: { code: 'VALIDATION_FAILED', message: 'The request was malformed.' } })
    }

    logger.error({ err: error, requestId, url: request.url, method: request.method }, 'unhandled server error')
    return reply.code(httpStatusFor('INTERNAL')).send({ error: toWireError(error) })
  })

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: `No route for ${request.method} ${request.url}.` } }),
  )

  app.addHook('onRequest', (request, _reply, done) => {
    // Correlation id for every line this request produces.
    request.id = request.headers['x-request-id']?.toString() ?? randomUUID()
    done()
  })
}
