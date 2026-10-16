/**
 * `/rsi`'s two rules (author, 2026-10-04) on any 0..100 series - the RSI, the lean's LONG figure, the lean + book's - always in
 * position, out only by reversing, no lookahead: the signal at the close of bar i reads the values of bars 0..i only. Same
 * convention as `ruleFlips` given `rsi` / `rsiCross` conditions (`leanRules.ts`): a side already held does nothing, both sides at once
 * gives nothing, an undefined (NaN) value holds nothing.
 */

import type { BenchBar, LeanFlip, LeanPoint } from './zonesBench'

/** `zone`: long at value <= low, short at value >= high. `exit`: long when the value crosses up through low (prev <= low < now), short when it crosses down through high (prev >= high > now). */
export type LevelRule = 'zone' | 'exit'

/**
 * `at[i]` = the series' value at `bars[i]`'s close (NaN where it has none). A flip sits at the bar's close (`t` = bar.t + 60, `px` = its close,
 * the lean's flips' convention); `long` is the lean's figure, which this rule has none of (NaN).
 */
export function levelFlips(bars: BenchBar[], at: number[], rule: LevelRule, low: number, high: number): LeanFlip[] {
  return flipsFrom(bars, (i) => {
    const r = at[i]
    const prev = i > 0 ? at[i - 1] : NaN
    const L = rule === 'zone' ? r <= low : prev <= low && r > low
    const S = rule === 'zone' ? r >= high : prev >= high && r < high
    return (L ? LONG_ON : 0) | (S ? SHORT_ON : 0)
  })
}

/** A player's raw side conditions at a bar's close, as bits: its long condition is true, its short condition is true. */
export const LONG_ON = 1
export const SHORT_ON = 2

/** The side the raw conditions `bits` ask for: only one of them true is a signal (1 long, -1 short), both or neither nothing. */
export function sideOf(bits: number): 1 | 0 | -1 {
  const L = (bits & LONG_ON) !== 0
  const S = (bits & SHORT_ON) !== 0
  return L && !S ? 1 : S && !L ? -1 : 0
}

/** When set, `flipsFrom` writes each bar's raw conditions into it (`withConditions`); null = nothing recorded, nothing computed for it. */
let recording: Uint8Array | null = null

/** `run` (a player's flips function, called once) with its raw conditions per bar written into `into` (one byte per bar); the flips it returns are the ones it returns without. */
export function withConditions<T>(into: Uint8Array, run: () => T): T {
  recording = into
  const out = run()
  recording = null
  return out
}

/**
 * The convention every player shares: `on(i)` (called for i = 0, 1, ... in order) = the raw conditions at the close of bar i (`LONG_ON` | `SHORT_ON`); only one of them true is a signal (1 long, -1 short), both or
 * neither nothing; always in position, out only by reversing, so a side already held does nothing.
 */
function flipsFrom(bars: BenchBar[], on: (i: number) => number, only: 1 | 0 | -1 = 0): LeanFlip[] {
  const out: LeanFlip[] = []
  let held = 0 as 1 | 0 | -1
  for (let i = 0; i < bars.length; i++) {
    const bits = on(i)
    if (recording !== null) recording[i] = bits
    const w = sideOf(bits)
    if (w === 0 || w === held) continue
    // A player of one side only (`only` = 1 long, -1 short): the signal of the other side closes what it holds (a `close` flip) and takes nothing; it is remembered in `held` as a side taken, so it fires once.
    if (only !== 0 && w === -only) {
      if (held === only) out.push({ kind: 'close', t: bars[i].t + 60, px: bars[i].c, long: NaN, from: held })
    } else out.push({ kind: w === 1 ? 'long' : 'short', t: bars[i].t + 60, px: bars[i].c, long: NaN, from: held })
    held = w
  }
  return out
}

/** The signals of raw side conditions already computed (`bits[i]` = bar i's `LONG_ON` | `SHORT_ON`), by the one convention above; `only` as `flipsFrom`'s. `/bot`'s bot builds its conditions from its members' (`botFlips.ts`). */
export function bitsFlips(bars: BenchBar[], bits: Uint8Array, only: 1 | 0 | -1 = 0): LeanFlip[] {
  return flipsFrom(bars, (i) => bits[i], only)
}

/** `/rsi`'s band players' two rules: `retour` = long under the lower line, short over the upper (the price is expected back inside); `cassure` = the reverse (the price is followed out). */
export type BandRule = 'retour' | 'cassure'

/** A band player's signals: `lines` = [upper, lower, ...], one value per bar (NaN where undefined: no signal); decided on the close of bar i against the lines of bar i. */
export function bandFlips(bars: BenchBar[], lines: number[][], rule: BandRule | null): LeanFlip[] {
  const [up, lo] = lines
  return flipsFrom(bars, (i) => {
    const above = bars[i].c > up[i]
    const below = bars[i].c < lo[i]
    return rule === 'cassure' ? (above ? LONG_ON : 0) | (below ? SHORT_ON : 0) : (below ? LONG_ON : 0) | (above ? SHORT_ON : 0)
  })
}

/**
 * The Squeeze's signals from `lines` = [Bollinger upper, Bollinger lower, Keltner upper, Keltner lower, Bollinger middle, ...]: a bar is compressed when all four lines are
 * defined and Bollinger's are strictly inside Keltner's; the signal is on the first bar that is not compressed after a compressed one, with its lines defined: long when its close is
 * above Bollinger's middle, short when under, nothing when equal. A bar with an undefined line breaks the run.
 */
export function squeezeFlips(bars: BenchBar[], lines: number[][]): LeanFlip[] {
  const [bu, bl, ku, kl, mid] = lines
  let was = false
  return flipsFrom(bars, (i) => {
    const defined = Number.isFinite(bu[i]) && Number.isFinite(bl[i]) && Number.isFinite(ku[i]) && Number.isFinite(kl[i]) && Number.isFinite(mid[i])
    const now = defined && bu[i] < ku[i] && bl[i] > kl[i]
    const release = was && !now && defined
    was = now
    return release ? (bars[i].c > mid[i] ? LONG_ON : 0) | (bars[i].c < mid[i] ? SHORT_ON : 0) : 0
  })
}

/** `/rsi`'s trend followers' one choice of rule (the MACD's): `cross` = the line against its signal, `zero` = the line against 0. */
export type TrendRule = 'cross' | 'zero'

/** Long while `a(i)` is above `b(i)`, short while below; nothing where either is undefined (NaN) or they are equal (the side held is kept). Decided at the close of bar i. */
export function aboveFlips(bars: BenchBar[], a: (i: number) => number, b: (i: number) => number): LeanFlip[] {
  return flipsFrom(bars, (i) => {
    const x = a(i)
    const y = b(i)
    return (x > y ? LONG_ON : 0) | (x < y ? SHORT_ON : 0)
  })
}

/** The trend followers that carry their side (SuperTrend, Parabolic SAR, the ATR stop): `side[i]` = 1 long, -1 short, NaN none. */
export function sideFlips(bars: BenchBar[], side: number[]): LeanFlip[] {
  return flipsFrom(bars, (i) => (side[i] === 1 ? LONG_ON : side[i] === -1 ? SHORT_ON : 0))
}

/** The ADX's signals from `lines` = [+DI, -DI, ADX, ...]: long while +DI > -DI and ADX >= `threshold`, short while -DI > +DI and ADX >= `threshold`, nothing otherwise (an undefined line holds nothing). */
export function adxFlips(bars: BenchBar[], lines: number[][], threshold: number): LeanFlip[] {
  const [pdi, mdi, adx] = lines
  return flipsFrom(bars, (i) => (adx[i] >= threshold ? (pdi[i] > mdi[i] ? LONG_ON : 0) | (pdi[i] < mdi[i] ? SHORT_ON : 0) : 0))
}

/** `leanHistory`'s points with no value (`s` NaN) where its two book components were not known: the lean + book has no lean there. */
export function bookOnlyPoints(points: LeanPoint[]): LeanPoint[] {
  return points.map((p) => (p.book ? p : { ...p, s: NaN }))
}

/**
 * The lean's points as the panel's LONG figure (50 + 50 s, thresholds read on it) aligned on `bars`: `leanHistory` starts at
 * a warm-up bar and a point's `t` is its bar's close, so point k sits on bar `bars.length - points.length + k`. NaN before it and where `s` is NaN.
 */
export function longOnBars(bars: BenchBar[], points: LeanPoint[]): number[] {
  const out: number[] = new Array(bars.length).fill(NaN)
  const offset = bars.length - points.length
  for (let k = 0; k < points.length; k++) out[offset + k] = 50 + 50 * points[k].s
  return out
}
