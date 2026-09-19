import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

/**
 * Configuration is parsed once at boot and the process refuses to start if it
 * is wrong, so these guards are the only thing standing between a typo and a
 * misconfigured deployment. They are worth testing directly.
 */

const base = {
  SESSION_SECRET: 'a-secret-that-is-long-enough-to-pass',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
}

describe('configuration', () => {
  it('refuses to start in production with the example secret', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'dev-only-insecure-secret-change-me-0000000000', WEB_DIST: '/app/web' }),
    ).toThrow(/development placeholder/)
  })

  it('refuses a secret that is too short', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/)
  })

  it('names the missing variable rather than failing obscurely', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/)
  })

  describe('CORS in production', () => {
    it('requires an allow-list when the web app is served separately', () => {
      expect(() => loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/)
    })

    it('accepts an empty allow-list when this process serves the web app', () => {
      // Every request is then same-origin, so an empty list is the stricter
      // setting — requiring one would only invite a wrong value or a wildcard.
      const config = loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '', WEB_DIST: '/app/web' })
      expect(config.CORS_ORIGINS).toEqual([])
      expect(config.isProduction).toBe(true)
    })
  })

  describe('public origin', () => {
    it('takes the host’s own URL when nothing is configured', () => {
      const config = loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://friendzone.onrender.com' })
      expect(config.PUBLIC_WEB_ORIGIN).toBe('https://friendzone.onrender.com')
    })

    it('prefers an explicit setting over the host’s', () => {
      const config = loadConfig({
        ...base,
        PUBLIC_WEB_ORIGIN: 'https://play.example.com',
        RENDER_EXTERNAL_URL: 'https://friendzone.onrender.com',
      })
      expect(config.PUBLIC_WEB_ORIGIN).toBe('https://play.example.com')
    })

    it('falls back to the dev origin when neither is set', () => {
      expect(loadConfig(base).PUBLIC_WEB_ORIGIN).toBe('http://localhost:5174')
    })
  })

  it('parses a rate limit into capacity and refill rate', () => {
    const config = loadConfig({ ...base, RL_ROOM_CREATE: '12:0.25' })
    expect(config.RL_ROOM_CREATE).toEqual({ capacity: 12, refillPerSecond: 0.25 })
  })

  it('rejects a malformed rate limit rather than guessing', () => {
    expect(() => loadConfig({ ...base, RL_ROOM_CREATE: '12 per minute' })).toThrow(/capacity:refillPerSecond/)
  })

  it('accepts port 0, which is how a test asks for any free port', () => {
    expect(loadConfig({ ...base, PORT: '0' }).PORT).toBe(0)
  })

  it('treats SEED_ON_BOOT as off unless explicitly enabled', () => {
    expect(loadConfig(base).SEED_ON_BOOT).toBe(false)
    expect(loadConfig({ ...base, SEED_ON_BOOT: 'true' }).SEED_ON_BOOT).toBe(true)
    expect(loadConfig({ ...base, SEED_ON_BOOT: 'yes' }).SEED_ON_BOOT).toBe(false)
  })
})
