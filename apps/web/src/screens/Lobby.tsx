import { useEffect, useState } from 'react'
import type { GameCatalogEntry, PublicRoomView, SettingField } from '@friendzone/shared'
import { ROOM_ACTIONS } from '@friendzone/shared'
import { api } from '../lib/api.ts'
import type { RoomConnection } from '../lib/useRoom.ts'
import { accentOf, Button, Card, Logo, Pill, PresenceDot } from '../components/ui.tsx'

/**
 * The waiting room: the code to share, who has arrived, and — for the host —
 * what everyone is about to play.
 *
 * The settings form is generated from the game definition's own declared
 * fields, so adding a setting to a game adds a control here with no change to
 * this file. That is the same boundary the server keeps.
 */
export function Lobby({ connection, room }: { connection: RoomConnection; room: PublicRoomView }) {
  const [catalog, setCatalog] = useState<GameCatalogEntry[] | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void api.games().then(setCatalog, () => setCatalog([]))
  }, [])

  const isHost = room.viewerId === room.hostId
  const game = catalog?.find((g) => g.id === room.config.gameId) ?? null
  const seated = room.players.filter((p) => p.presence !== 'INACTIVE')
  const shareUrl = `${window.location.origin}/r/${room.code}`

  const tooFew = game !== null && seated.length < game.minPlayers
  const tooMany = game !== null && seated.length > game.maxPlayers

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
    } catch {
      // Clipboard is blocked without a gesture in some browsers; the link is on
      // screen either way.
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const share = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'FriendZone', text: `Join my game: ${room.code}`, url: shareUrl })
        return
      } catch {
        // Cancelled, or unsupported. Fall through to copying.
      }
    }
    await copy()
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col items-center gap-2 pt-2 text-center">
        <Logo compact as="div" />
        <h1 className="font-mono text-5xl font-extrabold tracking-[0.22em]">{room.code}</h1>
      </header>

      <Card className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-muted">Share this link with your friends</p>
        <p className="truncate rounded-xl bg-black/30 px-4 py-3 font-mono text-sm text-chalk">{shareUrl}</p>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => void share()}>{copied ? 'Copied ✓' : 'Copy link'}</Button>
        </div>
      </Card>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted">
            Players <span className="text-chalk">{seated.length}</span>
            {game !== null && <span className="text-muted">/{room.config.maxPlayers}</span>}
          </h2>
          {connection.latencyMs > 0 && <Pill>{connection.latencyMs} ms</Pill>}
        </div>

        <ul aria-label="Players in this room" className="flex flex-col gap-1.5">
          {room.players.map((player) => (
            <li
              key={player.id}
              className="animate-rise flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
            >
              <PresenceDot presence={player.presence} />
              <span className="text-xl" aria-hidden>{player.avatar}</span>
              {/* The name is its own element rather than a text node sharing a
                  span with the badge, so it can be read and matched on its own. */}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate font-semibold">{player.name}</span>
                {player.id === room.viewerId && <span className="text-xs font-bold text-violet-300">you</span>}
              </span>
              {player.isHost && <Pill className="text-amber-200">host</Pill>}
              {isHost && player.id !== room.viewerId && (
                <Button
                  variant="subtle"
                  className="min-h-9 px-2 text-xs"
                  onClick={() => connection.send(ROOM_ACTIONS.KICK_PLAYER, { playerId: player.id })}
                >
                  remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {catalog !== null && (
        <GamePicker
          catalog={catalog}
          room={room}
          isHost={isHost}
          onPick={(gameId) => connection.send(ROOM_ACTIONS.UPDATE_CONFIG, { gameId })}
          onSetting={(key, value) => connection.send(ROOM_ACTIONS.UPDATE_CONFIG, { settings: { [key]: value } })}
        />
      )}

      {isHost ? (
        <div className="sticky bottom-4 flex flex-col gap-2">
          <Button
            size="lg"
            disabled={tooFew || tooMany}
            onClick={() => connection.send(ROOM_ACTIONS.START_GAME)}
          >
            Start game
          </Button>
          {game !== null && seated.length < game.minPlayers && (
            <p className="text-center text-sm text-muted">
              {game.name} needs at least {game.minPlayers} players — {game.minPlayers - seated.length} more to go.
            </p>
          )}
          {game !== null && seated.length > game.maxPlayers && (
            <p className="text-center text-sm text-amber-200">{game.name} takes at most {game.maxPlayers} players.</p>
          )}
        </div>
      ) : (
        <p className="py-2 text-center text-sm text-muted">
          Waiting for {room.players.find((p) => p.isHost)?.name ?? 'the host'} to start…
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function GamePicker({
  catalog,
  room,
  isHost,
  onPick,
  onSetting,
}: {
  catalog: GameCatalogEntry[]
  room: PublicRoomView
  isHost: boolean
  onPick: (gameId: string) => void
  onSetting: (key: string, value: unknown) => void
}) {
  const current = catalog.find((g) => g.id === room.config.gameId)

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-bold uppercase tracking-wider text-muted">Game</h2>

      {isHost ? (
        <div className="grid grid-cols-2 gap-2">
          {catalog.map((game) => {
            const accent = accentOf(game.accent)
            const selected = game.id === room.config.gameId
            return (
              <button
                key={game.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(game.id)}
                className={`card flex flex-col gap-1 p-3 text-left transition hover:bg-white/[0.06] ${
                  selected ? `ring-2 ${accent.ring}` : ''
                }`}
              >
                <span className="text-xl" aria-hidden>{game.emoji}</span>
                <span className="text-sm font-bold leading-tight">{game.name}</span>
                <span className="text-[11px] text-muted">{game.minPlayers}–{game.maxPlayers} players</span>
              </button>
            )
          })}
        </div>
      ) : (
        current !== undefined && (
          <Card className="flex items-center gap-3">
            <span className="text-2xl" aria-hidden>{current.emoji}</span>
            <div>
              <p className="font-bold">{current.name}</p>
              <p className="text-sm text-muted">{current.tagline}</p>
            </div>
          </Card>
        )
      )}

      {current !== undefined && (
        <Card className="flex flex-col gap-4">
          <p className="text-sm text-muted">{current.description}</p>
          {current.settings.map((field) => (
            <SettingControl
              key={field.key}
              field={field}
              value={room.config.settings[field.key]}
              disabled={!isHost}
              onChange={(value) => onSetting(field.key, value)}
            />
          ))}
        </Card>
      )}
    </section>
  )
}

/** One control, rendered from the declared field rather than hand-written. */
function SettingControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const id = `setting-${field.key}`

  if (field.kind === 'bool') {
    const checked = typeof value === 'boolean' ? value : field.default
    return (
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm font-semibold">
          {field.label}
          {field.help !== undefined && <span className="block text-xs font-normal text-muted">{field.help}</span>}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${checked ? 'bg-violet-500' : 'bg-white/15'}`}
        >
          <span className={`block size-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    )
  }

  if (field.kind === 'choice') {
    const selected = typeof value === 'string' ? value : field.default
    return (
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">{field.label}</span>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={option.value === selected}
              onClick={() => onChange(option.value)}
              className={`min-h-10 rounded-xl border px-3 text-sm font-semibold transition disabled:opacity-50 ${
                option.value === selected
                  ? 'border-violet-400/60 bg-violet-500/20 text-chalk'
                  : 'border-white/12 bg-white/5 text-muted hover:text-chalk'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const numeric = typeof value === 'number' ? value : field.default
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-semibold">{field.label}</label>
        <span className="tabular text-lg font-bold">
          {numeric}
          {field.unit ?? ''}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={numeric}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-violet-400 disabled:opacity-50"
      />
    </div>
  )
}
