/**
 * A player's raw side at the last closed minute, for the bot's script (`state.side(...)`, `botScript.ts`): the SAME conditions `/rsi` reads for that player with those settings, thresholds and rule, computed one closed bar at a time, no React.
 * Nothing is rewritten: the series come from the player's own loader (`playerLoader`; a zone oscillator from its one-bar continuation `intrabar`, the one `radinus/` runs) and the side from `playerFlips`' own `raw` conditions, read on a window of the last two bars
 * (every player's condition at bar i reads its series at i and i - 1 at most: the zone `exit` rule's previous value, the Squeeze's previous compression).
 */

import { sideOf } from './levelFlips'
import { BOT_PLAYERS, REGIME_PLAYER, playerFlips, playerLoader } from './players'
import type { PlayerRule, PlayerSeries, TablePlayer } from './players'
import { rollingBars } from './zonesBench'
import type { BenchBar, Intrabar } from './zonesBench'

/** What a script may say of a player beyond its settings: a zone oscillator's two thresholds, and the rule (a zone's `zone` | `exit`, a band's `retour` | `cassure`, the MACD's `cross` | `zero`). Absent = the player's default. */
export type SideOpts = { low?: number; high?: number; rule?: string | null }

/** A player with its settings in `settings` order, its thresholds (NaN for a player with none) and its rule, all checked. */
export type SideSpec = { def: TablePlayer; settings: number[]; low: number; high: number; rule: PlayerRule }

/** The spec of `player` (an id of `BOT_PLAYERS`: the regime or a `/rsi` player) from the script's by-key settings and options, or the sentence saying what is wrong. */
export function sideSpecOf(player: string, settings: Record<string, number> | undefined, opts: SideOpts | undefined): SideSpec | string {
  const def = BOT_PLAYERS.find((d) => d.id === player)
  if (def === undefined) return `unknown player ${JSON.stringify(player)}`
  const given = settings ?? {}
  for (const [key, v] of Object.entries(given)) {
    if (!def.settings.some((s) => s.key === key)) return `${player}: unknown setting ${key} (${def.settings.map((s) => s.key).join(', ') || 'none'})`
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${player}: setting ${key} must be a number`
  }
  // The regime has no thresholds and no rule: low / high / rule are ignored for it.
  const o: SideOpts = def === REGIME_PLAYER ? {} : opts ?? {}
  for (const key of Object.keys(o)) if (key !== 'low' && key !== 'high' && key !== 'rule') return `${player}: unknown option ${key} (low, high, rule)`
  if (def.shape !== 'zone' && (o.low !== undefined || o.high !== undefined)) return `${player}: has no thresholds`
  for (const v of [o.low, o.high]) if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return `${player}: low and high must be numbers`
  let rule: PlayerRule = def.rule
  if (o.rule !== undefined && o.rule !== null) {
    const known = def.shape === 'zone' ? ['zone', 'exit'] : def.shape === 'band' ? (def.rule === null ? [] : ['retour', 'cassure']) : def.rules.map((r) => r.id as string)
    if (!known.includes(o.rule)) return `${player}: rule ${JSON.stringify(o.rule)} is not one of ${known.length === 0 ? 'none (it has no choice)' : known.join(', ')}`
    rule = o.rule as PlayerRule
  }
  return { def, settings: def.settings.map((s) => given[s.key] ?? s.def), low: def.shape === 'zone' ? o.low ?? def.low : NaN, high: def.shape === 'zone' ? o.high ?? def.high : NaN, rule }
}

/** A band player's lines at one close. */
export type SideLines = { upper: number; lower: number; middle: number }

/** A bar where a player's side becomes long (`side` 1) or short (-1): `t` is the bar's start (s). */
export type SideMark = { t: number; side: 1 | -1 }

/**
 * The marks of a player over `bars` from bar `from` on, pushed onto `out`: a bar whose side (the raw conditions `SideRun` reads, one byte per bar from `playerFlips`) is long or short and differs from the previous bar's side (`prev` = the side of bar `from - 1`). A return to none draws nothing, the same side again after a bar of none is a new mark.
 * Read on the window `from - 1 ..` only (a condition at bar i reads the series at i and i - 1 at most, as `SideRun`), so a caller with bars and series that only grew moves over the new bars; from 0 it is the whole run. Returns the side of the last bar.
 * Computed on any bars, the 1-minute ones, the 1-second candles or the Lighter chart's.
 */
export function sideMarksFrom(bars: BenchBar[], series: PlayerSeries, spec: SideSpec, from: number, prev: 1 | 0 | -1, out: SideMark[]): 1 | 0 | -1 {
  const w = Math.max(0, from - 1)
  const cut = <T>(a: T[]): T[] => (w === 0 ? a : a.slice(w))
  const raw = new Uint8Array(bars.length - w)
  playerFlips(cut(bars), { values: series.values === null ? null : cut(series.values), lines: series.lines === null ? null : series.lines.map(cut) }, spec.def, spec.rule, spec.low, spec.high, spec.settings, 0, raw)
  for (let i = from; i < bars.length; i++) {
    const s = sideOf(raw[i - w])
    if (s !== 0 && s !== prev) out.push({ t: bars[i].t, side: s })
    prev = s
  }
  return prev
}

/**
 * One (player, settings, thresholds, rule) followed bar by bar: moved over the closes that are new since the last call, never from the first bar. One per replay and per distinct call of the script.
 * It holds its own copy of the bars and deltas it was fed (`own`, `ownDelta`: references, indexed from its first bar `from`), and the player reads them, so a run born on a window of bars (`radinus/`, `CANDLES_KEPT`) warms up from that window's first bar as the page does from its first;
 * `keep` bounds that copy as `radinus/indicator.ts` bounds a /rsi bot's (entries older than `keep` bars deleted). On the page `from` is 0 and `keep` Infinity: the same bars at the same indices.
 */
export class SideRun {
  private fed = 0
  private memo: 1 | 0 | -1 = 0
  /** The player's own value at the close of bar `fed - 1` (the last element of `series.values`), memoised with `memo`; NaN when the player has no single value (`values === null`). */
  private memoValue = NaN
  /** A band player's upper, lower and middle at the close of bar `fed - 1`, memoised with `memo`; all NaN for any other player or while its lines warm up. */
  private memoLines: SideLines = { upper: NaN, lower: NaN, middle: NaN }
  private intra: Intrabar | null = null
  private load!: (bars: BenchBar[], delta: number[]) => PlayerSeries
  private own = rollingBars(Infinity)
  private ownDelta: number[] = []
  /** How many of `own`'s first entries are deleted. */
  private trimmed = 0
  private prev = NaN
  private cur = NaN
  private readonly spec: SideSpec
  private readonly from: number
  private readonly keep: number

  constructor(spec: SideSpec, from = 0, keep = Infinity) {
    this.spec = spec
    this.from = from
    this.keep = keep
    this.start()
  }

  private start() {
    const { def, settings } = this.spec
    this.fed = this.from
    this.memo = 0
    this.memoValue = NaN
    this.memoLines = { upper: NaN, lower: NaN, middle: NaN }
    this.intra = def.shape === 'zone' && def.intrabar !== undefined ? def.intrabar(settings) : null
    this.load = playerLoader(def, settings)
    this.own = rollingBars(this.keep)
    this.ownDelta = []
    this.trimmed = 0
    this.prev = NaN
    this.cur = NaN
  }

  /** The side (1 long, -1 short, 0 none) at the close of bar `closed - 1`: `bars` are the candles (only `from` to `closed - 1` are read), `delta` the per-minute aggressor delta (read by the players that ask for it). */
  at(bars: readonly BenchBar[], delta: number[], closed: number): 1 | 0 | -1 {
    if (closed === this.fed) return this.memo
    if (closed < this.fed) this.start()
    if (closed <= this.from) return 0
    const { def, settings, low, high, rule } = this.spec
    const own = this.own
    const i = closed - 1 - this.from
    const window = <T>(a: T[]): T[] => (i >= 1 ? [a[i - 1], a[i]] : [a[i]])
    for (let j = this.fed; j < closed; j++) {
      own.push(bars[j])
      this.ownDelta.push(delta[j])
    }
    let series: PlayerSeries
    if (this.intra !== null) {
      for (let j = this.fed - this.from; j <= i; j++) {
        const v = this.intra.peek(own, j)
        this.intra.push(own, j)
        this.prev = this.cur
        this.cur = v
      }
      series = { values: i >= 1 ? [this.prev, this.cur] : [this.cur], lines: null }
    } else {
      const s = this.load(own, this.ownDelta)
      series = { values: s.values === null ? null : window(s.values), lines: s.lines === null ? null : s.lines.map(window) }
    }
    this.fed = closed
    const raw = new Uint8Array(i >= 1 ? 2 : 1)
    playerFlips(window(own), series, def, rule, low, high, settings, 0, raw)
    for (; this.trimmed < own.length - this.keep; this.trimmed++) {
      delete own[this.trimmed]
      delete this.ownDelta[this.trimmed]
    }
    this.memo = sideOf(raw[raw.length - 1])
    this.memoValue = series.values === null ? NaN : series.values[series.values.length - 1]
    if (def.shape === 'band' && series.lines !== null) {
      const last = series.lines[0].length - 1
      this.memoLines = { upper: series.lines[0][last], lower: series.lines[1][last], middle: def.middle(series.lines, last, settings) }
    } else this.memoLines = { upper: NaN, lower: NaN, middle: NaN }
    return this.memo
  }

  /** After `at`: the player's own value at the same close (`state.sideValue`); NaN while it warms up or when it has no single value (a band player, the MACD, the regime: `values === null`). */
  value(): number {
    return this.memoValue
  }

  /** After `at`: a band player's upper, lower and middle at the same close (`state.sideLines`); NaN for any other player (a zone player, a trend player, the regime) and while its lines warm up. The Squeeze gives its Bollinger pair. */
  lines(): SideLines {
    return this.memoLines
  }
}
