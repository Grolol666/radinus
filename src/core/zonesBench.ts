/**
 * The zones test bench ("Zones method", author 2026-09-30), pure: hindsight
 * turns (zigzag on 1-minute highs/lows) against causal tools, scored by lead, precision
 * and coverage. Ported from the author's first bench with its constants, signal
 * rules, refractory filter, move filter, scoring and seeded chance baseline unchanged,
 * so the page's table and the bench's `tables.txt` read the same numbers on the same data
 * (combinations are not ported). Plus the display-only series the `/test-bench` chart draws
 * (EMA, SMA, Bollinger, Keltner, Donchian, VWAP, RSI, MACD, order flow).
 *
 * No lookahead: a bar tool's value at bar i reads bars[0..i] only and its signal is dated
 * at that bar's close (t + 60 s), at its close price; a flow value or flip reads only the
 * prints with a time up to the moment it is dated. Only `zigzag` looks ahead - it is the
 * hindsight the tools are scored against, never a signal.
 */

import { adxFeed, aroonFeed, atrStopFeed, awesomeFeed, bollingerFeed, cciAt, cciFeed, cmfFeed, cvdFeed, donchianFeed, emaCrossFeed, emaFeed, envelopesFeed, forceFeed, heikinAshiFeed, ichimokuFeed, keltnerFeed, macdFeed, mfiAt, mfiFeed, momentumFeed, obvFeed, parabolicSarFeed, sma, smaFeed, squeezeFeed, stochasticFeed, stochasticPeek, stochasticStart, stochasticStep, superTrendFeed, trixFeed, tsiFeed, ultimateAt, ultimateFeed, vortexFeed, vwapFeed, zscoreAt, zscoreFeed } from './indicators'
import type { HighLowClose, StochasticRun } from './indicators'
import type { LighterBookDepth, LighterBookLevel } from './lighter'

/** Bench constants (`bench.mts`). */
export const REFRACT = 60 // same tool, same side: a signal within 60 s of the previous kept one is dropped
export const EMA_A_FRAC = 0.5 // signal A: |slope| < 50 % of the leg's max |slope|
export const EMA_A_MINLEG = 3 // ... leg at least 3 bars old
export const PIV_K = 5 // RSI divergence: pivot = extreme of +/-5 bars, known 5 bars later
export const PIV_LOOKBACK = 60 // ... pivot at most 60 bars back
export const MOVE_LOOKBACK = 1800 // move filter: the high (low) of the last 30 min, in s

/** One minute; `real` false = a minute the tape has no candle for, filled flat at the previous close (the bench's own fill, `v` 0). `v` = traded size, base units. */
export type BenchBar = { t: number; o: number; h: number; l: number; c: number; v: number; real: boolean }
/** One print: `t` in ms, `ask` 1 = the buyer was the aggressor (the bench's reading), `size` in base units. */
export type BenchTick = { t: number; px: number; size: number; ask: number; id: number }
/** side -1 = low, +1 = high; `t` in s (the extreme bar's middle, t + 30). */
export type Turn = { side: 1 | -1; t: number; px: number }
/** side -1 = "a low is here" (a long entry), +1 = "a high is here"; `t` in s. */
export type Sig = { side: 1 | -1; t: number; px: number }

/**
 * The tape's unfilled minutes (oldest first) as the bench reads them: the last minute dropped
 * (it may be incomplete), every missing minute filled flat at the previous close.
 */
export function benchBars(minutes: { t: number; o: number; h: number; l: number; c: number; v: number }[]): BenchBar[] {
  const out: BenchBar[] = []
  for (const r of minutes.slice(0, -1)) pushBenchMinute(out, r)
  return out
}

/** `benchBars`' step: the tape's minute `r` after `out`'s last bar, the minutes missing between them filled flat at the last close. `/rsi`'s store appends a closed live minute the same way. */
export function pushBenchMinute(out: BenchBar[], r: { t: number; o: number; h: number; l: number; c: number; v: number }): void {
  for (let t = out.length === 0 ? r.t : out[out.length - 1].t + 60; t < r.t; t += 60) {
    const p = out[out.length - 1].c
    out.push({ t, o: p, h: p, l: p, c: p, v: 0, real: false })
  }
  out.push({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, real: true })
}

// ---- 1. hindsight zigzag on bar highs/lows. A reversal must be confirmed by a bar LATER than the one that set the extreme.
export function zigzag(bars: BenchBar[], s: number): { turns: Turn[]; pendingT: number } {
  const turns: Turn[] = []
  if (bars.length === 0) return { turns, pendingT: 0 }
  let dir = 0
  let hi = bars[0].h
  let hiI = 0
  let lo = bars[0].l
  let loI = 0
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    if (dir === 0) {
      if (b.h > hi) { hi = b.h; hiI = i }
      if (b.l < lo) { lo = b.l; loI = i }
      if (hi / lo - 1 >= s) {
        if (hiI > loI) { turns.push({ side: -1, t: bars[loI].t + 30, px: lo }); dir = 1 }
        else { turns.push({ side: 1, t: bars[hiI].t + 30, px: hi }); dir = -1 }
      }
    } else if (dir === 1) {
      if (b.h > hi) { hi = b.h; hiI = i }
      else if (b.l <= hi * (1 - s)) { turns.push({ side: 1, t: bars[hiI].t + 30, px: hi }); dir = -1; lo = b.l; loI = i }
    } else {
      if (b.l < lo) { lo = b.l; loI = i }
      else if (b.h >= lo * (1 + s)) { turns.push({ side: -1, t: bars[loI].t + 30, px: lo }); dir = 1; hi = b.h; hiI = i }
    }
  }
  // the running extreme after the last confirmed turn: not a turn yet; up to it, no turn can exist
  const pendingT = dir === 1 ? bars[hiI].t + 30 : dir === -1 ? bars[loI].t + 30 : bars[0].t
  return { turns, pendingT }
}

// ---- 2. causal tools
/** EMA seeded at the first value (the bench's). */
export function ema(x: number[], n: number): number[] {
  return emaRun(x, n, [], 0)
}

/*
 * The `...Run` functions below are the bench's loops with their running state taken out: `from` = the first index
 * still to compute, `prev` = the output up to it (copied, never written), the state = the loop's variables after
 * index from - 1. From 0 with the initial state they ARE the full computation; continued on bars / prints that only
 * add to the previous ones (`benchLoad`'s fold) they run the same arithmetic in the same order, so the extended
 * arrays are the full ones bit for bit (`research/lean/timing.ts` checks it).
 */

/** `prev` copied and padded with NaN to `n`. */
const grow = (prev: number[], n: number): number[] => prev.concat(new Array<number>(n - prev.length).fill(NaN))

/** `ema` from `from`: the recursion continued on `prev`'s last value. */
export function emaRun(x: number[], n: number, prev: number[], from: number): number[] {
  const out = prev.slice(0, from)
  const a = 2 / (n + 1)
  for (let i = from; i < x.length; i++) out.push(i === 0 ? x[0] : out[i - 1] + a * (x[i] - out[i - 1]))
  return out
}

/** `emaSignals`' running leg. */
type EmaLeg = { sign: number; legMax: number; legLen: number; fired: boolean }
const emaLeg0 = (): EmaLeg => ({ sign: 0, legMax: 0, legLen: 0, fired: false })

/** A = the EMA's 1-bar slope has fallen under half its leg's max (leg >= 3 bars), once per leg; B = the slope changed sign. A falling leg's signal is a low. */
export function emaSignals(bars: BenchBar[], n: number): { A: Sig[]; B: Sig[] } {
  const A: Sig[] = []
  const B: Sig[] = []
  emaSignalsRun(bars, ema(bars.map((b) => b.c), n), emaLeg0(), 1, A, B)
  return { A, B }
}

/** `emaSignals` from bar `from` on the EMA `e`, pushing to `A` / `B`; `leg` is updated. */
function emaSignalsRun(bars: BenchBar[], e: number[], leg: EmaLeg, from: number, A: Sig[], B: Sig[]): void {
  let { sign, legMax, legLen, fired } = leg
  for (let i = Math.max(1, from); i < bars.length; i++) {
    const sl = (e[i] - e[i - 1]) / e[i - 1]
    const sg = sl > 0 ? 1 : sl < 0 ? -1 : 0
    const at = { t: bars[i].t + 60, px: bars[i].c }
    if (sg !== 0 && sg !== sign) {
      if (sign !== 0) B.push({ side: sign === -1 ? -1 : 1, ...at }) // was falling, now rising -> low; mirror
      sign = sg
      legMax = 0
      legLen = 0
      fired = false
    }
    if (sign === 0) continue
    legLen++
    const mag = Math.abs(sl)
    if (mag > legMax) legMax = mag
    if (!fired && legLen >= EMA_A_MINLEG && legMax > 0 && mag < EMA_A_FRAC * legMax) {
      A.push({ side: sign === -1 ? -1 : 1, ...at })
      fired = true
    }
  }
  Object.assign(leg, { sign, legMax, legLen, fired })
}

/**
 * Bollinger (n, k) on closes, population standard deviation, each window re-summed (the bench's
 * arithmetic, not `indicators.ts`'s running sum: on flat filled minutes the band sits exactly on the
 * close, and a running sum's rounding would flip the re-entry comparisons). NaN before bar n - 1.
 * `mid` is the SMA n.
 */
export function bollingerBands(bars: BenchBar[], n = 20, k = 2): { mid: number[]; up: number[]; lo: number[] } {
  return bollingerRun(bars, n, k, { mid: [], up: [], lo: [] }, 0)
}

function bollingerRun(bars: BenchBar[], n: number, k: number, prev: { mid: number[]; up: number[]; lo: number[] }, from: number): { mid: number[]; up: number[]; lo: number[] } {
  const mid = grow(prev.mid, bars.length)
  const up = grow(prev.up, bars.length)
  const lo = grow(prev.lo, bars.length)
  for (let i = Math.max(n - 1, from); i < bars.length; i++) {
    let m = 0
    for (let j = i - n + 1; j <= i; j++) m += bars[j].c
    m /= n
    let v = 0
    for (let j = i - n + 1; j <= i; j++) v += (bars[j].c - m) ** 2
    const sd = Math.sqrt(v / n)
    mid[i] = m
    up[i] = m + k * sd
    lo[i] = m - k * sd
  }
  return { mid, up, lo }
}

/** Re-entry: the previous close was outside the previous band, this close is back inside (under the lower band -> a low). */
export function bollSignals(bars: BenchBar[], bands: { up: number[]; lo: number[] } = bollingerBands(bars), from = 1): Sig[] {
  const out: Sig[] = []
  for (let i = Math.max(1, from); i < bars.length; i++) {
    const pl = bands.lo[i - 1]
    const pu = bands.up[i - 1]
    const c = bars[i].c
    const pc = bars[i - 1].c
    if (pc < pl && c >= bands.lo[i]) out.push({ side: -1, t: bars[i].t + 60, px: c })
    if (pc > pu && c <= bands.up[i]) out.push({ side: 1, t: bars[i].t + 60, px: c })
  }
  return out
}

/** RSI (Wilder), the bench's: the first `n` changes averaged, NaN before bar n, 100 when there is no loss. */
export function rsi(bars: BenchBar[], n = 14): number[] {
  return rsiRun(bars, n, [], { g: 0, l: 0 }, 0)
}

/**
 * `rsi(bars, n)` holding its last result and continuing it when the new bars only add to the old ones (a minute close) -
 * the array is the full run's, bit for bit. One per mount and period: the rule builder's period field (`/test-bench`).
 */
export function rsiLoader(n: number): (bars: BenchBar[]) => number[] {
  let last: { bars: BenchBar[]; r: number[]; st: RsiRun } | null = null
  return (bars) => {
    const prev = last !== null && last.bars.length > 0 && barsExtend(last.bars, bars) ? last : null
    const st: RsiRun = prev === null ? { g: 0, l: 0 } : { ...prev.st }
    const r = rsiRun(bars, n, prev?.r ?? [], st, prev?.bars.length ?? 0)
    last = { bars, r, st }
    return r
  }
}

/**
 * `stochastic(bars, period, smooth)` holding its state and continuing it when the new bars only add to the old ones (a minute close):
 * only the new bars are read, the array is the full run's, bit for bit. One per mount, period and smoothing: `/rsi`'s fourth player.
 */
export function stochasticLoader(period: number, smooth: number): (bars: BenchBar[]) => number[] {
  let last: { bars: BenchBar[]; out: number[]; st: StochasticRun } | null = null
  return (bars) => {
    const prev = last !== null && last.bars.length > 0 && barsExtend(last.bars, bars) ? last : null
    const st = prev?.st ?? stochasticStart(period, smooth)
    const out = prev === null ? [] : prev.out.slice()
    stochasticFeed(st, bars, out, prev?.bars.length ?? 0)
    last = { bars, out, st }
    return out
  }
}

/**
 * A window oscillator (`indicators.ts`' `xFeed`) holding its last array and continuing it when the new bars only add to the old ones (a minute close):
 * only the new bars are read, the array is the full run's, bit for bit. One per mount and settings: `/rsi`'s CCI, MFI, Ultimate Oscillator and Z-score.
 */
export function feedLoader(feed: (bars: BenchBar[], out: number[], from: number) => void): (bars: BenchBar[]) => number[] {
  let last: { bars: BenchBar[]; out: number[] } | null = null
  return (bars) => {
    const prev = last !== null && last.bars.length > 0 && barsExtend(last.bars, bars) ? last : null
    const out = prev === null ? [] : prev.out.slice()
    feed(bars, out, prev?.bars.length ?? 0)
    last = { bars, out }
    return out
  }
}

export const cciLoader = (period: number) => feedLoader((bars, out, from) => cciFeed(bars, out, from, period))
export const mfiLoader = (period: number) => feedLoader((bars, out, from) => mfiFeed(bars, out, from, period))
export const ultimateLoader = (short: number, medium: number, long: number) => feedLoader((bars, out, from) => ultimateFeed(bars, out, from, short, medium, long))
export const zscoreLoader = (period: number) => feedLoader((bars, out, from) => zscoreFeed(bars, out, from, period))

/**
 * A bot's bars (`radinus/`): `BenchBar[]` with its indices counted from the bot's first bar, as the page's, but kept as a window: the entries older than `keep` bars are deleted (holes), so nothing grows with the bot's age.
 * A loader handed one continues in place instead of comparing and copying (`bandLoader`): the page's `feed` reads bar i, the bars before it within its period and its own output at i - 1, never anything older than `keep`.
 */
export type RollingBars = BenchBar[] & { keep: number }
export const rollingBars = (keep: number): RollingBars => Object.assign([] as BenchBar[], { keep })

/**
 * A band player's `count` arrays (`indicators.ts`' `xFeed`, one value per bar each) held and continued when the new bars only add to the old ones (a minute close):
 * only the new bars are read, the arrays are the full run's, bit for bit. One per row and settings: `/rsi`'s lot 2.
 * Handed `RollingBars` it continues in place, the arrays kept as windows too (entries older than `keep` bars deleted after each call): the same `feed` on the same indices, so the same numbers.
 */
export function bandLoader(count: number, feed: (bars: BenchBar[], out: number[][], from: number) => void): (bars: BenchBar[]) => number[][] {
  let last: { bars: BenchBar[]; out: number[][] } | null = null
  let rolled: { out: number[][]; fed: number; trimmed: number } | null = null
  return (bars) => {
    if ('keep' in bars) {
      rolled ??= { out: Array.from({ length: count }, (): number[] => []), fed: 0, trimmed: 0 }
      feed(bars, rolled.out, rolled.fed)
      rolled.fed = bars.length
      for (; rolled.trimmed < bars.length - (bars as RollingBars).keep; rolled.trimmed++) for (const a of rolled.out) delete a[rolled.trimmed]
      return rolled.out
    }
    const prev = last !== null && last.bars.length > 0 && barsExtend(last.bars, bars) ? last : null
    const out = prev === null ? Array.from({ length: count }, (): number[] => []) : prev.out.map((a) => a.slice())
    feed(bars, out, prev?.bars.length ?? 0)
    last = { bars, out }
    return out
  }
}

export const bollingerLoader = (period: number, k: number) => bandLoader(3, (bars, out, from) => bollingerFeed(bars, out, from, period, k))
export const keltnerLoader = (period: number, k: number) => bandLoader(3, (bars, out, from) => keltnerFeed(bars, out, from, period, k))
export const donchianLoader = (period: number) => bandLoader(2, (bars, out, from) => donchianFeed(bars, out, from, period))
export const envelopesLoader = (period: number, x: number) => bandLoader(2, (bars, out, from) => envelopesFeed(bars, out, from, period, x))
export const vwapLoader = (x: number) => bandLoader(4, (bars, out, from) => vwapFeed(bars, out, from, x))
export const squeezeLoader = (bollingerPeriod: number, bollingerK: number, keltnerPeriod: number, keltnerK: number) => bandLoader(6, (bars, out, from) => squeezeFeed(bars, out, from, bollingerPeriod, bollingerK, keltnerPeriod, keltnerK))

/** The trend followers' loaders (`/rsi`'s lot 3): `bandLoader` over each feed, with the number of arrays the feed writes (the drawn lines first, then the carried state). */
export const emaCrossLoader = (fast: number, slow: number) => bandLoader(2, (bars, out, from) => emaCrossFeed(bars, out, from, fast, slow))
export const emaLoader = (period: number) => bandLoader(1, (bars, out, from) => emaFeed(bars, out, from, period))
export const smaLoader = (period: number) => bandLoader(1, (bars, out, from) => smaFeed(bars, out, from, period))
export const macdLoader = (fast: number, slow: number, signal: number) => bandLoader(4, (bars, out, from) => macdFeed(bars, out, from, fast, slow, signal))
export const superTrendLoader = (period: number, k: number) => bandLoader(5, (bars, out, from) => superTrendFeed(bars, out, from, period, k))
export const parabolicSarLoader = (step: number, max: number) => bandLoader(4, (bars, out, from) => parabolicSarFeed(bars, out, from, step, max))
export const adxLoader = (period: number) => bandLoader(6, (bars, out, from) => adxFeed(bars, out, from, period))
export const aroonLoader = (period: number) => bandLoader(2, (bars, out, from) => aroonFeed(bars, out, from, period))
export const vortexLoader = (period: number) => bandLoader(2, (bars, out, from) => vortexFeed(bars, out, from, period))
export const ichimokuLoader = (short: number, long: number) => bandLoader(2, (bars, out, from) => ichimokuFeed(bars, out, from, short, long))
export const atrStopLoader = (period: number, k: number) => bandLoader(3, (bars, out, from) => atrStopFeed(bars, out, from, period, k))
export const heikinAshiLoader = () => bandLoader(2, (bars, out, from) => heikinAshiFeed(bars, out, from))

/** The momentum and volume players' loaders (`/rsi`'s lot 4), `bandLoader` over each feed; the arrays = the drawn lines first, then the carried state. */
export const momentumLoader = (period: number) => bandLoader(1, (bars, out, from) => momentumFeed(bars, out, from, period))
export const trixLoader = (period: number, signal: number) => bandLoader(5, (bars, out, from) => trixFeed(bars, out, from, period, signal))
export const tsiLoader = (long: number, short: number, signal: number) => bandLoader(7, (bars, out, from) => tsiFeed(bars, out, from, long, short, signal))
export const awesomeLoader = (short: number, long: number) => bandLoader(1, (bars, out, from) => awesomeFeed(bars, out, from, short, long))
export const obvLoader = (period: number) => bandLoader(2, (bars, out, from) => obvFeed(bars, out, from, period))
export const cmfLoader = (period: number) => bandLoader(2, (bars, out, from) => cmfFeed(bars, out, from, period))
export const forceLoader = (period: number) => bandLoader(1, (bars, out, from) => forceFeed(bars, out, from, period))

/**
 * A player that reads the store's per-minute aggressor delta as well as the bars (`TrendPlayer.needs = 'delta'`): `bandLoader` with `delta` (one value per bar, aligned on `bars`) handed to its feed.
 * The delta only ever grows at its end, like the bars, so a continuation reads the new bars' deltas and the arrays are the full run's.
 */
export function deltaLoader(count: number, feed: (bars: BenchBar[], delta: number[], out: number[][], from: number) => void): (bars: BenchBar[], delta: number[]) => number[][] {
  let current: number[] = []
  const run = bandLoader(count, (bars, out, from) => feed(bars, current, out, from))
  return (bars, delta) => {
    current = delta
    return run(bars)
  }
}
export const cvdLoader = (period: number) => deltaLoader(2, (bars, delta, out, from) => cvdFeed(bars, delta, out, from, period))

/**
 * The stochastic applied to the RSI's values (`rsiLoader`, so the RSI is continued too): bar i >= `rsiPeriod` has an RSI, and the stochastic
 * (`stochasticFeed` on a series whose h = l = c = that RSI) runs from there, NaN before. `mid` and `sub` are the stochastic's own input and output,
 * kept between calls and only appended to.
 */
export function rsiStochasticLoader(rsiPeriod: number, period: number, smooth: number): (bars: BenchBar[]) => number[] {
  const rsiOf = rsiLoader(rsiPeriod)
  let last: { bars: BenchBar[]; out: number[]; st: StochasticRun; mid: HighLowClose[]; sub: number[] } | null = null
  return (bars) => {
    const r = rsiOf(bars)
    const prev = last !== null && last.bars.length > 0 && barsExtend(last.bars, bars) ? last : null
    const st = prev?.st ?? stochasticStart(period, smooth)
    const mid = prev?.mid ?? []
    const sub = prev?.sub ?? []
    const from = mid.length
    for (let i = rsiPeriod + from; i < bars.length; i++) mid.push({ h: r[i], l: r[i], c: r[i] })
    stochasticFeed(st, mid, sub, from)
    const out = prev === null ? [] : prev.out.slice()
    for (let i = out.length; i < bars.length; i++) out[i] = i < rsiPeriod ? NaN : sub[i - rsiPeriod]
    last = { bars, out, st, mid, sub }
    return out
  }
}

/** `rsi`'s running averages of gains and losses. */
export type RsiRun = { g: number; l: number }

/** `rsi`'s one bar: the averages `from` after bar i - 1 moved by the close's change `d` into `to` (the same object to continue the run, another to value a bar without moving it), and the value (NaN before bar n). */
export function rsiStep(from: RsiRun, to: RsiRun, n: number, i: number, d: number): number {
  const up = Math.max(d, 0)
  const dn = Math.max(-d, 0)
  let g = from.g
  let l = from.l
  if (i <= n) { g += up / n; l += dn / n } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n }
  to.g = g
  to.l = l
  return i >= n ? (l === 0 ? 100 : 100 - 100 / (1 + g / l)) : NaN
}

function rsiRun(bars: BenchBar[], n: number, prev: number[], st: RsiRun, from: number): number[] {
  const r = grow(prev, bars.length)
  for (let i = Math.max(1, from); i < bars.length; i++) {
    const v = rsiStep(st, st, n, i, bars[i].c - bars[i - 1].c)
    if (i >= n) r[i] = v
  }
  return r
}

/**
 * A zone oscillator's one-bar continuation (what `radinus/` runs, a bar at a time): its state after the closed bars, and the value of one more bar on top of it without changing it.
 * `push(bars, i)` folds the closed bar i in (bars 0..i - 1 already were: the continuation), `peek(bars, i)` is the value bar i would have if it closed as `bars[i]` is now (the closed bars before it, that bar provisional); both are the
 * indicator's own step, not a copy of its formula.
 */
export type Intrabar = { push: (bars: BenchBar[], i: number) => void; peek: (bars: BenchBar[], i: number) => number }

/** The RSI's: the running averages in `st`, a scratch pair for the value of a forming bar. */
export function rsiIntrabar(n: number): Intrabar {
  const st: RsiRun = { g: 0, l: 0 }
  const scratch: RsiRun = { g: 0, l: 0 }
  return {
    push: (bars, i) => { if (i >= 1) rsiStep(st, st, n, i, bars[i].c - bars[i - 1].c) },
    peek: (bars, i) => (i >= 1 ? rsiStep(st, scratch, n, i, bars[i].c - bars[i - 1].c) : NaN),
  }
}

/** The stochastic's: its two queues and ring of `stochasticStep`, rolled back by `stochasticPeek`. */
export function stochasticIntrabar(period: number, smooth: number): Intrabar {
  const st = stochasticStart(period, smooth)
  return { push: (bars, i) => { stochasticStep(st, bars, i) }, peek: (bars, i) => stochasticPeek(st, bars, i) }
}

/** A window oscillator keeps no state: the value of bar i is `at` read on the bars up to i, the forming one included. */
const windowIntrabar = (at: (bars: BenchBar[], i: number) => number): Intrabar => ({ push: () => {}, peek: at })
export const cciIntrabar = (period: number) => windowIntrabar((bars, i) => cciAt(bars, i, period))
export const mfiIntrabar = (period: number) => windowIntrabar((bars, i) => mfiAt(bars, i, period))
export const ultimateIntrabar = (short: number, medium: number, long: number) => windowIntrabar((bars, i) => ultimateAt(bars, i, short, medium, long))
export const zscoreIntrabar = (period: number) => windowIntrabar((bars, i) => zscoreAt(bars, i, period))

/** The RSI stochastic's: the RSI's averages and the stochastic's state over the RSI values (`mid`, as `rsiStochasticLoader` builds them from bar `rsiPeriod`); a forming bar is put at the end of `mid` for the value and taken off. */
export function rsiStochasticIntrabar(rsiPeriod: number, period: number, smooth: number): Intrabar {
  const rs: RsiRun = { g: 0, l: 0 }
  const scratch: RsiRun = { g: 0, l: 0 }
  const st = stochasticStart(period, smooth)
  const mid: HighLowClose[] = []
  const forming = { h: NaN, l: NaN, c: NaN }
  return {
    push: (bars, i) => {
      if (i < 1) return
      const r = rsiStep(rs, rs, rsiPeriod, i, bars[i].c - bars[i - 1].c)
      if (i >= rsiPeriod) {
        mid.push({ h: r, l: r, c: r })
        stochasticStep(st, mid, mid.length - 1)
        // The window reads the last `period` entries only: the one just out of it is never read again, so a bot that runs for days (`radinus/`) holds `period` of them, not one per bar.
        delete mid[mid.length - 1 - period]
      }
    },
    peek: (bars, i) => {
      if (i < 1) return NaN
      const r = rsiStep(rs, scratch, rsiPeriod, i, bars[i].c - bars[i - 1].c)
      if (i < rsiPeriod) return NaN
      forming.h = r
      forming.l = r
      forming.c = r
      mid.push(forming)
      const value = stochasticPeek(st, mid, mid.length - 1)
      mid.pop()
      return value
    },
  }
}

/**
 * Divergence: a pivot low (lowest low of +/-5 bars, known 5 bars after it) within 60 bars, then a bar
 * with a lower low but a higher RSI -> a low, once per pivot; mirror for highs.
 */
export function rsiDivSignals(bars: BenchBar[], R = rsi(bars)): Sig[] {
  const out: Sig[] = []
  rsiDivRun(bars, R, rsiPivots0(), 0, out)
  return out
}

/** `rsiDivSignals`' last known pivots and the last ones used. */
type RsiPivots = { lastLow: number; lastHigh: number; usedLow: number; usedHigh: number }
const rsiPivots0 = (): RsiPivots => ({ lastLow: -1, lastHigh: -1, usedLow: -1, usedHigh: -1 })

function rsiDivRun(bars: BenchBar[], R: number[], st: RsiPivots, from: number, out: Sig[]): void {
  let { lastLow, lastHigh, usedLow, usedHigh } = st
  for (let i = from; i < bars.length; i++) {
    // pivot at j = i - K becomes known at bar i (its right side is complete)
    const j = i - PIV_K
    if (j >= PIV_K) {
      let isL = true
      let isH = true
      for (let k = j - PIV_K; k <= i; k++) {
        if (k === j) continue
        if (k < j ? bars[k].l < bars[j].l : bars[k].l <= bars[j].l) isL = false
        if (k < j ? bars[k].h > bars[j].h : bars[k].h >= bars[j].h) isH = false
      }
      if (isL && !isNaN(R[j])) lastLow = j
      if (isH && !isNaN(R[j])) lastHigh = j
    }
    if (isNaN(R[i])) continue
    const at = { t: bars[i].t + 60, px: bars[i].c }
    if (lastLow >= 0 && lastLow !== usedLow && i - lastLow <= PIV_LOOKBACK && i > lastLow + PIV_K && bars[i].l < bars[lastLow].l && R[i] > R[lastLow]) { out.push({ side: -1, ...at }); usedLow = lastLow }
    if (lastHigh >= 0 && lastHigh !== usedHigh && i - lastHigh <= PIV_LOOKBACK && i > lastHigh + PIV_K && bars[i].h > bars[lastHigh].h && R[i] < R[lastHigh]) { out.push({ side: 1, ...at }); usedHigh = lastHigh }
  }
  Object.assign(st, { lastLow, lastHigh, usedLow, usedHigh })
}

/**
 * Move filter on bars (bars completed at the signal time only): a low signal needs the high of the last
 * 30 bars, then a low since that high at least s below it; mirror for highs. `idxByT` maps a bar's t to its index.
 */
export function barMoveOk(bars: BenchBar[], idxByT: Map<number, number>, sg: Sig, s: number): boolean {
  const i = idxByT.get(sg.t - 60)
  if (i === undefined) return false
  const from = Math.max(0, i - MOVE_LOOKBACK / 60 + 1)
  if (sg.side === -1) {
    let H = -Infinity
    let k = from
    for (let x = from; x <= i; x++) if (bars[x].h > H) { H = bars[x].h; k = x }
    let L = Infinity
    for (let x = k; x <= i; x++) L = Math.min(L, bars[x].l)
    return H / L - 1 >= s
  }
  let L = Infinity
  let k = from
  for (let x = from; x <= i; x++) if (bars[x].l < L) { L = bars[x].l; k = x }
  let H = -Infinity
  for (let x = k; x <= i; x++) H = Math.max(H, bars[x].h)
  return H / L - 1 >= s
}

/** A flow flip with the index of the print it was decided on (for the tick move filter). */
export type FlowFlip = Sig & { k: number }

/**
 * Order flow: rolling buyer-minus-seller aggressor size over W seconds, evaluated after each print (after
 * all prints of the same ms), prints with t <= now only. Its sign turning from selling to buying -> a low; mirror.
 */
export function flowFlips(ticks: BenchTick[], W: number): FlowFlip[] {
  const out: FlowFlip[] = []
  flowFlipsRun(ticks, W, { lo: 0, imb: 0, sign: 0 }, 0, out)
  return out
}

/** `flowFlips`' window start, running imbalance and last sign. */
type FlipRun = { lo: number; imb: number; sign: number }

/** `flowFlips` from print `from`. A continuation is exact only if print from - 1 was the last of its ms (`benchLoad` checks it). */
function flowFlipsRun(ticks: BenchTick[], W: number, st: FlipRun, from: number, out: FlowFlip[]): void {
  let { lo, imb, sign } = st
  for (let k = from; k < ticks.length; k++) {
    const tk = ticks[k]
    imb += tk.ask === 1 ? tk.size : -tk.size
    while (ticks[lo].t <= tk.t - W * 1000) { imb -= ticks[lo].ask === 1 ? ticks[lo].size : -ticks[lo].size; lo++ }
    if (k + 1 < ticks.length && ticks[k + 1].t === tk.t) continue // evaluate after all prints of the same ms
    const eps = 1e-9
    const sg = imb > eps ? 1 : imb < -eps ? -1 : 0
    if (sg !== 0 && sg !== sign) {
      if (sign === -1) out.push({ side: -1, t: tk.t / 1000, px: tk.px, k }) // selling dominated, now buying -> low
      if (sign === 1) out.push({ side: 1, t: tk.t / 1000, px: tk.px, k })
      sign = sg
    }
  }
  Object.assign(st, { lo, imb, sign })
}

/** The move filter on prints: the same rule as `barMoveOk`, on the prints of the last 30 min up to the flip's own. */
export function tickMoveOk(ticks: BenchTick[], sg: FlowFlip, s: number): boolean {
  const start = sg.t * 1000 - MOVE_LOOKBACK * 1000
  let k0 = sg.k
  while (k0 > 0 && ticks[k0 - 1].t >= start) k0--
  if (sg.side === -1) {
    let H = -Infinity
    let kh = k0
    for (let x = k0; x <= sg.k; x++) if (ticks[x].px > H) { H = ticks[x].px; kh = x }
    let L = Infinity
    for (let x = kh; x <= sg.k; x++) L = Math.min(L, ticks[x].px)
    return H / L - 1 >= s
  }
  let L = Infinity
  let kl = k0
  for (let x = k0; x <= sg.k; x++) if (ticks[x].px < L) { L = ticks[x].px; kl = x }
  let H = -Infinity
  for (let x = kl; x <= sg.k; x++) H = Math.max(H, ticks[x].px)
  return H / L - 1 >= s
}

/** Refractory: sorted by t, a signal within `REFRACT` s of the previous kept one of the same side is dropped. */
export function refract(sigs: Sig[]): Sig[] {
  return refractRun(sigs, refract0(), [])
}

/** `refract`'s last kept t per side. */
type Refract = Record<number, number>
const refract0 = (): Refract => ({ [-1]: -Infinity, [1]: -Infinity })

/** `refract` continued: `sigs` all later than the ones already kept in `out` (a copy is returned). */
function refractRun(sigs: Sig[], last: Refract, prev: Sig[]): Sig[] {
  const out = prev.slice()
  for (const s of [...sigs].sort((a, b) => a.t - b.t)) {
    if (s.t - last[s.side] < REFRACT) continue
    last[s.side] = s.t
    out.push(s)
  }
  return out
}

// ---- 3. scoring (turns and signals both sorted by t)
export const quantile = (xs: number[], p: number): number => quantileSorted([...xs].sort((a, b) => a - b), p)

/** `quantile` of values already sorted ascending (the sliding window of `leanScalesLoader` keeps its own sorted). */
const quantileSorted = (s: number[], p: number): number => {
  if (!s.length) return NaN
  const i = (s.length - 1) * p
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

export type BenchScore = { n: number; matched: number; prec: number; cov: number; leadMed: number; leadP10: number; leadP90: number; gapMed: number; gapTicksMed: number; beforeShare: number; usablePrec: number }

/**
 * A signal is matched when a same-side turn lies within +/-W s (the nearest one is its turn); precision =
 * matched / signals, coverage = turns with a same-side signal within +/-W / turns, lead = signal t - turn t
 * (negative = before the turn), gap = the signal's price past the turn's, in % (> 0 = worse for an entry),
 * usable = matched with gap <= s / 2.
 */
export function score(sigs: Sig[], turns: Turn[], W: number, s: number, tick: number): BenchScore {
  const leads: number[] = []
  const gaps: number[] = []
  const gapT: number[] = []
  let matched = 0
  let usable = 0
  let before = 0
  for (const g of sigs) {
    let best: Turn | null = null
    for (const tu of turns) if (tu.side === g.side && Math.abs(g.t - tu.t) <= W && (!best || Math.abs(g.t - tu.t) < Math.abs(g.t - best.t))) best = tu
    if (!best) continue
    matched++
    const lead = g.t - best.t
    leads.push(lead)
    if (lead < 0) before++
    const gap = g.side === -1 ? (g.px - best.px) / best.px : (best.px - g.px) / best.px
    gaps.push(gap * 100)
    gapT.push(Math.abs(g.px - best.px) / tick)
    if (gap <= s / 2) usable++
  }
  let covered = 0
  for (const tu of turns) if (sigs.some((g) => g.side === tu.side && Math.abs(g.t - tu.t) <= W)) covered++
  return {
    n: sigs.length,
    matched,
    prec: sigs.length ? matched / sigs.length : NaN,
    cov: turns.length ? covered / turns.length : NaN,
    leadMed: quantile(leads, 0.5),
    leadP10: quantile(leads, 0.1),
    leadP90: quantile(leads, 0.9),
    gapMed: quantile(gaps, 0.5),
    gapTicksMed: quantile(gapT, 0.5),
    beforeShare: matched ? before / matched : NaN,
    usablePrec: sigs.length ? usable / sigs.length : NaN,
  }
}

/** Whether a same-side turn lies within +/-W s of the signal - the chart's check or cross. */
export const signalHits = (g: Sig, turns: Turn[], W: number): boolean => turns.some((tu) => tu.side === g.side && Math.abs(g.t - tu.t) <= W)

// ---- 4. the bench run on one market, split so the page recomputes only what a setting changes

/** Flow windows the bench measures, in s. */
export const FLOW_WINDOWS = [60, 120, 300] as const
export type FlowWindow = (typeof FLOW_WINDOWS)[number]
export const flowName = (w: number) => `flow${w / 60}m`
/** The bar tools, in the bench's order. */
export const BAR_TOOLS = ['emaA9', 'emaA20', 'emaB9', 'emaB20', 'boll', 'rsiDiv'] as const
export type BarTool = (typeof BAR_TOOLS)[number]

/** Everything that depends on the data only: the bar tools' refracted signals and the raw flow flips. */
export type BenchBase = {
  bars: BenchBar[]
  ticks: BenchTick[]
  idxByT: Map<number, number>
  bar: Record<BarTool, Sig[]>
  flips: Record<FlowWindow, FlowFlip[]>
}

export function benchBase(bars: BenchBar[], ticks: BenchTick[]): BenchBase {
  const closes = bars.map((b) => b.c)
  return baseRun(bars, ticks, { e9: ema(closes, 9), e20: ema(closes, 20), R: rsi(bars), bands: bollingerBands(bars) }, null).base
}

/** `benchBase`'s running state: the EMA legs, the RSI pivots, each tool's refractory and each flow's window. */
type BaseRun = { leg9: EmaLeg; leg20: EmaLeg; piv: RsiPivots; refract: Record<BarTool, Refract>; flips: Record<FlowWindow, FlipRun> }

/** `benchBase` on the indicators it reads, from scratch or continued from `prev` (its bars and prints a prefix of these). */
function baseRun(bars: BenchBar[], ticks: BenchTick[], ind: { e9: number[]; e20: number[]; R: number[]; bands: { up: number[]; lo: number[] } }, prev: { base: BenchBase; run: BaseRun } | null): { base: BenchBase; run: BaseRun } {
  const from = prev?.base.bars.length ?? 0
  const kFrom = prev?.base.ticks.length ?? 0
  const run: BaseRun =
    prev === null
      ? { leg9: emaLeg0(), leg20: emaLeg0(), piv: rsiPivots0(), refract: { emaA9: refract0(), emaA20: refract0(), emaB9: refract0(), emaB20: refract0(), boll: refract0(), rsiDiv: refract0() }, flips: { 60: { lo: 0, imb: 0, sign: 0 }, 120: { lo: 0, imb: 0, sign: 0 }, 300: { lo: 0, imb: 0, sign: 0 } } }
      : structuredClone(prev.run)
  const A9: Sig[] = []
  const B9: Sig[] = []
  const A20: Sig[] = []
  const B20: Sig[] = []
  emaSignalsRun(bars, ind.e9, run.leg9, from, A9, B9)
  emaSignalsRun(bars, ind.e20, run.leg20, from, A20, B20)
  const div: Sig[] = []
  rsiDivRun(bars, ind.R, run.piv, from, div)
  const fresh: Record<BarTool, Sig[]> = { emaA9: A9, emaA20: A20, emaB9: B9, emaB20: B20, boll: bollSignals(bars, ind.bands, from), rsiDiv: div }
  const bar = {} as Record<BarTool, Sig[]>
  for (const k of BAR_TOOLS) bar[k] = refractRun(fresh[k], run.refract[k], prev?.base.bar[k] ?? [])
  const idxByT = new Map(prev?.base.idxByT)
  for (let i = from; i < bars.length; i++) idxByT.set(bars[i].t, i)
  const flips = {} as Record<FlowWindow, FlowFlip[]>
  for (const w of FLOW_WINDOWS) {
    flips[w] = prev?.base.flips[w].slice() ?? []
    flowFlipsRun(ticks, w, run.flips[w], kFrom, flips[w])
  }
  return { base: { bars, ticks, idxByT, bar, flips }, run }
}

/** Signals of every tool at move size s: `raw` without the move filter, `mv` with it. Flow in `raw` is its flips refracted, in `mv` filtered on the prints then refracted (the bench's `flowXm`, which is always filtered). */
export type BenchTools = { raw: Record<string, Sig[]>; mv: Record<string, Sig[]> }

export function benchTools(base: BenchBase, s: number): BenchTools {
  const raw: Record<string, Sig[]> = {}
  const mv: Record<string, Sig[]> = {}
  for (const k of BAR_TOOLS) {
    raw[k] = base.bar[k]
    mv[k] = base.bar[k].filter((g) => barMoveOk(base.bars, base.idxByT, g, s))
  }
  const strip = (xs: FlowFlip[]): Sig[] => xs.map(({ side, t, px }) => ({ side, t, px }))
  for (const w of FLOW_WINDOWS) {
    raw[flowName(w)] = refract(strip(base.flips[w]))
    mv[flowName(w)] = refract(strip(base.flips[w].filter((g) => tickMoveOk(base.ticks, g, s))))
  }
  return { raw, mv }
}

export type BenchPeriod = 'ticks' | 'candles'
export type BenchRow = { tool: string; score: BenchScore }
export type BenchTable = { from: number; to: number; turns: Turn[]; rows: BenchRow[] }

/**
 * The bench's table for one period, move size and window: `ticks` = from the first print's minute + 30 min
 * to the last print's minute (every tool), `candles` = from the first bar + 30 min to the last bar's close
 * (flow left out). Both end where hindsight is complete (the later of the last confirmed turn and the
 * pending extreme - 30 min). Rows: the chance baseline (one signal per 5 min at a random bar close,
 * random side, the bench's seed 12345 + market + s x 1e5), the bar tools, their "+mv" copies, the flows.
 */
export function benchTable(base: BenchBase, tools: BenchTools, zz: { turns: Turn[]; pendingT: number }, s: number, W: number, period: BenchPeriod, marketId: number, tick: number): BenchTable | null {
  const { bars, ticks, idxByT } = base
  if (bars.length === 0 || (period === 'ticks' && ticks.length === 0)) return null
  const barEnd = bars[bars.length - 1].t + 60
  const p =
    period === 'ticks'
      ? { from: Math.ceil(ticks[0].t / 60000) * 60 + MOVE_LOOKBACK, to: Math.min(barEnd, Math.floor(ticks[ticks.length - 1].t / 60000) * 60) }
      : { from: bars[0].t + MOVE_LOOKBACK, to: barEnd }
  const lastTurnT = zz.turns.length ? zz.turns[zz.turns.length - 1].t : 0
  const knownTo = Math.max(lastTurnT, zz.pendingT - 1800)
  const ev = { from: p.from, to: Math.min(p.to, knownTo) }
  if (ev.to <= ev.from) return null
  const turns = zz.turns.filter((t) => t.t >= ev.from && t.t <= ev.to)
  const inP = (xs: Sig[]) => xs.filter((g) => g.t >= ev.from && g.t <= ev.to)
  let seed = 12345 + marketId + Math.round(s * 1e5)
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const i0 = idxByT.get(Math.ceil(ev.from / 60) * 60 - 60) ?? 0
  const i1 = idxByT.get(Math.floor(ev.to / 60) * 60 - 60) ?? bars.length - 1
  const nR = Math.round((ev.to - ev.from) / 300)
  const R: Sig[] = []
  for (let r = 0; r < nR; r++) {
    const i = i0 + Math.floor(rnd() * (i1 - i0 + 1))
    R.push({ side: rnd() < 0.5 ? -1 : 1, t: bars[i].t + 60, px: bars[i].c })
  }
  const rows: BenchRow[] = [{ tool: 'random (chance)', score: score(refract(R), turns, W, s, tick) }]
  for (const k of BAR_TOOLS) rows.push({ tool: k, score: score(inP(tools.raw[k]), turns, W, s, tick) })
  for (const k of BAR_TOOLS) rows.push({ tool: `${k}+mv`, score: score(inP(tools.mv[k]), turns, W, s, tick) })
  if (period === 'ticks') for (const w of FLOW_WINDOWS) rows.push({ tool: flowName(w), score: score(inP(tools.mv[flowName(w)]), turns, W, s, tick) })
  return { from: ev.from, to: ev.to, turns, rows }
}

// ---- 5. display series (the chart only; every value at bar i reads bars[0..i] or the prints before its close)

/** Keltner (n, k): EMA n of the close +/- k x ATR n, ATR = the simple mean true range of the last n bars including this one. NaN before bar n - 1. */
export function keltner(bars: BenchBar[], n = 20, k = 2): { mid: number[]; up: number[]; lo: number[] } {
  return keltnerRun(bars, bars.map((b) => b.c), n, k, { mid: [], up: [], lo: [] }, { sum: 0 }, 0)
}

/** Bar j's true range (bar 0: its high - low). */
const trueRange = (bars: BenchBar[], j: number) => (j === 0 ? bars[j].h - bars[j].l : Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c)))

/** `keltner` from `from`; `st.sum` = the running sum of the last n true ranges. */
function keltnerRun(bars: BenchBar[], closes: number[], n: number, k: number, prev: { mid: number[]; up: number[]; lo: number[] }, st: { sum: number }, from: number): { mid: number[]; up: number[]; lo: number[] } {
  const mid = emaRun(closes, n, prev.mid, from)
  const up = grow(prev.up, bars.length)
  const lo = grow(prev.lo, bars.length)
  let { sum } = st
  for (let i = from; i < bars.length; i++) {
    sum += trueRange(bars, i)
    if (i >= n) sum -= trueRange(bars, i - n)
    if (i >= n - 1) {
      up[i] = mid[i] + (k * sum) / n
      lo[i] = mid[i] - (k * sum) / n
    }
  }
  st.sum = sum
  return { mid, up, lo }
}

/** Donchian (n): the highest high and lowest low of the last n bars including this one. NaN before bar n - 1. */
export function donchian(bars: BenchBar[], n = 20): { up: number[]; lo: number[] } {
  return donchianRun(bars, n, { up: [], lo: [] }, 0)
}

function donchianRun(bars: BenchBar[], n: number, prev: { up: number[]; lo: number[] }, from: number): { up: number[]; lo: number[] } {
  const up = grow(prev.up, bars.length)
  const lo = grow(prev.lo, bars.length)
  for (let i = Math.max(n - 1, from); i < bars.length; i++) {
    let h = -Infinity
    let l = Infinity
    for (let j = i - n + 1; j <= i; j++) {
      if (bars[j].h > h) h = bars[j].h
      if (bars[j].l < l) l = bars[j].l
    }
    up[i] = h
    lo[i] = l
  }
  return { up, lo }
}

/** MACD (fast, slow, signal) on closes, the bench's EMA: line = EMA fast - EMA slow, signal = EMA of the line, hist = line - signal. */
export function macd(bars: BenchBar[], fast = 12, slow = 26, sig = 9): Macd {
  return macdRun(bars.map((b) => b.c), fast, slow, sig, null).macd
}

type Macd = { line: number[]; signal: number[]; hist: number[] }

/** `macd` from `prev`'s length, its two EMAs (`f`, `s`) kept: the line is their rounded difference, they cannot be read back from it. */
function macdRun(c: number[], fast: number, slow: number, sig: number, prev: { macd: Macd; f: number[]; s: number[] } | null): { macd: Macd; f: number[]; s: number[] } {
  const from = prev?.f.length ?? 0
  const f = emaRun(c, fast, prev?.f ?? [], from)
  const s = emaRun(c, slow, prev?.s ?? [], from)
  const line = prev?.macd.line.slice() ?? []
  for (let i = from; i < c.length; i++) line.push(f[i] - s[i])
  const signal = emaRun(line, sig, prev?.macd.signal ?? [], from)
  const hist = prev?.macd.hist.slice() ?? []
  for (let i = from; i < c.length; i++) hist.push(line[i] - signal[i])
  return { macd: { line, signal, hist }, f, s }
}

/**
 * VWAP from the prints (sum px x size / sum size), reset at 00:00 UTC each day, valued at each bar's
 * close from the prints strictly before it. NaN for a bar with no print yet that day (and before the
 * first print the tape keeps).
 */
export function vwapDaily(bars: BenchBar[], ticks: BenchTick[]): number[] {
  return vwapRun(bars, ticks, [], { k: 0, day: -1, pv: 0, v: 0 }, 0)
}

/** `vwapDaily`'s next print, day and sums. */
type VwapRun = { k: number; day: number; pv: number; v: number }

function vwapRun(bars: BenchBar[], ticks: BenchTick[], prev: number[], st: VwapRun, from: number): number[] {
  const out = grow(prev, bars.length)
  let { k, day, pv, v } = st
  for (let i = from; i < bars.length; i++) {
    const closeMs = (bars[i].t + 60) * 1000
    const barDay = Math.floor(bars[i].t / 86400)
    if (barDay !== day) { day = barDay; pv = 0; v = 0 }
    while (k < ticks.length && ticks[k].t < closeMs) {
      const tk = ticks[k++]
      if (Math.floor(tk.t / 86400000) !== day) continue // a print of an earlier day (before the first bar of this day)
      pv += tk.px * tk.size
      v += tk.size
    }
    if (v > 0) out[i] = pv / v
  }
  Object.assign(st, { k, day, pv, v })
  return out
}

/** Buyer minus seller aggressor size over the W s before each bar's close (prints with close - W <= t < close). NaN before the first print. */
export function flowAtBars(bars: BenchBar[], ticks: BenchTick[], W: number): number[] {
  return flowAtBarsRun(bars, ticks, W, [], { hi: 0, lo: 0, imb: 0 }, 0)
}

/** `flowAtBars`' window [lo, hi) over the prints and its running sum. */
type FlowRun = { hi: number; lo: number; imb: number }

function flowAtBarsRun(bars: BenchBar[], ticks: BenchTick[], W: number, prev: number[], st: FlowRun, from: number): number[] {
  const out = grow(prev, bars.length)
  if (ticks.length === 0) return out
  let { hi, lo, imb } = st
  const signed = (tk: BenchTick) => (tk.ask === 1 ? tk.size : -tk.size)
  for (let i = from; i < bars.length; i++) {
    const closeMs = (bars[i].t + 60) * 1000
    while (hi < ticks.length && ticks[hi].t < closeMs) imb += signed(ticks[hi++])
    while (lo < hi && ticks[lo].t < closeMs - W * 1000) imb -= signed(ticks[lo++])
    if (closeMs > ticks[0].t) out[i] = imb
  }
  Object.assign(st, { hi, lo, imb })
  return out
}

/**
 * The flow estimated from the candles: `sign(c - o) × v` per minute (green = buyers, red = sellers), summed over the
 * last W / 60 bars including the bar itself - the research scripts' rule (`research/lean/candledays.ts`, `formulas.ts`).
 * For the minutes before the first print, where `flowAtBars` is NaN. A rough proxy: same sign as the real flow 61-73 % of the
 * time and a q90 2.7-4.4 times larger (48 h of ANTHROPIC, 2026-10-02), so it is never read on the real flow's scale.
 */
export function candleFlowAtBars(bars: BenchBar[], W: number): number[] {
  const n = W / 60
  const out = new Array<number>(bars.length)
  for (let i = 0; i < bars.length; i++) {
    let sum = 0
    for (let j = Math.max(0, i - n + 1); j <= i; j++) sum += Math.sign(bars[j].c - bars[j].o) * bars[j].v
    out[i] = sum
  }
  return out
}

// ---- 6. the page's two computations, timed (`/test-bench` shows the ms)

/** The chart's display series, one array per line, aligned on the bars. */
export type BenchSeries = {
  ema9: number[]
  ema20: number[]
  /** `mid` is the SMA 20. */
  boll: { mid: number[]; up: number[]; lo: number[] }
  keltner: { mid: number[]; up: number[]; lo: number[] }
  donchian: { up: number[]; lo: number[] }
  vwap: number[]
  rsi: number[]
  macd: { line: number[]; signal: number[]; hist: number[] }
  flow: Record<FlowWindow, number[]>
}

/** `benchSeries`' running state (the MACD's two EMAs are read, never written). */
type SeriesRun = { rsi: RsiRun; keltner: { sum: number }; macd: { f: number[]; s: number[] }; vwap: VwapRun; flow: Record<FlowWindow, FlowRun> }

/** `benchLoad`'s result, and what continuing it takes: the prints it was given and the loops' running state. */
export type BenchLoaded = { base: BenchBase; series: BenchSeries; ms: number; run: { prints: BenchTick[]; base: BaseRun; series: SeriesRun } }

/** The prints' order: by time, then by id. */
export const byTimeId = (a: BenchTick, b: BenchTick) => a.t - b.t || a.id - b.id

/**
 * Once per load: the bench's bars (`benchBars`), the prints sorted by (t, id), the data-only signals and the display series.
 * With `prev` (the previous load) and bars / prints that only add to its own (`appendedPrints`), the loops continue where
 * it stopped instead of rerunning the whole span - once a minute on `/lean`, where the full run is ~200 ms on 14 days
 * (`research/lean/timing.ts`, 2026-10-03). Either way the arrays are the full computation's, bit for bit.
 */
export function benchLoad(minutes: { t: number; o: number; h: number; l: number; c: number; v: number }[], prints: BenchTick[], prev: BenchLoaded | null = null): BenchLoaded {
  const started = performance.now()
  const bars = benchBars(minutes)
  const added = prev === null ? null : appendedPrints(prev, bars, prints)
  const p = added === null ? null : prev
  const ticks = p === null || added === null ? [...prints].sort(byTimeId) : p.base.ticks.concat(added)
  const s = seriesRun(bars, ticks, p === null ? null : { series: p.series, run: p.run.series })
  const b = baseRun(bars, ticks, { e9: s.series.ema9, e20: s.series.ema20, R: s.series.rsi, bands: s.series.boll }, p === null ? null : { base: p.base, run: p.run.base })
  return { base: b.base, series: s.series, ms: performance.now() - started, run: { prints, base: b.run, series: s.run } }
}

/** `benchLoad` holding its last result and continuing it on the next call (`useBenchBase`, one per mount). */
export function benchLoader(): (minutes: { t: number; o: number; h: number; l: number; c: number; v: number }[], prints: BenchTick[]) => BenchLoaded {
  let last: BenchLoaded | null = null
  return (minutes, prints) => (last = benchLoad(minutes, prints, last))
}

/** `old` is a prefix of `bars`, by value: continuing the loops over `old` then gives the full run's arrays. */
function barsExtend(old: BenchBar[], bars: BenchBar[]): boolean {
  if (bars.length < old.length) return false
  for (let i = 0; i < old.length; i++) {
    const a = old[i]
    const b = bars[i]
    if (a.t !== b.t || a.o !== b.o || a.h !== b.h || a.l !== b.l || a.c !== b.c || a.v !== b.v || a.real !== b.real) return false
  }
  return true
}

/**
 * The prints added since `prev`, sorted, when continuing `prev` gives the full result: its bars a prefix of `bars` (by
 * value), its prints a prefix of `prints` (by identity), every added print later than its last one (a flow flip is
 * evaluated after a ms's last print) and not before its last bar's close (the bar flows and the VWAP read the prints
 * before each close). `null` otherwise - a new market, a reload, the first live minute (it moves the loaded prints of
 * the forming minute in) - and the caller runs from scratch.
 */
function appendedPrints(prev: BenchLoaded, bars: BenchBar[], prints: BenchTick[]): BenchTick[] | null {
  const old = prev.base.bars
  const oldPrints = prev.run.prints
  if (old.length === 0 || bars.length < old.length || prints.length < oldPrints.length) return null
  if (!barsExtend(old, bars)) return null
  for (let i = 0; i < oldPrints.length; i++) if (prints[i] !== oldPrints[i]) return null
  const added = prints.slice(oldPrints.length).sort(byTimeId)
  if (added.length === 0) return added
  const last = prev.base.ticks[prev.base.ticks.length - 1]
  if ((last !== undefined && added[0].t <= last.t) || added[0].t < (old[old.length - 1].t + 60) * 1000) return null
  return added
}

/** The display series on `bars`, the flows on `ticks` (sorted by (t, id)): `benchLoad`'s. */
export function benchSeries(bars: BenchBar[], ticks: BenchTick[]): BenchSeries {
  return seriesRun(bars, ticks, null).series
}

/**
 * `benchSeries(bars, [])` holding its last result and continuing it when the new bars only add to the old ones (a minute
 * close on `/demain`, whose bars carry no prints) - the arrays are the full run's, bit for bit. One per mount.
 */
export function benchSeriesLoader(): (bars: BenchBar[]) => BenchSeries {
  let last: { bars: BenchBar[]; series: BenchSeries; run: SeriesRun } | null = null
  return (bars) => {
    const r = seriesRun(bars, [], last !== null && last.bars.length > 0 && barsExtend(last.bars, bars) ? last : null)
    last = { bars, ...r }
    return r.series
  }
}

/** `benchSeries` from scratch, or continued from `prev` (its bars and prints a prefix of these). */
function seriesRun(bars: BenchBar[], ticks: BenchTick[], prev: { series: BenchSeries; run: SeriesRun } | null): { series: BenchSeries; run: SeriesRun } {
  const from = prev?.series.ema9.length ?? 0
  const p = prev?.series
  const r = prev?.run
  const run: SeriesRun =
    r === undefined
      ? { rsi: { g: 0, l: 0 }, keltner: { sum: 0 }, macd: { f: [], s: [] }, vwap: { k: 0, day: -1, pv: 0, v: 0 }, flow: { 60: { hi: 0, lo: 0, imb: 0 }, 120: { hi: 0, lo: 0, imb: 0 }, 300: { hi: 0, lo: 0, imb: 0 } } }
      : { rsi: { ...r.rsi }, keltner: { ...r.keltner }, macd: r.macd, vwap: { ...r.vwap }, flow: { 60: { ...r.flow[60] }, 120: { ...r.flow[120] }, 300: { ...r.flow[300] } } }
  const closes = bars.map((b) => b.c)
  const m = macdRun(closes, 12, 26, 9, p === undefined ? null : { macd: p.macd, ...run.macd })
  run.macd = { f: m.f, s: m.s }
  const series: BenchSeries = {
    ema9: emaRun(closes, 9, p?.ema9 ?? [], from),
    ema20: emaRun(closes, 20, p?.ema20 ?? [], from),
    boll: bollingerRun(bars, 20, 2, p?.boll ?? { mid: [], up: [], lo: [] }, from),
    keltner: keltnerRun(bars, closes, 20, 2, p?.keltner ?? { mid: [], up: [], lo: [] }, run.keltner, from),
    donchian: donchianRun(bars, 20, p?.donchian ?? { up: [], lo: [] }, from),
    vwap: vwapRun(bars, ticks, p?.vwap ?? [], run.vwap, from),
    rsi: rsiRun(bars, 14, p?.rsi ?? [], run.rsi, from),
    macd: m.macd,
    flow: { 60: flowAtBarsRun(bars, ticks, 60, p?.flow[60] ?? [], run.flow[60], from), 120: flowAtBarsRun(bars, ticks, 120, p?.flow[120] ?? [], run.flow[120], from), 300: flowAtBarsRun(bars, ticks, 300, p?.flow[300] ?? [], run.flow[300], from) },
  }
  return { series, run }
}

/** Once per move size: every tool's signals with and without the move filter, and the hindsight turns. */
export function benchShape(base: BenchBase, s: number): { tools: BenchTools; zz: { turns: Turn[]; pendingT: number }; ms: number } {
  const started = performance.now()
  const tools = benchTools(base, s)
  const zz = zigzag(base.bars, s)
  return { tools, zz, ms: performance.now() - started }
}

/** `benchTable`, timed. */
export function benchTableTimed(...args: Parameters<typeof benchTable>): { table: BenchTable | null; ms: number } {
  const started = performance.now()
  const table = benchTable(...args)
  return { table, ms: performance.now() - started }
}

// ---- 7. the live book, and the "situation & risk" panel (`/test-bench`, author 2026-10-01)

/** The book shown: levels within ±1 % of the mid. */
export const BOOK_BAND = 0.01
/** The largest levels of each side within the band, marked as walls. */
export const BOOK_WALLS = 3

/** A read of the book as the page shows it: best prices, mid, the levels within ±1 % and the prices of the walls (the 3 largest levels of each side in the band). */
export type BookView = { bestBid: number; bestAsk: number; mid: number; bids: LighterBookLevel[]; asks: LighterBookLevel[]; bidWalls: Set<number>; askWalls: Set<number> }

/** `null` when one side is empty. */
export function bookView(depth: LighterBookDepth): BookView | null {
  const bestBid = depth.bids[0]?.price ?? null
  const bestAsk = depth.asks[0]?.price ?? null
  if (bestBid === null || bestAsk === null) return null
  const mid = (bestBid + bestAsk) / 2
  const asks = depth.asks.filter((l) => l.price <= mid * (1 + BOOK_BAND))
  const bids = depth.bids.filter((l) => l.price >= mid * (1 - BOOK_BAND))
  const walls = (levels: LighterBookLevel[]) => new Set([...levels].sort((a, b) => b.size - a.size).slice(0, BOOK_WALLS).map((l) => l.price))
  return { bestBid, bestAsk, mid, bids, asks, bidWalls: walls(bids), askWalls: walls(asks) }
}

/** The lean's flow windows (s): 1, 5 and 15 min. */
export const LEAN_FLOWS = [60, 300, 900] as const
export type LeanFlow = (typeof LEAN_FLOWS)[number]
/** Book imbalance bands around the mid: ±0.1 % and ±0.25 %. */
export const LEAN_IMBALANCE_BANDS = [0.001, 0.0025] as const
/** The EMA 20 slope is read over the last 5 closed bars. */
export const LEAN_SLOPE_BARS = 5
/** Each bar component is normalised by this quantile of its |value| over the loaded span: tanh(x / q90). */
export const LEAN_SCALE_Q = 0.9
/** |lean| under this is "≈ 50/50" (between 40/60 and 60/40). */
export const LEAN_FLAT = 0.2
/** Bars skipped before the EMA 20 slope is used (the EMA is seeded at the first close). */
const LEAN_WARMUP = 25

/** What the closed bars say at the last one, and the scale of each over the loaded span (q90 of |x|). */
export type BarFacts = {
  t: number
  /** (EMA20[i] - EMA20[i-5]) / EMA20[i-5]. */
  emaSlope: number
  sma20: number
  /** Buyer minus seller aggressor size over the W s before the last bar's close. */
  flow: Record<LeanFlow, number>
  scale: { emaSlope: number; smaDev: number; flow: Record<LeanFlow, number> }
}

/** The lean's bar inputs per bar - EMA 20 slope over 5 bars, flow 1/5/15 min - and the q90 scales of |x| over bars LEAN_WARMUP.. (the SMA deviation's on the closes). */
type LeanInputs = { slope: number[]; flow: Record<LeanFlow, number[]>; scale: LeanScale }
type LeanScale = BarFacts['scale']

/** (EMA20[i] - EMA20[i-5]) / EMA20[i-5] per bar, NaN before the 6th. */
function leanSlopes(ema20: number[], n: number): number[] {
  const slope = new Array<number>(n).fill(NaN)
  for (let i = LEAN_SLOPE_BARS; i < n; i++) slope[i] = (ema20[i] - ema20[i - LEAN_SLOPE_BARS]) / ema20[i - LEAN_SLOPE_BARS]
  return slope
}

function leanInputs(bars: BenchBar[], ema20: number[], sma20: number[], flow: Record<LeanFlow, number[]>): LeanInputs {
  const n = bars.length
  const slope = leanSlopes(ema20, n)
  const slopes: number[] = []
  const devs: number[] = []
  for (let i = LEAN_WARMUP; i < n; i++) {
    if (Number.isFinite(slope[i])) slopes.push(Math.abs(slope[i]))
    if (Number.isFinite(sma20[i])) devs.push(Math.abs(bars[i].c / sma20[i] - 1))
  }
  const flowScale = { 60: NaN, 300: NaN, 900: NaN }
  for (const w of LEAN_FLOWS) flowScale[w] = quantile(flow[w].filter(Number.isFinite).map(Math.abs), LEAN_SCALE_Q)
  return { slope, flow, scale: { emaSlope: quantile(slopes, LEAN_SCALE_Q), smaDev: quantile(devs, LEAN_SCALE_Q), flow: flowScale } }
}

/** Once per closed minute. `ticks` sorted by time (the base's). `null` with too few bars. */
export function barFacts(bars: BenchBar[], series: BenchSeries, ticks: BenchTick[]): BarFacts | null {
  const n = bars.length
  if (n <= LEAN_WARMUP) return null
  const x = leanInputs(bars, series.ema20, series.boll.mid, { 60: series.flow[60], 300: series.flow[300], 900: flowAtBars(bars, ticks, 900) })
  return { t: bars[n - 1].t, emaSlope: x.slope[n - 1], sma20: series.boll.mid[n - 1], flow: { 60: x.flow[60][n - 1], 300: x.flow[300][n - 1], 900: x.flow[900][n - 1] }, scale: x.scale }
}

/** (bids - asks) / (bids + asks), resting size within ±band of the mid; NaN when both are empty. */
export function bookImbalance(view: BookView, band: number): number {
  let b = 0
  let a = 0
  for (const l of view.bids) if (l.price >= view.mid * (1 - band)) b += l.size
  for (const l of view.asks) if (l.price <= view.mid * (1 + band)) a += l.size
  return b + a > 0 ? (b - a) / (b + a) : NaN
}

/** One component of the lean: its raw value, its scale (null = already in [-1, +1]) and its normalised value. */
export type LeanPart = { key: string; value: number; scale: number | null; norm: number }

/** tanh(x / scale), NaN when either is not usable. */
const squash = (x: number, scale: number) => (Number.isFinite(x) && Number.isFinite(scale) && scale > 0 ? Math.tanh(x / scale) : NaN)

/**
 * The lean: 7 components normalised to [-1, +1] - EMA 20 slope, flow 1/5/15 min and price (book mid) vs
 * SMA 20 by tanh(x / q90 of |x| over the loaded span), the two book imbalances as they are - averaged with
 * equal weights over the finite ones. `s` in [-1, +1], NaN if none is finite. Not calibrated: not a probability.
 */
export function lean(facts: BarFacts, view: BookView): { parts: LeanPart[]; s: number } {
  return leanOf(facts.emaSlope, facts.flow, view.mid / facts.sma20 - 1, LEAN_IMBALANCE_BANDS.map((band) => bookImbalance(view, band)), facts.scale)
}

/** `lean` from its raw values; a NaN value (a book imbalance with no book) is left out of the mean. */
function leanOf(emaSlope: number, flow: Record<LeanFlow, number>, smaDev: number, imbalances: number[], scale: LeanScale): { parts: LeanPart[]; s: number } {
  const parts: LeanPart[] = [
    { key: 'ema', value: emaSlope, scale: scale.emaSlope, norm: squash(emaSlope, scale.emaSlope) },
    ...LEAN_FLOWS.map((w) => ({ key: `flow${w / 60}`, value: flow[w], scale: scale.flow[w], norm: squash(flow[w], scale.flow[w]) })),
    { key: 'sma', value: smaDev, scale: scale.smaDev, norm: squash(smaDev, scale.smaDev) },
    ...LEAN_IMBALANCE_BANDS.map((band, j) => ({ key: `book${band}`, value: imbalances[j], scale: null, norm: imbalances[j] })),
  ]
  const used = parts.filter((p) => Number.isFinite(p.norm))
  return { parts, s: used.length > 0 ? used.reduce((sum, p) => sum + p.norm, 0) / used.length : NaN }
}

// ---- 8. the lean over time and its flips (`/test-bench`, author 2026-10-01: "the lean's turn is the signal, not its level")

/** The book as the lean reads it at one minute close: the mid and the imbalances at ±0.1 / ±0.25 % (`bookImbalance`). */
export type LeanBook = { mid: number; imbalances: number[] }

export const leanBookOf = (view: BookView): LeanBook => ({ mid: view.mid, imbalances: LEAN_IMBALANCE_BANDS.map((band) => bookImbalance(view, band)) })

/**
 * The same `LeanBook` from one sample of a recorded book (`/book/sampled`) (the summed sizes within ±0.1 % and ±0.25 % of the mid, in
 * the order of `LEAN_IMBALANCE_BANDS`): `bookImbalance`'s (bids - asks) / (bids + asks), NaN when both are empty. `null` for a gap sample.
 */
export function leanBookOfSample(s: { gap?: boolean; mid?: number; bidsWithin01?: number; asksWithin01?: number; bidsWithin025?: number; asksWithin025?: number }): LeanBook | null {
  if (s.gap || s.mid === undefined) return null
  const imbalance = (bids?: number, asks?: number) => (bids !== undefined && asks !== undefined && bids + asks > 0 ? (bids - asks) / (bids + asks) : NaN)
  return { mid: s.mid, imbalances: [imbalance(s.bidsWithin01, s.asksWithin01), imbalance(s.bidsWithin025, s.asksWithin025)] }
}

/** The lean at a bar's close (`t` = bar t + 60), `s` in [-1, +1]; `book` = the 2 book components were known; `est` = its flow components came from the candles (`candleFlowAtBars`). */
export type LeanPoint = { t: number; px: number; s: number; book: boolean; est: boolean }

/**
 * `lean` at every bar close from LEAN_WARMUP, the panel's formula and its scales (q90 over all loaded bars, so a
 * past point's scale reads later bars - the panel's choice, kept). `books[i]` = the book holding at bar i's close,
 * `null` when unknown: then the 2 book components are absent and the SMA deviation uses the bar's close for the mid.
 * `estimate` (off by default, the call form without it is unchanged): a bar whose real flow is NaN (before the first
 * print) takes `candleFlowAtBars` instead, squashed by the q90 of |estimate| over those bars alone - the real flow
 * keeps its own scale, computed over the real-flow bars only, and the bars that have it are computed as without.
 */
export function leanHistory(bars: BenchBar[], ema20: number[], sma20: number[], flow: Record<LeanFlow, number[]>, books: (LeanBook | null)[], estimate = false): LeanPoint[] {
  const x = leanInputs(bars, ema20, sma20, flow)
  const est: Record<LeanFlow, number[]> | null = estimate ? { 60: candleFlowAtBars(bars, 60), 300: candleFlowAtBars(bars, 300), 900: candleFlowAtBars(bars, 900) } : null
  const estScale = { 60: NaN, 300: NaN, 900: NaN }
  if (est !== null) for (const w of LEAN_FLOWS) estScale[w] = quantile(est[w].filter((_, i) => !Number.isFinite(flow[w][i])).map(Math.abs), LEAN_SCALE_Q)
  const out: LeanPoint[] = []
  const none = LEAN_IMBALANCE_BANDS.map(() => NaN)
  for (let i = LEAN_WARMUP; i < bars.length; i++) {
    const b = books[i]
    const used = est !== null && LEAN_FLOWS.some((w) => !Number.isFinite(flow[w][i]))
    const at = (w: LeanFlow) => (used && !Number.isFinite(flow[w][i]) ? est[w][i] : flow[w][i])
    const scale = used ? { ...x.scale, flow: { 60: Number.isFinite(flow[60][i]) ? x.scale.flow[60] : estScale[60], 300: Number.isFinite(flow[300][i]) ? x.scale.flow[300] : estScale[300], 900: Number.isFinite(flow[900][i]) ? x.scale.flow[900] : estScale[900] } } : x.scale
    const { s } = leanOf(x.slope[i], { 60: at(60), 300: at(300), 900: at(900) }, (b?.mid ?? bars[i].c) / sma20[i] - 1, b?.imbalances ?? none, scale)
    out.push({ t: bars[i].t + 60, px: bars[i].c, s, book: b !== null, est: used })
  }
  return out
}

/** The five bar components' scales at each bar, from the past alone: `leanScalesLoader`'s output, aligned on the bars, NaN where the window is not full. */
export type LeanScales = { emaSlope: number[]; smaDev: number[]; flow: Record<LeanFlow, number[]> }

/** One component's sliding window: `vals` the |x| it has read, `out` the scale at each bar, `sorted` the finite values of the window [next - size, next - 1], `bad` the others. */
type PastTracker = { vals: number[]; out: number[]; sorted: number[]; bad: number }

/** Index of the first element >= x in an ascending array. */
function lowerBound(s: number[], x: number): number {
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Brings `t` up to `v` (|x| per bar, NaN = no value): `out[i]` = q90 of the `size` values strictly before bar i, NaN unless all
 * `size` are there. A bar close costs one insert and one removal in the sorted window; only when an old value changed does the
 * window restart (one sort) at the first changed bar.
 */
function pastTrackerRun(t: PastTracker, v: number[], size: number): void {
  const had = t.vals.length
  let d = 0
  while (d < had && d < v.length && Object.is(v[d], t.vals[d])) d++
  if (d < had) {
    const window = v.slice(Math.max(0, d - size), d)
    t.sorted = window.filter(Number.isFinite).sort((a, b) => a - b)
    t.bad = window.length - t.sorted.length
    t.vals.length = d
    t.out.length = d
  }
  for (let i = d; i < v.length; i++) {
    t.out[i] = i >= size && t.bad === 0 ? quantileSorted(t.sorted, LEAN_SCALE_Q) : NaN
    t.vals[i] = v[i]
    if (Number.isFinite(v[i])) t.sorted.splice(lowerBound(t.sorted, v[i]), 0, v[i])
    else t.bad++
    if (i >= size) {
      const old = t.vals[i - size]
      if (Number.isFinite(old)) t.sorted.splice(lowerBound(t.sorted, old), 1)
      else t.bad--
    }
  }
}

/**
 * The lean's five scales at each bar from the past alone (`/rsi`, author 2026-10-04): the q90 of |x| over the `size` bars strictly
 * before that bar - never its own value, never a later one - for the EMA 20 slope, the flow 1 / 5 / 15 min and the price vs SMA 20,
 * each NaN until `size` values of its own exist (the price components count from bar LEAN_WARMUP, the flow ones from the first print).
 * Returns a function holding the windows: called again with the bars grown by one close it computes that close only.
 */
export function leanScalesLoader() {
  const fresh = (): PastTracker => ({ vals: [], out: [], sorted: [], bad: 0 })
  let held = 0
  let tr = { emaSlope: fresh(), smaDev: fresh(), 60: fresh(), 300: fresh(), 900: fresh() }
  return (bars: BenchBar[], ema20: number[], sma20: number[], flow: Record<LeanFlow, number[]>, size: number): LeanScales => {
    if (size !== held) {
      held = size
      tr = { emaSlope: fresh(), smaDev: fresh(), 60: fresh(), 300: fresh(), 900: fresh() }
    }
    const slope = leanSlopes(ema20, bars.length)
    pastTrackerRun(tr.emaSlope, slope.map((x, i) => (i >= LEAN_WARMUP ? Math.abs(x) : NaN)), size)
    pastTrackerRun(tr.smaDev, bars.map((b, i) => (i >= LEAN_WARMUP ? Math.abs(b.c / sma20[i] - 1) : NaN)), size)
    for (const w of LEAN_FLOWS) pastTrackerRun(tr[w], flow[w].map(Math.abs), size)
    return { emaSlope: tr.emaSlope.out.slice(), smaDev: tr.smaDev.out.slice(), flow: { 60: tr[60].out.slice(), 300: tr[300].out.slice(), 900: tr[900].out.slice() } }
  }
}

/**
 * `leanHistory` with each bar's scales taken from `scales` (`leanScalesLoader`) instead of the whole loaded span: the same
 * `leanOf`, from LEAN_WARMUP. A bar where any of the five scales is NaN has no lean (`s` NaN): the lean is the mean of its seven
 * components or nothing. No estimated flow.
 */
export function leanHistoryPast(bars: BenchBar[], ema20: number[], sma20: number[], flow: Record<LeanFlow, number[]>, books: (LeanBook | null)[], scales: LeanScales): LeanPoint[] {
  const slope = leanSlopes(ema20, bars.length)
  const out: LeanPoint[] = []
  const none = LEAN_IMBALANCE_BANDS.map(() => NaN)
  for (let i = LEAN_WARMUP; i < bars.length; i++) {
    const b = books[i]
    const scale: LeanScale = { emaSlope: scales.emaSlope[i], smaDev: scales.smaDev[i], flow: { 60: scales.flow[60][i], 300: scales.flow[300][i], 900: scales.flow[900][i] } }
    const full = Number.isFinite(scale.emaSlope) && Number.isFinite(scale.smaDev) && LEAN_FLOWS.every((w) => Number.isFinite(scale.flow[w]))
    const s = full ? leanOf(slope[i], { 60: flow[60][i], 300: flow[300][i], 900: flow[900][i] }, (b?.mid ?? bars[i].c) / sma20[i] - 1, b?.imbalances ?? none, scale).s : NaN
    out.push({ t: bars[i].t + 60, px: bars[i].c, s, book: b !== null, est: false })
  }
  return out
}

/** The change of the plotted lean (100·s) over the last `k` closed minutes, per point; NaN under `k` points or when either end is NaN. */
export function leanSlope(points: LeanPoint[], k = 3): number[] {
  return points.map((p, i) => (i < k ? NaN : 100 * (p.s - points[i - k].s)))
}

/** The panel's LONG figure, round(50 + 50 s); SHORT = 100 - it. */
export const leanLong = (s: number) => Math.round(50 + 50 * s)

/** "→ LONG" / "→ SHORT" / "close", at a minute close (`t`, `px` its close); `from` = the side held before (0 = flat). */
export type LeanFlip = { kind: 'long' | 'short' | 'close'; t: number; px: number; long: number; from: 1 | 0 | -1 }

/**
 * Hysteresis on the panel's figures: "→ SHORT" when not short and SHORT >= `enter`, "→ LONG" the mirror, "close" when
 * the side held drops under `exit` (a flip to the other side closes and reverses at once). A NaN lean changes nothing.
 * `zoneEnd` (the zone rule, author 2026-10-01): a long zone starts at LONG >= enter (→ LONG) and ends when LONG falls to
 * <= zoneEnd (→ SHORT at once); a short zone mirrored (ends at LONG >= 100 - zoneEnd, → LONG). Always in position, no
 * "close", `exit` unused; a zone start on the side held changes nothing. (rule B).
 */
export function leanFlips(points: LeanPoint[], enter: number, exit: number, zoneEnd: number | null = null): LeanFlip[] {
  const out: LeanFlip[] = []
  let held: 1 | 0 | -1 = 0
  let zone: 1 | 0 | -1 = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!Number.isFinite(p.s)) continue
    const long = leanLong(p.s)
    const at = { t: p.t, px: p.px, long, from: held }
    if (zoneEnd !== null) {
      // The side to hold after this point (0 = unchanged): a zone start goes its way, a zone end reverses.
      let side: 1 | 0 | -1 = 0
      if (zone !== 1 && long >= enter) {
        zone = 1
        side = 1
      } else if (zone !== -1 && 100 - long >= enter) {
        zone = -1
        side = -1
      } else if (zone === 1 && long <= zoneEnd) {
        zone = 0
        side = -1
      } else if (zone === -1 && 100 - long <= zoneEnd) {
        zone = 0
        side = 1
      }
      if (side !== 0 && side !== held) {
        out.push({ kind: side === 1 ? 'long' : 'short', ...at })
        held = side
      }
      continue
    }
    if (held !== -1 && 100 - long >= enter) {
      out.push({ kind: 'short', ...at })
      held = -1
    } else if (held !== 1 && long >= enter) {
      out.push({ kind: 'long', ...at })
      held = 1
    } else if ((held === 1 && long < exit) || (held === -1 && 100 - long < exit)) {
      out.push({ kind: 'close', ...at })
      held = 0
    }
  }
  return out
}

/** The SMA `n` of the lean points' prices (their minute closes), per point; NaN before a full window (`indicators.ts`'s running sum). */
export function priceSma(points: LeanPoint[], n: number): number[] {
  const out = new Array<number>(points.length).fill(NaN)
  sma(points.map((p) => ({ time: p.t, value: p.px })), n).forEach((v, j) => {
    out[j + n - 1] = v.value
  })
  return out
}

/** The EMA `n` of the lean points' prices (`ema`, seeded at the first price), per point; the "EMA" choice of `/lean`'s trend way. */
export function priceEma(points: LeanPoint[], n: number): number[] {
  return ema(points.map((p) => p.px), n)
}

/** The SMA's rise is read over this many minutes (`TREND_LOOKBACK`). */
export const TREND_LOOKBACK = 10

/** A minute's trend: 1 = up, -1 = down, 0 = waves, 'mixed' = the price within the gap of its average. */
export type TrendRegime = 1 | 0 | -1 | 'mixed'

/**
 * The trend per point from the SMA of the price (`ma`, `priceSma`), with `gap` = price / SMA - 1: 1 = up (gap > `gapPct` %
 * and SMA > SMA 10 min before), -1 = down (mirrored), 'mixed' when |gap| <= `gapPct` %, else 0 = waves; 0 too when the SMA
 * 10 min before is not known yet.
 */
export function trendRegimes(points: LeanPoint[], ma: number[], gapPct = 0): TrendRegime[] {
  const b = gapPct / 100
  return points.map((p, i) => {
    if (i < TREND_LOOKBACK || !Number.isFinite(ma[i - TREND_LOOKBACK])) return 0
    const gap = p.px / ma[i] - 1
    if (gap > b && ma[i] > ma[i - TREND_LOOKBACK]) return 1
    if (gap < -b && ma[i] < ma[i - TREND_LOOKBACK]) return -1
    if (Math.abs(gap) <= b) return 'mixed'
    return 0
  })
}

/**
 * `/lean`'s "with the trend (SMA N)" rule (author, 2026-10-01): the trend from `trendRegimes` on the SMA `smaN` of the price
 * (the lean is not smoothed). Up: LONG on a push (LONG reaches x from outside the top zone) or on a bottom peak (LONG <= 100
 * - x, `leanSlope` crossing 0 going up), no shorts; down mirrored, no longs; waves: "zone + d=0" both ways. Always in
 * position, a signal on the side held does nothing, a minute with a NaN lean, slope or SMA 10 min before is skipped (the
 * push zone too). With a gap (`gapPct` %, `trendRegimes`): the mixed minutes trade the waves, or nothing when `holdMixed`
 * (the position is held).
 * `extreme` E (author, 2026-10-01, "often the top of a peak"): the unrounded lean crossing above E (previous minute not
 * skipped <= E) is a SHORT whatever the trend, crossing below 100 - E a LONG; it outranks the trend at that minute, and its
 * flips carry `extreme: true`. `null` = off, unchanged.
 */
export function trendRegimeFlips(points: LeanPoint[], x: number, smaN: number, ma = priceSma(points, smaN), gapPct = 0, holdMixed = false, extreme: number | null = null): TrendFlip[] {
  const d = leanSlope(points)
  const regime = trendRegimes(points, ma, gapPct)
  const out: TrendFlip[] = []
  let held: 1 | 0 | -1 = 0
  let zone: 1 | 0 | -1 = 0
  // The unrounded lean (50 + 50 s) of the last minute not skipped, for the extreme crossings.
  let prevU = 50
  for (let i = TREND_LOOKBACK + 1; i < points.length; i++) {
    const p = points[i]
    if (!Number.isFinite(p.s) || !Number.isFinite(d[i]) || !Number.isFinite(d[i - 1]) || !Number.isFinite(ma[i - TREND_LOOKBACK])) continue
    const long = leanLong(p.s)
    const enterL = zone !== 1 && long >= x
    const enterS = zone !== -1 && long <= 100 - x
    if (enterL) zone = 1
    else if (enterS) zone = -1
    const peakS = long >= x && d[i - 1] > 0 && d[i] <= 0
    const peakL = long <= 100 - x && d[i - 1] < 0 && d[i] >= 0
    const u = 50 + 50 * p.s
    let side: 1 | -1 | 0 = 0
    let exc = false
    if (extreme !== null && u > extreme && prevU <= extreme) {
      side = -1
      exc = true
    } else if (extreme !== null && u < 100 - extreme && prevU >= 100 - extreme) {
      side = 1
      exc = true
    } else if (regime[i] === 1) side = enterL || peakL ? 1 : 0
    else if (regime[i] === -1) side = enterS || peakS ? -1 : 0
    else if (regime[i] === 'mixed' && holdMixed) side = 0
    else side = peakS ? -1 : peakL ? 1 : 0
    prevU = u
    if (side !== 0 && side !== held) {
      const f: TrendFlip = { kind: side === 1 ? 'long' : 'short', t: p.t, px: p.px, long, from: held }
      if (exc) f.extreme = true
      out.push(f)
      held = side
    }
  }
  return out
}

/** A point's mode under the stretch rule: 1 = "maybe long" (price <= MA - E %), -1 = "maybe short" (price >= MA + E %), 0 = neither; NaN inputs give 0. */
export type StretchMode = 1 | 0 | -1

/** Rule 1 (author, 2026-10-03): the stretch price / `ma` - 1 in % against E, per point. */
export function stretchModes(points: LeanPoint[], ma: number[], ePct: number): StretchMode[] {
  return points.map((p, i) => {
    const stretch = (p.px / ma[i] - 1) * 100
    return !Number.isFinite(stretch) ? 0 : stretch >= ePct ? -1 : stretch <= -ePct ? 1 : 0
  })
}

/**
 * Rules 1 + 2 (author, 2026-10-03, `/lean`'s rule): the MA first, the lean second. Rule 1: the price far above its MA
 * (`stretchModes`, >= +E %) puts the minute in "maybe short", far below (<= -E %) in "maybe long", between the two
 * nothing fires and the side held stays. Rule 2: in "maybe short" the lean's LONG figure reaching >= `x` fires →SHORT;
 * in "maybe long" the figure at <= 100 - `x` fires →LONG (the author, on the chart's -100..+100 scale: "+100 short,
 * -100 long", the top line for the shorts, the bottom line for the longs). A level crossed, not a wave turn. Always in
 * position, out only by reversing, never twice
 * on the held side. No regime, no mixed zone, no extreme exception.
 */
export function stretchLeanFlips(points: LeanPoint[], ma: number[], ePct: number, a: number, b: number): LeanFlip[] {
  const out: LeanFlip[] = []
  let held: 1 | 0 | -1 = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!Number.isFinite(p.s)) continue
    const long = leanLong(p.s)
    const side = tryRule({ stretchPct: (p.px / ma[i] - 1) * 100, lean: 100 * p.s }, { E: ePct, A: a, B: b })
    if (side !== 0 && side !== held) {
      out.push({ kind: side === 1 ? 'long' : 'short', t: p.t, px: p.px, long, from: held })
      held = side
    }
  }
  return out
}

/** What one minute shows the rule: the stretch price / SMA - 1 in %, and the lean as the chart's pane draws it, -100..+100. */
export type RuleInputs = { stretchPct: number; lean: number }
/** The rule's visible fields: E = "beaucoup" in %; [A, B] = the lean's top band on the -100..+100 scale, [-B, -A] the bottom one. */
export type RuleFields = { E: number; A: number; B: number }

/**
 * THE RULE, one minute at a time (author, 2026-10-03) - the place to read and change it. Returns the side the minute asks
 * for: -1 = SHORT, 1 = LONG, 0 = nothing. `stretchLeanFlips` turns the sides into flips (a side already held is not fired
 * again).
 */
export function tryRule({ stretchPct, lean }: RuleInputs, { E, A, B }: RuleFields): 1 | 0 | -1 {
  if (!Number.isFinite(stretchPct) || !Number.isFinite(lean)) return 0
  // Rule 1: the price against its SMA.
  const maybeShort = stretchPct >= E // far above
  const maybeLong = stretchPct <= -E // far below
  // Rule 2: the lean must be IN the band to fire (author, 2026-10-04: "it has to be in the band to fire") - above B
  // is too high, nothing until it comes back into [A, B]; the bottom band is the mirror, [-B, -A].
  const inTopBand = lean >= A && lean <= B
  const inBottomBand = lean <= -A && lean >= -B
  if (maybeShort && inTopBand) return -1
  if (maybeLong && inBottomBand) return 1
  return 0
}

/** A flip of `trendRegimeFlips`; `extreme` only on the exception's (the lean crossing E or 100 - E), absent otherwise. */
export type TrendFlip = LeanFlip & { extreme?: true }

/** The flip was the extreme exception's (`trendRegimeFlips` with `extreme`). */
export const isExtremeFlip = (f: LeanFlip): boolean => 'extreme' in f && f.extreme === true

/** A turn known in real time: `side` -1 = an L, +1 = an H, at its extreme close `px`, known at point `i`. */
export type KnownTurn = { side: 1 | -1; px: number; i: number }

/**
 * The real-time zigzag on the lean's points (their closes): an L is known when a close is `pct` % above the lowest close
 * since the last H was known, an H when `pct` % under the highest since the last L; they alternate.
 */
export function knownTurns(points: LeanPoint[], pct: number): KnownTurn[] {
  const out: KnownTurn[] = []
  let last: 1 | 0 | -1 = 0
  let hi = -Infinity
  let lo = Infinity
  for (let i = 0; i < points.length; i++) {
    const px = points[i].px
    hi = Math.max(hi, px)
    lo = Math.min(lo, px)
    if (last !== -1 && px >= lo * (1 + pct / 100)) {
      out.push({ side: -1, px: lo, i })
      last = -1
      hi = px
      lo = px
    } else if (last !== 1 && px <= hi * (1 - pct / 100)) {
      out.push({ side: 1, px: hi, i })
      last = 1
      hi = px
      lo = px
    }
  }
  return out
}

/**
 * The L / H known at `pct` % as flips (`knownTurns`): "→ LONG" at a known L, "→ SHORT" at a known H; always in position,
 * never "close". The lean itself unused but for the `long` figure.
 */
export function knownTurnFlips(points: LeanPoint[], pct: number): LeanFlip[] {
  return knownTurns(points, pct).map((k, j, all) => {
    const p = points[k.i]
    return { kind: k.side === -1 ? 'long' : 'short', t: p.t, px: p.px, long: leanLong(p.s), from: j === 0 ? 0 : all[j - 1].side === -1 ? 1 : -1 }
  })
}

/** The flips as bench signals: "→ LONG" claims a low (side -1), "→ SHORT" a high. */
export const leanFlipSigs = (flips: LeanFlip[]): Sig[] => refract(flips.flatMap((f) => (f.kind === 'close' ? [] : [{ side: f.kind === 'long' ? (-1 as const) : (1 as const), t: f.t, px: f.px }])))

/** A row scored on a table's own span and turns, like its other rows. */
export const benchExtraRow = (table: BenchTable, tool: string, sigs: Sig[], W: number, s: number, tick: number): BenchRow => ({ tool, score: score(sigs.filter((g) => g.t >= table.from && g.t <= table.to), table.turns, W, s, tick) })

/** One side's risk on the live book for `margin` USDG at `leverage`. Prices in quote, $ in USDG. */
export type SideRisk = {
  side: 1 | -1
  notional: number
  /** Best ask for a long, best bid for a short. */
  entry: number
  qty: number
  stop: number
  /** The wall the stop sits one tick beyond, or null when the band holds no wall on that side (fixed % stop). */
  stopWall: number | null
  /** The nearest opposite wall strictly beyond the entry, or null. */
  target: number | null
  loss: number
  gain: number | null
  rr: number | null
  /** Average fill walking the read book for `qty`, minus the entry, as a fraction of the entry; null when the read book is too thin. */
  slip: number | null
  slipUsd: number | null
  /** entry x (1 -/+ 1 / leverage): ignores the maintenance margin, which `core/lighter.ts` does not read. */
  liq: number
}

/** Long (side 1) or short (-1): stop one tick beyond the nearest own-side wall, target the nearest opposite wall. */
export function sideRisk(depth: LighterBookDepth, view: BookView, side: 1 | -1, margin: number, leverage: number, fallbackStop: number, tick: number): SideRisk {
  const notional = margin * leverage
  const entry = side === 1 ? view.bestAsk : view.bestBid
  const qty = notional / entry
  // Own-side walls (bids under a long, asks over a short): the nearest is the closest to the price.
  const own = [...(side === 1 ? view.bidWalls : view.askWalls)]
  const stopWall = own.length === 0 ? null : side === 1 ? Math.max(...own) : Math.min(...own)
  const stop = stopWall !== null ? stopWall - side * tick : entry * (1 - side * fallbackStop)
  const beyond = [...(side === 1 ? view.askWalls : view.bidWalls)].filter((p) => (p - entry) * side > 0)
  const target = beyond.length === 0 ? null : side === 1 ? Math.min(...beyond) : Math.max(...beyond)
  const loss = (entry - stop) * side * qty
  const gain = target === null ? null : (target - entry) * side * qty
  // Walk the opposite side of the whole read book (250 orders, not only the band) for qty.
  let left = qty
  let cost = 0
  for (const l of side === 1 ? depth.asks : depth.bids) {
    const take = Math.min(left, l.size)
    cost += take * l.price
    left -= take
    if (left <= 0) break
  }
  const avg = left <= qty * 1e-9 ? cost / qty : null
  return {
    side,
    notional,
    entry,
    qty,
    stop,
    stopWall,
    target,
    loss,
    gain,
    rr: gain !== null && loss > 0 ? gain / loss : null,
    slip: avg === null ? null : ((avg - entry) * side) / entry,
    slipUsd: avg === null ? null : (avg - entry) * side * qty,
    liq: entry * (1 - side / leverage),
  }
}

// ---- 8. the state of the indicators at the turns (`/lean`'s table, author 2026-10-03)

/** A table column: `row` ones are the turn's own (known, next move), `minute` ones are read at a minute and also feed the condition test. */
export type TurnColumn = { key: string; label: string; kind: 'row' | 'minute'; digits: number }
const MA_STRETCH = [20, 60, 90, 120] as const
const EMA_STRETCH = [9, 20, 60, 90, 120] as const
export const TURN_COLUMNS: TurnColumn[] = [
  { key: 'knownMin', label: 'known after (min)', kind: 'row', digits: 0 },
  { key: 'knownMove', label: 'known at (%)', kind: 'row', digits: 2 },
  { key: 'nextMove', label: 'next move %', kind: 'row', digits: 2 },
  { key: 'lean', label: 'lean', kind: 'minute', digits: 1 },
  { key: 'dlean', label: 'd lean', kind: 'minute', digits: 1 },
  ...MA_STRETCH.map((n) => ({ key: `sma${n}`, label: `SMA ${n} %`, kind: 'minute' as const, digits: 3 })),
  ...EMA_STRETCH.map((n) => ({ key: `ema${n}`, label: `EMA ${n} %`, kind: 'minute' as const, digits: 3 })),
  { key: 'vwap', label: 'VWAP %', kind: 'minute', digits: 3 },
  { key: 'boll', label: 'Boll pos', kind: 'minute', digits: 2 },
  { key: 'keltner', label: 'Keltner pos', kind: 'minute', digits: 2 },
  { key: 'donchian', label: 'Donchian pos', kind: 'minute', digits: 2 },
  { key: 'rsi', label: 'RSI 14', kind: 'minute', digits: 1 },
  { key: 'macdLine', label: 'MACD %', kind: 'minute', digits: 4 },
  { key: 'macdSignal', label: 'MACD sig %', kind: 'minute', digits: 4 },
  { key: 'macdHist', label: 'MACD hist %', kind: 'minute', digits: 4 },
  { key: 'flow1', label: 'flux 1', kind: 'minute', digits: 1 },
  { key: 'flow5', label: 'flux 5', kind: 'minute', digits: 1 },
  { key: 'flow15', label: 'flux 15', kind: 'minute', digits: 1 },
]
export const TURN_MINUTE_COLUMNS = TURN_COLUMNS.filter((c) => c.kind === 'minute')

/** Every minute column at every bar, read at the bar's close; NaN where the indicator or the lean does not exist. `barAt` maps a bar's `t` to its index. */
export type TurnArrays = { bars: BenchBar[]; barAt: Map<number, number>; cols: Record<string, number[]>; derived: Map<string, number[]> }

/** The operations between two minute columns the search tries (author, 2026-10-04: "operations * + - between the values"). */
export const DERIVED_OPS = ['-', '+', '*'] as const
export type DerivedOp = (typeof DERIVED_OPS)[number]
/** A derived column's key: `<a><op><b>` on two minute column keys, e.g. `sma120-sma20`. */
export const derivedKey = (a: string, op: DerivedOp, b: string) => `${a}${op}${b}`
const DERIVED_RE = /^([a-zA-Z0-9]+)([-+*])([a-zA-Z0-9]+)$/

/** A column by key: a minute column of `TURN_COLUMNS`, or a derived one computed once and kept on `ta.derived`; `[]` when unknown. */
export function columnOf(ta: TurnArrays, key: string): number[] {
  const base = ta.cols[key]
  if (base !== undefined) return base
  const kept = ta.derived.get(key)
  if (kept !== undefined) return kept
  const m = DERIVED_RE.exec(key)
  if (m === null) return []
  const a = ta.cols[m[1]]
  const b = ta.cols[m[3]]
  if (a === undefined || b === undefined) return []
  const op = m[2] as DerivedOp
  const out = a.map((x, i) => (op === '-' ? x - b[i] : op === '+' ? x + b[i] : x * b[i]))
  ta.derived.set(key, out)
  return out
}

/** A column's label for the author: the table's for a base column, "A − B" for a derived one. */
export function columnLabel(key: string): string {
  const base = TURN_COLUMNS.find((c) => c.key === key)
  if (base !== undefined) return base.label
  const m = DERIVED_RE.exec(key)
  if (m === null) return key
  const sym = m[2] === '-' ? '−' : m[2] === '+' ? '+' : '×'
  return `${columnLabel(m[1])} ${sym} ${columnLabel(m[3])}`
}

/**
 * The minute columns once per load. Index: a bar index `i` reads `series.*[i]` and `flow[*][i]`; the lean, its slope and the
 * `priceSma` / `priceEma` MAs are per point `j`, a point's `t` being bar `i`'s close (`t - 60`), so they land on bar `barAt(points[j].t - 60)`.
 * Stretch = close / MA - 1 in %, band position = (close - lower) / (upper - lower), MACD in % of the close. SMA 20 / EMA 9 / EMA 20 are the chart's own series.
 */
export function turnArrays(bars: BenchBar[], points: LeanPoint[], series: BenchSeries, flow: Record<LeanFlow, number[]>): TurnArrays {
  const n = bars.length
  const barAt = new Map(bars.map((b, i) => [b.t, i]))
  const cols: Record<string, number[]> = {}
  for (const c of TURN_MINUTE_COLUMNS) cols[c.key] = new Array<number>(n).fill(NaN)
  const stretch = (i: number, ma: number) => (bars[i].c / ma - 1) * 100
  const pos = (i: number, lo: number, up: number) => (bars[i].c - lo) / (up - lo)
  for (let i = 0; i < n; i++) {
    cols.sma20[i] = stretch(i, series.boll.mid[i])
    cols.ema9[i] = stretch(i, series.ema9[i])
    cols.ema20[i] = stretch(i, series.ema20[i])
    cols.vwap[i] = stretch(i, series.vwap[i])
    cols.boll[i] = pos(i, series.boll.lo[i], series.boll.up[i])
    cols.keltner[i] = pos(i, series.keltner.lo[i], series.keltner.up[i])
    cols.donchian[i] = pos(i, series.donchian.lo[i], series.donchian.up[i])
    cols.rsi[i] = series.rsi[i]
    cols.macdLine[i] = (series.macd.line[i] / bars[i].c) * 100
    cols.macdSignal[i] = (series.macd.signal[i] / bars[i].c) * 100
    cols.macdHist[i] = (series.macd.hist[i] / bars[i].c) * 100
    cols.flow1[i] = flow[60][i]
    cols.flow5[i] = flow[300][i]
    cols.flow15[i] = flow[900][i]
  }
  const slope = leanSlope(points)
  const mas = [...[60, 90, 120].map((m) => ({ key: `sma${m}`, ma: priceSma(points, m) })), ...[60, 90, 120].map((m) => ({ key: `ema${m}`, ma: priceEma(points, m) }))]
  points.forEach((p, j) => {
    const i = barAt.get(p.t - 60)
    if (i === undefined) return
    cols.lean[i] = 100 * p.s
    cols.dlean[i] = slope[j]
    for (const m of mas) cols[m.key][i] = stretch(i, m.ma[j])
  })
  return { bars, barAt, cols, derived: new Map() }
}

/** The turns the author marked by hand (`/lean`'s →L / →S): `side` 1 = →S (an H), -1 = →L (an L), `t` = the bar's `t`. */
export type TurnMark = { t: number; side: 1 | -1 }

/** The author's judgement of a zigzag turn (`/lean`'s context window, 2026-10-04): `t` = the turn's bar `t` (turn.t - 30), `good` = a good H / L or a bad one. */
export type TurnLabel = { t: number; side: 1 | -1; good: boolean }

/** A mark as a `Turn` (`t` = bar + 30, as the zigzag's); its `px` is the bar's high for an H and its low for an L. A mark on an unloaded bar is dropped. */
export function marksAsTurns(marks: TurnMark[], ta: TurnArrays): Turn[] {
  return marks
    .flatMap((m) => {
      const i = ta.barAt.get(m.t)
      return i === undefined ? [] : [{ side: m.side, t: m.t + 30, px: m.side === 1 ? ta.bars[i].h : ta.bars[i].l }]
    })
    .sort((a, b) => a.t - b.t)
}

/** Reading minute = the turn's bar + this many minutes, or `known` = the minute the turn became visible (`TurnRow.v[0]`). */
export type TurnOffset = number | 'known'

/** `v` follows `TURN_COLUMNS`; `bi` = the turn's bar index (-1 when its bar is not loaded), `r` = the reading bar index (-1 when none). */
export type TurnRow = { turn: Turn; bi: number; r: number; v: number[] }
export type TurnStats = { n: number; q10: number[]; med: number[]; q90: number[] }
export type TurnStates = { rows: TurnRow[]; H: TurnStats; L: TurnStats }

/**
 * One row per turn: the known minute (the first close after the extreme `hlPct` % away from it, searched up to the next turn's
 * bar - the `knownTurns` condition on the turn's own price), the move to the next turn (NaN for the last turn and when
 * `withNext` is false, i.e. marks), and the minute columns at the reading minute. Summaries over every turn whose next move is
 * at least `minMove` % (`minMove` <= 0 keeps every turn, marks included), per column, over its finite values only.
 */
export function turnStates(ta: TurnArrays, turns: Turn[], hlPct: number, offset: TurnOffset, minMove: number, withNext: boolean, keep: (turn: Turn) => boolean = () => true): TurnStates {
  const { bars, barAt, cols } = ta
  // `keep` selects the rows listed and summed up (the author's good or bad turns); known and next move are read over every turn.
  const all: TurnRow[] = turns.map((turn, k) => {
    const bi = barAt.get(turn.t - 30) ?? -1
    const next = withNext && k + 1 < turns.length ? turns[k + 1] : null
    const nextBi = next === null ? bars.length : (barAt.get(next.t - 30) ?? bars.length)
    let knownMin = NaN
    let knownMove = NaN
    if (bi >= 0) {
      for (let i = bi + 1; i < nextBi; i++) {
        const c = bars[i].c
        const move = (turn.side === -1 ? c / turn.px - 1 : 1 - c / turn.px) * 100
        if (move >= hlPct) {
          knownMin = i - bi
          knownMove = move
          break
        }
      }
    }
    const nextMove = next === null ? NaN : ((turn.side === 1 ? turn.px - next.px : next.px - turn.px) / turn.px) * 100
    const r0 = offset === 'known' ? (Number.isFinite(knownMin) ? bi + knownMin : -1) : bi < 0 ? -1 : bi + offset
    const r = r0 >= 0 && r0 < bars.length ? r0 : -1
    const v = TURN_COLUMNS.map((c) => (c.key === 'knownMin' ? knownMin : c.key === 'knownMove' ? knownMove : c.key === 'nextMove' ? nextMove : r < 0 ? NaN : cols[c.key][r]))
    return { turn, bi, r, v }
  })
  const rows = all.filter((row) => keep(row.turn))
  const stats = (side: 1 | -1): TurnStats => {
    const sel = rows.filter((row) => row.turn.side === side && (minMove <= 0 || row.v[2] >= minMove))
    const per = TURN_COLUMNS.map((_, c) => sel.map((row) => row.v[c]).filter(Number.isFinite))
    return { n: sel.length, q10: per.map((x) => quantile(x, 0.1)), med: per.map((x) => quantile(x, 0.5)), q90: per.map((x) => quantile(x, 0.9)) }
  }
  return { rows, H: stats(1), L: stats(-1) }
}

/** The condition test's adverse move is read over this many minutes after the signal. */
export const CONDITION_ADVERSE_MIN = 15

export type ConditionResult = { sigs: Sig[]; hits: boolean[]; score: BenchScore; falseN: number; falseAdverseMed: number }

/** One comparison on a minute column of `TURN_COLUMNS`: `col` `>=` / `<=` `value`. A rule is one or more, ANDed. */
export type Condition = { col: string; op: '>=' | '<='; value: number }

/** `scoreConditions` with one condition - the condition test's own call. */
export function scoreCondition(ta: TurnArrays, col: string, op: '>=' | '<=', value: number, side: 1 | -1, turns: Turn[], windowMin: number, hlPct: number, tick: number): ConditionResult {
  return scoreConditions(ta, [{ col, op, value }], side, turns, windowMin, hlPct, tick)
}

/**
 * A signal at the close of each minute where every condition holds and did not the minute before (or the first loaded
 * minute) (`side` 1 = SHORT as an H, -1 = LONG as an L), scored by `score` against `turns` within +/-`windowMin`; the false
 * ones (no same-side turn within it, `signalHits`) get the median of the price's move against the side over the next
 * `CONDITION_ADVERSE_MIN` minutes, in % (an H: the highest high above the close, an L: the lowest low under it). Reads every
 * minute, not the offset.
 */
export function scoreConditions(ta: TurnArrays, conds: Condition[], side: 1 | -1, turns: Turn[], windowMin: number, hlPct: number, tick: number): ConditionResult {
  const { bars } = ta
  const xs = conds.map((c) => columnOf(ta, c.col))
  const holds = (j: number) => conds.length > 0 && conds.every((c, k) => Number.isFinite(xs[k][j]) && (c.op === '>=' ? xs[k][j] >= c.value : xs[k][j] <= c.value))
  const sigs: Sig[] = []
  const at: number[] = []
  for (let i = 0; i < bars.length; i++) {
    if (holds(i) && (i === 0 || !holds(i - 1))) {
      sigs.push({ side, t: bars[i].t + 60, px: bars[i].c })
      at.push(i)
    }
  }
  const W = windowMin * 60
  const hits = sigs.map((g) => signalHits(g, turns, W))
  const adverse: number[] = []
  sigs.forEach((g, k) => {
    const i = at[k]
    if (hits[k] || i + 1 >= bars.length) return
    let worst = 0
    for (let j = i + 1; j <= Math.min(bars.length - 1, i + CONDITION_ADVERSE_MIN); j++) worst = Math.max(worst, side === 1 ? bars[j].h / g.px - 1 : 1 - bars[j].l / g.px)
    adverse.push(worst * 100)
  })
  return { sigs, hits, score: score(sigs, turns, W, hlPct / 100, tick), falseN: hits.filter((h) => !h).length, falseAdverseMed: quantile(adverse, 0.5) }
}

/** A rule the search found: its conditions, the side it fires, and its score against the targets. */
export type RuleFound = { conds: Condition[]; side: 1 | -1; result: ConditionResult; zigzag?: BenchScore }
export type RuleSearch = { H: RuleFound[]; L: RuleFound[]; targets: { H: number; L: number } }
/** A rule is listed only with this many signals: fewer says nothing. */
export const RULE_SEARCH_MIN_N = 5
/** The thresholds tried per column: these quantiles of the column at the targets of the side. */
const RULE_SEARCH_QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]
/** The singles the pairs are built from, per side. */
const RULE_SEARCH_PAIR_FROM = 15

/**
 * "Analyser" (author, 2026-10-04): the search of `research/lean/destroy.ts` on the page, aimed at the author's own targets
 * (the turns he marked "bon"). Per side with at least one target: every minute column, thresholds at the column's
 * quantiles over the targets' minutes, `>=` and `<=`, each scored with `scoreConditions` against the targets at
 * +/-`windowMin`; then the pairs (AND) of the best `RULE_SEARCH_PAIR_FROM` singles on different columns. The `top` of
 * singles and pairs together, by precision then coverage, with at least `RULE_SEARCH_MIN_N` signals.
 */
export function searchRules(ta: TurnArrays, targets: Turn[], windowMin: number, hlPct: number, tick: number, top = 10, derived = false, zigzag: Turn[] = []): RuleSearch {
  const out: RuleSearch = { H: [], L: [], targets: { H: targets.filter((t) => t.side === 1).length, L: targets.filter((t) => t.side === -1).length } }
  const rank = (xs: RuleFound[]) => xs.filter((r) => r.result.score.n >= RULE_SEARCH_MIN_N).sort((a, b) => b.result.score.prec - a.result.score.prec || b.result.score.cov - a.result.score.cov)
  // The columns tried: the table's, plus - when asked - every pair's difference, sum and product (759 more on 23).
  const keys: { key: string; digits: number }[] = TURN_MINUTE_COLUMNS.map((c) => ({ key: c.key, digits: c.digits }))
  if (derived)
    for (let a = 0; a < TURN_MINUTE_COLUMNS.length; a++)
      for (let b = a + 1; b < TURN_MINUTE_COLUMNS.length; b++)
        for (const op of DERIVED_OPS) keys.push({ key: derivedKey(TURN_MINUTE_COLUMNS[a].key, op, TURN_MINUTE_COLUMNS[b].key), digits: Math.max(TURN_MINUTE_COLUMNS[a].digits, TURN_MINUTE_COLUMNS[b].digits) })
  for (const side of [1, -1] as const) {
    const tg = targets.filter((t) => t.side === side)
    if (tg.length === 0) continue
    const idx = tg.flatMap((t) => { const i = ta.barAt.get(t.t - 30); return i === undefined ? [] : [i] })
    const zz = zigzag.filter((t) => t.side === side)
    const singles: RuleFound[] = []
    for (const c of keys) {
      const col = columnOf(ta, c.key)
      const at = idx.map((i) => col[i]).filter(Number.isFinite)
      if (at.length === 0) continue
      const values = new Set(RULE_SEARCH_QUANTILES.map((q) => +quantile(at, q).toFixed(c.digits)))
      for (const value of values) for (const op of ['>=', '<='] as const) {
        const conds = [{ col: c.key, op, value }]
        singles.push({ conds, side, result: scoreConditions(ta, conds, side, tg, windowMin, hlPct, tick) })
      }
      // A derived column is kept only while it is scored (759 x 20,000 numbers would not fit).
      if (ta.cols[c.key] === undefined) ta.derived.delete(c.key)
    }
    const best = rank(singles).slice(0, RULE_SEARCH_PAIR_FROM)
    const pairs: RuleFound[] = []
    for (let a = 0; a < best.length; a++) for (let b = a + 1; b < best.length; b++) {
      if (best[a].conds[0].col === best[b].conds[0].col) continue
      const conds = [...best[a].conds, ...best[b].conds]
      pairs.push({ conds, side, result: scoreConditions(ta, conds, side, tg, windowMin, hlPct, tick) })
    }
    const found = rank([...singles, ...pairs]).slice(0, top)
    // The sanity column (6 targets fit anything): the same rule's precision against every same-side zigzag turn.
    for (const r of found) if (zz.length > 0) r.zigzag = scoreConditions(ta, r.conds, side, zz, windowMin, hlPct, tick).score
    out[side === 1 ? 'H' : 'L'] = found
  }
  // The pairs' derived columns were cached while scored: freed here (on "period = all", 107,000 bars, each is 856 KB;
  // the author's tab ran out of memory on 2026-10-03). The condition test recomputes the one or two it loads.
  ta.derived.clear()
  return out
}
