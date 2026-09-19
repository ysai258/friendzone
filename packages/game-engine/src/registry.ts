import { AppError, type GameCatalogEntry } from '@friendzone/shared'
import type { ErasedGameDefinition } from './types.ts'

/**
 * The registry is the whole of the room service's game knowledge. It looks a
 * game up by id and calls the interface; there is no branch anywhere in the
 * server on which game is running. Adding one is a single line here.
 */
export class GameRegistry {
  private readonly byId = new Map<string, ErasedGameDefinition>()

  constructor(definitions: ErasedGameDefinition[]) {
    for (const def of definitions) {
      if (this.byId.has(def.id)) throw new Error(`duplicate game id: ${def.id}`)
      this.byId.set(def.id, def)
    }
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** Throws the client-safe UNKNOWN_GAME rather than returning undefined: every
   *  caller would otherwise repeat the same check. */
  get(id: string): ErasedGameDefinition {
    const def = this.byId.get(id)
    if (def === undefined) throw new AppError('UNKNOWN_GAME', `No game registered as "${id}".`)
    return def
  }

  list(): ErasedGameDefinition[] {
    return [...this.byId.values()]
  }

  /** Everything the lobby needs to render game cards and the host settings form. */
  catalog(): GameCatalogEntry[] {
    return this.list().map((def) => ({
      id: def.id,
      name: def.meta.name,
      tagline: def.meta.tagline,
      description: def.meta.description,
      emoji: def.meta.emoji,
      accent: def.meta.accent,
      minPlayers: def.minPlayers,
      maxPlayers: def.maxPlayers,
      estimatedMinutes: def.meta.estimatedMinutes,
      settings: def.settingsSpec,
      playable: def.meta.playable,
    }))
  }

  /** Defaults straight from the declared spec, so the form and the server agree. */
  defaultSettings(id: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of this.get(id).settingsSpec) out[field.key] = field.default
    return out
  }
}
