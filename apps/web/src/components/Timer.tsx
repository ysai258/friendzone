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
  accent = 'bg-violet-400',
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
        className={clsx('tabular w-12 text-right text-3xl font-extrabold', urgent ? 'text-rose-300' : 'text-chalk')}
        // Announced at a readable pace rather than on every 100ms tick.
        aria-live="off"
      >
        {seconds}
      </div>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={clsx('h-full rounded-full transition-[width] duration-100 ease-linear', urgent ? 'bg-rose-400' : accent)}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <span className="sr-only">{seconds} seconds left</span>
    </div>
  )
}
