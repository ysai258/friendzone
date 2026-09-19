/**
 * Every player gets an emoji so the lobby reads at a glance. Derived from the
 * player id, so it survives a reconnect and needs no storage of its own.
 */
const AVATARS = [
  '🦊', '🐼', '🐸', '🦉', '🐙', '🦄', '🐝', '🦖', '🐧', '🦁',
  '🐳', '🦑', '🐢', '🦩', '🐨', '🦔', '🐬', '🦚', '🐯', '🦝',
  '🐰', '🦜', '🐺', '🦥', '🐌', '🦫', '🐷', '🦦', '🐮', '🦨',
]

export function avatarFor(playerId: string): string {
  let h = 0
  for (let i = 0; i < playerId.length; i++) h = (Math.imul(h, 31) + playerId.charCodeAt(i)) | 0
  return AVATARS[Math.abs(h) % AVATARS.length] as string
}

export const AVATAR_COUNT = AVATARS.length
