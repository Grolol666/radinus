/**
 * A data source: what `direct` and `controler` read from outside, in one place. A module is a file of this folder that
 * exports `source: Source`; `--source <name>` loads `./<name>.ts`, by name, so a module can be left out of a tree
 * without any other file naming it. This tree ships `lighter` (Lighter's public API, no key); other modules may exist.
 * `guardNetwork` (`../guard.ts`) lets the program reach the chosen module's hosts and nothing else.
 */

import type { LighterMarketLimits, LighterMarketOverview, LighterTapeMinute, LighterTick, LighterTrade } from '../core/lighter'
import type { LighterConnectionState } from '../core/lighterStream'

export type LiveLoaders = {
  /** Opens the source's socket (one for every market); no effect when it is already open. */
  connect: () => void
  /** The prints of a market as they are pushed (the subscription's own seed of recent prints left out); returns the unsubscribe. */
  trades: (marketId: number, onTrades: (trades: LighterTrade[]) => void) => () => void
  connection: () => LighterConnectionState
  /** Called on every change of the socket's state. */
  onConnection: (cb: () => void) => () => void
  /** The 1-minute candles of a market from `fromS` (epoch seconds) to now, oldest first, `t` in seconds. */
  minutes: (marketId: number, fromS: number) => Promise<{ bars: LighterTapeMinute[]; requests: number }>
  /**
   * The prints of a market from `fromMs` to `toMs` (or now), oldest first. `synthetic` = the source has no prints
   * history and gave one print per closed minute instead (at the close, the minute's last trade id and its volume):
   * the engine says so where it uses them (the catch-up after a cut) and `controler`, which needs real prints, refuses.
   */
  ticks: (marketId: number, fromMs: number, toMs?: number) => Promise<{ ticks: LighterTick[]; requests: number; failed: boolean; synthetic: boolean }>
  /** The last `limit` prints of a market (at most what the source gives in one read), oldest first; `[]` when the read fails or the market has none. */
  lastPrints: (marketId: number, limit: number) => Promise<LighterTick[]>
  fundingPage: (marketId: number, endS: number) => Promise<{ timestamp: number; value: number | null }[] | null>
  markets: () => Promise<LighterMarketOverview[]>
  limits: (marketId: number) => Promise<LighterMarketLimits | null>
}

export type Source = {
  name: string
  /** The hosts `fetch` may reach. */
  fetchHosts: string[]
  /** The hosts a socket may open on. */
  socketHosts: string[]
  loaders: LiveLoaders
}

/** The source module named `name`, or a one-sentence error when this tree has no such module. */
export async function loadSource(name: string): Promise<Source> {
  const unknown = new Error(`unknown source "${name}": src/sources/${name}.ts is not a data module of this build (the default is --source lighter)`)
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name === 'types') throw unknown
  let mod: { source?: Source }
  try {
    mod = (await import(`./${name}.ts`)) as { source?: Source }
  } catch {
    throw unknown
  }
  if (mod.source === undefined) throw unknown
  return mod.source
}
