import clsx from 'clsx'
import type { ScoreEntry } from '@friendzone/shared'

const MEDALS = ['🥇', '🥈', '🥉']

export function Scoreboard({
  entries,
  viewerId,
  showDeltas = false,
  compact = false,
}: {
  entries: ScoreEntry[]
  viewerId: string | null
  showDeltas?: boolean
  compact?: boolean
}) {
  if (entries.length === 0) return null

  return (
    <ol className="flex flex-col gap-1.5">
      {entries.map((entry, index) => {
        const isYou = entry.playerId === viewerId
        return (
          <li
            key={entry.playerId}
            className={clsx(
              'animate-rise flex items-center gap-3 rounded-2xl border-3 border-ink px-3 shadow-hard-sm',
              compact ? 'py-1.5' : 'py-2.5',
              isYou ? 'bg-sun' : entry.rank === 1 && entry.score > 0 ? 'bg-lime-soft' : 'bg-white',
            )}
            style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
          >
            <span className="tabular w-7 shrink-0 text-center font-display text-base font-extrabold">
              {/* A medal means you earned something. Before anyone has scored,
                  dense ranking correctly puts everybody first — but a row of
                  gold medals on a 0-0 board reads as a bug. */}
              {entry.score > 0 ? (MEDALS[entry.rank - 1] ?? entry.rank) : entry.rank}
            </span>
            <span className="grid size-9 shrink-0 place-items-center rounded-full border-2 border-ink bg-white text-xl" aria-hidden>{entry.avatar}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="truncate font-bold">{entry.name}</span>
              {isYou && <span className="rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-bold uppercase text-paper">you</span>}
            </span>
            {showDeltas && entry.delta !== null && entry.delta !== 0 && (
              // Negative happens when the host undoes a join they had made,
              // and a score that moves without saying so looks like a bug.
              <span
                className={`animate-pop tabular rounded-full border-2 border-ink px-2 py-0.5 text-xs font-extrabold ${entry.delta > 0 ? 'bg-lime' : 'bg-tomato'}`}
              >
                {entry.delta > 0 ? `+${entry.delta}` : `−${Math.abs(entry.delta)}`}
              </span>
            )}
            <span className="tabular w-16 text-right font-display text-xl font-extrabold">{entry.score.toLocaleString()}</span>
          </li>
        )
      })}
    </ol>
  )
}
