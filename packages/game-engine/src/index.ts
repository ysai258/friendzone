export * from './types.ts'
export * from './content.ts'
export * from './scoring.ts'
export * from './selection.ts'
export * from './registry.ts'

import { GameRegistry } from './registry.ts'
import { blurBattle } from './games/blur-battle.ts'
import { whoAmI } from './games/who-am-i.ts'
import { emojiMovie } from './games/emoji-movie.ts'
import { mindMeld } from './games/mind-meld.ts'
import { movieMafia } from './games/movie-mafia.ts'
import { paataPattu } from './games/paata-pattu.ts'
export { songCatalog, type CatalogEntry } from './games/paata-pattu.ts'

export { blurBattle, whoAmI, emojiMovie, mindMeld, movieMafia, paataPattu }

/**
 * Every game the platform knows about. This list is the only place the server
 * learns a game exists; nothing downstream branches on which one is running.
 */
export const gameRegistry = new GameRegistry([blurBattle, emojiMovie, mindMeld, whoAmI, movieMafia, paataPattu])

export const DEFAULT_GAME_ID = blurBattle.id
