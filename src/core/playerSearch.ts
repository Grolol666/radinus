/**
 * The row's `chercher` (author, 2026-10-05): every combination of a player's search grid (each field from its minimum to its maximum
 * by its step, a zone oscillator's low threshold with its mirrored high one, each rule), one try per setting (the stop is calibrated after), the one with the highest `compte` kept (the bots' fake account replayed over the
 * trades, in % of its starting stake, a liquidated setting scoring what its account lost; a tie keeps the first). No React import. The trades of a try are the simulation's: the signals are `playerFlips`', the fills are
 * `opportunityFillAt`'s (computed once per minute, `minuteFills`) and the book-keeping of `replay` is `simulateLeanFlips`' for flips only, no fee, no lock, no candles; `replayAccount` (`playerAccount.ts`) reads them as the account.
 * An indicator is computed once per value of the settings its series depends on; the thresholds and rules are tried on that same series.
 * On the page the search runs off the page's thread; Radinus keeps only the scoring of one setting (`scoreSetting`).
 */

import { fundingPaid } from './funding'
import type { FundingHours } from './funding'
import type { AccountParams } from './account'
import { opportunityFillAt } from './hedgeSim'
import type { OpportunityTape } from './hedgeSim'
import { replayAccount } from './playerAccount'
import type { AccountRun } from './playerAccount'
import { PLAYER_NOTIONAL, RSI_TABLE_PLAYERS, playerFlips, playerLoader } from './players'
import type { PlayerRule, SearchRange, TablePlayer } from './players'
import type { HaltCause } from './playerRules'
import type { StopPrints, StopTrade } from './playerStop'
import type { BenchBar, LeanFlip } from './zonesBench'

/** The most the `stop` field accepts by hand, % (author, 2026-10-05: "3 % en manuel"). */
export const STOP_HAND_MAX = 3
/** Where the stop calibration starts: this many times the market's median spread (author, 2026-10-05: "start from 1.5 × this value"). */
export const STOP_START_SPREADS = 1.5
/** Where it stops: this share of the market's liquidation distance (author, 2026-10-05: "go to 50 % of the liquidation for the max", after 5 % found no stop). */
export const STOP_CEILING_SHARE = 0.5

/** A market's margin fractions as Lighter publishes them (`/orderBookDetails`: `min_initial_margin_fraction`, `maintenance_margin_fraction`, hundredths of a percent - 200 = 2 %; BTC 200 / 120, read 2026-10-05). */
export type MarketMargins = { initial: number; maintenance: number }
/** What the account reads of a market besides its margins : the liquidation fee, a percent of the notional (Lighter's `liquidation_fee`). `/rsi` and `radinus/` read both from the same call. */
export type MarketLimits = { margins: MarketMargins; liquidationFeePct: number }
/** The contrary move, %, at which the liquidation starts with the whole account committed: at the maximum leverage (`leverage` null) initial - maintenance; at a chosen leverage L, 100 / L - maintenance (the maintenance margin stays the market's). */
export const liquidationOf = (m: MarketMargins, leverage: number | null = null): number => (leverage === null ? (m.initial - m.maintenance) / 100 : 100 / leverage - m.maintenance / 100)
/** The market's maximum leverage as Lighter shows it beside a perp's name: 10000 / the minimum initial fraction. */
export const leverageOf = (m: MarketMargins): number => Math.floor(10000 / m.initial)
/** The default step of the stop's calibration ladder, % (author, 2026-10-05: "in steps of 0.005"); the page's top line changes it, and its bounds. */
export const STOP_STEP_DEFAULT = 0.005
export const STOP_STEP_MIN = 0.001
export const STOP_STEP_MAX = 1

/** The calibration's first stop from the market's median spread (`OpportunityTape.spreadPct`, %); `null` = no spread measured. */
export const stopStartOf = (spreadPct: number | null): number | null => (spreadPct === null ? null : STOP_START_SPREADS * spreadPct)
/** The calibration's last stop from the liquidation distance (`liquidationOf`, %); `null` = margins not read. */
export const stopCeilingOf = (liquidationPct: number | null): number | null => (liquidationPct === null ? null : STOP_CEILING_SHARE * liquidationPct)

export const french = (x: number) => String(Number(x.toPrecision(3))).replace('.', ',')

/** A guard halt's cause in words (`playerRules.ts`), for the titles of `/rsi`'s rows and `/bots`. */
export const haltWords = (cause: HaltCause, value: number): string =>
  cause === 'pertes' ? `${value} losses in a row` : cause === 'perte' ? `loss of ${french(value)} % of the starting stake` : `fixed stake ${value} $ above the account at an entry`

/**
 * The buy and the sell price of an order decided at the close of each bar (NaN where the tape has no print yet), by the simulation's own fill rule, and the few numbers `replay` reads from the tape
 * (the last print's time and price, for a position closed at the end), so a search never needs the tape itself: a job carries these arrays, not the 1.2 million prints.
 * `t0` = the first bar's time: the bars are one per minute without a hole (`pushBenchMinute` fills the gaps flat), so the flip at a close `t` is bar `(t - 60 - t0) / 60`.
 */
export type MinuteFills = { buy: Float64Array; sell: Float64Array; t0: number; latencyMs: number; lastT: number; lastPx: number }

/** `opportunityFillAt` for every bar of `bars`, at that bar's close + `latencyMs`: what every try reads, computed once per (bars, tape). */
export function minuteFills(tape: OpportunityTape, bars: BenchBar[], latencyMs: number): MinuteFills {
  const buy = new Float64Array(bars.length)
  const sell = new Float64Array(bars.length)
  for (let i = 0; i < bars.length; i++) {
    const at = (bars[i].t + 60) * 1000 + latencyMs
    buy[i] = opportunityFillAt(tape, 1, at) ?? NaN
    sell[i] = opportunityFillAt(tape, 0, at) ?? NaN
  }
  const n = tape.t.length
  return { buy, sell, t0: bars.length === 0 ? 0 : bars[0].t, latencyMs, lastT: tape.t[n - 1], lastPx: tape.k[n - 1] / Math.round(1 / tape.tick) }
}

/** What `simulateLeanFlips(tape, bars, flips, PLAYER_NOTIONAL, 0, latencyMs, null, null, funding)` books for `flips` from a player's signals: its PnL and number of trades (same operations in the same order, so the same digits), `out` (when given) getting each trade. */
export function replay(flips: LeanFlip[], fills: MinuteFills, funding: FundingHours | null, out?: StopTrade[]): { pnl: number; trades: number } {
  const { latencyMs } = fills
  let realized = 0
  let trades = 0
  let pos: { side: 1 | -1; tIn: number; pxIn: number; qty: number } | null = null
  const close = (tOut: number, pxOut: number) => {
    if (pos === null) return
    const priced = pos.side * (pxOut - pos.pxIn) * pos.qty
    const paid = funding === null ? null : fundingPaid(pos.side, pos.qty, Math.round(pos.tIn * 1000), Math.round(tOut * 1000), funding)
    const pnl = paid === null ? priced : priced + paid.paid
    realized += pnl
    trades++
    out?.push({ side: pos.side, tIn: pos.tIn, pxIn: pos.pxIn, tOut, pxOut, pnl, stopped: false, trailing: false })
    pos = null
  }
  // A flip's fill is its bar's, found by the bar's close. Every flip sits at a bar's close (`levelFlips`: `t` = bar.t + 60), so one outside the bars (none) would have no fill.
  const fillOf = (fl: LeanFlip, need: 0 | 1): number => {
    const i = (fl.t - 60 - fills.t0) / 60
    const buy = need === 1 ? fills.buy : fills.sell
    return Number.isInteger(i) && i >= 0 && i < buy.length ? buy[i] : NaN
  }
  for (const fl of flips) {
    const at = fl.t * 1000 + latencyMs
    if (at > fills.lastT) break
    if (pos !== null) {
      const px = fillOf(fl, (pos as { side: 1 | -1 }).side === 1 ? 0 : 1)
      if (!Number.isNaN(px)) close(at / 1000, px)
    }
    if (fl.kind !== 'close') {
      const side = fl.kind === 'long' ? 1 : -1
      const px = fillOf(fl, side === 1 ? 1 : 0)
      if (!Number.isNaN(px)) pos = { side, tIn: at / 1000, pxIn: px, qty: PLAYER_NOTIONAL / px }
    }
  }
  close(fills.lastT / 1000, fills.lastPx)
  return { pnl: realized, trades }
}

/** A search's grid for one player: the values of each setting, the thresholds, the rules, and how many tries that makes. */
export type PlayerGrid = { axes: number[][]; seriesAxes: number[]; flipAxes: number[]; lows: number[] | null; mirror: number; rules: PlayerRule[]; tries: number }

/** `min` to `max` by `step`, both ends, each value rounded to 1e-9 so 0.1 steps give 0.7, not 0.7000000000000001; the values outside `lo`..`hi` are dropped. */
function rangeValues(r: SearchRange, lo: number, hi: number): number[] {
  const out: number[] = []
  const n = Math.floor((r.max - r.min) / r.step + 1e-9)
  for (let k = 0; k <= n; k++) {
    const v = Math.round((r.min + k * r.step) * 1e9) / 1e9
    if (v >= lo && v <= hi) out.push(v)
  }
  return out
}

/** The rules a row's rule cell offers, as the search tries them (`null` = the player has no choice). */
function playerRules(def: TablePlayer): PlayerRule[] {
  if (def.shape === 'zone') return ['zone', 'exit']
  if (def.shape === 'band') return def.rule === null ? [null] : ['retour', 'cassure']
  return def.rules.length === 0 ? [null] : def.rules.map((r) => r.id)
}

/** The odometer over `axes` (the last one turns fastest): `fn` gets each tuple in order. */
function eachTuple(axes: number[][], fn: (tuple: number[]) => void): void {
  if (axes.some((a) => a.length === 0)) return
  const at = axes.map(() => 0)
  for (;;) {
    fn(axes.map((a, k) => a[at[k]]))
    let k = axes.length - 1
    while (k >= 0 && ++at[k] === axes[k].length) at[k--] = 0
    if (k < 0) return
  }
}

const gridCache = new Map<string, PlayerGrid>()

/** The grid of a player, counted by walking it (a `valid` constraint is in the number); `null` for a player with no searchable setting (the Heikin-Ashi, no setting at all: the only one of the 32): nothing to try. */
export function playerGrid(def: TablePlayer): PlayerGrid | null {
  const base = baseGrid(def)
  return def.settings.some((s) => s.search !== undefined) ? base : null
}

function baseGrid(def: TablePlayer): PlayerGrid {
  const held = gridCache.get(def.id)
  if (held !== undefined) return held
  const axes = def.settings.map((s) => (s.search === undefined ? [s.def] : rangeValues(s.search, s.lo, s.hi)))
  const seriesAxes = def.settings.flatMap((s, k) => (s.flipsOnly ? [] : [k]))
  const flipAxes = def.settings.flatMap((s, k) => (s.flipsOnly ? [k] : []))
  const lows = def.shape === 'zone' ? rangeValues(def.thresholdSearch, def.bounds.lo, def.bounds.hi) : null
  const rules = playerRules(def)
  const full = (tuple: number[]) => {
    const s = def.settings.map((x) => x.def)
    seriesAxes.forEach((k, j) => (s[k] = tuple[j]))
    return s
  }
  let seriesCombos = 0
  eachTuple(seriesAxes.map((k) => axes[k]), (tuple) => {
    if (def.valid === undefined || def.valid(full(tuple))) seriesCombos++
  })
  let flipCombos = 1
  for (const k of flipAxes) flipCombos *= axes[k].length
  const grid: PlayerGrid = { axes, seriesAxes, flipAxes, lows, mirror: def.shape === 'zone' ? def.thresholdSearch.mirror : 0, rules, tries: seriesCombos * flipCombos * (lows?.length ?? 1) * rules.length }
  gridCache.set(def.id, grid)
  return grid
}

/** Whether the row has any setting to search. */
export const searchable = (def: TablePlayer): boolean => playerGrid(def) !== null

/** The row's title for its button: each field's search minimum, maximum and step, the thresholds, the rules and the number of tries (no hidden rule). */
export function searchTitle(def: TablePlayer, share: number, critere: SearchCritere = 'compte', minTrades = MIN_TRADES_DEFAULT): string {
  const grid = playerGrid(def)
  if (grid === null) return `search: nothing to try - ${def.name} has no setting to search`
  const num = (x: number) => String(x).replace('.', ',')
  const range = (label: string, r: SearchRange) => `${label} ${num(r.min)} to ${num(r.max)} by ${num(r.step)}`
  const fields = def.settings.flatMap((s) => (s.search === undefined ? [] : [range(s.label, s.search)]))
  if (def.shape === 'zone') fields.push(`${range('low threshold', def.thresholdSearch)} (high threshold = ${def.thresholdSearch.mirror === 0 ? '-' : `${def.thresholdSearch.mirror} - `}low threshold)`)
  const rules = def.shape === 'zone' ? ['in zone', 'zone exit'] : def.shape === 'band' ? (def.rule === null ? [] : ['return', 'breakout']) : def.rules.map((r) => r.label)
  const words = [...fields, ...(rules.length > 0 ? [`rules: ${rules.join(', ')}`] : []), `${grid.tries.toLocaleString('fr-FR')} tries`]
  const what = critere === 'fiabilite'
    ? `search the highest share of winning trades, on the measured part (prints) only (winners ÷ trades, at least ${minTrades} trades; on a tie, the setting with the most trades)`
    : `search the best account, on the measured part (prints) only (the bots' account replayed, in % of the starting stake, part ${num(share)}; a liquidated setting is worth what its account lost)`
  return `${what} - ${words.join('; ')}`
}

/**
 * What a search needs, frozen at its start, and nothing the structured clone cannot carry (a player's description holds functions, so the job names its player: `id`, found again in `RSI_TABLE_PLAYERS`): the bars,
 * the per-minute fills, the funding rows, `delta` (the store's per-minute aggressor delta) only for the players that ask for it, else empty, `stopPrints` (the prints as typed arrays, `playerStop.ts`) for the liquidation, and `account` (the market's leverage, the share, the maintenance margin and the liquidation fee: `AccountParams`, what the score reads).
 */
export type SearchJob = { id: string; bars: BenchBar[]; delta: number[]; firstPrintT: number; fills: MinuteFills; funding: FundingHours | null; stopPrints: StopPrints; account: AccountParams; critere: SearchCritere; minTrades: number }

/** What a search maximises: `compte` (the replayed account's `pct`) or `fiabilite` (the part of winning trades among at least `minTrades`). */
export type SearchCritere = 'compte' | 'fiabilite'
export const MIN_TRADES_DEFAULT = 5

/** A setting of the player with its score under the job's critere (`compte`: the account's change in % of its starting stake, `replayAccount`'s `pct`; `fiabilite`: wins ÷ trades), its `pct` whatever the critere, and the trades the account counts: `low` / `high` are NaN on a player with no thresholds. */
export type SearchBest = { settings: number[]; low: number; high: number; rule: PlayerRule; score: number; pct: number; trades: number }

/** The player a job names; a job for a player the table does not have is a bug, said by the throw. */
function jobPlayer(job: SearchJob): TablePlayer {
  const def = RSI_TABLE_PLAYERS.find((d) => d.id === job.id)
  if (def === undefined) throw new Error(`playerSearch: unknown player ${job.id}`)
  return def
}

/**
 * An account replay's score under a critere: `compte` = its `pct`; `fiabilite` = wins ÷ trades; under `minTrades` trades, or liquidated / out of money without a stop (author, 2026-10-06: a setting that does not survive the days unprotected has no place first), a setting is not retained
 * (-Infinity beats nothing, not even a floor of -Infinity). The search's tries and the trailing's calibration (`playerStopFind.ts`) score with this one function.
 */
export const scoreOf = (critere: SearchCritere, minTrades: number, r: AccountRun): number => (critere === 'compte' ? r.pct : r.trades >= minTrades && r.trades > 0 && r.ended === null ? r.wins / r.trades : -Infinity)

/** A try's score from the signals `flips`: the trades of `replay` (into `buf`, emptied first), read by `replayAccount`. */
function figureOf(job: SearchJob, flips: LeanFlip[], buf: StopTrade[]): { score: number; pct: number; trades: number } {
  buf.length = 0
  replay(flips, job.fills, job.funding, buf)
  const r = replayAccount(buf, job.stopPrints, job.fills.t0, job.account)
  return { score: scoreOf(job.critere, job.minTrades, r), pct: r.pct, trades: r.trades }
}

/** One setting scored the way a try is: series, signals, replay. */
export function scoreSetting(job: SearchJob, settings: number[], low: number, high: number, rule: PlayerRule): { score: number; pct: number; trades: number } {
  const def = jobPlayer(job)
  const series = playerLoader(def, settings)(job.bars, job.delta)
  return figureOf(job, playerFlips(job.bars, series, def, rule, low, high, settings, job.firstPrintT) ?? [], [])
}

// Cut for radinus: the page's settings search (runSearch and its messages, not used by Radinus).
