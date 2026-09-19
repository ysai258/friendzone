import { build } from 'esbuild'
import { cp, rm } from 'node:fs/promises'

/**
 * Bundle the server to a single file.
 *
 * The workspace packages export TypeScript source, which is what lets dev,
 * tests and the editor all resolve the same files with no build step. Bundling
 * at deploy time keeps that property without asking Node to resolve TypeScript
 * at runtime: one file in, one file out, no node_modules resolution on a cold
 * start.
 *
 * Native and lazily-loaded modules stay external — bundling them either fails
 * or produces something that cannot find its own .node files.
 */
const external = ['pg-native', 'sharp', 'bufferutil', 'utf-8-validate', 'pino-pretty']

await rm('dist', { recursive: true, force: true })

for (const [entry, outfile] of [
  ['src/index.ts', 'dist/index.js'],
  ['src/jobs/worker.ts', 'dist/worker.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    minify: false, // readable stack traces matter more than a few hundred KB
    external,
    // Bundled CommonJS dependencies still reach for require, __dirname and
    // __filename at runtime — pino's transport resolves its worker file that
    // way — and ESM defines none of them. Put them back at the top of the
    // bundle rather than marking every such package external.
    banner: {
      js: [
        "import { createRequire as __nodeCreateRequire } from 'node:module'",
        "import { fileURLToPath as __nodeFileURLToPath } from 'node:url'",
        "import { dirname as __nodeDirname } from 'node:path'",
        'const require = __nodeCreateRequire(import.meta.url)',
        'const __filename = __nodeFileURLToPath(import.meta.url)',
        'const __dirname = __nodeDirname(__filename)',
      ].join('\n'),
    },
    logLevel: 'info',
  })
}

// The migration runner reads .sql files from a directory next to itself, which
// after bundling means dist/. Copying them here keeps the bundle self-contained
// rather than making every deployment remember to ship them.
await cp('src/db/migrations', 'dist/migrations', { recursive: true })
console.log('  copied migrations -> dist/migrations')
