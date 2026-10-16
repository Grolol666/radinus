/**
 * The market's regime (author's go, 2026-10-08): the slope of the EMA of the 1-minute closes, in % of price per minute, `(ema[i] - ema[i-1]) / ema[i-1] * 100`. At or above the threshold the minute is
 * `up` (fast up), at or below minus the threshold `down` (fast down), else `calm`. A zone is a maximal run of consecutive minutes with the same non-calm regime. Pure: no store, no React (radinus can import it).
 * The EMA is `zonesBench.ema`'s (seeded at the first close); minute 0 has no slope and is calm.
 */

import { emaRun } from './zonesBench'

export type Regime = 'up' | 'down' | 'calm'
/** A zone: bar indexes `i0..i1` (both included), their start times `t0..t1` in s, the lowest low and the highest high over them. */
export type RegimeZone = { kind: 'up' | 'down'; i0: number; i1: number; t0: number; t1: number; low: number; high: number }
export type RegimeBar = { t: number; h: number; l: number; c: number }
export type RegimeRun = { slope: number[]; regime: Regime[]; zones: RegimeZone[] }

/** The shortest zone drawn, in minutes. */
export const REGIME_MIN_MINUTES = 3
export const REGIME_PERIOD_DEFAULT = 20
/** % of price per minute. */
export const REGIME_THRESHOLD_DEFAULT = 0.05

/** Words shown for a regime. */
export const REGIME_WORDS: Record<Regime, string> = { up: 'fast up', down: 'fast down', calm: 'calm' }

/** `regimeOf`'s state after the bars it was fed (`n` of them): continued by `regimeFeed` on bars that only add to those, the open zone extended in place. */
export type RegimeFollow = { run: RegimeRun; e: number[]; open: RegimeZone | null; n: number }

export const regimeStart = (): RegimeFollow => ({ run: { slope: [], regime: [], zones: [] }, e: [], open: null, n: 0 })

/** Moves `f` over `bars[f.n ..]` (the bars before are the ones it was fed): the EMA continued by `emaRun`, the slope, regime and zones of the new bars only. From `regimeStart()` it is `regimeOf`. */
export function regimeFeed(f: RegimeFollow, bars: RegimeBar[], period: number, threshold: number): void {
  const from = f.n
  f.e = emaRun(bars.map((b) => b.c), period, f.e, from)
  const { e } = f
  const { slope, regime, zones } = f.run
  for (let i = from; i < bars.length; i++) {
    slope[i] = i === 0 ? NaN : ((e[i] - e[i - 1]) / e[i - 1]) * 100
    regime[i] = slope[i] >= threshold ? 'up' : slope[i] <= -threshold ? 'down' : 'calm'
    const r = regime[i]
    if (r === 'calm') {
      f.open = null
      continue
    }
    if (f.open !== null && f.open.kind === r) {
      f.open.i1 = i
      f.open.t1 = bars[i].t
      if (bars[i].h > f.open.high) f.open.high = bars[i].h
      if (bars[i].l < f.open.low) f.open.low = bars[i].l
    } else {
      f.open = { kind: r, i0: i, i1: i, t0: bars[i].t, t1: bars[i].t, low: bars[i].l, high: bars[i].h }
      zones.push(f.open)
    }
  }
  f.n = bars.length
}

export function regimeOf(bars: RegimeBar[], period: number, threshold: number): RegimeRun {
  const f = regimeStart()
  regimeFeed(f, bars, period, threshold)
  return f.run
}
