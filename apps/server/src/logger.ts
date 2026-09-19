import { pino, type Logger } from 'pino'
import type { Config } from './config.ts'

/**
 * One structured logger, with a child per unit of work. Every line a request or
 * a socket produces carries the same correlation fields, so tracing one
 * player's bad round through a multi-instance deployment is a single query
 * rather than a guess.
 */
export interface LogContext {
  requestId?: string
  roomCode?: string
  playerId?: string
  gameId?: string
  actionId?: string
  connectionId?: string
}

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'friendzone' },
    // Anything that looks like a credential is redacted before it is written.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'token', '*.token', 'password', '*.password'],
      censor: '[redacted]',
    },
    ...(config.isProduction
      ? {}
      : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' } } }),
  })
}

export type { Logger }
