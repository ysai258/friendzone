import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the seed JSON lives.
 *
 * Three shapes have to work: running from source in the repo, running the
 * bundled server from `dist/`, and running a container that carries `data/`
 * beside the bundle. An explicit DATA_DIR always wins; otherwise the first
 * candidate that actually exists is used, so a missing directory surfaces as
 * "no content" rather than a path that silently resolves to nothing.
 */
export function resolveDataDir(configured: string): string {
  if (configured.length > 0) return resolve(configured)

  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'data'), // bundled: dist/data
    join(here, '..', 'data'), // container: /app/data beside dist
    join(here, '..', '..', '..', '..', 'data'), // source: apps/server/src/content -> repo root
    resolve('data'), // cwd
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'seed'))) return candidate
  }
  return candidates.at(-1) as string
}
