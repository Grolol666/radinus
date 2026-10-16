// Stub for radinus: `Point` is the chart component's type (site/src/components/PriceChart.tsx), copied here so nothing reaches outside core/.
type Point = { time: number; value: number }

/**
 * Technical indicators, computed on the round history already in memory.
 *
 * Ported from an earlier project's `indicators.ts`, with one change forced by
 * what this chain actually serves: that project computes these on OHLC candles
 * and reads `.close`; there is no OHLC anywhere on Robinhood Chain (see
 * the chain's price sources), so every function here takes the `Point[]` a Chainlink
 * round history already is and reads `.value`. The math — Wilder smoothing
 * for RSI, population standard deviation for Bollinger, a running sum for
 * SMA — is unchanged, because that math is what makes the numbers agree
 * with every other chart reading the same kind of series.
 */

/** The three periods a chart is normally read with — Binance's own default. */
export const SMA_PERIODS = [7, 25, 99] as const

/**
 * Simple moving average.
 *
 * A running sum rather than re-summing a window per point — at a few hundred
 * rounds and three periods this barely matters, but it is the same shape as
 * the reference implementation and there is no reason to diverge from it.
 *
 * Starts at the first point with a full window: a moving average over fewer
 * points than its period is not an early value, it is a different average.
 */
export function sma(points: Point[], period: number): Point[] {
  if (period <= 0 || points.length < period) return []

  const out: Point[] = new Array(points.length - period + 1)
  let sum = 0

  for (let i = 0; i < points.length; i++) {
    sum += points[i].value
    if (i >= period) sum -= points[i - period].value
    if (i >= period - 1) {
      out[i - period + 1] = { time: points[i].time, value: sum / period }
    }
  }

  return out
}

/**
 * Relative Strength Index, Wilder's original smoothing.
 *
 * The first value is a plain average over `period` changes; every one after
 * is smoothed as `(prev * (period - 1) + current) / period`. A simple moving
 * average throughout is a different indicator that happens to share the
 * name — it reacts faster and disagrees with every charting platform.
 */
export function rsi(points: Point[], period = 14): Point[] {
  if (points.length <= period) return []

  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const change = points[i].value - points[i - 1].value
    if (change >= 0) gain += change
    else loss -= change
  }
  gain /= period
  loss /= period

  const out: Point[] = [{ time: points[period].time, value: toRsi(gain, loss) }]

  for (let i = period + 1; i < points.length; i++) {
    const change = points[i].value - points[i - 1].value
    const up = change > 0 ? change : 0
    const down = change < 0 ? -change : 0

    gain = (gain * (period - 1) + up) / period
    loss = (loss * (period - 1) + down) / period

    out.push({ time: points[i].time, value: toRsi(gain, loss) })
  }

  return out
}

/**
 * The two cases the ratio cannot express.
 *
 * No losses with gains is genuine one-way pressure: pinned at 100 by
 * definition. No losses *and* no gains is not that — it is a window that did
 * not move, and calling it maximally overbought is a different claim. The
 * naive `loss === 0 ? 100` guard most implementations carry reports 100 for a
 * dead-flat series; this returns the neutral point instead, because "no
 * directional pressure" is what a flat window actually says.
 */
function toRsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100
  const rs = gain / loss
  return 100 - 100 / (1 + rs)
}

/** One bar of a Bollinger band: the average, and the two edges around it. */
export type Band = { time: number; middle: number; upper: number; lower: number }

export const BOLLINGER_PERIOD = 20
export const BOLLINGER_MULT = 2

/**
 * Bollinger bands: a moving average, with a standard deviation of the value
 * either side of it.
 *
 * **Population standard deviation** (divide by `period`, not `period - 1`) —
 * the sample form is the statistically defensible one and it is not what
 * Bollinger defined or what any charting platform draws. Same trap as the
 * RSI above: the "more correct" smoothing makes a different indicator that
 * happens to share the name.
 */
export function bollinger(points: Point[], period = BOLLINGER_PERIOD, mult = BOLLINGER_MULT): Band[] {
  if (period <= 0 || points.length < period) return []

  const out: Band[] = new Array(points.length - period + 1)
  let sum = 0

  for (let i = 0; i < points.length; i++) {
    sum += points[i].value
    if (i >= period) sum -= points[i - period].value
    if (i < period - 1) continue

    const middle = sum / period

    let squares = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = points[j].value - middle
      squares += d * d
    }
    const sd = Math.sqrt(squares / period)

    out[i - period + 1] = {
      time: points[i].time,
      middle,
      upper: middle + mult * sd,
      lower: middle - mult * sd,
    }
  }

  return out
}

/** What the stochastic reads of a bar. */
export type HighLowClose = { h: number; l: number; c: number }

/**
 * The stochastic's running state: the indices of the window's highest highs and lowest lows (two monotonic queues in rings of
 * `period`, so each bar is pushed and popped once) and the last `smooth` raw %K. A run continued from it
 * gives the full run's array.
 */
export type StochasticRun = { period: number; smooth: number; hiQ: Int32Array; hiHead: number; hiLen: number; loQ: Int32Array; loHead: number; loLen: number; ring: Float64Array; defined: number; hiSave: Int32Array; loSave: Int32Array }

export function stochasticStart(period: number, smooth: number): StochasticRun {
  return { period, smooth, hiQ: new Int32Array(period), hiHead: 0, hiLen: 0, loQ: new Int32Array(period), loHead: 0, loLen: 0, ring: new Float64Array(smooth), defined: 0, hiSave: new Int32Array(period), loSave: new Int32Array(period) }
}

/**
 * The stochastic oscillator's one bar (0..100): bar `i` is fed to `st` (bars 0..i - 1 already were) and its value returned.
 * raw %K = 100 (close - lowest low) / (highest high - lowest low) over the last `period` bars, the bar included; the value
 * is the simple average of the last `smooth` raw %K (1 = the raw one). NaN while the window or the average is not full,
 * and where highest = lowest (no range, no value: the average then restarts). Bar i reads bars 0..i only.
 */
export function stochasticStep(st: StochasticRun, bars: HighLowClose[], i: number): number {
  const { period, smooth, hiQ, loQ, ring } = st
  const b = bars[i]
  while (st.hiLen > 0 && hiQ[st.hiHead] <= i - period) { st.hiHead = (st.hiHead + 1) % period; st.hiLen-- }
  while (st.loLen > 0 && loQ[st.loHead] <= i - period) { st.loHead = (st.loHead + 1) % period; st.loLen-- }
  while (st.hiLen > 0 && bars[hiQ[(st.hiHead + st.hiLen - 1) % period]].h <= b.h) st.hiLen--
  while (st.loLen > 0 && bars[loQ[(st.loHead + st.loLen - 1) % period]].l >= b.l) st.loLen--
  hiQ[(st.hiHead + st.hiLen) % period] = i
  st.hiLen++
  loQ[(st.loHead + st.loLen) % period] = i
  st.loLen++
  const hh = bars[hiQ[st.hiHead]].h
  const ll = bars[loQ[st.loHead]].l
  const raw = i >= period - 1 && hh > ll ? (100 * (b.c - ll)) / (hh - ll) : NaN
  if (Number.isNaN(raw)) {
    st.defined = 0
    return NaN
  }
  ring[i % smooth] = raw
  st.defined++
  if (st.defined < smooth) return NaN
  // Summed oldest first at each bar, not kept as a running sum: a running sum drifts ~1e-12, enough to cross a threshold the average sits exactly on (measured: 2 of 2,380 signals on 106,983 bars).
  let sum = 0
  for (let k = 1; k <= smooth; k++) sum += ring[(i + k) % smooth]
  return sum / smooth
}

/**
 * What bar `i` would be worth if it closed as `bars[i]` is now (a bar not closed yet, the one-bar continuation `radinus/` runs), with `st` left exactly as it was: the step above is run on `st` and rolled back - the two rings
 * of indices (`period` entries each, saved in `st`), the head and length of each, the ring slot the raw %K lands in and the run of defined values - so the value is the continuation's own, not a second formula.
 */
export function stochasticPeek(st: StochasticRun, bars: HighLowClose[], i: number): number {
  const { hiHead, hiLen, loHead, loLen, defined, ring, smooth } = st
  const slot = i % smooth
  const slotValue = ring[slot]
  st.hiSave.set(st.hiQ)
  st.loSave.set(st.loQ)
  const value = stochasticStep(st, bars, i)
  st.hiQ.set(st.hiSave)
  st.loQ.set(st.loSave)
  st.hiHead = hiHead
  st.hiLen = hiLen
  st.loHead = loHead
  st.loLen = loLen
  st.defined = defined
  ring[slot] = slotValue
  return value
}

/** Writes `out[i]` for i = `from`..`bars.length - 1` (bars 0..`from` - 1 already fed to `st`): `stochasticStep` on each. */
export function stochasticFeed(st: StochasticRun, bars: HighLowClose[], out: number[], from: number): void {
  for (let i = from; i < bars.length; i++) out[i] = stochasticStep(st, bars, i)
}

/** The stochastic on all `bars` (`stochasticFeed` from the start): one value per bar. */
export function stochastic(bars: HighLowClose[], period: number, smooth: number): number[] {
  const out: number[] = new Array(bars.length)
  stochasticFeed(stochasticStart(period, smooth), bars, out, 0)
  return out
}

/** What the CCI, the MFI, the Ultimate Oscillator and the Z-score read of a bar (`/rsi`'s lot 1). */
export type OhlcvBar = HighLowClose & { v: number }

const typical = (b: HighLowClose): number => (b.h + b.l + b.c) / 3

/**
 * The four window oscillators below share one shape: `xAt(bars, i, ...settings)` is one bar's value and `xFeed(bars, out, from, ...settings)` writes `out[i]` for i = `from`..`bars.length - 1` (`xAt` on each),
 * reading bars of index <= i only (so a run continued from `from` is the full run's array), NaN where a window is not full or the
 * formula would divide by zero; `x(bars, ...)` is the run from the start. Each window is summed directly, oldest first, at each bar (work =
 * the period, not the history): a running sum drifts ~1e-12, and a window that is flat or has no flow must give exactly 0, not a residue
 * that the division turns into a number (the stochastic's comment above met the same problem).
 */

/**
 * Commodity Channel Index: TP = (h + l + c) / 3, CCI = (TP - mean TP over `period`) / (0.015 x mean absolute deviation of TP over `period`),
 * the bar included. A window whose TPs are all equal has no deviation: NaN (tested on the window's highest = lowest, not on a deviation that rounding may leave at 1e-16).
 */
export function cciAt(bars: HighLowClose[], i: number, period: number): number {
  if (i < period - 1) return NaN
  let sum = 0
  let lo = Infinity
  let hi = -Infinity
  for (let j = i - period + 1; j <= i; j++) {
    const tp = typical(bars[j])
    sum += tp
    if (tp < lo) lo = tp
    if (tp > hi) hi = tp
  }
  if (hi === lo) return NaN
  const mean = sum / period
  let dev = 0
  for (let j = i - period + 1; j <= i; j++) dev += Math.abs(typical(bars[j]) - mean)
  return (typical(bars[i]) - mean) / (0.015 * (dev / period))
}

export function cciFeed(bars: HighLowClose[], out: number[], from: number, period: number): void {
  for (let i = from; i < bars.length; i++) out[i] = cciAt(bars, i, period)
}

export function cci(bars: HighLowClose[], period: number): number[] {
  const out: number[] = new Array(bars.length)
  cciFeed(bars, out, 0, period)
  return out
}

/**
 * Money Flow Index, 0..100: a bar's flow is TP x v, positive when its TP is above the previous bar's, negative when below, nothing when equal;
 * over the last `period` bars MFI = 100 - 100 / (1 + positive / negative). No negative flow with a positive one gives 100; no flow at all, NaN.
 * The first bar has no previous one, so the first value is at bar `period`.
 */
export function mfiAt(bars: OhlcvBar[], i: number, period: number): number {
  if (i < period) return NaN
  let pos = 0
  let neg = 0
  for (let j = i - period + 1; j <= i; j++) {
    const tp = typical(bars[j])
    const before = typical(bars[j - 1])
    if (tp > before) pos += tp * bars[j].v
    else if (tp < before) neg += tp * bars[j].v
  }
  return neg === 0 ? (pos > 0 ? 100 : NaN) : 100 - 100 / (1 + pos / neg)
}

export function mfiFeed(bars: OhlcvBar[], out: number[], from: number, period: number): void {
  for (let i = from; i < bars.length; i++) out[i] = mfiAt(bars, i, period)
}

export function mfi(bars: OhlcvBar[], period: number): number[] {
  const out: number[] = new Array(bars.length)
  mfiFeed(bars, out, 0, period)
  return out
}

/**
 * Ultimate Oscillator, 0..100: BP = c - min(l, previous c), TR = max(h, previous c) - min(l, previous c), a(n) = sum BP / sum TR over n bars,
 * UO = 100 (4 a(short) + 2 a(medium) + a(long)) / 7 (the weights follow the settings' order, whatever their sizes). The first bar has no
 * previous close, so the first value is at bar max(short, medium, long); a window whose TR sums to 0 gives NaN for the bar, never a partial mix.
 */
export function ultimateAt(bars: HighLowClose[], i: number, short: number, medium: number, long: number): number {
  if (i < Math.max(short, medium, long)) return NaN
  let mix = 0
  for (let k = 0; k < 3; k++) {
    const span = k === 0 ? short : k === 1 ? medium : long
    let bp = 0
    let tr = 0
    for (let j = i - span + 1; j <= i; j++) {
      const before = bars[j - 1].c
      const low = Math.min(bars[j].l, before)
      bp += bars[j].c - low
      tr += Math.max(bars[j].h, before) - low
    }
    if (tr === 0) { mix = NaN; break }
    mix += (k === 0 ? 4 : k === 1 ? 2 : 1) * (bp / tr)
  }
  return (100 * mix) / 7
}

export function ultimateFeed(bars: HighLowClose[], out: number[], from: number, short: number, medium: number, long: number): void {
  for (let i = from; i < bars.length; i++) out[i] = ultimateAt(bars, i, short, medium, long)
}

export function ultimate(bars: HighLowClose[], short: number, medium: number, long: number): number[] {
  const out: number[] = new Array(bars.length)
  ultimateFeed(bars, out, 0, short, medium, long)
  return out
}

/** Z-score of the close: (c - mean of c over `period`) / population standard deviation (divide by `period`); a flat window has none: NaN. */
export function zscoreAt(bars: HighLowClose[], i: number, period: number): number {
  if (i < period - 1) return NaN
  let sum = 0
  let lo = Infinity
  let hi = -Infinity
  for (let j = i - period + 1; j <= i; j++) {
    const c = bars[j].c
    sum += c
    if (c < lo) lo = c
    if (c > hi) hi = c
  }
  if (hi === lo) return NaN
  const mean = sum / period
  let squares = 0
  for (let j = i - period + 1; j <= i; j++) squares += (bars[j].c - mean) ** 2
  return (bars[i].c - mean) / Math.sqrt(squares / period)
}

export function zscoreFeed(bars: HighLowClose[], out: number[], from: number, period: number): void {
  for (let i = from; i < bars.length; i++) out[i] = zscoreAt(bars, i, period)
}

export function zscore(bars: HighLowClose[], period: number): number[] {
  const out: number[] = new Array(bars.length)
  zscoreFeed(bars, out, 0, period)
  return out
}

/**
 * The band players (`/rsi`'s lot 2) share one shape: `xFeed(bars, out, from, ...settings)` writes `out[a][i]` for i = `from`..`bars.length - 1`, reading bars of
 * index <= i only (a run continued from `from` is the full run's arrays), NaN where a line is not defined. `out` holds the arrays in a layout each feed
 * says: the first ones are the drawn lines (upper, then lower), the rest are carried state or lines only the signals read. Windows are summed directly,
 * oldest first (work = the period, not the history), so a continuation and a plain loop add the same numbers in the same order.
 */

/** Bar j's true range (bar 0: its high - low), `zonesBench.keltner`'s. */
const trueRange = (bars: HighLowClose[], j: number): number => (j === 0 ? bars[j].h - bars[j].l : Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c)))

/** Bollinger (n, k) on closes, population standard deviation, `zonesBench.bollingerBands`' arithmetic: `out` = [upper, lower, middle (the SMA)]. NaN before bar n - 1. */
export function bollingerFeed(bars: HighLowClose[], out: number[][], from: number, n: number, k: number): void {
  const [up, lo, mid] = out
  for (let i = from; i < bars.length; i++) {
    if (i < n - 1) { up[i] = lo[i] = mid[i] = NaN; continue }
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
}

/**
 * Keltner (n, k): the EMA n of the close (seeded at the first close, `zonesBench.ema`'s) +/- k x ATR n, ATR = the simple mean of the last n true ranges, the bar
 * included. `out` = [upper, lower, EMA]; the EMA is carried (it is defined from bar 0 and a continuation reads its last value), the lines are NaN before bar n - 1.
 */
export function keltnerFeed(bars: HighLowClose[], out: number[][], from: number, n: number, k: number): void {
  const [up, lo, mid] = out
  const a = 2 / (n + 1)
  for (let i = from; i < bars.length; i++) {
    mid[i] = i === 0 ? bars[0].c : mid[i - 1] + a * (bars[i].c - mid[i - 1])
    if (i < n - 1) { up[i] = lo[i] = NaN; continue }
    let sum = 0
    for (let j = i - n + 1; j <= i; j++) sum += trueRange(bars, j)
    up[i] = mid[i] + (k * sum) / n
    lo[i] = mid[i] - (k * sum) / n
  }
}

/**
 * Donchian (n): the highest high and the lowest low of the n bars BEFORE the bar (the bar itself excluded, or a close could never be outside), `out` = [upper, lower].
 * NaN before bar n. Two monotonic queues over the window; a continuation rebuilds them from the n bars before `from` (work = n once per call).
 */
export function donchianFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [up, lo] = out
  const hiQ: number[] = []
  const loQ: number[] = []
  let hiHead = 0
  let loHead = 0
  const push = (j: number) => {
    while (hiQ.length > hiHead && bars[hiQ[hiQ.length - 1]].h <= bars[j].h) hiQ.pop()
    hiQ.push(j)
    while (loQ.length > loHead && bars[loQ[loQ.length - 1]].l >= bars[j].l) loQ.pop()
    loQ.push(j)
  }
  for (let j = Math.max(0, from - n); j < from; j++) push(j)
  for (let i = from; i < bars.length; i++) {
    while (hiQ.length > hiHead && hiQ[hiHead] < i - n) hiHead++
    while (loQ.length > loHead && loQ[loHead] < i - n) loHead++
    if (i < n) { up[i] = lo[i] = NaN } else { up[i] = bars[hiQ[hiHead]].h; lo[i] = bars[loQ[loHead]].l }
    push(i)
  }
}

/** Envelopes: SMA n of the close x (1 +/- x / 100), `out` = [upper, lower]. NaN before bar n - 1. */
export function envelopesFeed(bars: HighLowClose[], out: number[][], from: number, n: number, x: number): void {
  const [up, lo] = out
  for (let i = from; i < bars.length; i++) {
    if (i < n - 1) { up[i] = lo[i] = NaN; continue }
    let m = 0
    for (let j = i - n + 1; j <= i; j++) m += bars[j].c
    m /= n
    up[i] = m * (1 + x / 100)
    lo[i] = m * (1 - x / 100)
  }
}

/**
 * The day's VWAP: sum (TP x v) / sum v of the bars since the UTC midnight (TP = (h + l + c) / 3, the bar included), x (1 +/- x / 100). `out` = [upper, lower, running
 * sum of TP x v, running sum of v]: the two sums are carried per bar, restart at a bar whose UTC day is not the previous bar's, and are added in the order a direct
 * sum from the day's first bar would. NaN while the day's volume is 0 (the filled minutes carry none).
 */
export function vwapFeed(bars: (OhlcvBar & { t: number })[], out: number[][], from: number, x: number): void {
  const [up, lo, pvs, vs] = out
  for (let i = from; i < bars.length; i++) {
    const fresh = i === 0 || Math.floor(bars[i].t / 86400) !== Math.floor(bars[i - 1].t / 86400)
    pvs[i] = (fresh ? 0 : pvs[i - 1]) + typical(bars[i]) * bars[i].v
    vs[i] = (fresh ? 0 : vs[i - 1]) + bars[i].v
    if (vs[i] > 0) {
      const w = pvs[i] / vs[i]
      up[i] = w * (1 + x / 100)
      lo[i] = w * (1 - x / 100)
    } else up[i] = lo[i] = NaN
  }
}

/**
 * The Squeeze's lines: Bollinger (nb, kb) and Keltner (nk, kk) side by side, `out` = [Bollinger upper, Bollinger lower, Keltner upper, Keltner lower, Bollinger middle,
 * Keltner's EMA]; the first four are drawn, the middle is what the release is read against, the EMA is carried.
 */
export function squeezeFeed(bars: HighLowClose[], out: number[][], from: number, nb: number, kb: number, nk: number, kk: number): void {
  bollingerFeed(bars, [out[0], out[1], out[4]], from, nb, kb)
  keltnerFeed(bars, [out[2], out[3], out[5]], from, nk, kk)
}

/**
 * The trend followers (`/rsi`'s lot 3) have the band players' shape: `xFeed(bars, out, from, ...settings)` writes `out[a][i]` for i = `from`..`bars.length - 1`, reading bars of
 * index <= i only, NaN where a line is not defined; `out` = the drawn lines first, then the state the recurrences carry (read back at bar `from` - 1 by a continuation, so
 * a run continued from `from` is the full run's arrays bit for bit) or what the signals read. Windows are summed or scanned directly, oldest first (work = the period).
 */

/** What Heikin-Ashi reads of a bar. */
export type OhlcBar = HighLowClose & { o: number }

/** The bench's EMA (`zonesBench.ema`: seeded at the first value, then prev + 2 / (n + 1) x (x - prev)), bar `i` of `e` for the input value `x`. */
const emaStep = (e: number[], i: number, x: number, n: number): number => (i === 0 ? x : e[i - 1] + (2 / (n + 1)) * (x - e[i - 1]))

/** Wilder's ATR n at bar `i` (`atr` holds bars < i): the simple mean of the first n true ranges (bar 0's is high - low) at bar n - 1, then (previous x (n - 1) + TR) / n; NaN before. */
function wilderAtr(bars: HighLowClose[], atr: number[], i: number, n: number): number {
  if (i < n - 1) return NaN
  if (i === n - 1) {
    let sum = 0
    for (let j = 0; j <= i; j++) sum += trueRange(bars, j)
    return sum / n
  }
  return (atr[i - 1] * (n - 1) + trueRange(bars, i)) / n
}

/** The middle of the highest high and the lowest low of the `n` bars ending at `i` (the bar included). */
function rangeMiddle(bars: HighLowClose[], i: number, n: number): number {
  let hi = -Infinity
  let lo = Infinity
  for (let j = i - n + 1; j <= i; j++) {
    if (bars[j].h > hi) hi = bars[j].h
    if (bars[j].l < lo) lo = bars[j].l
  }
  return (hi + lo) / 2
}

/** Croisement de moyennes: `out` = [EMA fast, EMA slow] of the close, both defined from bar 0 (the bench's seed, as `zonesBench.macd`'s). */
export function emaCrossFeed(bars: HighLowClose[], out: number[][], from: number, fast: number, slow: number): void {
  const [f, s] = out
  for (let i = from; i < bars.length; i++) {
    f[i] = emaStep(f, i, bars[i].c, fast)
    s[i] = emaStep(s, i, bars[i].c, slow)
  }
}

/** The EMA of the close: `out` = [EMA n], defined from bar 0 (the bench's seed, `zonesBench.ema`'s arithmetic). */
export function emaFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [e] = out
  for (let i = from; i < bars.length; i++) e[i] = emaStep(e, i, bars[i].c, n)
}

/** Prix contre moyenne: `out` = [SMA n of the close], NaN before bar n - 1; the window is summed directly. */
export function smaFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [m] = out
  for (let i = from; i < bars.length; i++) {
    if (i < n - 1) { m[i] = NaN; continue }
    let sum = 0
    for (let j = i - n + 1; j <= i; j++) sum += bars[j].c
    m[i] = sum / n
  }
}

/** MACD (`zonesBench.macd`'s arithmetic): `out` = [line = EMA fast - EMA slow, signal = EMA of the line, EMA fast, EMA slow]; all defined from bar 0 (the line is 0 there). */
export function macdFeed(bars: HighLowClose[], out: number[][], from: number, fast: number, slow: number, sig: number): void {
  const [line, signal, f, s] = out
  for (let i = from; i < bars.length; i++) {
    f[i] = emaStep(f, i, bars[i].c, fast)
    s[i] = emaStep(s, i, bars[i].c, slow)
    line[i] = f[i] - s[i]
    signal[i] = emaStep(signal, i, line[i], sig)
  }
}

/**
 * SuperTrend (n, k): `out` = [line, ATR (Wilder's), final upper band, final lower band, trend (1 up, -1 down)]; NaN before bar n - 1. Basic bands = (h + l) / 2 +/- k x ATR; at bar i the trend
 * reads the close against the PREVIOUS final bands (up -> down when the close is under the previous lower, down -> up when over the previous upper), then the upper final band keeps
 * the previous one unless the basic one is lower or the previous close was above it (the lower: unless the basic one is higher or the previous close was under it). The line is
 * the lower final band in an up-trend, the upper in a down-trend. Reading choice: the first bar with an ATR starts its bands at the basic ones and its trend up when its close is above (h + l) / 2, down otherwise.
 */
export function superTrendFeed(bars: HighLowClose[], out: number[][], from: number, n: number, k: number): void {
  const [line, atr, fu, fl, trend] = out
  for (let i = from; i < bars.length; i++) {
    atr[i] = wilderAtr(bars, atr, i, n)
    if (i < n - 1) { line[i] = fu[i] = fl[i] = trend[i] = NaN; continue }
    const { h, l, c } = bars[i]
    const mid = (h + l) / 2
    const upper = mid + k * atr[i]
    const lower = mid - k * atr[i]
    if (i === n - 1) {
      fu[i] = upper
      fl[i] = lower
      trend[i] = c > mid ? 1 : -1
    } else {
      const before = bars[i - 1].c
      trend[i] = trend[i - 1] === 1 ? (c < fl[i - 1] ? -1 : 1) : c > fu[i - 1] ? 1 : -1
      fu[i] = upper < fu[i - 1] || before > fu[i - 1] ? upper : fu[i - 1]
      fl[i] = lower > fl[i - 1] || before < fl[i - 1] ? lower : fl[i - 1]
    }
    line[i] = trend[i] === 1 ? fl[i] : fu[i]
  }
}

/**
 * Wilder's Parabolic SAR (step, max): `out` = [SAR, side (1 up, -1 down), extreme point, acceleration factor]; NaN at bar 0. Reading choices (TA-Lib's): bar 1 starts the trend up unless the previous
 * low minus this low is larger than this high minus the previous high; its SAR is the previous low (up) or high (down), its extreme point this bar's high (low), its factor `step`.
 * From bar 2: SAR = previous SAR + factor x (extreme point - previous SAR), kept out of the two previous bars' range (up: <= their lows, down: >= their highs); the trend reverses when
 * this bar's low (up) / high (down) TOUCHES it (<= / >=): the SAR is then the previous extreme point, the extreme point this bar's low (high), the factor restarts at `step`; otherwise a new
 * extreme point (strictly beyond the previous one) raises the factor by `step`, capped at `max`.
 */
export function parabolicSarFeed(bars: HighLowClose[], out: number[][], from: number, step: number, max: number): void {
  const [sar, side, ep, af] = out
  for (let i = from; i < bars.length; i++) {
    if (i === 0) { sar[i] = side[i] = ep[i] = af[i] = NaN; continue }
    const b = bars[i]
    const p = bars[i - 1]
    if (i === 1) {
      const up = !(p.l - b.l > b.h - p.h)
      side[i] = up ? 1 : -1
      sar[i] = up ? p.l : p.h
      ep[i] = up ? b.h : b.l
      af[i] = step
      continue
    }
    const next = sar[i - 1] + af[i - 1] * (ep[i - 1] - sar[i - 1])
    if (side[i - 1] === 1) {
      const s = Math.min(next, p.l, bars[i - 2].l)
      if (b.l <= s) { side[i] = -1; sar[i] = ep[i - 1]; ep[i] = b.l; af[i] = step }
      else {
        side[i] = 1
        sar[i] = s
        if (b.h > ep[i - 1]) { ep[i] = b.h; af[i] = Math.min(af[i - 1] + step, max) } else { ep[i] = ep[i - 1]; af[i] = af[i - 1] }
      }
    } else {
      const s = Math.max(next, p.h, bars[i - 2].h)
      if (b.h >= s) { side[i] = 1; sar[i] = ep[i - 1]; ep[i] = b.h; af[i] = step }
      else {
        side[i] = -1
        sar[i] = s
        if (b.l < ep[i - 1]) { ep[i] = b.l; af[i] = Math.min(af[i - 1] + step, max) } else { ep[i] = ep[i - 1]; af[i] = af[i - 1] }
      }
    }
  }
}

/** Under it a smoothed TR is a decayed denormal (measured on ANTHROPIC's 1-minute bars: a flat stretch of ~5,000 bars at n = 7 reached 1.5e-323, where the DI ratio was 60, 75, 100 by quantization): DI is 0, as for an exact 0. */
const ADX_FLAT = 1e-300

/**
 * ADX / DMI (n): `out` = [+DI, -DI, ADX, smoothed TR, smoothed +DM, smoothed -DM]. +DM = high - previous high when that is larger than previous low - low and positive (else 0), -DM the mirror, TR as
 * `trueRange` (from bar 1). Each is smoothed as Wilder's ATR: the mean of bars 1..n at bar n, then (previous x (n - 1) + value) / n. +DI = 100 x smoothed +DM / smoothed TR (-DI the same), DX = 100 x
 * |+DI - -DI| / (+DI + -DI), ADX = the mean of DX over bars n..2n - 1 at bar 2n - 1, then (previous x (n - 1) + DX) / n. Reading choice: a smoothed TR of 0 (or under `ADX_FLAT`) gives DI 0, a DI sum
 * of 0 gives DX 0 (TA-Lib's guards). NaN before bar n (DI) and bar 2n - 1 (ADX).
 */
export function adxFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [pdi, mdi, adx, str, sp, sm] = out
  const parts = (j: number): [number, number, number] => {
    const up = bars[j].h - bars[j - 1].h
    const down = bars[j - 1].l - bars[j].l
    return [trueRange(bars, j), up > down && up > 0 ? up : 0, down > up && down > 0 ? down : 0]
  }
  const dx = (j: number) => (pdi[j] + mdi[j] > 0 ? (100 * Math.abs(pdi[j] - mdi[j])) / (pdi[j] + mdi[j]) : 0)
  for (let i = from; i < bars.length; i++) {
    if (i < n) { pdi[i] = mdi[i] = adx[i] = str[i] = sp[i] = sm[i] = NaN; continue }
    if (i === n) {
      let t = 0
      let p = 0
      let m = 0
      for (let j = 1; j <= n; j++) {
        const [a, b, c] = parts(j)
        t += a
        p += b
        m += c
      }
      str[i] = t / n
      sp[i] = p / n
      sm[i] = m / n
    } else {
      const [a, b, c] = parts(i)
      str[i] = (str[i - 1] * (n - 1) + a) / n
      sp[i] = (sp[i - 1] * (n - 1) + b) / n
      sm[i] = (sm[i - 1] * (n - 1) + c) / n
    }
    pdi[i] = str[i] > ADX_FLAT ? (100 * sp[i]) / str[i] : 0
    mdi[i] = str[i] > ADX_FLAT ? (100 * sm[i]) / str[i] : 0
    if (i < 2 * n - 1) adx[i] = NaN
    else if (i === 2 * n - 1) {
      let sum = 0
      for (let j = n; j <= i; j++) sum += dx(j)
      adx[i] = sum / n
    } else adx[i] = (adx[i - 1] * (n - 1) + dx(i)) / n
  }
}

/** Aroon (n): `out` = [haut, bas] = 100 x (n - bars since the highest high (lowest low) of the last n + 1 bars) / n; the most recent bar wins a tie. NaN before bar n. */
export function aroonFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [up, down] = out
  for (let i = from; i < bars.length; i++) {
    if (i < n) { up[i] = down[i] = NaN; continue }
    let hi = i - n
    let lo = i - n
    for (let j = i - n; j <= i; j++) {
      if (bars[j].h >= bars[hi].h) hi = j
      if (bars[j].l <= bars[lo].l) lo = j
    }
    up[i] = (100 * (n - (i - hi))) / n
    down[i] = (100 * (n - (i - lo))) / n
  }
}

/** Vortex (n): `out` = [VI+, VI-] = the sum over the last n bars of |h - previous l| (|l - previous h|) over the sum of the true ranges; NaN before bar n and where the true ranges sum to 0. */
export function vortexFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [vp, vm] = out
  for (let i = from; i < bars.length; i++) {
    if (i < n) { vp[i] = vm[i] = NaN; continue }
    let p = 0
    let m = 0
    let t = 0
    for (let j = i - n + 1; j <= i; j++) {
      p += Math.abs(bars[j].h - bars[j - 1].l)
      m += Math.abs(bars[j].l - bars[j - 1].h)
      t += trueRange(bars, j)
    }
    if (t === 0) { vp[i] = vm[i] = NaN; continue }
    vp[i] = p / t
    vm[i] = m / t
  }
}

/** Ichimoku's two lines (the cloud is not drawn): `out` = [Tenkan over `short`, Kijun over `long`], each the middle of the highest high and the lowest low of its last bars, the bar included. NaN before its window is full. */
export function ichimokuFeed(bars: HighLowClose[], out: number[][], from: number, short: number, long: number): void {
  const [tenkan, kijun] = out
  for (let i = from; i < bars.length; i++) {
    tenkan[i] = i < short - 1 ? NaN : rangeMiddle(bars, i, short)
    kijun[i] = i < long - 1 ? NaN : rangeMiddle(bars, i, long)
  }
}

/**
 * Stop ATR suiveur (n, k): `out` = [stop, side (1 long, -1 short), ATR (Wilder's)]; NaN before bar n - 1. Long stop = highest high of the last n - k x ATR, short stop = lowest low + k x ATR.
 * Long: the close under the PREVIOUS stop reverses (the new stop is the short formula), else the stop = max(previous, long formula); short mirrored (the close over the previous stop). Strict, a
 * close on the stop holds. Before the first signal (no side): long when the close is above the short stop and not under the long stop, short in the mirror case, none otherwise (stop NaN); the stop then starts from the formula of the side taken.
 */
export function atrStopFeed(bars: HighLowClose[], out: number[][], from: number, n: number, k: number): void {
  const [stop, side, atr] = out
  for (let i = from; i < bars.length; i++) {
    atr[i] = wilderAtr(bars, atr, i, n)
    if (i < n - 1) { stop[i] = side[i] = NaN; continue }
    let hi = -Infinity
    let lo = Infinity
    for (let j = i - n + 1; j <= i; j++) {
      if (bars[j].h > hi) hi = bars[j].h
      if (bars[j].l < lo) lo = bars[j].l
    }
    const longStop = hi - k * atr[i]
    const shortStop = lo + k * atr[i]
    const c = bars[i].c
    const held = i > 0 ? side[i - 1] : NaN
    if (Number.isNaN(held)) {
      const long = c > shortStop
      const short = c < longStop
      if (long && !short) { side[i] = 1; stop[i] = longStop } else if (short && !long) { side[i] = -1; stop[i] = shortStop } else stop[i] = side[i] = NaN
    } else if (held === 1) {
      if (c < stop[i - 1]) { side[i] = -1; stop[i] = shortStop } else { side[i] = 1; stop[i] = Math.max(stop[i - 1], longStop) }
    } else if (c > stop[i - 1]) { side[i] = 1; stop[i] = longStop } else { side[i] = -1; stop[i] = Math.min(stop[i - 1], shortStop) }
  }
}

/** Heikin-Ashi: `out` = [HA close = (o + h + l + c) / 4, HA open = (previous HA open + previous HA close) / 2, the first (o + c) / 2]; defined from bar 0, nothing drawn. */
export function heikinAshiFeed(bars: OhlcBar[], out: number[][], from: number): void {
  const [close, open] = out
  for (let i = from; i < bars.length; i++) {
    const b = bars[i]
    close[i] = (b.o + b.h + b.l + b.c) / 4
    open[i] = i === 0 ? (b.o + b.c) / 2 : (open[i - 1] + close[i - 1]) / 2
  }
}

/**
 * Lot 4 (`/rsi`'s momentum and volume players), same shape as the trend followers' feeds. An EMA over a series that is undefined at its start (the price change, TRIX, TSI) is the bench's
 * (seeded at the first defined value, then prev + 2 / (n + 1) x (x - prev)); `state[i]` = its value after bar i, carried through an undefined input.
 */
const emaOver = (state: number[], i: number, x: number, n: number): number => {
  const prev = i > 0 ? state[i - 1] : NaN
  if (!Number.isFinite(x)) return prev
  return Number.isFinite(prev) ? prev + (2 / (n + 1)) * (x - prev) : x
}

/** Momentum (n): `out` = [close - close n bars before], NaN before bar n. */
export function momentumFeed(bars: HighLowClose[], out: number[][], from: number, n: number): void {
  const [m] = out
  for (let i = from; i < bars.length; i++) m[i] = i < n ? NaN : bars[i].c - bars[i - n].c
}

/**
 * TRIX (n, s): `out` = [TRIX, signal, e1, e2, e3]; e1..e3 = three EMAs in a row of the close (the bench's, defined from bar 0), TRIX = 100 x (e3 - previous e3) / previous e3 (NaN at bar 0 and where the
 * previous e3 is 0), signal = EMA(TRIX, s) seeded at bar 1, the first TRIX. No warm-up is cut: the EMAs' first bars count, as the MACD's.
 */
export function trixFeed(bars: HighLowClose[], out: number[][], from: number, n: number, s: number): void {
  const [trix, signal, e1, e2, e3] = out
  for (let i = from; i < bars.length; i++) {
    e1[i] = emaStep(e1, i, bars[i].c, n)
    e2[i] = emaStep(e2, i, e1[i], n)
    e3[i] = emaStep(e3, i, e2[i], n)
    trix[i] = i === 0 || e3[i - 1] === 0 ? NaN : (100 * (e3[i] - e3[i - 1])) / e3[i - 1]
    signal[i] = emaOver(signal, i, trix[i], s)
  }
}

/**
 * TSI (long, short, s): `out` = [TSI, signal, EMA(m, long), EMA of that over short, EMA(|m|, long), EMA of that over short, the signal's carried EMA], m = close - previous close (from bar 1, each EMA seeded at its first
 * defined value). TSI = 100 x the 4th over the 6th, NaN where that denominator is 0; the signal = EMA(TSI, s) over the defined TSI values (carried through an undefined one), NaN where TSI is.
 */
export function tsiFeed(bars: HighLowClose[], out: number[][], from: number, long: number, short: number, s: number): void {
  const [tsi, signal, a1, a2, b1, b2, sg] = out
  for (let i = from; i < bars.length; i++) {
    const m = i === 0 ? NaN : bars[i].c - bars[i - 1].c
    a1[i] = emaOver(a1, i, m, long)
    a2[i] = emaOver(a2, i, a1[i], short)
    b1[i] = emaOver(b1, i, Math.abs(m), long)
    b2[i] = emaOver(b2, i, b1[i], short)
    tsi[i] = b2[i] > 0 ? (100 * a2[i]) / b2[i] : NaN
    sg[i] = emaOver(sg, i, tsi[i], s)
    signal[i] = Number.isFinite(tsi[i]) ? sg[i] : NaN
  }
}

/** Awesome Oscillator (short, long): `out` = [SMA of (h + l) / 2 over short - the same over long], each window summed directly; NaN before bar long - 1. */
export function awesomeFeed(bars: HighLowClose[], out: number[][], from: number, short: number, long: number): void {
  const [ao] = out
  const mean = (i: number, n: number) => {
    let sum = 0
    for (let j = i - n + 1; j <= i; j++) sum += (bars[j].h + bars[j].l) / 2
    return sum / n
  }
  for (let i = from; i < bars.length; i++) ao[i] = i < long - 1 ? NaN : mean(i, short) - mean(i, long)
}

/** The mean of `x[i - n + 1..i]`, summed directly oldest first; NaN before the window is full (and where it holds a NaN). */
function windowMean(x: number[], i: number, n: number): number {
  if (i < n - 1) return NaN
  let sum = 0
  for (let j = i - n + 1; j <= i; j++) sum += x[j]
  return sum / n
}

/** OBV (n): `out` = [the running total, its SMA over n]; the total starts at bar 0's volume (TA-Lib's), then + v when the close is above the previous close, - v when under, unchanged when equal. The average is NaN before bar n - 1. */
export function obvFeed(bars: OhlcvBar[], out: number[][], from: number, n: number): void {
  const [obv, avg] = out
  for (let i = from; i < bars.length; i++) {
    obv[i] = i === 0 ? bars[0].v : bars[i].c > bars[i - 1].c ? obv[i - 1] + bars[i].v : bars[i].c < bars[i - 1].c ? obv[i - 1] - bars[i].v : obv[i - 1]
    avg[i] = windowMean(obv, i, n)
  }
}

/** CMF (n): `out` = [CMF, the bar's money-flow volume ((c - l) - (h - c)) / (h - l) x v, 0 when h = l]; CMF = the sum of the flow over n bars over the sum of v, both summed directly; NaN before bar n - 1 and where the volume sums to 0. */
export function cmfFeed(bars: OhlcvBar[], out: number[][], from: number, n: number): void {
  const [cmf, flow] = out
  for (let i = from; i < bars.length; i++) {
    const { h, l, c, v } = bars[i]
    flow[i] = h === l ? 0 : (((c - l) - (h - c)) / (h - l)) * v
    if (i < n - 1) { cmf[i] = NaN; continue }
    let f = 0
    let vol = 0
    for (let j = i - n + 1; j <= i; j++) {
      f += flow[j]
      vol += bars[j].v
    }
    cmf[i] = vol === 0 ? NaN : f / vol
  }
}

/** Force index (n): `out` = [EMA((c - previous c) x v, n)] seeded at bar 1, the first defined value; NaN at bar 0. */
export function forceFeed(bars: OhlcvBar[], out: number[][], from: number, n: number): void {
  const [force] = out
  for (let i = from; i < bars.length; i++) force[i] = emaOver(force, i, i === 0 ? NaN : (bars[i].c - bars[i - 1].c) * bars[i].v, n)
}

/** Cumulative volume delta (n): `delta[i]` = bar i's aggressor buying minus selling (the store's, NaN before the first print's minute); `out` = [the running total of it, its SMA over n]. The total starts at the first bar with a delta, the average is NaN until its window holds n of them. */
export function cvdFeed(bars: HighLowClose[], delta: number[], out: number[][], from: number, n: number): void {
  const [cum, avg] = out
  for (let i = from; i < bars.length; i++) {
    cum[i] = Number.isNaN(delta[i]) ? NaN : (i > 0 && Number.isFinite(cum[i - 1]) ? cum[i - 1] : 0) + delta[i]
    avg[i] = windowMean(cum, i, n)
  }
}
