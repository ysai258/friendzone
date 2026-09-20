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
              'animate-rise flex items-center gap-3 rounded-2xl border px-3',
              compact ? 'py-2' : 'py-3',
              isYou ? 'border-violet-400/40 bg-violet-500/10' : 'border-white/10 bg-white/[0.03]',
            )}
            style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
          >
            <span className="tabular w-7 shrink-0 text-center text-sm font-bold text-muted">
              {/* A medal means you earned something. Before anyone has scored,
                  dense ranking correctly puts everybody first — but a row of
                  gold medals on a 0-0 board reads as a bug. */}
              {entry.score > 0 ? (MEDALS[entry.rank - 1] ?? entry.rank) : entry.rank}
            </span>
            <span className="text-xl" aria-hidden>{entry.avatar}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="truncate font-semibold">{entry.name}</span>
              {isYou && <span className="text-xs font-bold text-violet-300">you</span>}
            </span>
            {showDeltas && entry.delta !== null && entry.delta !== 0 && (
              // Negative happens when the host undoes a join they had made,
              // and a score that moves without saying so looks like a bug.
              <span
                className={`animate-pop tabular text-sm font-bold ${entry.delta > 0 ? 'text-emerald-300' : 'text-rose-300'}`}
              >
                {entry.delta > 0 ? `+${entry.delta}` : `−${Math.abs(entry.delta)}`}
              </span>
            )}
            <span className="tabular w-16 text-right text-lg font-extrabold">{entry.score.toLocaleString()}</span>
          </li>
        )
      })}
    </ol>
  )
}
