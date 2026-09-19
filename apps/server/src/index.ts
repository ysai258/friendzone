import { buildApp } from './app.ts'

/**
 * Entry point. Its only jobs are to start the server and to make sure the
 * process cannot die without running the drain sequence.
 */

const SHUTDOWN_TIMEOUT_MS = 15_000

async function main(): Promise<void> {
  const { app, services, shutdown } = await buildApp()

  await app.listen({ port: services.config.PORT, host: services.config.HOST })
  services.logger.info(
    { port: services.config.PORT, env: services.config.NODE_ENV },
    'friendzone server listening',
  )

  let closing = false
  const stop = (signal: string) => {
    if (closing) {
      // A second signal means somebody is impatient; honour that.
      services.logger.warn({ signal }, 'second signal received, exiting now')
      process.exit(1)
    }
    closing = true
    services.logger.info({ signal }, 'signal received')

    // A drain that hangs must not leave the process wedged forever.
    const timer = setTimeout(() => {
      services.logger.error('shutdown timed out; forcing exit')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    timer.unref()

    shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        services.logger.error({ err: error }, 'shutdown failed')
        process.exit(1)
      },
    )
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    // Logged rather than fatal: one dropped promise must not disconnect every
    // player on the box. A crash here would be indistinguishable to them from
    // the server falling over.
    services.logger.error({ err: reason }, 'unhandled rejection')
  })

  process.on('uncaughtException', (error) => {
    // This one is fatal. The process is in an unknown state; drain and let the
    // orchestrator replace it.
    services.logger.fatal({ err: error }, 'uncaught exception')
    stop('uncaughtException')
  })
}

main().catch((error: unknown) => {
  console.error('failed to start:', error)
  process.exit(1)
})
