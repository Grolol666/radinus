/**
 * `/rsi`'s players, described once (built to take 35 players): the table, the chart's marks and panes and the simulation
 * read `RSI_TABLE_PLAYERS` and nothing else. Three shapes: a zone oscillator (a series against two thresholds, one pane), a band player
 * (the price against lines drawn on the price chart) and a trend follower (a few lines, on the price or in a pane, and a rule of its own). Any is added by one description here and its indicator function: the
 * RSI's and the stochastic's are `zonesBench.ts`'s loaders, called from their descriptions.
 */

import { aboveFlips, adxFlips, bandFlips, levelFlips, sideFlips, squeezeFlips, withConditions } from './levelFlips'
import type { BandRule, LevelRule, TrendRule } from './levelFlips'
import { LEAN_SIM_LATENCY_MS, simulateLeanFlips } from './leanSim'
import type { LeanSimResult } from './leanSim'
import type { FundingHours } from './funding'
import type { OpportunityTape } from './hedgeSim'
import { adxLoader, aroonLoader, atrStopLoader, awesomeLoader, bollingerLoader, cciIntrabar, cciLoader, cmfLoader, cvdLoader, donchianLoader, emaCrossLoader, emaLoader, envelopesLoader, forceLoader, heikinAshiLoader, ichimokuLoader, keltnerLoader, macdLoader, mfiIntrabar, mfiLoader, momentumLoader, obvLoader, parabolicSarLoader, rsiIntrabar, rsiLoader, rsiStochasticIntrabar, rsiStochasticLoader, smaLoader, squeezeLoader, stochasticIntrabar, stochasticLoader, superTrendLoader, trixLoader, tsiLoader, ultimateIntrabar, ultimateLoader, vortexLoader, vwapLoader, zscoreIntrabar, zscoreLoader } from './zonesBench'
import type { BenchBar, Intrabar, LeanFlip } from './zonesBench'
import { REGIME_PERIOD_DEFAULT, REGIME_THRESHOLD_DEFAULT } from './regime'

/** $100 traded per signal, as `/lean`. */
export const PLAYER_NOTIONAL = 100

/** A search grid on one field : from `min` to `max` by `step`, both ends tried. Not the field's bounds: the page's search, predefined here. */
export type SearchRange = { min: number; max: number; step: number }

/**
 * One of a player's own settings (the RSI's period, the stochastic's period and smoothing, a band's deviations): an integer field with its bounds, or with decimals when it has a `step`.
 * `search` = what the row's `chercher` tries on it (none = the field is not searched); `flipsOnly` = the signals read it, the series does not (the ADX's seuil), so the series is computed without it.
 */
export type PlayerSetting = { key: string; label: string; def: number; lo: number; hi: number; step?: number; search?: SearchRange; flipsOnly?: true }

/** What every player has: its row's letter and colour (its marks on the price), its settings, whether it is drawn at the start; `valid` = which settings together the search may try (the fast under the slow), absent = all. */
type PlayerBase = { id: string; letter: string; color: string; name: string; settings: PlayerSetting[]; shown: boolean; valid?: (settings: number[]) => boolean }

/** A player's thresholds: the bounds the table's fields accept and their arrow step (the CCI's are not 0..100, the Z-score's have decimals). */
export type ThresholdBounds = { lo: number; hi: number; step: number }

/**
 * A zone oscillator: a series read against two thresholds by `levelFlips`. `range` is the pane's fixed vertical range (0..100 for the bounded
 * oscillators), `null` = the pane autoscales (CCI, Z-score). `shown` = drawn at the start. `loader` gets the settings in `settings` order and returns the series' loader (continued at a minute close, state kept between calls). */
export type ZonePlayer = PlayerBase & {
  shape: 'zone'
  low: number
  high: number
  bounds: ThresholdBounds
  /** The search on the low threshold; the high one is its mirror, `mirror - low` (100 on a 0..100 scale, 0 on a scale centred on 0). */
  thresholdSearch: SearchRange & { mirror: number }
  range: [number, number] | null
  rule: LevelRule
  loader: (settings: number[]) => (bars: BenchBar[]) => number[]
  /** The oscillator's one-bar continuation (`radinus/` runs it a bar at a time): gets the settings in `settings` order and returns its `Intrabar`, built from the same step as `loader`'s continuation. */
  intrabar?: (settings: number[]) => Intrabar
}

/** One line a band player draws on the price pane (the first two of its arrays are always the upper and the lower line). */
export type BandLine = { dashed?: boolean }

/**
 * A band player: arrays per bar read against the price. `rule` is the default of the row's `retour` / `cassure` choice; `null` = the
 * player has no choice (the Squeeze). `loader` gets the settings in `settings` order and returns the arrays' loader (continued at a minute close); the first `lines.length` arrays are drawn
 * on the price pane, the others are carried state or what the signals read. `flips` = its signals from the bars and the arrays. It has no thresholds and no pane.
 */
export type BandPlayer = PlayerBase & {
  shape: 'band'
  rule: BandRule | null
  lines: BandLine[]
  loader: (settings: number[]) => (bars: BenchBar[]) => number[][]
  flips: (bars: BenchBar[], lines: number[][], rule: BandRule | null) => LeanFlip[]
  /** The band's middle at bar i, from the loader's arrays and the settings (`state.sideLines`): the SMA, the EMA, the VWAP, the channel's midline; NaN while it warms up. */
  middle: (arrays: number[][], i: number, settings: number[]) => number
}

/** One line a trend follower draws (the first `lines.length` arrays of its loader, in order): dotted when `dashed`, in `color` when it has one of its own (else the player's). */
export type TrendLine = { dashed?: boolean; color?: string }
/** A horizontal level drawn in the player's pane: a fixed value (the MACD's zero) or one of its settings, by key (the ADX's seuil). */
export type TrendLevel = { value: number } | { setting: string }
/** One choice of the row's `rule` cell. */
export type TrendRuleOption = { id: TrendRule; label: string }

/**
 * A trend follower: arrays per bar, drawn as `lines` on the price pane (`pane` false) or in a pane of its own (`pane` true, with `levels` and the pane's fixed vertical `range`, `null` = autoscale), read by `flips`
 * under the row's rule. `rules` = the choices of the `rule` cell (empty = none, the cell stays empty), `rule` = the default one. `loader` gets the settings in `settings` order and returns the arrays' loader (the drawn lines first,
 * then the carried state); `flips` gets the bars, the arrays, the rule and the settings (a threshold is one of them). No thresholds of its own: the `seuil` cells stay empty.
 * `needs: 'delta'` = the loader also gets the store's per-minute aggressor delta (one value per bar, NaN before the first print's minute), which the store then computes from the prints; absent = bars only.
 */
export type TrendPlayer = PlayerBase & {
  shape: 'trend'
  needs?: 'delta'
  rule: TrendRule | null
  rules: TrendRuleOption[]
  pane: boolean
  range: [number, number] | null
  lines: TrendLine[]
  levels: TrendLevel[]
  loader: (settings: number[]) => (bars: BenchBar[], delta: number[]) => number[][]
  flips: (bars: BenchBar[], lines: number[][], rule: TrendRule | null, settings: number[]) => LeanFlip[]
}

export type TablePlayer = ZonePlayer | BandPlayer | TrendPlayer
/** A player's rule as its fields hold it: a zone oscillator's, a band's, a trend follower's, or none. */
export type PlayerRule = LevelRule | BandRule | TrendRule | null

/** What a player's loader returns: the zone oscillator's series or the band / trend player's arrays, the other one `null`. */
export type PlayerSeries = { values: number[] | null; lines: number[][] | null }

/** The loader of `def` at `settings`, in the one shape the store keeps; `delta` is the store's per-minute aggressor delta, read by the players that ask for it (`needs`). */
export function playerLoader(def: TablePlayer, settings: number[]): (bars: BenchBar[], delta: number[]) => PlayerSeries {
  if (def.shape === 'zone') {
    const run = def.loader(settings)
    return (bars) => ({ values: run(bars), lines: null })
  }
  if (def.shape === 'trend') {
    const run = def.loader(settings)
    return (bars, delta) => ({ values: null, lines: run(bars, delta) })
  }
  const run = def.loader(settings)
  return (bars) => ({ values: null, lines: run(bars) })
}

/** A trend follower's levels as numbers, from its settings: a fixed value as is, a setting read in `settings`. */
export function trendLevels(def: TrendPlayer, settings: number[]): number[] {
  return def.levels.map((l) => ('value' in l ? l.value : settings[def.settings.findIndex((s) => s.key === l.setting)]))
}

/** The thresholds of the 0..100 oscillators. */
const PCT: ThresholdBounds = { lo: 0, hi: 100, step: 1 }

/** The band players' shared description parts: the drawn lines (upper, lower) and the settings with their bounds (the decimals carry their own step). */
const TWO_LINES: BandLine[] = [{}, {}]
const PERIOD_20: PlayerSetting = { key: 'period', label: 'period', def: 20, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }
const BOLLINGER_SETTINGS: PlayerSetting[] = [PERIOD_20, { key: 'k', label: 'deviations', def: 2, lo: 0.1, hi: 10, step: 0.1, search: { min: 0.5, max: 4, step: 0.5 } }]
const KELTNER_SETTINGS: PlayerSetting[] = [PERIOD_20, { key: 'k', label: 'ATR ×', def: 2, lo: 0.1, hi: 10, step: 0.1, search: { min: 0.5, max: 4, step: 0.5 } }]
const DONCHIAN_SETTINGS: PlayerSetting[] = [{ ...PERIOD_20, lo: 1, search: { min: 1, max: 240, step: 1 } }]
const ENVELOPES_SETTINGS: PlayerSetting[] = [PERIOD_20, { key: 'x', label: 'offset %', def: 0.2, lo: 0.01, hi: 20, step: 0.05, search: { min: 0.05, max: 1, step: 0.05 } }]
const VWAP_SETTINGS: PlayerSetting[] = [{ key: 'x', label: 'offset %', def: 0.2, lo: 0.01, hi: 20, step: 0.05, search: { min: 0.05, max: 1, step: 0.05 } }]
const SQUEEZE_SETTINGS: PlayerSetting[] = [
  { key: 'bPeriod', label: 'Bollinger period', def: 20, lo: 2, hi: 200, search: { min: 5, max: 100, step: 5 } },
  { key: 'bK', label: 'deviations', def: 2, lo: 0.1, hi: 10, step: 0.1, search: { min: 1.5, max: 2.5, step: 0.5 } },
  { key: 'kPeriod', label: 'Keltner period', def: 20, lo: 2, hi: 200, search: { min: 5, max: 100, step: 5 } },
  { key: 'kK', label: 'ATR ×', def: 1.5, lo: 0.1, hi: 10, step: 0.1, search: { min: 1, max: 2, step: 0.5 } },
]

/** The trend followers' shared description parts: no choice of rule, the settings two of them have, the colours of an up / down pair of lines in a pane. */
const NO_RULES: TrendRuleOption[] = []
const PERIOD_10: PlayerSetting = { key: 'period', label: 'period', def: 10, lo: 2, hi: 200, search: { min: 2, max: 100, step: 2 } }
const PERIOD_50: PlayerSetting = { key: 'period', label: 'period', def: 50, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }
/** The TSI saturates at +/-100 over a run of moves of one sign (a flat stretch included: both smoothed sums decay by the same factor) and its signal converges on it: the two then differ by one rounding (100.00000000000001 against 100), and that noise, not the market, decided the side (measured on 106,982 bars, 7,297 flips against 5,965 for an independent writing of the same formulas). Read to 1e-8, a TSI point being the unit, equal values are equal. */
const tieRound = (x: number) => Math.round(x * 1e8) / 1e8
const UP_LINE = '#26a69a'
const DOWN_LINE = '#ef5350'

/** The players, in the table's order: the zone oscillators (author, 2026-10-04: RSI 30 / 70, stochastic 20 / 80, both on `zone`; the five of lot 1 start unchecked), then the band players (lot 2, unchecked; retour except the Donchian's cassure by default, the Squeeze has no rule), then the trend followers (lot 3, unchecked; the MACD alone has a choice of rule), then the momentum and volume players (lot 4, trend followers in a pane, unchecked; the last reads the store's aggressor delta). */
export const RSI_TABLE_PLAYERS: TablePlayer[] = [
  { shape: 'zone', id: 'rsi', letter: 'R', color: '#ff6ec7', name: 'RSI', settings: [{ key: 'period', label: 'period', def: 14, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], low: 30, high: 70, bounds: PCT, thresholdSearch: { min: 5, max: 45, step: 1, mirror: 100 }, range: [0, 100], shown: true, rule: 'zone', loader: ([n]) => rsiLoader(n), intrabar: ([n]) => rsiIntrabar(n) },
  { shape: 'zone', id: 'stoch', letter: 'S', color: '#b388ff', name: 'Stochastic', settings: [{ key: 'period', label: 'period', def: 14, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }, { key: 'smooth', label: 'smoothing', def: 3, lo: 1, hi: 100, search: { min: 1, max: 10, step: 1 } }], low: 20, high: 80, bounds: PCT, thresholdSearch: { min: 5, max: 45, step: 5, mirror: 100 }, range: [0, 100], shown: true, rule: 'zone', loader: ([n, k]) => stochasticLoader(n, k), intrabar: ([n, k]) => stochasticIntrabar(n, k) },
  { shape: 'zone', id: 'cci', letter: 'C', color: '#4dd0e1', name: 'CCI', settings: [{ key: 'period', label: 'period', def: 20, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], low: -100, high: 100, bounds: { lo: -1000, hi: 1000, step: 5 }, thresholdSearch: { min: -250, max: -50, step: 10, mirror: 0 }, range: null, shown: false, rule: 'zone', loader: ([n]) => cciLoader(n), intrabar: ([n]) => cciIntrabar(n) },
  { shape: 'zone', id: 'mfi', letter: 'M', color: '#ffd54f', name: 'MFI', settings: [{ key: 'period', label: 'period', def: 14, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], low: 20, high: 80, bounds: PCT, thresholdSearch: { min: 5, max: 45, step: 1, mirror: 100 }, range: [0, 100], shown: false, rule: 'zone', loader: ([n]) => mfiLoader(n), intrabar: ([n]) => mfiIntrabar(n) },
  { shape: 'zone', id: 'rsistoch', letter: 'SR', color: '#69f0ae', name: 'Stochastic RSI', settings: [{ key: 'rsi', label: 'RSI', def: 14, lo: 2, hi: 200, search: { min: 2, max: 60, step: 2 } }, { key: 'window', label: 'window', def: 14, lo: 2, hi: 200, search: { min: 2, max: 60, step: 2 } }, { key: 'smooth', label: 'smoothing', def: 3, lo: 1, hi: 100, search: { min: 1, max: 5, step: 1 } }], low: 20, high: 80, bounds: PCT, thresholdSearch: { min: 5, max: 45, step: 5, mirror: 100 }, range: [0, 100], shown: false, rule: 'zone', loader: ([r, n, k]) => rsiStochasticLoader(r, n, k), intrabar: ([r, n, k]) => rsiStochasticIntrabar(r, n, k) },
  { shape: 'zone', id: 'uo', letter: 'U', color: '#ff8a65', name: 'Ultimate Oscillator', settings: [{ key: 'short', label: 'short', def: 7, lo: 1, hi: 200, search: { min: 2, max: 20, step: 2 } }, { key: 'medium', label: 'medium', def: 14, lo: 1, hi: 200, search: { min: 4, max: 60, step: 4 } }, { key: 'long', label: 'long', def: 28, lo: 1, hi: 240, search: { min: 8, max: 240, step: 16 } }], valid: ([a, b, c]) => a < b && b < c, low: 30, high: 70, bounds: PCT, thresholdSearch: { min: 5, max: 45, step: 5, mirror: 100 }, range: [0, 100], shown: false, rule: 'zone', loader: ([a, b, c]) => ultimateLoader(a, b, c), intrabar: ([a, b, c]) => ultimateIntrabar(a, b, c) },
  { shape: 'zone', id: 'zscore', letter: 'Z', color: '#e0e0e0', name: 'Z-score', settings: [{ key: 'period', label: 'period', def: 20, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], low: -2, high: 2, bounds: { lo: -10, hi: 10, step: 0.1 }, thresholdSearch: { min: -3, max: -0.5, step: 0.1, mirror: 0 }, range: null, shown: false, rule: 'zone', loader: ([n]) => zscoreLoader(n), intrabar: ([n]) => zscoreIntrabar(n) },
  { shape: 'band', id: 'bollinger', letter: 'B', color: '#42a5f5', name: 'Bollinger', settings: BOLLINGER_SETTINGS, shown: false, rule: 'retour', lines: TWO_LINES, loader: ([n, k]) => bollingerLoader(n, k), flips: bandFlips, middle: (arrays, i) => arrays[2][i] },
  { shape: 'band', id: 'keltner', letter: 'K', color: '#26a69a', name: 'Keltner', settings: KELTNER_SETTINGS, shown: false, rule: 'retour', lines: TWO_LINES, loader: ([n, k]) => keltnerLoader(n, k), flips: bandFlips, middle: (arrays, i) => arrays[2][i] },
  { shape: 'band', id: 'donchian', letter: 'D', color: '#ef5350', name: 'Donchian', settings: DONCHIAN_SETTINGS, shown: false, rule: 'cassure', lines: TWO_LINES, loader: ([n]) => donchianLoader(n), flips: bandFlips, middle: (arrays, i) => (arrays[0][i] + arrays[1][i]) / 2 },
  { shape: 'band', id: 'envelopes', letter: 'E', color: '#a1887f', name: 'Envelopes', settings: ENVELOPES_SETTINGS, shown: false, rule: 'retour', lines: TWO_LINES, loader: ([n, x]) => envelopesLoader(n, x), flips: bandFlips, middle: (arrays, i, settings) => arrays[0][i] / (1 + settings[1] / 100) },
  { shape: 'band', id: 'vwap', letter: 'V', color: '#f48fb1', name: 'VWAP', settings: VWAP_SETTINGS, shown: false, rule: 'retour', lines: TWO_LINES, loader: ([x]) => vwapLoader(x), flips: bandFlips, middle: (arrays, i) => arrays[3][i] > 0 ? arrays[2][i] / arrays[3][i] : NaN },
  { shape: 'band', id: 'squeeze', letter: 'Sq', color: '#c6ff00', name: 'Squeeze', settings: SQUEEZE_SETTINGS, shown: false, rule: null, lines: [{}, {}, { dashed: true }, { dashed: true }], loader: ([nb, kb, nk, kk]) => squeezeLoader(nb, kb, nk, kk), flips: squeezeFlips, middle: (arrays, i) => arrays[4][i] },
  { shape: 'trend', id: 'emacross', letter: 'X', color: '#ff9100', name: 'Moving-average cross', settings: [{ key: 'fast', label: 'fast', def: 9, lo: 2, hi: 200, search: { min: 2, max: 60, step: 1 } }, { key: 'slow', label: 'slow', def: 20, lo: 2, hi: 240, search: { min: 5, max: 240, step: 5 } }], valid: ([a, b]) => a < b, shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [{}, { dashed: true }], levels: [], loader: ([a, b]) => emaCrossLoader(a, b), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'pricema', letter: 'P', color: '#536dfe', name: 'Price vs average', settings: [PERIOD_50], shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [{}], levels: [], loader: ([n]) => smaLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => bars[i].c, (i) => lines[0][i]) },
  { shape: 'trend', id: 'macd', letter: 'MC', color: '#d500f9', name: 'MACD', settings: [{ key: 'fast', label: 'fast', def: 12, lo: 2, hi: 200, search: { min: 2, max: 30, step: 2 } }, { key: 'slow', label: 'slow', def: 26, lo: 2, hi: 200, search: { min: 10, max: 120, step: 5 } }, { key: 'signal', label: 'signal', def: 9, lo: 2, hi: 200, search: { min: 2, max: 20, step: 2 } }], valid: ([a, b]) => a < b, shown: false, rule: 'cross', rules: [{ id: 'cross', label: 'cross' }, { id: 'zero', label: 'zero line' }], pane: true, range: null, lines: [{}, { dashed: true }], levels: [{ value: 0 }], loader: ([f, s, g]) => macdLoader(f, s, g), flips: (bars, lines, rule) => aboveFlips(bars, (i) => lines[0][i], rule === 'zero' ? () => 0 : (i) => lines[1][i]) },
  { shape: 'trend', id: 'supertrend', letter: 'ST', color: '#00c853', name: 'SuperTrend', settings: [PERIOD_10, { key: 'k', label: 'ATR ×', def: 3, lo: 0.1, hi: 10, step: 0.1, search: { min: 1, max: 6, step: 0.5 } }], shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [{}], levels: [], loader: ([n, k]) => superTrendLoader(n, k), flips: (bars, lines) => sideFlips(bars, lines[4]) },
  { shape: 'trend', id: 'sar', letter: 'PS', color: '#18ffff', name: 'Parabolic SAR', settings: [{ key: 'step', label: 'step', def: 0.02, lo: 0.001, hi: 1, step: 0.005, search: { min: 0.005, max: 0.1, step: 0.005 } }, { key: 'max', label: 'maximum', def: 0.2, lo: 0.01, hi: 1, step: 0.05, search: { min: 0.1, max: 0.5, step: 0.05 } }], shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [{ dashed: true }], levels: [], loader: ([a, m]) => parabolicSarLoader(a, m), flips: (bars, lines) => sideFlips(bars, lines[1]) },
  { shape: 'trend', id: 'adx', letter: 'AX', color: '#ff1744', name: 'ADX / DMI', settings: [{ key: 'period', label: 'period', def: 14, lo: 2, hi: 200, search: { min: 2, max: 60, step: 1 } }, { key: 'threshold', label: 'threshold', def: 25, lo: 0, hi: 100, search: { min: 10, max: 40, step: 5 }, flipsOnly: true }], shown: false, rule: null, rules: NO_RULES, pane: true, range: [0, 100], lines: [{ color: UP_LINE }, { color: DOWN_LINE }, {}], levels: [{ setting: 'threshold' }], loader: ([n]) => adxLoader(n), flips: (bars, lines, _rule, [, threshold]) => adxFlips(bars, lines, threshold) },
  { shape: 'trend', id: 'aroon', letter: 'Ar', color: '#8bc34a', name: 'Aroon', settings: [{ key: 'period', label: 'period', def: 25, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: [0, 100], lines: [{ color: UP_LINE }, { color: DOWN_LINE }], levels: [], loader: ([n]) => aroonLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'vortex', letter: 'Vx', color: '#00bfa5', name: 'Vortex', settings: [{ key: 'period', label: 'period', def: 14, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{ color: UP_LINE }, { color: DOWN_LINE }], levels: [], loader: ([n]) => vortexLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'ichimoku', letter: 'I', color: '#795548', name: 'Ichimoku', settings: [{ key: 'short', label: 'short', def: 9, lo: 2, hi: 200, search: { min: 2, max: 60, step: 1 } }, { key: 'long', label: 'long', def: 26, lo: 2, hi: 240, search: { min: 5, max: 240, step: 5 } }], valid: ([a, b]) => a < b, shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [{}, { dashed: true }], levels: [], loader: ([a, b]) => ichimokuLoader(a, b), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'atrstop', letter: 'AT', color: '#ec407a', name: 'ATR trailing stop', settings: [{ key: 'period', label: 'period', def: 22, lo: 2, hi: 200, search: { min: 2, max: 100, step: 2 } }, { key: 'k', label: 'ATR ×', def: 3, lo: 0.1, hi: 10, step: 0.1, search: { min: 1, max: 6, step: 0.5 } }], shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [{}], levels: [], loader: ([n, k]) => atrStopLoader(n, k), flips: (bars, lines) => sideFlips(bars, lines[1]) },
  { shape: 'trend', id: 'heikin', letter: 'H', color: '#9e9e9e', name: 'Heikin-Ashi', settings: [], shown: false, rule: null, rules: NO_RULES, pane: false, range: null, lines: [], levels: [], loader: () => heikinAshiLoader(), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'momentum', letter: 'Mo', color: '#ce93d8', name: 'Momentum', settings: [{ key: 'period', label: 'period', def: 10, lo: 1, hi: 240, search: { min: 1, max: 240, step: 1 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}], levels: [{ value: 0 }], loader: ([n]) => momentumLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], () => 0) },
  { shape: 'trend', id: 'trix', letter: 'TX', color: '#ffcc80', name: 'TRIX', settings: [{ key: 'period', label: 'period', def: 15, lo: 2, hi: 240, search: { min: 2, max: 60, step: 1 } }, { key: 'signal', label: 'signal', def: 9, lo: 2, hi: 100, search: { min: 2, max: 20, step: 2 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}, { dashed: true }], levels: [{ value: 0 }], loader: ([n, s]) => trixLoader(n, s), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'tsi', letter: 'TS', color: '#9fa8da', name: 'TSI', settings: [{ key: 'long', label: 'long', def: 25, lo: 2, hi: 240, search: { min: 5, max: 60, step: 5 } }, { key: 'short', label: 'short', def: 13, lo: 2, hi: 100, search: { min: 2, max: 30, step: 2 } }, { key: 'signal', label: 'signal', def: 7, lo: 2, hi: 100, search: { min: 2, max: 20, step: 2 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}, { dashed: true }], levels: [{ value: 0 }], loader: ([l, c, s]) => tsiLoader(l, c, s), flips: (bars, lines) => aboveFlips(bars, (i) => tieRound(lines[0][i]), (i) => tieRound(lines[1][i])) },
  { shape: 'trend', id: 'awesome', letter: 'AO', color: '#a5d6a7', name: 'Awesome Oscillator', settings: [{ key: 'short', label: 'short', def: 5, lo: 2, hi: 100, search: { min: 2, max: 20, step: 1 } }, { key: 'long', label: 'long', def: 34, lo: 3, hi: 240, search: { min: 10, max: 100, step: 5 } }], valid: ([a, b]) => a < b, shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}], levels: [{ value: 0 }], loader: ([a, b]) => awesomeLoader(a, b), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], () => 0) },
  { shape: 'trend', id: 'obv', letter: 'OB', color: '#81d4fa', name: 'OBV', settings: [{ key: 'period', label: 'average', def: 20, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}, { dashed: true }], levels: [], loader: ([n]) => obvLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
  { shape: 'trend', id: 'cmf', letter: 'CF', color: '#b0bec5', name: 'CMF', settings: [PERIOD_20], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}], levels: [{ value: 0 }], loader: ([n]) => cmfLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], () => 0) },
  { shape: 'trend', id: 'force', letter: 'FI', color: '#dce775', name: 'Force index', settings: [{ key: 'period', label: 'period', def: 13, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}], levels: [{ value: 0 }], loader: ([n]) => forceLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], () => 0) },
  { shape: 'trend', id: 'cvd', letter: 'CV', color: '#ff80ab', name: 'Cumulative volume delta', needs: 'delta', settings: [{ key: 'period', label: 'average', def: 20, lo: 2, hi: 240, search: { min: 2, max: 240, step: 1 } }], shown: false, rule: null, rules: NO_RULES, pane: true, range: null, lines: [{}, { dashed: true }], levels: [], loader: ([n]) => cvdLoader(n), flips: (bars, lines) => aboveFlips(bars, (i) => lines[0][i], (i) => lines[1][i]) },
]

/**
 * `/bot`'s regime as a player (author's go, 2026-10-10; not in `/rsi`'s table): the slope of the EMA of the closes, in % of price per minute, `(e[i] - e[i-1]) / e[i-1] * 100` as `regime.ts`: at or above `threshold` long (fast up), at or below minus it short (fast down), else none (calm).
 * The one line is the EMA, drawn on the price in the chip's colour; the side of the first bar is none (no slope).
 */
export const REGIME_PLAYER: TrendPlayer = {
  shape: 'trend',
  id: 'regime',
  letter: 'Rg',
  color: '#4fc3f7',
  name: 'Regime',
  settings: [
    { key: 'period', label: 'EMA', def: REGIME_PERIOD_DEFAULT, lo: 2, hi: 1000 },
    { key: 'threshold', label: 'slope %/min', def: REGIME_THRESHOLD_DEFAULT, lo: 0.0001, hi: 100, step: 0.01, flipsOnly: true },
  ],
  shown: false,
  rule: null,
  rules: [],
  pane: false,
  range: null,
  lines: [{}],
  levels: [],
  loader: ([n]) => emaLoader(n),
  flips: (bars, lines, _rule, [, threshold]) =>
    sideFlips(
      bars,
      bars.map((_, i) => {
        const slope = i === 0 ? NaN : ((lines[0][i] - lines[0][i - 1]) / lines[0][i - 1]) * 100
        return slope >= threshold ? 1 : slope <= -threshold ? -1 : NaN
      }),
    ),
}

/** The players `/bot` can use (`state.side`, the `+ indicator` menu): the regime, then `/rsi`'s table. */
export const BOT_PLAYERS: TablePlayer[] = [REGIME_PLAYER, ...RSI_TABLE_PLAYERS]

/**
 * A player's signals on its series aligned on the bars (`levelFlips`, or the band's or trend follower's own, the latter reading its settings too), from the first print as `/lean`. `null` until everything is loaded.
 * `raw` (one byte per bar), when given, gets the player's raw side conditions at each bar's close (`LONG_ON` | `SHORT_ON`, `levelFlips.ts`) from the same pass, for the stop's "out until the next signal"; absent, nothing more is computed.
 */
export function playerFlips(bars: BenchBar[] | null, series: PlayerSeries | null, def: TablePlayer, rule: PlayerRule, low: number, high: number, settings: number[], firstPrintT: number | null, raw?: Uint8Array): LeanFlip[] | null {
  if (bars === null || series === null || firstPrintT === null) return null
  const flips = () =>
    def.shape === 'zone'
      ? series.values === null ? [] : levelFlips(bars, series.values, rule === 'exit' ? 'exit' : 'zone', low, high)
      : series.lines === null ? []
      : def.shape === 'band' ? def.flips(bars, series.lines, rule === 'retour' || rule === 'cassure' ? rule : null)
      : def.flips(bars, series.lines, rule === 'cross' || rule === 'zero' ? rule : null, settings)
  if (raw !== undefined) raw.fill(0)
  const all = raw === undefined ? flips() : withConditions(raw, flips)
  return all.filter((f) => f.t >= firstPrintT)
}

/** `/lean`'s simulation of a player's flips; `null` until the tape, the bars and (when asked) the funding rows are in. */
export function playerSim(fundingWait: boolean, tape: OpportunityTape | null, bars: BenchBar[] | null, flips: LeanFlip[] | null, funding: FundingHours | null): LeanSimResult | null {
  if (fundingWait || tape === null || bars === null || flips === null) return null
  return simulateLeanFlips(tape, bars, flips, PLAYER_NOTIONAL, 0, LEAN_SIM_LATENCY_MS, null, null, funding)
}
