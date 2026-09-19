import clsx from 'clsx'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/** The accent tokens games declare, mapped once so a game card and its screens
 *  agree without every component repeating the palette. */
export const ACCENTS = {
  violet: { text: 'text-violet-300', ring: 'ring-violet-400/40', bg: 'bg-violet-500', glow: 'shadow-violet-500/25', from: 'from-violet-500/25' },
  rose: { text: 'text-rose-300', ring: 'ring-rose-400/40', bg: 'bg-rose-500', glow: 'shadow-rose-500/25', from: 'from-rose-500/25' },
  emerald: { text: 'text-emerald-300', ring: 'ring-emerald-400/40', bg: 'bg-emerald-500', glow: 'shadow-emerald-500/25', from: 'from-emerald-500/25' },
  amber: { text: 'text-amber-300', ring: 'ring-amber-400/40', bg: 'bg-amber-500', glow: 'shadow-amber-500/25', from: 'from-amber-500/25' },
  sky: { text: 'text-sky-300', ring: 'ring-sky-400/40', bg: 'bg-sky-500', glow: 'shadow-sky-500/25', from: 'from-sky-500/25' },
} as const

export type AccentName = keyof typeof ACCENTS
export const accentOf = (name: string): (typeof ACCENTS)[AccentName] =>
  ACCENTS[(name in ACCENTS ? name : 'violet') as AccentName]

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  size?: 'md' | 'lg'
  loading?: boolean
}

export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled === true || loading === true}
      className={clsx(
        'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-2xl font-semibold transition',
        'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100',
        // 48px minimum height: this is played one-handed, on a phone, quickly.
        size === 'lg' ? 'min-h-14 px-7 text-lg' : 'min-h-12 px-5 text-base',
        variant === 'primary' && 'bg-violet-500 text-white shadow-lg shadow-violet-500/30 hover:bg-violet-400',
        variant === 'danger' && 'bg-rose-500 text-white shadow-lg shadow-rose-500/25 hover:bg-rose-400',
        variant === 'ghost' && 'border border-white/15 bg-white/5 text-chalk hover:bg-white/10',
        variant === 'subtle' && 'text-muted hover:text-chalk',
        className,
      )}
    >
      {loading === true && (
        <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      )}
      {children}
    </button>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        'min-h-14 w-full rounded-2xl border border-white/15 bg-black/30 px-5 text-lg text-chalk',
        'placeholder:text-muted/60 focus:border-violet-400/60 focus:outline-none',
        className,
      )}
    />
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('card p-5', className)}>{children}</div>
}

export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={clsx('mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pb-24 pt-6', className)}>{children}</main>
  )
}

export function Logo({ compact = false, as: Tag = 'h1' }: { compact?: boolean; as?: 'h1' | 'div' }) {
  return (
    <Tag className={clsx('font-extrabold tracking-tight', compact ? 'text-2xl' : 'text-5xl sm:text-6xl')}>
      <span className="bg-gradient-to-r from-violet-300 via-rose-300 to-amber-200 bg-clip-text text-transparent">
        FRIENDZONE
      </span>
    </Tag>
  )
}

/** A presence dot. Colour and the label together, never colour alone. */
export function PresenceDot({ presence }: { presence: string }) {
  const colour =
    presence === 'CONNECTED' ? 'bg-emerald-400' : presence === 'DISCONNECTED' ? 'bg-amber-400 animate-soft-pulse' : 'bg-white/25'
  const label = presence === 'CONNECTED' ? 'Connected' : presence === 'DISCONNECTED' ? 'Reconnecting' : 'Away'
  return <span className={clsx('inline-block size-2.5 shrink-0 rounded-full', colour)} title={label} aria-label={label} />
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={clsx('rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-muted', className)}>
      {children}
    </span>
  )
}

export function EmptyState({ emoji, title, hint }: { emoji: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <div className="text-4xl" aria-hidden>{emoji}</div>
      <p className="font-semibold">{title}</p>
      {hint !== undefined && <p className="max-w-xs text-sm text-muted">{hint}</p>}
    </div>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted" role="status">
      <span className="size-8 animate-spin rounded-full border-2 border-white/15 border-t-violet-400" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
