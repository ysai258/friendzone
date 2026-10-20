import clsx from 'clsx'

/**
 * The round clock.
 *
 * Both the number and the bar are computed from the server's absolute deadline
 * every tick, so a backgrounded tab, a sleeping phone or a device whose clock
 * is simply wrong all show the same truth the moment they come back. Nothing
 * here counts down locally.
 */
export function Timer({
  msLeft,
  totalMs,
  accent = 'bg-lime',
}: {
  msLeft: number
  totalMs: number
  accent?: string
}) {
  const seconds = Math.ceil(msLeft / 1000)
  const fraction = totalMs > 0 ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0
  const urgent = seconds <= 5 && msLeft > 0

  return (
    <div className="flex items-center gap-3">
      <div
        className={clsx(
          'grid h-10 min-w-12 place-items-center rounded-full border-3 border-ink px-2 font-display text-xl font-extrabold tabular',
          urgent ? 'animate-pulse-soft bg-tomato' : 'bg-white',
        )}
        // Announced at a readable pace rather than on every 100ms tick.
        aria-live="off"
      >
        {seconds}
      </div>
      <div className={clsx('h-4 flex-1 overflow-hidden rounded-full border-3 border-ink bg-white', urgent && 'animate-shake')}>
        <div
          className={clsx('h-full transition-[width] duration-100 ease-linear', urgent ? 'bg-tomato' : fraction > 0.5 ? accent : 'bg-sun')}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <span className="sr-only">{seconds} seconds left</span>
    </div>
  )
}
