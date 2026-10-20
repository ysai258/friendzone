/**
 * Every player has an emoji so the lobby reads at a glance.
 *
 * A player picks one when they create or join a room. Someone who does not
 * pick (an older client, or a script) gets one derived from their player id,
 * so it still survives a reconnect without storage of its own.
 *
 * Picks are limited to this list, which keeps a player from passing off a
 * string of text, or forty emoji, as a face.
 */
export const AVATARS = [
  '😎', '🤠', '🥸', '🤓', '😈', '👻', '🤖', '👽', '🐸', '🐼',
  '🦊', '🐯', '🦁', '🐵', '🐧', '🦄', '🐙', '🦖', '🐝', '🦩',
  '🐳', '🦉', '🐢', '🐨', '🐰', '🦥', '🐷', '🦦', '🍕', '🌮',
  '🥭', '🌶️', '🧋', '🍩', '🔥', '⚡', '🌈', '💀', '🎸', '🏏',
  '🎯', '🛺', '🪩', '🧠', '🍿', '🎬', '🎧', '👑',
] as const

export type Avatar = (typeof AVATARS)[number]

export function isAvatar(value: string): value is Avatar {
  return (AVATARS as readonly string[]).includes(value)
}

export function avatarFor(playerId: string): string {
  let h = 0
  for (let i = 0; i < playerId.length; i++) h = (Math.imul(h, 31) + playerId.charCodeAt(i)) | 0
  return AVATARS[Math.abs(h) % AVATARS.length] as string
}

export function randomAvatar(): Avatar {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)] as Avatar
}

export const AVATAR_COUNT = AVATARS.length
