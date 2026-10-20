import clsx from 'clsx'
import { AVATARS } from '@friendzone/shared'
import type { ButtonHTMLAttributes, ElementType, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/*
 * The sticker kit: thick ink outlines, hard offset shadows, loud colour on
 * cream paper. Shared in spirit with Chaos Club, so the two read as siblings.
 */

export type PaletteColor = 'tomato' | 'sky' | 'lime' | 'grape' | 'sun' | 'bubblegum'

/**
 * Literal classes per palette colour. Tailwind only ships classes it can see
 * written out in full, so never build `bg-${color}` strings: use this.
 */
export const COLOR: Record<PaletteColor, { bg: string; soft: string; text: string; border: string }> = {
  tomato: { bg: 'bg-tomato', soft: 'bg-tomato-soft', text: 'text-tomato', border: 'border-tomato' },
  sky: { bg: 'bg-sky', soft: 'bg-sky-soft', text: 'text-sky', border: 'border-sky' },
  lime: { bg: 'bg-lime', soft: 'bg-lime-soft', text: 'text-lime', border: 'border-lime' },
  grape: { bg: 'bg-grape', soft: 'bg-grape-soft', text: 'text-grape', border: 'border-grape' },
  sun: { bg: 'bg-sun', soft: 'bg-sun-soft', text: 'text-sun', border: 'border-sun' },
  bubblegum: { bg: 'bg-bubblegum', soft: 'bg-bubblegum-soft', text: 'text-bubblegum', border: 'border-bubblegum' },
}

/** The accent a game declares on the server, as a palette colour. */
const ACCENT_TO_COLOR: Record<string, PaletteColor> = {
  violet: 'grape',
  rose: 'tomato',
  emerald: 'lime',
  amber: 'sun',
  sky: 'sky',
}

export const colorOf = (accent: string): PaletteColor => ACCENT_TO_COLOR[accent] ?? 'grape'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `ghost` is the outlined white sticker, kept under its old name. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'dark' | 'subtle'
  /** Paint the button in a palette colour instead of the variant's. */
  color?: PaletteColor
  size?: 'sm' | 'md' | 'lg' | 'xl'
  block?: boolean
  loading?: boolean
  /** Emoji before the label. */
  icon?: ReactNode
}

const VARIANT = {
  primary: 'bg-sun text-ink',
  secondary: 'bg-white text-ink',
  ghost: 'bg-white text-ink',
  danger: 'bg-tomato text-ink',
  success: 'bg-lime text-ink',
  dark: 'bg-ink text-paper',
  subtle: 'border-transparent bg-transparent text-ink shadow-none underline decoration-2 underline-offset-4',
}

const SIZE = {
  sm: 'min-h-11 px-3.5 text-sm rounded-xl gap-1.5',
  md: 'min-h-12 px-5 text-base rounded-2xl gap-2',
  lg: 'min-h-14 px-6 text-lg rounded-2xl gap-2',
  xl: 'min-h-16 px-7 text-xl rounded-3xl gap-2.5',
}

/** Chunky sticker button that squishes into its shadow when pressed. */
export function Button({
  variant = 'primary',
  color,
  size = 'md',
  block,
  loading,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const flat = variant === 'subtle'
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading === true}
      className={clsx(
        'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-display font-extrabold leading-tight',
        'border-3 border-ink transition-[transform,box-shadow] duration-100 ease-out',
        !flat && 'shadow-hard hover:-translate-x-px hover:-translate-y-px hover:shadow-hard-lg',
        !flat && 'active:translate-x-[4px] active:translate-y-[4px] active:shadow-none',
        flat && 'active:scale-95',
        'disabled:translate-x-0 disabled:translate-y-0 disabled:opacity-55 disabled:saturate-50',
        !flat && 'disabled:shadow-hard-sm',
        color !== undefined ? `${COLOR[color].bg} text-ink` : VARIANT[variant],
        SIZE[size],
        block === true && 'w-full',
        className,
      )}
    >
      {loading === true ? (
        <Dots size="sm" />
      ) : icon !== undefined ? (
        <span className="text-[1.2em] leading-none" aria-hidden>{icon}</span>
      ) : null}
      {children}
    </button>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        'min-h-14 w-full min-w-0 rounded-2xl border-3 border-ink bg-white px-4 text-lg font-semibold text-ink shadow-hard-sm',
        'placeholder:font-normal placeholder:text-ink/40 focus:shadow-hard focus:outline-none',
        className,
      )}
    />
  )
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** A palette colour, its soft tint, white (default), paper or ink. */
  color?: PaletteColor | 'white' | 'paper' | 'ink'
  soft?: boolean
  /** Slight sticker rotation. */
  tilt?: 'left' | 'right' | 'none'
  shadow?: 'none' | 'sm' | 'md' | 'lg'
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

const TILT = { left: '-rotate-1', right: 'rotate-1', none: '' }
const SHADOW = { none: '', sm: 'shadow-hard-sm', md: 'shadow-hard', lg: 'shadow-hard-lg' }
const PAD = { none: '', sm: 'p-3', md: 'p-5', lg: 'p-6' }

/** A sticker: thick outline, hard shadow, optional tilt. */
export function Card({ color = 'white', soft, tilt = 'none', shadow = 'md', padding = 'md', className, ...rest }: CardProps) {
  const bg =
    color === 'white'
      ? 'bg-white'
      : color === 'paper'
        ? 'bg-paper'
        : color === 'ink'
          ? 'bg-ink text-paper'
          : soft === true
            ? COLOR[color].soft
            : COLOR[color].bg
  return <div {...rest} className={clsx('rounded-3xl border-3 border-ink', bg, TILT[tilt], SHADOW[shadow], PAD[padding], className)} />
}

export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={clsx('mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pb-24 pt-6', className)}>{children}</main>
  )
}

/** The wordmark: two stickers, slightly askew. `compact` is the header chip. */
export function Logo({ compact = false, as: Tag = 'h1' }: { compact?: boolean; as?: 'h1' | 'div' }) {
  if (compact) {
    return (
      <Tag className="inline-flex -rotate-2 items-center rounded-xl border-3 border-ink bg-ink px-2.5 py-1 font-chunky text-xs leading-none text-sun shadow-hard-sm">
        FZ
      </Tag>
    )
  }
  return (
    <Tag className="flex flex-col items-center gap-1 font-chunky leading-[0.9]">
      <span className="text-outline inline-block -rotate-3 rounded-2xl border-4 border-ink bg-grape px-4 pb-1 pt-2 text-[2.9rem] text-paper shadow-hard-lg sm:text-7xl">
        FRIEND
      </span>
      <span className="text-outline inline-block rotate-2 rounded-2xl border-4 border-ink bg-bubblegum px-4 pb-1 pt-2 text-[2.9rem] text-paper shadow-hard-lg sm:text-7xl">
        ZONE
      </span>
    </Tag>
  )
}

/** Shouty outlined headline: "GOT IT!", "YOUR TURN", the big reveal. */
export function BigText({
  children,
  color = 'sun',
  size = 'lg',
  as: Tag = 'h2',
  className,
}: {
  children: ReactNode
  color?: PaletteColor | 'white' | 'ink'
  size?: 'md' | 'lg' | 'xl'
  as?: ElementType
  className?: string
}) {
  const fill = color === 'white' ? 'text-white' : color === 'ink' ? 'text-ink' : COLOR[color].text
  return (
    <Tag
      className={clsx(
        'animate-pop break-words font-display font-extrabold leading-[0.95]',
        color !== 'ink' && 'text-outline [text-shadow:3px_3px_0_var(--color-ink)]',
        size === 'md' ? 'text-3xl sm:text-4xl' : size === 'lg' ? 'text-4xl sm:text-5xl' : 'text-5xl sm:text-7xl',
        fill,
        className,
      )}
    >
      {children}
    </Tag>
  )
}

/** A presence dot. Colour and the label together, never colour alone. */
export function PresenceDot({ presence }: { presence: string }) {
  const colour =
    presence === 'CONNECTED' ? 'bg-lime' : presence === 'DISCONNECTED' ? 'bg-sun animate-soft-pulse' : 'bg-ink/20'
  const label = presence === 'CONNECTED' ? 'Connected' : presence === 'DISCONNECTED' ? 'Reconnecting' : 'Away'
  return (
    <span
      className={clsx('inline-block size-3 shrink-0 rounded-full border-2 border-ink', colour)}
      title={label}
      aria-label={label}
    />
  )
}

/** Small sticker label: "HOST", "Round 2 / 8", "+150". */
export function Badge({
  children,
  color = 'white',
  size = 'sm',
  className,
}: {
  children: ReactNode
  color?: PaletteColor | 'white' | 'ink'
  size?: 'sm' | 'md'
  className?: string
}) {
  const bg = color === 'white' ? 'bg-white text-ink' : color === 'ink' ? 'bg-ink text-paper' : `${COLOR[color].bg} text-ink`
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border-2 border-ink font-display font-bold leading-none',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        bg,
        className,
      )}
    >
      {children}
    </span>
  )
}

/** The old name for a white badge; games still use it for headers. */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge size="md" {...(className === undefined ? {} : { className })}>
      {children}
    </Badge>
  )
}

/** An emoji in a sticker circle. */
export function Avatar({
  emoji,
  size = 'md',
  color,
  host,
  dim,
  className,
}: {
  emoji: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  color?: PaletteColor
  host?: boolean
  dim?: boolean
  className?: string
}) {
  const sizes = {
    xs: 'size-7 text-base border-2',
    sm: 'size-9 text-xl border-2',
    md: 'size-12 text-2xl border-3',
    lg: 'size-16 text-4xl border-3',
    xl: 'size-24 text-6xl border-4',
  }
  return (
    <span
      className={clsx(
        'relative grid shrink-0 place-items-center rounded-full border-ink leading-none',
        sizes[size],
        color !== undefined ? COLOR[color].soft : 'bg-white',
        dim === true && 'opacity-45 grayscale',
        className,
      )}
    >
      <span aria-hidden>{emoji}</span>
      {host === true && (
        <span className="absolute -right-1.5 -top-2.5 rotate-12 text-[0.55em] drop-shadow-[1px_1px_0_var(--color-ink)]" aria-label="host">
          👑
        </span>
      )}
    </span>
  )
}

/**
 * The face picker shown when creating or joining a room. The big button
 * shuffles; the grid picks. Only faces the server accepts are offered.
 */
export function AvatarPicker({ value, onChange }: { value: string; onChange: (avatar: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-display text-sm font-bold uppercase tracking-wide">Pick your face</legend>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
        {AVATARS.map((a) => (
          <button
            key={a}
            type="button"
            aria-label={`Avatar ${a}`}
            aria-pressed={a === value}
            onClick={() => onChange(a)}
            className={clsx(
              'grid aspect-square min-h-11 place-items-center rounded-xl border-2 text-2xl transition-transform',
              a === value ? 'scale-110 border-ink bg-sun shadow-hard-sm' : 'border-transparent hover:bg-ink/5 active:scale-90',
            )}
          >
            {a}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/** The big shuffle button that sits next to the name field. */
export function AvatarShuffle({ value, onShuffle }: { value: string; onShuffle: () => void }) {
  return (
    <button
      key={value}
      type="button"
      onClick={onShuffle}
      aria-label="Random face"
      title="Random face"
      className="grid size-14 shrink-0 animate-pop place-items-center rounded-full border-3 border-ink bg-sun-soft text-3xl shadow-hard-sm active:scale-90"
    >
      {value}
    </button>
  )
}

export function EmptyState({ emoji, title, hint }: { emoji: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <div className="animate-float text-5xl" aria-hidden>{emoji}</div>
      <p className="font-display text-lg font-extrabold">{title}</p>
      {hint !== undefined && <p className="max-w-xs text-sm text-ink-soft">{hint}</p>}
    </div>
  )
}

/** Three bouncing blobs. */
export function Dots({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dot = size === 'sm' ? 'size-1.5' : size === 'lg' ? 'size-4' : 'size-2.5'
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {['bg-tomato', 'bg-sun', 'bg-sky'].map((c, i) => (
        <span
          key={c}
          className={clsx(dot, c, 'animate-bounce-dot rounded-full border-2 border-ink')}
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-ink-soft" role="status">
      <Dots size="lg" />
      <span className="font-display text-sm font-bold">{label}</span>
    </div>
  )
}
