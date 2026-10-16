/**
 * A bot's indicator, continued by one candle at each minute's close, WITHOUT ever recomputing anything from the start. Everything is the page's code: the player is its description in `players.ts`
 * (`playerLoader` for a band or a trend follower, its `intrabar` for a zone oscillator: the same step as its loader, called one candle at a time), and its side conditions are `playerFlips` (`levelFlips.ts`).
 *
 * The 24 hours that leave. The bot holds only its last `MARKET_BARS` candles (references to the market's candles, not copies) and its output arrays, counted from ITS first candle (the page's index 0, which
 * the indicators read: the warm-up of an average, the "no value yet before the period"); what is older is deleted (`RollingBars`, `bandLoader`). Without changing a decision, because, of all the indicators
 * read, nothing is further than 2 x 240 + 2 candles behind the current candle, except what a recurrence carries, and that one carries it in its OUTPUT (the last value of the EMA, of Wilder's ATR, of the RSI, of the
 * VWAP's sums, of the OBV...), which is never recomputed, hence never warmed up again:
 *   - the pure windows (CCI, MFI, Ultimate, Z-score, Bollinger, envelopes, SMA, Donchian, Aroon, Vortex, Ichimoku, Awesome, Momentum, CMF) read only the candles of their period;
 *   - the recurrences (EMA, MACD, TRIX, TSI, Force, Heikin-Ashi, SuperTrend, Parabolic SAR, ATR stop, ADX, OBV, cumulative delta, daily VWAP, RSI) read their previous value and, at most, their period of candles;
 *   - the stochastic keeps two queues of indices in a window of its period; the stochastic RSI adds its RSI values, bounded by its period (`rsiStochasticIntrabar`);
 *   - the warm-ups that read from index 0 (Wilder's ATR at bar n - 1, the ADX at bars n and 2n - 1) fall in the first 481 candles, which the bot all receives (the 24 h warm-up) before the first one leaves.
 */

import { botBits } from './core/botFlips'
import type { BotLien } from './core/radinusMessages'
import { playerFlips, playerLoader } from './core/players'
import type { PlayerRule, PlayerSeries, TablePlayer } from './core/players'
import { rollingBars } from './core/zonesBench'
import type { BenchBar, Intrabar } from './core/zonesBench'
import { MARKET_BARS } from './market'

export type IndicatorSetup = { def: TablePlayer; settings: number[]; rule: PlayerRule; low: number; high: number }

export class Indicator {
  private readonly setup: IndicatorSetup
  private readonly bars = rollingBars(MARKET_BARS)
  private readonly delta: number[] = []
  private n = 0
  /** A zone oscillator: its step (`intrabar`) and its last two values; a band or a follower: its loader, which continues in place, and its lines. */
  private readonly ib: Intrabar | null
  private readonly load: ((bars: BenchBar[], delta: number[]) => PlayerSeries) | null
  private prevValue = NaN
  private value = NaN
  private lines: number[][] | null = null

  constructor(setup: IndicatorSetup) {
    this.setup = setup
    const def = setup.def
    this.ib = def.shape === 'zone' && def.intrabar !== undefined ? def.intrabar(setup.settings) : null
    this.load = this.ib === null ? playerLoader(def, setup.settings) : null
  }

  /** The next closed candle (and its volume delta, which only the cumulative delta reads): the indicator moves one step. */
  push(bar: BenchBar, delta: number): void {
    const i = this.n++
    this.bars[i] = bar
    this.delta[i] = delta
    if (i >= MARKET_BARS) {
      delete this.bars[i - MARKET_BARS]
      delete this.delta[i - MARKET_BARS]
    }
    if (this.ib !== null) {
      const v = this.ib.peek(this.bars, i)
      this.ib.push(this.bars, i)
      this.prevValue = this.value
      this.value = v
    } else if (this.load !== null) this.lines = this.load(this.bars, this.delta).lines
  }

  /** The side conditions of the last candle (`LONG_ON` | `SHORT_ON`), by `playerFlips` on the last two candles and values: a condition reads only its candle and the one before (the Squeeze carries "squeezed or not" from one candle to the next: the candle before gives it). */
  bits(): number {
    const n = this.n
    const len = Math.min(2, n)
    const tail: BenchBar[] = []
    for (let k = n - len; k < n; k++) tail.push(this.bars[k])
    const lines = this.lines
    const series: PlayerSeries = this.ib !== null
      ? { values: len === 2 ? [this.prevValue, this.value] : [this.value], lines: null }
      : { values: null, lines: lines === null ? null : lines.map((a) => (len === 2 ? [a[n - 2], a[n - 1]] : [a[n - 1]])) }
    const raw = new Uint8Array(len)
    const { def, settings, rule, low, high } = this.setup
    playerFlips(tail, series, def, rule, low, high, settings, 0, raw)
    return raw[len - 1]
  }

  /** What the indicator is worth at the last candle: an oscillator's value, a band's or a follower's lines (for the journal). */
  current(): number[] {
    if (this.ib !== null) return [this.value]
    const n = this.n
    return this.lines === null ? [] : this.lines.map((a) => a[n - 1])
  }

  /** How many candles the indicator has received since the bot's launch (its age; it holds only `MARKET_BARS` of them). */
  get pushed(): number {
    return this.n
  }

  /** The candles the bot still holds, by reference (proof 6 counts them). */
  held(): { bars: number; ref: BenchBar[] } {
    const ref: BenchBar[] = []
    this.bars.forEach((b) => ref.push(b))
    return { bars: ref.length, ref }
  }
}

/**
 * The indicators of a bot launched from `/bot` (`compose`): one `Indicator` per member, each continued bar by bar with its own settings, and their raw side conditions joined at each close by `botBits` (`site/src/core/botFlips.ts`, the function the page's
 * bot row uses, the links applied left to right). `botBits` reads whole arrays and `filtre` remembers the last side the left one held, so each member keeps its conditions of the last `MARKET_BARS` bars (the seed included) and `botBits` runs on those:
 * the last value is the page's, unless a `filtre`'s left indicator has said nothing for 24 hours, where the page remembers further back.
 */
export class Chain {
  private readonly members: Indicator[]
  private readonly links: BotLien[]
  private readonly history: number[][]

  constructor(setups: IndicatorSetup[], links: BotLien[]) {
    this.members = setups.map((s) => new Indicator(s))
    this.links = links
    this.history = setups.map(() => [])
  }

  push(bar: BenchBar, delta: number): void {
    this.members.forEach((m, k) => {
      m.push(bar, delta)
      const h = this.history[k]
      h.push(m.bits())
      if (h.length > MARKET_BARS) h.shift()
    })
  }

  /** The bot's conditions at the last bar: the members' joined by the links. */
  bits(): number {
    const joined = botBits(this.history.map((h) => Uint8Array.from(h)), this.links)
    return joined[joined.length - 1]
  }

  /** Each member's own conditions at the last bar (for the journal). */
  memberBits(): number[] {
    return this.history.map((h) => h[h.length - 1])
  }

  /** The members' values at the last bar, one after the other. */
  current(): number[] {
    return this.members.flatMap((m) => m.current())
  }

  get pushed(): number {
    return this.members[0].pushed
  }
}

/** What a bot continues at each close, a single player's indicator or a composed bot's chain. */
export type Signals = Indicator | Chain
