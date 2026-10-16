/**
 * The bot's row id, and what `radinus/` still reads of a composed bot: `botBits` joins the raw side conditions of a composed bot's indicators by the links (`radinus/` runs it for the bots it launches), `BOT_DEF` is the bot's row, `onlyOf` the side a `cote` allows.
 * The page has no indicator chain any more: the bot is its script (`botScript.ts`). No React import.
 */

import { LONG_ON, SHORT_ON, sideOf } from './levelFlips'
import type { PlayerRule, TablePlayer } from './players'
import type { BotCote, BotLien } from './radinusMessages'

/** The id of the bot's row in the store, beside the players'. */
export const BOT_ID = 'bot'
/** The most indicators a composed bot has (`radinus/`). */
export const BOT_MAX = 3

/** The side a `cote` allows: 1 long only, -1 short only, 0 both. */
export const onlyOf = (cote: BotCote): 1 | 0 | -1 => (cote === 'long' ? 1 : cote === 'short' ? -1 : 0)

/**
 * Two sides (1 long, -1 short, 0 none) joined per bar by `lien`. `et`: the same side on both, else nothing. `ou`: the side of the one that has one; both with a side must agree, else nothing. `filtre`: the left one decides but only at the bar where it
 * turns to a side it did not hold (its fresh signal, the convention of `flipsFrom`), and only if the right one says that side then; a right one that agrees later does not bring the entry back, and the output is that one-bar signal, not a state.
 */
function linked(left: Int8Array, right: Int8Array, lien: BotLien): Int8Array {
  const out = new Int8Array(left.length)
  let last = 0
  for (let i = 0; i < left.length; i++) {
    const a = left[i]
    const b = right[i]
    if (lien === 'et') out[i] = a !== 0 && a === b ? a : 0
    else if (lien === 'ou') out[i] = a === 0 ? b : b === 0 || a === b ? a : 0
    else {
      const fresh = a !== 0 && a !== last
      if (a !== 0) last = a
      out[i] = fresh && a === b ? a : 0
    }
  }
  return out
}

/** The bot's raw conditions from its indicators' (`rows[k]` = indicator k's, one byte per bar), the links applied from left to right: the result of the first two is joined to the third by the second link. */
export function botBits(rows: Uint8Array[], liens: BotLien[]): Uint8Array {
  const sides = (bits: Uint8Array): Int8Array => Int8Array.from(bits, sideOf)
  let acc = sides(rows[0])
  for (let k = 1; k < rows.length; k++) acc = linked(acc, sides(rows[k]), liens[k - 1])
  return Uint8Array.from(acc, (s) => (s === 1 ? LONG_ON : s === -1 ? SHORT_ON : 0))
}

/** The row of the bot in the store: a player with nothing of its own (no series, no settings, no signals). */
export const BOT_DEF: TablePlayer = { shape: 'trend', id: BOT_ID, letter: 'B', color: '#ffd400', name: 'Bot', settings: [], shown: false, rule: null, rules: [], pane: false, range: null, lines: [], levels: [], loader: () => () => [], flips: () => [] }

/** The fields a player's script is written from (`scriptOf`): its settings in the order of its description, its two thresholds (NaN for a player with none) and its rule. */
export type IndicatorFields = { settings: number[]; low: number; high: number; rule: PlayerRule }
