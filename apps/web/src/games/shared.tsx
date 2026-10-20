import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PublicPlayer, PublicRoomView } from '@friendzone/shared'
import { Timer } from '../components/Timer.tsx'
import { useCountdown, type RoomConnection } from '../lib/useRoom.ts'
import { Card, Pill } from '../components/ui.tsx'

/**
 * The game's slice of the room view, typed by the screen that renders it.
 *
 * The server sends this as an open record on purpose: the room layer is
 * game-agnostic, so it cannot know the shape, and the screen is the one piece
 * of the system that does. This is the single place that knowledge is
 * asserted — one cast per game, at the boundary, rather than scattered through
 * every field access.
 *
 * Phase-specific fields are declared optional in each screen's interface, so a
 * payload from a phase that omits them reads as undefined rather than crashing.
 */
export function readView<T>(room: PublicRoomView): T {
  return (room.game?.view ?? {}) as T
}

/** The header every game shares: round, clock, and who has acted. */
export function GameHeader({
  connection,
  room,
  label,
  accent,
}: {
  connection: RoomConnection
  room: PublicRoomView
  label: string
  accent?: string
}) {
  const { msLeft } = useCountdown(room.deadlineAt, connection.serverNow)
  const totalMs = room.deadlineAt !== null && room.phaseStartedAt !== null ? room.deadlineAt - room.phaseStartedAt : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Pill>{label}</Pill>
        {room.game !== null && room.game.totalRounds > 0 && (
          <Pill>
            Round {Math.min(room.game.roundNumber, room.game.totalRounds)} / {room.game.totalRounds}
          </Pill>
        )}
      </div>
      {room.deadlineAt !== null && <Timer msLeft={msLeft} totalMs={totalMs} {...(accent === undefined ? {} : { accent })} />}
    </div>
  )
}

/** Big centred countdown between rounds. */
export function Countdown({ connection, room, title, subtitle }: { connection: RoomConnection; room: PublicRoomView; title: string; subtitle?: string }) {
  const { seconds } = useCountdown(room.deadlineAt, connection.serverNow)
  return (
    <div className="flex flex-col items-center gap-5 py-16 text-center">
      <p className="font-display text-xl font-extrabold">{title}</p>
      <p
        key={seconds}
        className="animate-pop font-chunky text-[7rem] leading-none tabular text-sun text-outline-thick [text-shadow:5px_5px_0_var(--color-ink)]"
      >
        {Math.max(seconds, 0)}
      </p>
      {subtitle !== undefined && <p className="max-w-xs font-medium text-ink-soft">{subtitle}</p>}
    </div>
  )
}

/** Dots showing who has locked something in, without saying what. */
export function AnsweredRow({ players, answeredIds }: { players: PublicPlayer[]; answeredIds: string[] }) {
  const seated = players.filter((p) => p.presence !== 'INACTIVE')
  return (
    <ul aria-label="Players in this round" className="flex flex-wrap items-center justify-center gap-2">
      {seated.map((player) => {
        const done = answeredIds.includes(player.id)
        return (
          <li
            key={player.id}
            className={clsx(
              'flex items-center gap-1.5 rounded-full border-2 border-ink px-2.5 py-1 text-xs font-bold transition',
              done ? 'animate-pop bg-lime shadow-hard-sm' : 'bg-white text-ink-soft',
            )}
          >
            <span aria-hidden>{player.avatar}</span>
            <span className="max-w-20 truncate">{player.name}</span>
            <span className="sr-only">{done ? 'has answered' : 'still thinking'}</span>
            {done && <span aria-hidden>✓</span>}
          </li>
        )
      })}
    </ul>
  )
}

export function PlayerName({ room, playerId }: { room: PublicRoomView; playerId: string }) {
  const player = room.players.find((p) => p.id === playerId)
  if (player === undefined) return <span className="text-ink-soft">someone</span>
  return (
    <span className="font-semibold">
      <span aria-hidden>{player.avatar}</span> {player.name}
    </span>
  )
}

export function Attribution({ value }: { value: unknown }) {
  if (typeof value !== 'object' || value === null) return null
  const a = value as { source: string; sourceUrl: string; license: string; licenseUrl: string; author: string | null }
  return (
    <p className="text-[11px] leading-relaxed text-ink-soft">
      {a.author !== null && <>{a.author} · </>}
      <a className="underline hover:text-ink" href={a.sourceUrl} target="_blank" rel="noreferrer noopener">
        {a.source}
      </a>
      {' · '}
      <a className="underline hover:text-ink" href={a.licenseUrl} target="_blank" rel="noreferrer noopener">
        {a.license}
      </a>
    </p>
  )
}

export function Banner({ tone, children }: { tone: 'good' | 'bad' | 'neutral'; children: ReactNode }) {
  return (
    <Card
      color={tone === 'good' ? 'lime' : tone === 'bad' ? 'tomato' : 'sun'}
      soft
      padding="sm"
      className="animate-pop text-center font-display text-lg font-extrabold"
    >
      {children}
    </Card>
  )
}
