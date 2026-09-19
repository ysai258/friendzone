import type { ErrorCode } from './errors.ts'

/**
 * Validation inside the game reducers returns a Result rather than throwing.
 * A rejected action is an ordinary outcome — a player tapped twice, a round
 * expired mid-flight — and the reducers stay pure and cheap to test when that
 * path is a value instead of an exception.
 */
export type Result<T, E = ActionRejection> = { ok: true; value: T } | { ok: false; error: E }

export interface ActionRejection {
  code: ErrorCode
  message?: string
}

export const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E,>(error: E): Result<never, E> => ({ ok: false, error })
export const reject = (code: ErrorCode, message?: string): Result<never, ActionRejection> => ({
  ok: false,
  error: message === undefined ? { code } : { code, message },
})
export const accept: Result<void, never> = { ok: true, value: undefined }
