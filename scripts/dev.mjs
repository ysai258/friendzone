#!/usr/bin/env node
/**
 * One command to run everything locally.
 *
 * Starts the API and the web dev server together, prefixes their output so it
 * is obvious which is which, and shuts both down on Ctrl-C. It also checks
 * that Postgres and Redis are actually reachable first, because "npm run dev"
 * failing with a connection refused three screens down is a miserable first
 * five minutes with a project.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'

const ROOT = new URL('..', import.meta.url).pathname

if (!existsSync(`${ROOT}/.env`)) {
  console.error('\n  No .env found. Copy the example and try again:\n')
  console.error('    cp .env.example .env\n')
  process.exit(1)
}

process.loadEnvFile(`${ROOT}/.env`)

const reachable = (url, fallbackPort) =>
  new Promise((resolve) => {
    let host = '127.0.0.1'
    let port = fallbackPort
    try {
      const parsed = new URL(url)
      host = parsed.hostname || host
      port = Number(parsed.port) || fallbackPort
    } catch {
      // Fall back to the defaults below.
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(1500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })

const [pg, redis] = await Promise.all([
  reachable(process.env.DATABASE_URL, 5432),
  reachable(process.env.REDIS_URL, 6379),
])

if (!pg || !redis) {
  console.error('\n  Cannot reach:', [!pg && 'PostgreSQL', !redis && 'Redis'].filter(Boolean).join(' and '))
  console.error('\n    docker compose up -d\n')
  process.exit(1)
}

const COLOURS = { api: '\x1b[35m', web: '\x1b[36m' }
const RESET = '\x1b[0m'

function run(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `${COLOURS[label]}${label.padEnd(3)}${RESET} `
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`)
    })
  }
  return child
}

const children = [
  run('api', 'npm', ['run', 'dev'], `${ROOT}/apps/server`),
  run('web', 'npm', ['run', 'dev'], `${ROOT}/apps/web`),
]

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', stop)

console.log('\n  FriendZone\n    web  http://localhost:5174\n    api  http://localhost:8080\n')
