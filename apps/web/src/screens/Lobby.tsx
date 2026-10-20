import { useEffect, useState } from 'react'
import type { GameCatalogEntry, PublicRoomView, SettingField } from '@friendzone/shared'
import { ROOM_ACTIONS } from '@friendzone/shared'
import { api } from '../lib/api.ts'
import type { RoomConnection } from '../lib/useRoom.ts'
import clsx from 'clsx'
import { Avatar, Badge, Button, Card, COLOR, colorOf, Logo, PresenceDot } from '../components/ui.tsx'

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
    <div className="flex flex-col gap-8">
      <header className="flex items-center gap-3 pt-1">
        <div className="flex min-w-0 flex-1 flex-col leading-none">
          <span className="text-[0.7rem] font-bold uppercase tracking-[0.2em] text-ink-soft">Room code</span>
          <h1 className="font-chunky text-[2rem] tracking-wider">{room.code}</h1>
        </div>
        {connection.latencyMs > 0 && <Badge>{connection.latencyMs} ms</Badge>}
        <Logo compact as="div" />
      </header>

      <Card color="sky" soft tilt="left" className="flex flex-col gap-3">
        <p className="font-display text-lg font-extrabold">Share this link with your friends <span aria-hidden>🔗</span></p>
        <p className="truncate rounded-xl border-2 border-ink bg-white px-4 py-3 text-sm font-semibold">{shareUrl}</p>
        <Button color="sky" icon={copied ? '✅' : '📋'} onClick={() => void share()}>{copied ? 'Copied ✓' : 'Copy link'}</Button>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-3xl">
            Players{' '}
            <Badge size="md" className="ml-1 align-middle">
              {seated.length}
              {game !== null && <span className="text-ink-soft">/{room.config.maxPlayers}</span>}
            </Badge>
          </h2>
        </div>

        <ul aria-label="Players in this room" className="flex flex-col gap-2">
          {room.players.map((player) => (
            <li
              key={player.id}
              className={clsx(
                'animate-pop flex items-center gap-3 rounded-2xl border-3 border-ink px-3 py-2 shadow-hard-sm',
                player.id === room.viewerId ? 'bg-sun-soft' : 'bg-white',
                player.presence === 'INACTIVE' && 'opacity-60',
              )}
            >
              <Avatar emoji={player.avatar} size="sm" host={player.isHost} dim={player.presence !== 'CONNECTED'} />
              {/* The name is its own element rather than a text node sharing a
                  span with the badge, so it can be read and matched on its own. */}
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate font-bold">{player.name}</span>
                {player.id === room.viewerId && <Badge color="ink">you</Badge>}
              </span>
              <PresenceDot presence={player.presence} />
              {player.isHost && <Badge color="sun">host</Badge>}
              {isHost && player.id !== room.viewerId && (
                <Button
                  variant="subtle"
                  size="sm"
                  className="!min-h-9 px-2 text-xs"
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
        <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 bg-gradient-to-t from-paper via-paper/90 to-transparent px-1 pb-4 pt-6">
          <Button
            size="xl"
            block
            icon="🚀"
            disabled={tooFew || tooMany}
            onClick={() => connection.send(ROOM_ACTIONS.START_GAME)}
          >
            Start game
          </Button>
          {game !== null && seated.length < game.minPlayers && (
            <p className="text-center text-sm font-semibold text-ink-soft">
              {game.name} needs at least {game.minPlayers} players — {game.minPlayers - seated.length} more to go.
            </p>
          )}
          {game !== null && seated.length > game.maxPlayers && (
            <p className="text-center text-sm font-bold text-tomato">{game.name} takes at most {game.maxPlayers} players.</p>
          )}
        </div>
      ) : (
        <Card color="sun" soft padding="sm" className="flex items-center justify-center gap-2 text-center font-display font-extrabold">
          <span className="animate-wiggle-loop" aria-hidden>⏳</span>
          Waiting for {room.players.find((p) => p.isHost)?.name ?? 'the host'} to start…
        </Card>
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
      <h2 className="text-3xl">{isHost ? 'Pick a game' : 'The game'}</h2>

      {isHost ? (
        <div className="grid grid-cols-2 gap-2">
          {catalog.map((game) => {
            const selected = game.id === room.config.gameId
            return (
              <button
                key={game.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(game.id)}
                className={clsx(
                  'flex items-center gap-2 rounded-2xl border-3 border-ink p-2.5 text-left transition-transform',
                  'active:translate-x-1 active:translate-y-1 active:shadow-none',
                  COLOR[colorOf(game.accent)].bg,
                  selected ? 'shadow-hard-lg ring-3 ring-inset ring-ink' : 'shadow-hard-sm',
                )}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border-2 border-ink bg-white text-xl" aria-hidden>
                  {game.emoji}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-display text-sm font-extrabold leading-tight">{game.name}</span>
                  <span className="text-[11px] font-semibold">{game.minPlayers}–{game.maxPlayers} players</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        current !== undefined && (
          <Card color={colorOf(current.accent)} tilt="right" className="flex items-center gap-3">
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl border-3 border-ink bg-white text-3xl" aria-hidden>{current.emoji}</span>
            <div>
              <p className="font-display text-xl font-extrabold">{current.name}</p>
              <p className="text-sm font-medium">{current.tagline}</p>
            </div>
          </Card>
        )
      )}

      {current !== undefined && (
        <Card className="flex flex-col gap-5">
          <p className="text-ink-soft">{current.description}</p>
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
        <label htmlFor={id} className="font-display font-bold">
          {field.label}
          {field.help !== undefined && <span className="block font-body text-xs font-normal text-ink-soft">{field.help}</span>}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`h-8 w-14 shrink-0 rounded-full border-3 border-ink transition disabled:opacity-40 ${checked ? 'bg-lime' : 'bg-white'}`}
        >
          <span className={`block size-5 rounded-full border-2 border-ink bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-0.5'}`} />
        </button>
      </div>
    )
  }

  if (field.kind === 'multi') {
    const selected = Array.isArray(value) ? (value as string[]) : field.default
    const toggle = (option: string) => {
      const next = selected.includes(option)
        ? selected.filter((v) => v !== option)
        : [...selected, option]
      // Never send an empty set: the server would only substitute the default
      // back, and a lobby showing nothing selected looks broken.
      onChange(next.length === 0 ? field.default : next)
    }
    return (
      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="font-display font-bold">
          {field.label}
          {field.help !== undefined && <span className="block font-body text-xs font-normal text-ink-soft">{field.help}</span>}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((option) => {
            const on = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={disabled}
                onClick={() => toggle(option.value)}
                className={`flex min-h-11 items-center gap-1.5 rounded-xl border-2 border-ink px-3 text-sm font-bold transition disabled:opacity-50 ${
                  on ? 'bg-sun shadow-hard-sm' : 'bg-white text-ink-soft hover:text-ink'
                }`}
              >
                <span aria-hidden className="text-xs">{on ? '☑' : '☐'}</span>
                {option.label}
              </button>
            )
          })}
        </div>
      </fieldset>
    )
  }

  if (field.kind === 'choice') {
    const selected = typeof value === 'string' ? value : field.default
    return (
      <div className="flex flex-col gap-2">
        <span className="font-display font-bold">{field.label}</span>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={option.value === selected}
              onClick={() => onChange(option.value)}
              className={`min-h-11 rounded-xl border-2 border-ink px-3 text-sm font-bold transition disabled:opacity-50 ${
                option.value === selected ? 'bg-sun shadow-hard-sm' : 'bg-white text-ink-soft hover:text-ink'
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
        <label htmlFor={id} className="font-display font-bold">{field.label}</label>
        <span className="tabular rounded-full border-2 border-ink bg-sun px-2.5 py-0.5 font-display text-lg font-extrabold">
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
        className="h-3 w-full cursor-pointer appearance-none rounded-full border-2 border-ink bg-white accent-[var(--color-tomato)] disabled:opacity-50"
      />
    </div>
  )
}
