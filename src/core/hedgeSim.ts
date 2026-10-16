/**
 * The two-sub hedge (one long sub, one short sub) replayed on 1-minute candles - a port of
 * the author's first simulation's "central" candle run, pure and in memory
 * (nothing is sent anywhere). Sub A only goes long, sub B only short; each is a
 * stop-loss at E behind the best price, moved up by steps of S, and a market
 * reopen when the price has come back E from its lowest point since the close.
 *
 * Model, as in the reference: prices are last-trade prices; levels are hit
 * exactly (continuous path inside a minute); inside a minute the order of high
 * and low is unknown, so the "central" ordering is used (close >= open ->
 * open-low-high-close, else open-high-low-close); a hole in the data is a jump
 * (the level is filled at the far side of the hole, nothing is filled inside).
 * Every fill pays `slipPct` of the level's price against the sub, plus `feePct`
 * of its notional. The real stop trigger (mark or last) and Lighter's latency are not
 * modelled; the funding is, when `HedgeParams.funding` is given (`core/funding.ts`), booked at each close.
 */
import { fundingPaid } from './funding'
import type { FundingFigure, FundingHours } from './funding'

export type HedgeBar = { t: number; o: number; h: number; l: number; c: number; gap: boolean }

export type HedgeParams = {
  /** E, in % of the reference price (entry, peak or trough). */
  ePct: number
  /** S as a fraction of E; `<= 0` = the stop never trails (stays at entry - E). */
  sOverE: number
  leverage: number
  /** Margin per sub, in $. */
  margin: number
  /** Fee per fill, in % of its notional. */
  feePct: number
  /** Adverse slippage per market order, in % of price. */
  slipPct: number
  /** SMA filter: N minutes, `0` = off. A opens only above the SMA of the last N 1-minute closes, B only below (`smaSeries`). */
  smaN: number
  /** Adaptive E: ATR period in minutes, `0` = off. E = `atrK` x ATR(period) as a % of the last close (`atrEPctSeries`); `ePct` is used until enough bars exist. */
  atrP: number
  atrK: number
  /**
   * ONE SUB (`single`): one sub, always in the market, that reverses. It opens long at the first bar's open; a long's stop is A's
   * (entry - E, moved to peak - E by steps of S), a short's is B's (the mirror). When the stop is hit the position is
   * closed and the opposite one opened at market at the same level, in the same step (two fills, each paying slippage
   * and fee). With the SMA filter, a side the SMA forbids is not opened: the sub stays flat, waiting for that side
   * only, and opens it at market as soon as the price is on its side of the SMA. The events and curves of the long
   * legs are A's, of the short legs B's; the capital is one margin, not two.
   */
  single: boolean
  /** The hourly funding rows (`loadLighterFundingHistory`): given, each position pays the hour marks it crosses (`fundingPaid`) when it closes; absent, no funding - the figures are then the ones without this field. */
  funding?: FundingHours | null
}

/** The capital a setting puts up: the margin of each sub it uses (one in UN SEUL, two otherwise). */
export const hedgeCapital = (p: Pick<HedgeParams, 'single' | 'margin'>): number => (p.single ? 1 : 2) * p.margin

export type HedgeSubId = 'A' | 'B'
export type HedgeEvent = { t: number; sub: HedgeSubId; kind: 'open' | 'close'; reason: 'start' | 'reopen' | 'stop' | 'end'; price: number }

export type HedgeSubSummary = {
  pnl: number
  opens: number
  closes: number
  stopMoves: number
  wins: number
  losses: number
  avgWin: number
  avgLoss: number
  timeInPct: number
  maxDrawdown: number
}

export type HedgeSummary = {
  A: HedgeSubSummary
  B: HedgeSubSummary
  /** Includes `funding.paid` when the funding is on. */
  pairPnl: number
  pairPnlPct: number
  pairMaxDrawdown: number
  /** The funding of both subs, positions added up (`paid` is already in the PnL figures); zeros when the funding is off. */
  funding: FundingFigure
  hours: number
  opens: number
  stopMovesPerHour: number
  /** Market orders plus stop placements and modifications, per hour (the reference's `txPerHour`: 2 x opens + moves). */
  ordersPerHour: number
  /** The same count as Lighter's sendTx (`sendTxRate`): average per minute, and the peak over any rolling minute (1-minute engines: the busiest minute bar). */
  sendTxPerMin: number
  sendTxPeakMin: number
}

export type HedgeDay = { day: string; a: number; b: number; pair: number }
export type HedgeHold = { pnl: number; maxDrawdown: number }

export type HedgeResult = {
  times: number[]
  /** Stop level in price terms at each bar's end, `null` while the sub is closed. */
  stopA: (number | null)[]
  stopB: (number | null)[]
  /** Cumulative PnL in $ at each bar's close (realized + open). */
  eqA: number[]
  eqB: number[]
  eqPair: number[]
  events: HedgeEvent[]
  summary: HedgeSummary
  days: HedgeDay[]
  holdA: HedgeHold
  holdB: HedgeHold
  /** The SMA at each bar (`null` before N bars exist), or `null` when the filter is off. */
  sma: (number | null)[] | null
  /** The ATR-based E in % at each bar (`null` while the fixed E is used), or `null` when adaptive E is off. */
  atrEPct: (number | null)[] | null
  /** The median E in % actually used over the run: the fixed E, or with ATR on the median of the per-bar E (the fixed E stands in before enough bars exist). */
  medianEPct: number
  /** The run was ONE SUB (`HedgeParams.single`): A's figures are the long legs, B's the short legs. */
  single: boolean
  /** How long the run took, in ms (measured inside the engine, not the render). */
  ms: number
}

// One sub in signed price space x = sign * price, so B is A run on -price.
type Sub = {
  id: HedgeSubId
  sign: 1 | -1
  open: boolean
  entry: number
  qty: number
  stop: number
  anchor: number
  peak: number
  trough: number
  realized: number
  tradeFee: number
  opens: number
  closes: number
  moves: number
  wins: number
  losses: number
  sumWin: number
  sumLoss: number
  openSince: number
  timeIn: number
  /** The funding booked into `realized`, and the hour marks crossed and missing (`fundingPaid`). */
  fund: FundingFigure
  /** UN SEUL only: flat, and waiting for the SMA to allow this side. */
  wait: boolean
}

function newSub(id: HedgeSubId, sign: 1 | -1): Sub {
  return { id, sign, open: false, entry: 0, qty: 0, stop: 0, anchor: 0, peak: 0, trough: 0, realized: 0, tradeFee: 0, opens: 0, closes: 0, moves: 0, wins: 0, losses: 0, sumWin: 0, sumLoss: 0, openSince: 0, timeIn: 0, fund: { paid: 0, hours: 0, missing: 0 }, wait: false }
}

/** `s`'s funding over its open position, up to `exitMs`, added to the sub's totals; `0` with no rows given. */
function bookFunding(s: Sub, rows: FundingHours | null | undefined, exitMs: number): number {
  if (!rows) return 0
  const f = fundingPaid(s.sign, s.qty, s.openSince, exitMs, rows)
  s.fund = { paid: s.fund.paid + f.paid, hours: s.fund.hours + f.hours, missing: s.fund.missing + f.missing }
  return f.paid
}

const sumFunding = (a: FundingFigure, b: FundingFigure): FundingFigure => ({ paid: a.paid + b.paid, hours: a.hours + b.hours, missing: a.missing + b.missing })

const equity = (s: Sub, x: number): number => s.realized + (s.open ? s.qty * (x - s.entry) : 0)

export function maxDrawdown(series: ArrayLike<number>): number {
  let peak = 0
  let dd = 0
  for (let i = 0; i < series.length; i++) {
    const v = series[i]
    if (v > peak) peak = v
    if (peak - v > dd) dd = peak - v
  }
  return dd
}

/**
 * sendTx per minute, average over `spanMs` and peak over any rolling minute, from the sendTx times (ms, ascending).
 * Lighter RH, Standard account: 60 sendTx a minute per L1 address, all its sub-accounts together; every create,
 * modify and cancel is one (Lighter's API docs, rate limits, read 2026-09-30).
 */
export function sendTxRate(timesMs: ArrayLike<number>, spanMs: number): { perMin: number; peakMin: number } {
  let peak = 0
  let lo = 0
  for (let hi = 0; hi < timesMs.length; hi++) {
    while (timesMs[hi] - timesMs[lo] >= 60000) lo++
    if (hi - lo + 1 > peak) peak = hi - lo + 1
  }
  return { perMin: spanMs > 0 ? timesMs.length / (spanMs / 60000) : 0, peakMin: peak }
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Day-by-day change of a cumulative series, days in UTC. */
export function perDay(timesMs: number[], series: ArrayLike<number>): Map<string, number> {
  const out = new Map<string, number>()
  let prev = 0
  let cur = ''
  let last = 0
  for (let i = 0; i < timesMs.length; i++) {
    const d = dayOf(timesMs[i])
    if (d !== cur) {
      if (cur) {
        out.set(cur, last - prev)
        prev = last
      }
      cur = d
    }
    last = series[i]
  }
  if (cur) out.set(cur, last - prev)
  return out
}

/**
 * SMA of the N completed 1-minute closes before each bar (bars are counted, a
 * hole in the data is not filled); `null` for the first N bars.
 */
export function smaSeries(bars: HedgeBar[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(bars.length).fill(null)
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    if (i >= n) out[i] = sum / n
    sum += bars[i].c
    if (i >= n) sum -= bars[i - n].c
  }
  return out
}

/**
 * E in % from the ATR: k x the mean true range of the `period` completed bars
 * before each bar, over the close of the bar just before it. True range =
 * max(high - low, |high - previous close|, |low - previous close|) (the first
 * bar: high - low). Simple mean, not Wilder's. `null` for the first `period`
 * bars, or when the mean is 0.
 */
export function atrEPctSeries(bars: HedgeBar[], period: number, k: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(bars.length).fill(null)
  const tr = bars.map((b, j) => (j === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[j - 1].c), Math.abs(b.l - bars[j - 1].c))))
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    if (i >= period && i >= 1) {
      const atr = sum / period
      if (atr > 0) out[i] = ((k * atr) / bars[i - 1].c) * 100
    }
    sum += tr[i]
    if (i >= period) sum -= tr[i - period]
  }
  return out
}

/**
 * `ordering` is how the unknown order of a minute's high and low is settled: 'central' = up minute
 * open-low-high-close, else open-high-low-close; 'pess' = per sub, whichever of the two leaves that
 * sub's equity lowest at the close (the first simulation's 'pess', a greedy bound).
 * The stress case is 'pess' with the p90 spread as slippage - see `stressHedge`.
 */
export function simulateHedge(bars: HedgeBar[], p: HedgeParams, ordering: 'central' | 'pess' = 'central'): HedgeResult | null {
  const started = performance.now()
  if (bars.length < 2) return null
  const E0 = p.ePct / 100
  // E and S are per bar: the fixed pair, or - adaptive E - k x ATR with S the same fraction of it.
  let E = E0
  let S = p.sOverE > 0 ? E * p.sOverE : Infinity
  const smaLine = p.smaN > 0 ? smaSeries(bars, p.smaN) : null
  const atrLine = p.atrP > 0 ? atrEPctSeries(bars, p.atrP, p.atrK) : null
  // Per sub, in its signed space: it may open when x >= xsCur (-Infinity = no filter, +Infinity = SMA not yet known).
  const xsCur = [-Infinity, -Infinity]
  const eUsed = new Float64Array(bars.length)
  const setBar = (i: number) => {
    const e = atrLine ? atrLine[i] : null
    E = e !== null ? e / 100 : E0
    eUsed[i] = E * 100
    S = p.sOverE > 0 ? E * p.sOverE : Infinity
    if (smaLine) {
      const m = smaLine[i]
      xsCur[0] = m === null ? Infinity : m
      xsCur[1] = m === null ? Infinity : -m
    }
  }
  const fee = p.feePct / 100
  const slipFrac = p.slipPct / 100
  const notional = p.margin * p.leverage
  const subs = [newSub('A', 1), newSub('B', -1)]
  let events: HedgeEvent[] = []
  const n = bars.length
  const eq = [new Array<number>(n), new Array<number>(n)]
  const stops: (number | null)[][] = [new Array<number | null>(n).fill(null), new Array<number | null>(n).fill(null)]
  let clockMs = 0
  let barT = 0

  const doOpen = (s: Sub, fill: number, reason: HedgeEvent['reason']) => {
    s.open = true
    s.entry = fill
    s.qty = notional / Math.abs(fill)
    s.tradeFee = fee * s.qty * Math.abs(fill)
    s.realized -= s.tradeFee
    s.stop = fill - E * Math.abs(fill)
    s.anchor = fill
    s.peak = fill
    s.opens++
    s.openSince = clockMs
    events.push({ t: barT, sub: s.id, kind: 'open', reason, price: s.sign * fill })
  }
  const doClose = (s: Sub, fill: number, reason: HedgeEvent['reason']) => {
    const feeOut = fee * s.qty * Math.abs(fill)
    const priced = s.qty * (fill - s.entry) - feeOut
    const pnl = p.funding ? priced + bookFunding(s, p.funding, clockMs) : priced
    s.realized += pnl
    const net = pnl - s.tradeFee
    if (net > 0) {
      s.wins++
      s.sumWin += net
    } else {
      s.losses++
      s.sumLoss += net
    }
    s.open = false
    s.closes++
    s.timeIn += clockMs - s.openSince
    events.push({ t: barT, sub: s.id, kind: 'close', reason, price: s.sign * fill })
  }
  // The program steps the stop each time the peak has gained S.
  const trail = (s: Sub, x: number) => {
    if (x > s.peak) s.peak = x
    if (!Number.isFinite(S)) return
    while (s.peak >= s.anchor + S * Math.abs(s.anchor)) {
      s.anchor += S * Math.abs(s.anchor)
      const ns = s.anchor - E * Math.abs(s.anchor)
      if (ns > s.stop) {
        s.stop = ns
        s.moves++
      }
    }
  }
  // One monotone move x0 -> x1; `jump` = no prices in between (a data hole).
  const segment = (s: Sub, x0: number, x1: number, jump: boolean) => {
    const xs = smaLine ? xsCur[s.sign === 1 ? 0 : 1] : -Infinity
    // The filter can newly allow an open from a price that is already past the reopen level.
    if (!s.open && smaLine && x0 >= Math.max(s.trough + E * Math.abs(s.trough), xs)) doOpen(s, x0 + slipFrac * Math.abs(x0), 'reopen')
    if (x1 >= x0) {
      if (s.open) {
        trail(s, x1)
        return
      }
      s.trough = Math.min(s.trough, x0)
      const R = Math.max(s.trough + E * Math.abs(s.trough), xs)
      if (x1 >= R) {
        const lvl = jump ? x1 : Math.max(R, x0)
        doOpen(s, lvl + slipFrac * Math.abs(lvl), 'reopen')
        trail(s, x1)
      }
    } else {
      if (!s.open) {
        s.trough = Math.min(s.trough, x1)
        return
      }
      if (x1 <= s.stop) {
        const lvl = jump ? x1 : Math.min(s.stop, x0)
        doClose(s, lvl - slipFrac * Math.abs(lvl), 'stop')
        s.trough = Math.min(lvl, x1)
      }
    }
  }
  // ONE SUB: `s` may open when x >= its SMA bound, opened at x0 if already allowed, else where the rising move crosses the bound.
  const enter = (s: Sub, x0: number, x1: number, jump: boolean) => {
    const xs = smaLine ? xsCur[s.sign === 1 ? 0 : 1] : -Infinity
    let lvl: number | null = null
    if (x0 >= xs) lvl = x0
    else if (x1 >= xs) lvl = jump ? x1 : xs
    if (lvl === null) return
    s.wait = false
    doOpen(s, lvl + slipFrac * Math.abs(lvl), 'reopen')
    if (x1 >= lvl) trail(s, x1)
  }
  // UN SEUL: one monotone move p0 -> p1 in price terms for the pair [long, short], of which one is open or waiting.
  const segmentOne = (pair: Sub[], p0: number, p1: number, jump: boolean) => {
    const s = pair[0].open || pair[0].wait ? pair[0] : pair[1]
    const other = s === pair[0] ? pair[1] : pair[0]
    const x0 = s.sign * p0
    const x1 = s.sign * p1
    if (s.wait) {
      enter(s, x0, x1, jump)
      // Opened at x0 on a falling move: the stop is checked below.
      if (!s.open || x1 >= x0) return
    }
    if (!s.open) return
    if (x1 >= x0) {
      trail(s, x1)
      return
    }
    if (x1 > s.stop) return
    const lvl = jump ? x1 : Math.min(s.stop, x0)
    doClose(s, lvl - slipFrac * Math.abs(lvl), 'stop')
    // The reverse at the same level; the rest of the move is in its favour.
    other.wait = true
    const at = s.sign * lvl
    enter(other, other.sign * at, other.sign * p1, jump)
  }

  const groups = p.single ? [[0, 1]] : [[0], [1]]
  const step = (group: Sub[], p0: number, p1: number, jump: boolean) => {
    if (p.single) segmentOne(group, p0, p1, jump)
    else segment(group[0], group[0].sign * p0, group[0].sign * p1, jump)
  }

  const first = bars[0]
  barT = first.t
  clockMs = first.t * 1000
  setBar(0)
  for (const s of subs) {
    s.trough = s.sign * first.o
    if (p.single && s.sign === -1) continue
    if (!smaLine || s.sign * first.o >= xsCur[s.sign === 1 ? 0 : 1]) doOpen(s, s.sign * first.o + slipFrac * first.o, 'start')
    else if (p.single) s.wait = true
  }

  let prevC = first.o
  let prevT = first.t - 60
  // sendTx: an open is 2 (the market order and its stop), a stop move 1 (a modify); the stop's own close is none.
  const txCount = () => 2 * (subs[0].opens + subs[1].opens) + subs[0].moves + subs[1].moves
  let txPrev = 0
  let txPeak = 0
  for (let i = 0; i < n; i++) {
    const c = bars[i]
    barT = c.t
    clockMs = c.t * 1000 + 30000
    setBar(i)
    const hole = c.t - prevT > 60 || c.gap
    const path = c.c >= c.o ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c]
    // Each group of subs plays the minute on its own: A and B apart in TRAILING, the long and short legs together in UN SEUL.
    for (const g of groups) {
      const run = (group: Sub[], route: number[]) => {
        step(group, prevC, route[0], hole)
        for (let j = 1; j < route.length; j++) step(group, route[j - 1], route[j], false)
      }
      if (ordering === 'pess') {
        // Play both orderings on a copy of the group, keep the one that leaves it poorer at the close.
        const play = (route: number[]) => {
          const copies = g.map((k) => ({ ...subs[k] }))
          const kept = events
          events = []
          run(copies, route)
          const mine = events
          events = kept
          return { copies, mine, eq: copies.reduce((sum, s) => sum + equity(s, s.sign * c.c), 0) }
        }
        const a = play([c.o, c.h, c.l, c.c])
        const b = play([c.o, c.l, c.h, c.c])
        const chosen = a.eq <= b.eq ? a : b
        g.forEach((k, j) => (subs[k] = chosen.copies[j]))
        events.push(...chosen.mine)
      } else {
        run(
          g.map((k) => subs[k]),
          path,
        )
      }
    }
    for (let k = 0; k < 2; k++) {
      const s = subs[k]
      eq[k][i] = equity(s, s.sign * c.c)
      stops[k][i] = s.open ? s.sign * s.stop : null
    }
    const tx = txCount()
    if (tx - txPrev > txPeak) txPeak = tx - txPrev
    txPrev = tx
    prevC = c.c
    prevT = c.t
  }

  const last = bars[n - 1]
  const tEndMs = last.t * 1000 + 60000
  const t0Ms = first.t * 1000
  clockMs = tEndMs
  barT = last.t
  for (const s of subs) {
    if (s.open) doClose(s, s.sign * last.c - slipFrac * last.c, 'end')
  }
  eq[0][n - 1] = subs[0].realized
  eq[1][n - 1] = subs[1].realized
  const eqPair = eq[0].map((v, i) => v + eq[1][i])
  const hours = (tEndMs - t0Ms) / 3.6e6

  const subSummary = (s: Sub, series: number[]): HedgeSubSummary => ({
    pnl: s.realized,
    opens: s.opens,
    closes: s.closes,
    stopMoves: s.moves,
    wins: s.wins,
    losses: s.losses,
    avgWin: s.wins ? s.sumWin / s.wins : 0,
    avgLoss: s.losses ? s.sumLoss / s.losses : 0,
    timeInPct: (s.timeIn / (tEndMs - t0Ms)) * 100,
    maxDrawdown: maxDrawdown(series),
  })
  const A = subSummary(subs[0], eq[0])
  const B = subSummary(subs[1], eq[1])
  const pairPnl = A.pnl + B.pnl
  const summary: HedgeSummary = {
    A,
    B,
    pairPnl,
    pairPnlPct: (pairPnl / hedgeCapital(p)) * 100,
    pairMaxDrawdown: maxDrawdown(eqPair),
    funding: sumFunding(subs[0].fund, subs[1].fund),
    hours,
    opens: A.opens + B.opens,
    stopMovesPerHour: (A.stopMoves + B.stopMoves) / hours,
    ordersPerHour: (2 * (A.opens + B.opens) + A.stopMoves + B.stopMoves) / hours,
    sendTxPerMin: txCount() / (hours * 60),
    sendTxPeakMin: txPeak,
  }

  const times = bars.map((b) => b.t)
  const timesMs = times.map((t) => t * 1000)
  const dA = perDay(timesMs, eq[0])
  const dB = perDay(timesMs, eq[1])
  const dP = perDay(timesMs, eqPair)
  const days = [...dP.keys()].map((day) => ({ day, a: dA.get(day) ?? 0, b: dB.get(day) ?? 0, pair: dP.get(day) ?? 0 }))

  // The references: one sub opened at the first bar and held to the last, same slippage and fees, no rules.
  const hold = (sign: 1 | -1): HedgeHold => {
    const e = sign * first.o + slipFrac * first.o
    const x = sign * last.c - slipFrac * last.c
    const qty = notional / Math.abs(e)
    const series = bars.map((b) => qty * (sign * b.c - e) - fee * notional)
    return { pnl: qty * (x - e) - 2 * fee * notional, maxDrawdown: maxDrawdown(series) }
  }

  return { times, stopA: stops[0], stopB: stops[1], eqA: eq[0], eqB: eq[1], eqPair, events, summary, days, holdA: hold(1), holdB: hold(-1), sma: smaLine, atrEPct: atrLine, medianEPct: p.atrP > 0 ? Array.from(eUsed).sort((x, y) => x - y)[Math.floor(n / 2)] : p.ePct, single: p.single, ms: performance.now() - started }
}

/** The hindsight ceiling of `idealHedge`: its PnL, how many swings it took, and its cumulative PnL at each bar's close. */
export type HedgeIdeal = { pnl: number; swings: number; eq: number[] }

/**
 * IDEAL - impossible in real time: the zigzag of the 1-minute bars at threshold E, every swing taken perfectly.
 * A turning point is the highest (lowest) price of a leg, confirmed once the price has come back E (a fraction of
 * that extreme) from it; the first one is the first of the lowest or highest price since the first bar's open that
 * the price comes back E from. The prices walked are each bar's high and low, in the same order as the central
 * run: low then high when the bar closes at or above its open, high then low otherwise. One position of
 * `notional` $: opened at the first turning point (long at a trough, short at a peak), reversed at each next one
 * (close and open at that price, two fills), and closed at the last leg's extreme (the leg after the last turning
 * point is at least E long, since it confirmed it). Every fill pays `slipPct` of the price against it and `feePct`
 * of its notional. `null` with fewer than 2 bars or E <= 0.
 */
export function idealHedge(bars: HedgeBar[], ePct: number, notional: number, slipPct: number, feePct: number): HedgeIdeal | null {
  if (bars.length < 2 || !(ePct > 0)) return null
  const E = ePct / 100
  const pivots: { i: number; px: number }[] = []
  let dir = 0
  let hi = bars[0].o
  let hiI = 0
  let lo = bars[0].o
  let loI = 0
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    for (const px of b.c >= b.o ? [b.l, b.h] : [b.h, b.l]) {
      if (dir >= 0 && px > hi) {
        hi = px
        hiI = i
      }
      if (dir <= 0 && px < lo) {
        lo = px
        loI = i
      }
      if (dir <= 0 && px >= lo * (1 + E)) {
        pivots.push({ i: loI, px: lo })
        dir = 1
        hi = px
        hiI = i
      } else if (dir >= 0 && px <= hi * (1 - E)) {
        pivots.push({ i: hiI, px: hi })
        dir = -1
        lo = px
        loI = i
      }
    }
  }
  const n = bars.length
  const eq = new Array<number>(n).fill(0)
  if (pivots.length === 0) return { pnl: 0, swings: 0, eq }
  // The last leg ends at its extreme; `dir` is its direction.
  pivots.push(dir === 1 ? { i: hiI, px: hi } : { i: loI, px: lo })
  const slip = slipPct / 100
  const fee = feePct / 100
  let long = pivots[0].px < pivots[1].px
  let realized = 0
  let qty = 0
  let entry = 0
  let side = 0
  let k = 0
  for (let i = 0; i < n; i++) {
    while (k < pivots.length && pivots[k].i === i) {
      const px = pivots[k].px
      if (side !== 0) {
        const fill = px * (1 - side * slip)
        realized += side * qty * (fill - entry) - fee * qty * fill
        side = 0
      }
      if (k < pivots.length - 1) {
        side = long ? 1 : -1
        entry = px * (1 + side * slip)
        qty = notional / entry
        realized -= fee * notional
        long = !long
      }
      k++
    }
    eq[i] = realized + (side !== 0 ? side * qty * (bars[i].c - entry) : 0)
  }
  return { pnl: realized, swings: pivots.length - 1, eq }
}

/** A print as `measureSpread` reads it (`t` in ms, `ask` = the aggressor side flag). */
export type HedgeTick = { t: number; px: number; ask: number }

export type SpreadEstimate = {
  /** Median / p90 of |px difference| between two consecutive prints of opposite side < 5 s apart, in % of the latest price. */
  medianPct: number
  p90Pct: number
  /** How many such pairs the two figures rest on. */
  pairs: number
  printsPerMin: number
  spanHours: number
}

/**
 * The bid/ask gap seen from the tape: a buy print followed within 5 s by a sell
 * print (or the reverse) sits on the two sides of the book, so their price
 * difference is about the spread. Measured on a recorded tape's last 20,000 prints,
 * 2026-09-29: ANTHROPIC 0.004 % median, CASHCAT 0.188 % (p90 0.304 %). `null`
 * when fewer than 20 such pairs exist. `ticks` oldest first.
 */
export function measureSpread(ticks: HedgeTick[]): SpreadEstimate | null {
  if (ticks.length < 2) return null
  return spreadOf(ticks, spreadGaps(ticks, 1).sort())
}

/** How many opposite-side pairs under 5 s `ticks` hold (`measureSpread` needs 20): what a refusal to measure can say. */
export function spreadPairs(ticks: HedgeTick[]): number {
  return ticks.length < 2 ? 0 : spreadGaps(ticks, 1).length
}

/** What reading a market's spread gives: the spread (as the page's tape holds it) or the reason of its absence. */
export type SpreadRead = { spread: { ticks: number; pct: number }; prints: number; pairs: number; fromMs: number; toMs: number } | { spread: null; prints: number; reason: string }

/**
 * A market's median spread as the page measures it: `opportunityTape` (the page's tape, the one `rsiStore` builds by `tapeBuilder`) on these prints, oldest first, at the market's tick; `spreadTicks` and `spreadPct` are what
 * `opportunityFillAt` reads. Nothing is guessed: without 20 opposite-side pairs, or without a print, `spread` is `null` and the reason is said. Shared by `/rsi` and radinus.
 */
export function spreadOfPrints(prints: HedgeTick[], priceDecimals: number): SpreadRead {
  if (prints.length === 0) return { spread: null, prints: 0, reason: 'no print came back (the read failed, or the market has none)' }
  const tape = opportunityTape(prints, 10 ** -priceDecimals)
  const est = measureSpread(prints)
  if (tape.spreadPct === null || est === null) return { spread: null, prints: prints.length, reason: `too few prints to measure the spread: fewer than 20 buy / sell pairs less than 5 s apart in ${prints.length} prints` }
  return { spread: { ticks: tape.spreadTicks, pct: tape.spreadPct }, prints: prints.length, pairs: est.pairs, fromMs: prints[0].t, toMs: prints[prints.length - 1].t }
}

/** |px difference| of each opposite-side pair < 5 s apart whose second print is `from` or later. */
function spreadGaps(ticks: HedgeTick[], from: number): Float64Array {
  const gaps: number[] = []
  for (let i = Math.max(1, from); i < ticks.length; i++) {
    const a = ticks[i - 1]
    const b = ticks[i]
    if (a.ask !== b.ask && b.t - a.t < 5000) gaps.push(Math.abs(b.px - a.px))
  }
  return Float64Array.from(gaps)
}

/**
 * `measureSpread` from its gaps sorted in $, turned into % of the last price only where picked: x / px x 100 is monotone,
 * so the picked values are the ones of sorting the % themselves - which lets `opportunityTapeRun` keep the sorted gaps
 * and merge each minute's in, the price of the last print changing every time.
 */
function spreadOf(ticks: HedgeTick[], sorted: Float64Array): SpreadEstimate | null {
  if (sorted.length < 20) return null
  const last = ticks[ticks.length - 1]
  const pct = (x: number) => (x / last.px) * 100
  const spanMs = last.t - ticks[0].t
  return {
    medianPct: pct(sorted[Math.floor(sorted.length / 2)]),
    p90Pct: pct(sorted[Math.floor(sorted.length * 0.9)]),
    pairs: sorted.length,
    printsPerMin: spanMs > 0 ? (ticks.length - 1) / (spanMs / 60000) : 0,
    spanHours: spanMs / 3.6e6,
  }
}

/** Two ascending arrays as one. */
function mergeSorted(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length)
  let i = 0
  let j = 0
  let o = 0
  while (i < a.length && j < b.length) out[o++] = a[i] <= b[j] ? a[i++] : b[j++]
  while (i < a.length) out[o++] = a[i++]
  while (j < b.length) out[o++] = b[j++]
  return out
}

/** A seeded uniform draw in [0, 1) (32-bit LCG): the random-walk control's, and `/demain`'s simulation (`bookSim.ts`). */
export const lcg = (seed: number) => {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296
}

/** The seeds of the random-walk control (the reference script's 1, 2, 3). */
export const HEDGE_CONTROL_SEEDS = [1, 2, 3]

/**
 * A driftless random walk with the loaded bars' count, first price and per-minute volatility (root mean
 * square of the close-to-close return over consecutive bars). Each minute is 20 Gaussian sub-steps, so it has
 * a high and a low; no trend, no mean reversion, so a profit on it is model bias, not edge. Its minutes are
 * a little narrower than real ones (no bid/ask bounce). Deterministic for a seed.
 */
export function randomWalkBars(bars: HedgeBar[], seed: number): HedgeBar[] {
  let sum = 0
  let count = 0
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t - bars[i - 1].t === 60 && !bars[i].gap) {
      const r = bars[i].c / bars[i - 1].c - 1
      sum += r * r
      count++
    }
  }
  const steps = 20
  const stepSd = (count ? Math.sqrt(sum / count) : 0) / Math.sqrt(steps)
  const rnd = lcg(seed)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
  const out: HedgeBar[] = []
  let prev = bars[0].o
  for (let i = 0; i < bars.length; i++) {
    let px = prev
    let h = px
    let l = px
    for (let j = 0; j < steps; j++) {
      px *= 1 + stepSd * gauss()
      if (px > h) h = px
      if (px < l) l = px
    }
    out.push({ t: bars[0].t + i * 60, o: prev, h, l, c: px, gap: false })
    prev = px
  }
  return out
}

/** Mean of `pairPnl` (a run of the setting under test on one walk, central ordering; `null` counts 0) over `HEDGE_CONTROL_SEEDS` random walks; `null` when the bars are too few. */
export function controlOf(bars: HedgeBar[], pairPnl: (walk: HedgeBar[]) => number | null): number | null {
  if (bars.length < 2) return null
  let sum = 0
  for (const seed of HEDGE_CONTROL_SEEDS) sum += pairPnl(randomWalkBars(bars, seed)) ?? 0
  return sum / HEDGE_CONTROL_SEEDS.length
}

export const controlHedge = (bars: HedgeBar[], p: HedgeParams): number | null => controlOf(bars, (walk) => simulateHedge(walk, p)?.summary.pairPnl ?? null)

export type HedgeVerdict = { level: 'solide' | 'fragile' | 'ne-tient-pas'; reasons: string[] }

export const HEDGE_VERDICT_LABEL = { solide: 'SOLID', fragile: 'FRAGILE', 'ne-tient-pas': 'DOES NOT HOLD' } as const
export const HEDGE_VERDICT_RANK = { solide: 0, fragile: 1, 'ne-tient-pas': 2 } as const

const usdText = (n: number) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)} $`

/**
 * Whether a setting holds. DOES NOT HOLD if the stress PnL <= 0, or the effective E is under 0.1 % (the candle
 * model is optimistic below) or under 3 x the market's median spread; else FRAGILE if the stress PnL is under
 * `solidPct` (% of `capital`, the two subs' margin, the "SOLID margin"), the worst UTC day < 0, the random-walk control earns (> 0), or (recouvrement)
 * a cycle was lost at the last floor (`maxFloorLoss`, the worst such cycle); else SOLID. `eName` names the
 * width in the reasons ('E', 'median E' with ATR, 'Z' in recovery). A figure that is `null` (not computed) fails nothing.
 * OPPORTUNITY has no E: `medianEPct` is `null` and the two E rules are skipped. Every mode: `txCap` makes it DOES NOT HOLD
 * when its peak rolling minute of sendTx passes the cap (60 on a Standard Lighter RH account, per L1 address, `sendTxRate`).
 */
export function hedgeVerdict(f: { stressPnl: number | null; worstDay: number; medianEPct: number | null; eName: string; spreadMedianPct: number | null; controlPnl: number | null; solidPct: number; capital: number; maxFloorLoss: number | null; txCap?: { peakPerMin: number; max: number } }): HedgeVerdict {
  const bad: string[] = []
  const shaky: string[] = []
  if (f.stressPnl !== null && f.stressPnl <= 0) bad.push(`stress ${usdText(f.stressPnl)}`)
  if (f.medianEPct !== null) {
    const e = `${f.eName} ${Number(f.medianEPct.toPrecision(3))} %`
    if (f.medianEPct < 0.1) bad.push(`${e} < 0.1 %`)
    if (f.spreadMedianPct !== null && f.medianEPct < 3 * f.spreadMedianPct) bad.push(`${e} < 3 x spread (${(3 * f.spreadMedianPct).toFixed(3)} %)`)
  }
  if (f.txCap && f.txCap.peakPerMin > f.txCap.max) bad.push(`peak ${f.txCap.peakPerMin} sendTx/min > ${f.txCap.max} (Standard RH, per L1 address)`)
  if (bad.length) return { level: 'ne-tient-pas', reasons: bad }
  const solid = (f.capital * f.solidPct) / 100
  if (f.stressPnl !== null && f.stressPnl < solid) shaky.push(`stress +${f.stressPnl.toFixed(2)} $ < margin ${f.solidPct} % (${solid.toFixed(2)} $)`)
  if (f.worstDay < 0) shaky.push(`worst day ${usdText(f.worstDay)}`)
  if (f.controlPnl !== null && f.controlPnl > 0) shaky.push(`random walk ${usdText(f.controlPnl)} > 0`)
  if (f.maxFloorLoss !== null) shaky.push(`cycle lost at the last floor: ${usdText(f.maxFloorLoss)}`)
  return shaky.length ? { level: 'fragile', reasons: shaky } : { level: 'solide', reasons: [] }
}

/** The unfavourable case: 'pess' ordering inside each minute and slippage = the measured p90 spread instead of the median. */
export const stressHedge = (bars: HedgeBar[], p: HedgeParams, p90Pct: number): HedgeResult | null => simulateHedge(bars, { ...p, slipPct: Math.max(p.slipPct, p90Pct) }, 'pess')

/** The grid of "best E / S": E 0.1 % to 1 % by 0.05 %, then to 5 % by 0.25 % (below 0.1 % the 1-minute candle model is optimistic), S in these fractions of E (0 = never trails). With adaptive E the grid runs on k instead (`HEDGE_GRID_K`). */
export const HEDGE_GRID_S = [0.25, 0.5, 0.75, 1, 0]
export const HEDGE_GRID_E = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, ...Array.from({ length: 16 }, (_, i) => 1.25 + 0.25 * i)]
export const HEDGE_GRID_K = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]

/** `k` is the ATR multiple of the row (adaptive E), `null` when the row is a fixed E. `stressPnl`, `controlPnl` and `verdict` are filled for the rows the BEST search checked. */
export type HedgeGridRow = {
  ePct: number
  k: number | null
  sOverE: number
  pairPnl: number
  stressPnl: number | null
  controlPnl: number | null
  medianEPct: number
  verdict: HedgeVerdict | null
  worstDay: number
  maxDrawdown: number
  ordersPerHour: number
  sendTxPeakMin: number
  /** The IDEAL (`idealHedge`) at this row's E (its median E with ATR), `null` when not computed. */
  idealPnl: number | null
}

/** One grid point reduced to the figures the table shows (`stressPnl` is filled for the ranked rows only). */
export function gridRow(result: HedgeResult, ePct: number, k: number | null, sOverE: number, idealPnl: number | null): HedgeGridRow {
  return {
    ePct,
    k,
    sOverE,
    pairPnl: result.summary.pairPnl,
    stressPnl: null,
    controlPnl: null,
    medianEPct: result.medianEPct,
    verdict: null,
    worstDay: result.days.length ? Math.min(...result.days.map((d) => d.pair)) : 0,
    maxDrawdown: result.summary.pairMaxDrawdown,
    ordersPerHour: result.summary.ordersPerHour,
    sendTxPeakMin: result.summary.sendTxPeakMin,
    idealPnl,
  }
}

/**
 * RECOUVREMENT (zone recovery): same two subs, A long only, B short only. A cycle opens A at market
 * for the base notional x = margin x leverage at P0 (the market price, before slippage); the zone is
 * [P0 (1 - Z), P0]. Floor k >= 1 adds x m^k at the zone bound on its side: odd k = B adds short at the low
 * bound, even k = A adds long at P0; each sub keeps its average entry. When the pair's cycle PnL - realized
 * since the cycle opened plus what closing both at market would realize now, slippage and fee included -
 * reaches G, both close at market (won). A floor past F, or a sub whose position after the add (at the floor
 * price) / leverage exceeds its margin + its realized PnL since the start, closes both at market instead
 * (lost). Every close starts the next cycle at once at that price; the data's end closes the last one.
 * Same bars, orderings, slippage and fee as `simulateHedge`; 'pess' picks, per minute, the order of high and
 * low that leaves the pair's equity lowest at the close.
 */
export type RecoveryParams = {
  /** Z, zone width in % of P0. */
  zPct: number
  /** m, the size multiplier per floor. */
  mult: number
  /** G, the cycle's goal in $. */
  goal: number
  /** F, the highest floor allowed. */
  floors: number
  leverage: number
  /** Margin per sub, in $. */
  margin: number
  /** x, the base notional of floor 0 in $ (floor k adds x m^k) - set apart from the margin. */
  notional: number
  feePct: number
  slipPct: number
  /** The hourly funding rows, as `HedgeParams.funding`: each leg pays the hour marks crossed at the size it held, settled whenever that size changes or the cycle closes. Absent, none. */
  funding?: FundingHours | null
}

/**
 * How many floors a margin allows: the highest k such that, for every floor up to k, the adding sub's cumulative
 * notional / leverage stays within its margin (A holds floors 0, 2, 4...: x (1 + m^2 + m^4...); B holds 1, 3, 5...:
 * x (m + m^3...)), and the margin each sub then needs. `n` = -1 when even floor 0 does not fit.
 */
export function recoveryFloorsPossible(p: Pick<RecoveryParams, 'mult' | 'leverage' | 'margin' | 'notional'>): { n: number; marginA: number; marginB: number } {
  let n = -1
  let cumA = 0
  let cumB = 0
  let marginA = 0
  let marginB = 0
  for (let k = 0; k < 200; k++) {
    const size = p.notional * p.mult ** k
    if (k % 2 === 0) cumA += size
    else cumB += size
    if ((k % 2 === 0 ? cumA : cumB) / p.leverage > p.margin) break
    n = k
    marginA = cumA / p.leverage
    marginB = cumB / p.leverage
  }
  return { n, marginA, marginB }
}

export type RecoveryOutcome = 'won' | 'lost-floors' | 'lost-margin' | 'end'
export type RecoveryEvent = { t: number; kind: 'floor'; sub: HedgeSubId; floor: number; price: number } | { t: number; kind: 'close'; outcome: RecoveryOutcome; price: number }
/** `floor` = the highest floor the cycle reached; `pnl` = both subs' realized PnL over the cycle, costs included. */
export type RecoveryCycle = { tStart: number; tEnd: number; floor: number; pnl: number; outcome: RecoveryOutcome }

export type RecoverySummary = {
  /** Cycles that ended on the goal or a loss; the one the data's end cut is `endCycle`. */
  cycles: number
  won: number
  lostFloors: number
  lostMargin: number
  endCycle: RecoveryCycle | null
  /** The worst ended cycle (won or lost), `null` when none ended. */
  worstCycle: number | null
  /** The worst cycle lost at the last floor, `null` when none was. */
  maxFloorLoss: number | null
  /** `floorHits[k]` = ended cycles whose highest floor was k (0..F). */
  floorHits: number[]
  maxFloor: number
  /** Largest notional held at once (both subs, at the fill's level), and margin = notional / leverage, both subs and each. */
  maxNotional: number
  maxMargin: number
  maxMarginA: number
  maxMarginB: number
  pnlA: number
  pnlB: number
  /** Includes `funding.paid` when the funding is on. */
  pairPnl: number
  pairMaxDrawdown: number
  /** The funding of both legs over the run (`paid` is already in `pnlA`, `pnlB`, `pairPnl` and the cycles' PnL); zeros when the funding is off. */
  funding: FundingFigure
  hours: number
  /** sendTx (`sendTxRate`): a floor is 1 market order, a cycle's close 1 per sub it holds; average per minute and the busiest minute bar. */
  sendTxPerMin: number
  sendTxPeakMin: number
}

export type RecoveryResult = {
  times: number[]
  eqA: number[]
  eqB: number[]
  eqPair: number[]
  /** The current cycle's zone bounds at each bar's end (P0 and P0 (1 - Z)); `null` while no cycle is open. */
  zoneHi: (number | null)[]
  zoneLo: (number | null)[]
  events: RecoveryEvent[]
  cycles: RecoveryCycle[]
  summary: RecoverySummary
  days: HedgeDay[]
  ms: number
}

/** `side`: 1 = A (long), -1 = B (short); `since`: ms up to which the leg's funding is settled. */
type RLeg = { side: 1 | -1; qty: number; entry: number; realized: number; since: number }
type RState = {
  A: RLeg
  B: RLeg
  p0: number
  lo: number
  floor: number
  /** A + B realized when the cycle opened (before its first fee). */
  base: number
  tStart: number
  floorHits: number[]
  maxNotional: number
  maxMargin: number
  maxMarginA: number
  maxMarginB: number
  ev: RecoveryEvent[]
  cy: RecoveryCycle[]
  fund: FundingFigure
}

export function simulateRecovery(bars: HedgeBar[], p: RecoveryParams, ordering: 'central' | 'pess' = 'central'): RecoveryResult | null {
  const started = performance.now()
  if (bars.length < 2 || p.zPct <= 0 || p.goal <= 0 || p.mult <= 0 || p.floors < 0) return null
  const Z = p.zPct / 100
  const f = p.feePct / 100
  const sl = p.slipPct / 100
  const x = p.notional
  let barT = bars[0].t
  let clockMs = bars[0].t * 1000
  // A leg's funding up to now at the size it held, into its realized PnL; called before that size changes and when the cycle closes.
  const settle = (st: RState, leg: RLeg) => {
    if (p.funding && leg.qty > 0) {
      const g = fundingPaid(leg.side, leg.qty, leg.since, clockMs, p.funding)
      leg.realized += g.paid
      st.fund = { paid: st.fund.paid + g.paid, hours: st.fund.hours + g.hours, missing: st.fund.missing + g.missing }
    }
    leg.since = clockMs
  }

  const measure = (st: RState, px: number) => {
    const a = st.A.qty * px
    const b = st.B.qty * px
    st.maxNotional = Math.max(st.maxNotional, a + b)
    st.maxMargin = Math.max(st.maxMargin, (a + b) / p.leverage)
    st.maxMarginA = Math.max(st.maxMarginA, a / p.leverage)
    st.maxMarginB = Math.max(st.maxMarginB, b / p.leverage)
  }
  // A buys and B covers at level (1 + slip); A sells and B shorts at level (1 - slip); a fee of f on each fill's notional.
  const add = (st: RState, leg: RLeg, notional: number, fill: number) => {
    settle(st, leg)
    const q = notional / fill
    leg.entry = (leg.qty * leg.entry + q * fill) / (leg.qty + q)
    leg.qty += q
    leg.realized -= f * q * fill
  }
  const open = (st: RState, level: number) => {
    st.base = st.A.realized + st.B.realized
    st.p0 = level
    st.lo = level * (1 - Z)
    st.floor = 0
    st.tStart = barT
    add(st, st.A, x, level * (1 + sl))
    measure(st, level)
    st.ev.push({ t: barT, kind: 'floor', sub: 'A', floor: 0, price: level })
  }
  const close = (st: RState, level: number, outcome: RecoveryOutcome) => {
    const fa = level * (1 - sl)
    const fb = level * (1 + sl)
    settle(st, st.A)
    settle(st, st.B)
    st.A.realized += st.A.qty * (fa - st.A.entry) - f * st.A.qty * fa
    st.B.realized += st.B.qty * (st.B.entry - fb) - f * st.B.qty * fb
    st.A.qty = 0
    st.B.qty = 0
    st.cy.push({ tStart: st.tStart, tEnd: barT, floor: st.floor, pnl: st.A.realized + st.B.realized - st.base, outcome })
    if (outcome !== 'end') st.floorHits[st.floor]++
    st.ev.push({ t: barT, kind: 'close', outcome, price: level })
  }
  // The cycle's PnL if both closed at `px` now: linear in px, k1 px + k0.
  const k1 = (st: RState) => st.A.qty * (1 - sl) * (1 - f) - st.B.qty * (1 + sl) * (1 + f)
  const k0 = (st: RState) => st.A.realized + st.B.realized - st.base - st.A.qty * st.A.entry + st.B.qty * st.B.entry
  const net = (st: RState, px: number) => k1(st) * px + k0(st)
  // Floor k at `level`: past F or short of margin, the cycle is lost and the next opens there.
  const floorAt = (st: RState, level: number) => {
    const k = st.floor + 1
    if (k > p.floors) {
      close(st, level, 'lost-floors')
      open(st, level)
      return
    }
    const short = k % 2 === 1
    const leg = short ? st.B : st.A
    const notional = x * p.mult ** k
    const fill = level * (short ? 1 - sl : 1 + sl)
    if (((leg.qty + notional / fill) * level) / p.leverage > p.margin + leg.realized) {
      close(st, level, 'lost-margin')
      open(st, level)
      return
    }
    add(st, leg, notional, fill)
    st.floor = k
    measure(st, level)
    st.ev.push({ t: barT, kind: 'floor', sub: short ? 'B' : 'A', floor: k, price: level })
  }
  // One monotone move x0 -> x1 (`jump` = a data hole: everything happens at x1). The goal and the next floor are
  // levels on the path; the nearer one fires first (the goal on a tie), then the rest of the move is replayed.
  const segment = (st: RState, x0: number, x1: number, jump: boolean) => {
    let px = jump ? x1 : x0
    for (let guard = 0; guard < 64; guard++) {
      const up = x1 >= px
      let goal: number | null = null
      if (net(st, px) >= p.goal) goal = px
      else if (net(st, x1) >= p.goal) {
        const c = k1(st)
        const at = c !== 0 ? (p.goal - k0(st)) / c : x1
        goal = up ? Math.min(Math.max(at, px), x1) : Math.max(Math.min(at, px), x1)
      }
      const short = (st.floor + 1) % 2 === 1
      let floor: number | null = null
      if (short) {
        if (px <= st.lo) floor = px
        else if (x1 <= st.lo) floor = st.lo
      } else {
        if (px >= st.p0) floor = px
        else if (x1 >= st.p0) floor = st.p0
      }
      if (goal === null && floor === null) return
      if (goal !== null && (floor === null || Math.abs(goal - px) <= Math.abs(floor - px))) {
        close(st, goal, 'won')
        open(st, goal)
        px = goal
      } else if (floor !== null) {
        floorAt(st, floor)
        px = floor
      }
    }
  }
  const eqOf = (st: RState, c: number) => ({ a: st.A.realized + st.A.qty * (c - st.A.entry), b: st.B.realized + st.B.qty * (st.B.entry - c) })
  const clone = (st: RState): RState => ({ ...st, A: { ...st.A }, B: { ...st.B }, floorHits: st.floorHits.slice(), ev: [], cy: [] })

  const n = bars.length
  let st: RState = { A: { side: 1, qty: 0, entry: 0, realized: 0, since: 0 }, B: { side: -1, qty: 0, entry: 0, realized: 0, since: 0 }, p0: 0, lo: 0, floor: 0, base: 0, tStart: barT, floorHits: new Array<number>(Math.floor(p.floors) + 1).fill(0), maxNotional: 0, maxMargin: 0, maxMarginA: 0, maxMarginB: 0, ev: [], cy: [], fund: { paid: 0, hours: 0, missing: 0 } }
  const events: RecoveryEvent[] = []
  const cycles: RecoveryCycle[] = []
  const eqA = new Array<number>(n)
  const eqB = new Array<number>(n)
  const zoneHi = new Array<number | null>(n).fill(null)
  const zoneLo = new Array<number | null>(n).fill(null)
  open(st, bars[0].o)
  let prevC = bars[0].o
  let prevT = bars[0].t - 60
  for (let i = 0; i < n; i++) {
    const c = bars[i]
    barT = c.t
    clockMs = c.t * 1000 + 30000
    const hole = c.t - prevT > 60 || c.gap
    const play = (s: RState, route: number[]) => {
      segment(s, prevC, route[0], hole)
      for (let j = 1; j < route.length; j++) segment(s, route[j - 1], route[j], false)
      return s
    }
    if (ordering === 'pess') {
      const a = play(clone(st), [c.o, c.h, c.l, c.c])
      const b = play(clone(st), [c.o, c.l, c.h, c.c])
      const sum = (s: RState) => {
        const e = eqOf(s, c.c)
        return e.a + e.b
      }
      const chosen = sum(a) <= sum(b) ? a : b
      events.push(...st.ev, ...chosen.ev)
      cycles.push(...st.cy, ...chosen.cy)
      st = chosen
    } else {
      play(st, c.c >= c.o ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c])
      events.push(...st.ev)
      cycles.push(...st.cy)
    }
    st.ev = []
    st.cy = []
    const e = eqOf(st, c.c)
    eqA[i] = e.a
    eqB[i] = e.b
    zoneHi[i] = st.p0
    zoneLo[i] = st.lo
    prevC = c.c
    prevT = c.t
  }
  const last = bars[n - 1]
  barT = last.t
  clockMs = (last.t + 60) * 1000
  close(st, last.c, 'end')
  events.push(...st.ev)
  cycles.push(...st.cy)
  eqA[n - 1] = st.A.realized
  eqB[n - 1] = st.B.realized
  const eqPair = eqA.map((v, i) => v + eqB[i])

  const ended = cycles.filter((c) => c.outcome !== 'end')
  const lostAtTop = ended.filter((c) => c.outcome === 'lost-floors')
  const times = bars.map((b) => b.t)
  const timesMs = times.map((t) => t * 1000)
  const dA = perDay(timesMs, eqA)
  const dB = perDay(timesMs, eqB)
  const dP = perDay(timesMs, eqPair)
  // sendTx stamped at the event's minute, so the rolling minute is the minute bar; the data's end is not an order.
  const txTimes: number[] = []
  const held = new Set<HedgeSubId>()
  for (const e of events) {
    if (e.kind === 'floor') {
      held.add(e.sub)
      txTimes.push(e.t * 1000)
      continue
    }
    if (e.outcome !== 'end') for (let k = 0; k < held.size; k++) txTimes.push(e.t * 1000)
    held.clear()
  }
  const tx = sendTxRate(txTimes, (last.t + 60 - bars[0].t) * 1000)
  const summary: RecoverySummary = {
    cycles: ended.length,
    won: ended.filter((c) => c.outcome === 'won').length,
    lostFloors: lostAtTop.length,
    lostMargin: ended.filter((c) => c.outcome === 'lost-margin').length,
    endCycle: cycles.find((c) => c.outcome === 'end') ?? null,
    worstCycle: ended.length ? Math.min(...ended.map((c) => c.pnl)) : null,
    maxFloorLoss: lostAtTop.length ? Math.min(...lostAtTop.map((c) => c.pnl)) : null,
    floorHits: st.floorHits,
    maxFloor: cycles.length ? Math.max(...cycles.map((c) => c.floor)) : 0,
    maxNotional: st.maxNotional,
    maxMargin: st.maxMargin,
    maxMarginA: st.maxMarginA,
    maxMarginB: st.maxMarginB,
    pnlA: st.A.realized,
    pnlB: st.B.realized,
    pairPnl: st.A.realized + st.B.realized,
    pairMaxDrawdown: maxDrawdown(eqPair),
    funding: st.fund,
    hours: (last.t + 60 - bars[0].t) / 3600,
    sendTxPerMin: tx.perMin,
    sendTxPeakMin: tx.peakMin,
  }
  const days = [...dP.keys()].map((day) => ({ day, a: dA.get(day) ?? 0, b: dB.get(day) ?? 0, pair: dP.get(day) ?? 0 }))
  return { times, eqA, eqB, eqPair, zoneHi, zoneLo, events, cycles, summary, days, ms: performance.now() - started }
}

/** The unfavourable case of a recouvrement setting, as `stressHedge`: 'pess' ordering and the p90 spread as slippage. */
export const stressRecovery = (bars: HedgeBar[], p: RecoveryParams, p90Pct: number): RecoveryResult | null => simulateRecovery(bars, { ...p, slipPct: Math.max(p.slipPct, p90Pct) }, 'pess')

export const controlRecovery = (bars: HedgeBar[], p: RecoveryParams): number | null => controlOf(bars, (walk) => simulateRecovery(walk, p)?.summary.pairPnl ?? null)

/** BEST in recouvrement: Z (%), m and G ($) on these values, F as set - 8 x 4 x 4 = 128 runs. */
export const RECOVERY_GRID_Z = [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2]
export const RECOVERY_GRID_M = [1.2, 1.4, 1.6, 2]
export const RECOVERY_GRID_G = [0.25, 0.5, 1, 2]

export type RecoveryGridRow = {
  zPct: number
  mult: number
  goal: number
  pairPnl: number
  stressPnl: number | null
  controlPnl: number | null
  verdict: HedgeVerdict | null
  worstDay: number
  worstCycle: number | null
  maxFloor: number
  maxFloorLoss: number | null
  sendTxPeakMin: number
  /** The IDEAL (`idealHedge`) at this row's Z on the base notional, `null` when not computed. */
  idealPnl: number | null
}

export function recoveryGridRow(result: RecoveryResult, zPct: number, mult: number, goal: number, idealPnl: number | null): RecoveryGridRow {
  const s = result.summary
  return { idealPnl, zPct, mult, goal, pairPnl: s.pairPnl, stressPnl: null, controlPnl: null, verdict: null, worstDay: result.days.length ? Math.min(...result.days.map((d) => d.pair)) : 0, worstCycle: s.worstCycle, maxFloor: s.maxFloor, maxFloorLoss: s.maxFloorLoss, sendTxPeakMin: s.sendTxPeakMin }
}

/**
 * OPPORTUNITY (author 2026-09-30): A longs only, B shorts only, each on its own, every order at market,
 * replayed on recorded prints (not candles). Prices are counted in the market's tick (10^-supportedPriceDecimals).
 * - Flat: the sub sends its market order at once (A buys, B sells).
 * - Stop, in ticks in the sub's signed space (B = A on -price): max(entry - init, peak - max(gap, (1 - lock) x
 *   (peak - entry))), `opportunityStopTicks`, with init = the tape's median spread + 1 tick (the seed rule, below) and gap = gapPct of the entry fill's price (author,
 *   2026-09-30: a tick-sized gap sits inside CASHCAT's ~30-tick spread and is 1/500 of ANTHROPIC's visible moves); a print
 *   strictly below it (above it for B) sends the market close. The peak is the best print since the entry fill (every
 *   print, either side; with a clock, every decision print).
 * - `exclusion` (author, 2026-09-30, the LIVE chart showing A re-buying through falls while B held a winning short): a
 *   flat sub sends no open, first or re-entry, while the other sub holds a position in profit at the deciding print
 *   (its signed price above its entry fill, fees not counted); it may once the other is flat or at or under its entry.
 * - After a close has filled, the sub sends its next open once the pause and the confirmation allow it (by default at
 *   once, decided on the first print after the close's fill).
 * Four settings slow it down (author, 2026-09-30, "it is too fast"), each at the first version's behaviour by default:
 * - `clockSec` (0 = every print): the rules (stop check, trailing update, entry) run only on the last print of each
 *   clockSec-second UTC slot, and the decision is dated at the slot's end (a print is known to be a slot's last only
 *   once the slot is over); the prints in between are seen by the fills only.
 * - `pauseSec` (0): no new entry for a sub until pauseSec seconds after its close fill.
 * - `confirmTicks` (0): after a close, the sub enters only once a decision print is confirmTicks ticks in its direction
 *   from its lowest (A) / highest (B) decision print since the close, the close fill's own price included.
 * SMA reinforcement (`smaN` > 0, author 2026-09-30: "SMA for the trend (reinforcement), but not for [the entry]"):
 * entries are not filtered. On each decision print, a sub WITH the trend (A while the print is above the SMA, B while
 * below; `smaSeries` of the N 1-minute bars before the print's minute, so completed minutes only) trails at gap x smaK
 * instead of gap. The stop never moves back: the new stop is max(the stop so far, the formula), so a wider gap only
 * delays later raises. Every raise of the stop is sent at once and is one sendTx.
 * Fills (author, 2026-09-30: a market order fills at once against the book, it does not wait for a print): an order
 * decided at time t fills at t + latency, at an estimate from the prints known then (time <= t + latency): a buy at
 * the last print on the ask (`ask` = 1), a sell at the last print on the bid (`ask` = 0); if that print is older than
 * 60 s at the fill (or there is none), at the last print of either side + the tape's median spread for a buy, - for a
 * sell (in ticks, unrounded, as the seed rule). Stress (`stressOpportunity`): the worse of the two for the order. The
 * fill is dated t + latency and marked on the last print at or before it; the first print after it runs the rules.
 * A print's size is not checked against the order's. Fee `feePct` of each fill's notional. The stop resting on Lighter (machine outage
 * only) is not simulated. At the data's end an open position is closed at the last print; an unfilled open is dropped.
 */
export type OpportunityParams = {
  /** The share of the gain the trailing stop keeps, a fraction (the page shows it in %). */
  lock: number
  gapPct: number
  exclusion: boolean
  leverage: number
  /** Margin per sub, in $; notional per open = margin x leverage, capital = 2 x margin. */
  margin: number
  feePct: number
  latencyMs: number
  clockSec: number
  pauseSec: number
  confirmTicks: number
  /** SMA reinforcement: N 1-minute bars, `0` = off; `smaK` multiplies the gap while the sub is with the trend. */
  smaN: number
  smaK: number
  /** The hourly funding rows, as `HedgeParams.funding`: a position pays the hour marks between its entry fill and its exit fill (ms), booked at the close. Absent, none. */
  funding?: FundingHours | null
}

/** The prints as the engine reads them: times (ms), prices in whole ticks, the aggressor flag; and 1-minute bars built from them for the chart and the per-day table. */
export type OpportunityTape = {
  t: Float64Array
  k: Float64Array
  ask: Uint8Array
  tick: number
  bars: HedgeBar[]
  /** Index into `bars` of each print's minute. */
  barOf: Int32Array
  /** The random-walk control's inputs, from the real prints: RMS change between consecutive same-side prints (bid/ask bounce cancels), and the median spread in ticks (`measureSpread`). */
  sigmaTicks: number
  spreadTicks: number
  /** The same median spread in % of the last price, `null` when too few opposite-side pairs exist to measure it; the IDEAL's floor. */
  spreadPct: number | null
}

/** The tape's bars from print `from` on, continuing `prev`'s (its last bar copied before it can grow). */
function buildTape(t: Float64Array, k: Float64Array, ask: Uint8Array, tick: number, prev: OpportunityTape | null = null, from = 0): Omit<OpportunityTape, 'sigmaTicks' | 'spreadTicks' | 'spreadPct'> {
  const scale = Math.round(1 / tick)
  const n = t.length
  const bars: HedgeBar[] = prev?.bars.slice() ?? []
  const barOf = new Int32Array(n)
  if (prev !== null) barOf.set(prev.barOf)
  let cur: HedgeBar | null = bars.length > 0 ? { ...bars[bars.length - 1] } : null
  if (cur !== null) bars[bars.length - 1] = cur
  for (let i = from; i < n; i++) {
    const m = Math.floor(t[i] / 60000) * 60
    const px = k[i] / scale
    if (cur === null || cur.t !== m) {
      cur = { t: m, o: px, h: px, l: px, c: px, gap: false }
      bars.push(cur)
    } else {
      if (px > cur.h) cur.h = px
      if (px < cur.l) cur.l = px
      cur.c = px
    }
    barOf[i] = bars.length - 1
  }
  return { t, k, ask, tick, bars, barOf }
}

/** The loaded prints (oldest first) as a tape at `tick` $ a tick (a power of ten: prices are whole ticks divided by 1 / tick, so 20801 / 10 prints 2080.1, not 2080.1000000000001). */
export function opportunityTape(prints: HedgeTick[], tick: number): OpportunityTape {
  return opportunityTapeRun(prints, tick, null).tape
}

/** `opportunityTapeRun` holding its last result and continuing it on the next call (`useOpportunityTape`, one per mount). */
export function tapeBuilder(): (prints: HedgeTick[], tick: number, spread?: { ticks: number; pct: number } | null) => OpportunityTape {
  let last: TapeRun | null = null
  return (prints, tick, spread = null) => {
    const { tape } = (last = opportunityTapeRun(prints, tick, last))
    // `spread` = a spread measured elsewhere (the data module's last prints), taken only when these prints measured none; the run held keeps its own tape, so the continuation is unchanged.
    return spread !== null && tape.spreadPct === null ? { ...tape, spreadTicks: spread.ticks, spreadPct: spread.pct } : tape
  }
}

/** `opportunityTape` and what extending it takes: the prints it was built from, the running sum of same-side moves, the spread's gaps sorted ($). */
export type TapeRun = { prints: HedgeTick[]; tape: OpportunityTape; sum: number; count: number; gaps: Float64Array }

/**
 * `opportunityTape`, continued from `prev` when `prints` only adds to its prints (same tick, `prev.prints` a prefix by
 * identity): the arrays copied, the loops run on the new prints only, the spread's gaps merged - the same tape bit for bit
 * (`research/lean/timing.ts`). Built from scratch otherwise. 711,000 prints: ~135 ms in full (2026-10-03).
 */
export function opportunityTapeRun(prints: HedgeTick[], tick: number, prev: TapeRun | null): TapeRun {
  const p = prev !== null && prev.tape.tick === tick && prev.prints.length > 0 && prev.prints.length <= prints.length && prev.prints.every((x, i) => prints[i] === x) ? prev : null
  const from = p?.prints.length ?? 0
  const n = prints.length
  const t = new Float64Array(n)
  const k = new Float64Array(n)
  const ask = new Uint8Array(n)
  if (p !== null) {
    t.set(p.tape.t)
    k.set(p.tape.k)
    ask.set(p.tape.ask)
  }
  for (let i = from; i < n; i++) {
    t[i] = prints[i].t
    k[i] = Math.round(prints[i].px / tick)
    ask[i] = prints[i].ask ? 1 : 0
  }
  let sum = p?.sum ?? 0
  let count = p?.count ?? 0
  for (let i = Math.max(1, from); i < n; i++) {
    if (ask[i] === ask[i - 1]) {
      const d = k[i] - k[i - 1]
      sum += d * d
      count++
    }
  }
  const added = spreadGaps(prints, from).sort()
  const gaps = p === null ? added : mergeSorted(p.gaps, added)
  const spread = n < 2 ? null : spreadOf(prints, gaps)
  const tape = { ...buildTape(t, k, ask, tick, p?.tape ?? null, from), sigmaTicks: count ? Math.sqrt(sum / count) : 0, spreadTicks: spread !== null && n ? ((spread.medianPct / 100) * prints[n - 1].px) / tick : 1, spreadPct: spread?.medianPct ?? null }
  return { prints, tape, sum, count, gaps }
}

/**
 * The take-off rule - it is OPPORTUNITY's definition (author, 2026-09-30): negative before take-off (measured at the market's middle) = immediate close. Never make it optional, never remove it.
 * The seed stop sits initTicks behind the entry; the engine passes 0: at the price paid - the position is cut as soon as the price passes under the price paid (author, 2026-09-30).
 * The stop in ticks, signed space: max(entry - initTicks, peak - max(minGap, (1 - lock) x (peak - entry))); the trailing gap is rounded to 1e-9 tick so 0.2 x 15 is 3, not 2.9999999999999996. */
export function opportunityStopTicks(entry: number, peak: number, lock: number, minGapTicks: number, initTicks: number): number {
  const gap = Math.max(minGapTicks, Math.round((1 - lock) * (peak - entry) * 1e9) / 1e9)
  return Math.max(entry - initTicks, peak - gap)
}

/** Per print, for the LIVE chart: each sub's stop in $ after the print (NaN while flat) and its equity at the print. */
export type OpportunityTrace = { eqA: Float64Array; eqB: Float64Array }

/** `eventPrints[e]` = the tape index of the print that filled `events[e]`; `trace` only when asked (the chart's run). */
export type OpportunityResult = HedgeResult & { prints: number; tape: OpportunityTape; latencyMs: number; stress: boolean; eventPrints: number[]; trace: OpportunityTrace | null }

type OSub = Sub & { pend: 0 | 1 | 2; due: number; need: number; entryK: number; gapK: number; closedAt: number; low: number; ideal: number }

/**
 * OPPORTUNITY's market-order fill in ticks (the rule above): an order on side `need` (1 = buy) filling at `at` ms, `e` = the
 * last print at or before `at`, `same` = the last print on side `need` at or before `e` (-1 = none).
 */
export function marketFillK(K: Float64Array, T: Float64Array, spreadK: number, need: number, e: number, same: number, at: number, stress: boolean): number {
  const any = K[e] + (need === 1 ? spreadK : -spreadK)
  if (same < 0) return any
  if (stress) return need === 1 ? Math.max(K[same], any) : Math.min(K[same], any)
  return at - T[same] > 60000 ? any : K[same]
}

/** What `opportunityFillAt` reads of a tape: the prints and the spread (a search is given these, not the minute bars). */
export type FillTape = Pick<OpportunityTape, 't' | 'k' | 'ask' | 'tick' | 'spreadTicks' | 'spreadPct'>

/** The same fill for an order decided off the print loop: located by binary search. Price in $, `null` before the first print. */
export function opportunityFillAt(tape: FillTape, need: 0 | 1, atMs: number): number | null {
  const { t: T, k: K, ask: ASK } = tape
  let lo = 0
  let hi = T.length - 1
  if (hi < 0 || T[0] > atMs) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (T[mid] <= atMs) lo = mid
    else hi = mid - 1
  }
  let same = lo
  while (same >= 0 && ASK[same] !== need) same--
  const spreadK = tape.spreadPct !== null ? tape.spreadTicks : 0
  return marketFillK(K, T, spreadK, need, lo, same, atMs, false) / Math.round(1 / tape.tick)
}

/** `stress` = fill every order at the worse of the two estimates (`stressOpportunity`). `trace` = also record every print's stops and equity. */
export function simulateOpportunity(tape: OpportunityTape, p: OpportunityParams, stress = false, trace = false): OpportunityResult | null {
  const started = performance.now()
  const n = tape.t.length
  if (n < 2) return null
  const { t: T, k: K, ask: ASK, tick, bars, barOf } = tape
  const scale = Math.round(1 / tick)
  const fee = p.feePct / 100
  const notional = p.margin * p.leverage
  const lat = p.latencyMs
  // The take-off rule - it is OPPORTUNITY's definition (author, 2026-09-30): negative before take-off (measured at the market's middle) = immediate close. Never make it optional, never remove it.
  // Seed stop = the entry price paid, exactly: on the first print strictly under it (A; mirrored for B) the sub closes at market - at the price paid, cut as soon as the price passes under the price paid (author, 2026-09-30).
  const seedTicks = 0
  const subs: OSub[] = [
    { ...newSub('A', 1), pend: 0, due: 0, need: 0, entryK: 0, gapK: 0, closedAt: 0, low: 0, ideal: 0 },
    { ...newSub('B', -1), pend: 0, due: 0, need: 0, entryK: 0, gapK: 0, closedAt: 0, low: 0, ideal: 0 },
  ]
  const clockMs = p.clockSec * 1000
  const smaLine = p.smaN > 0 ? smaSeries(bars, p.smaN) : null
  const pauseMs = p.pauseSec * 1000
  const tr: OpportunityTrace | null = trace ? { eqA: new Float64Array(n), eqB: new Float64Array(n) } : null
  const eventPrints: number[] = []
  // sendTx times: every market order when sent, every stop move (a modify of the stop resting on Lighter).
  const txTimes: number[] = []
  const nb = bars.length
  const eq = [new Array<number>(nb), new Array<number>(nb)]
  const stops: (number | null)[][] = [new Array<number | null>(nb).fill(null), new Array<number | null>(nb).fill(null)]
  const events: HedgeEvent[] = []
  // A buys to open and sells to close; B the reverse. A buy fills at the ask side's last print (ask = 1).
  const send = (s: OSub, opening: boolean, now: number) => {
    s.pend = opening ? 1 : 2
    txTimes.push(now)
    s.due = now + lat
    s.need = opening === (s.sign === 1) ? 1 : 0
  }
  // The median spread in ticks (0 when it cannot be measured); `lastOf[side]` = the last print on that side before the current one (-1 = none yet).
  const spreadK = tape.spreadPct !== null ? tape.spreadTicks : 0
  const lastOf = [-1, -1]
  // The fill price in ticks of an order on side `need` filling at `at`, from the prints up to `e` (all known at `at`).
  const fillK = (need: number, e: number, at: number): number => marketFillK(K, T, spreadK, need, e, ASK[e] === need ? e : lastOf[need], at, stress)
  const open = (s: OSub, i: number, k: number, at: number) => {
    const px = k / scale
    s.open = true
    s.pend = 0
    s.entry = s.sign * px
    s.entryK = s.sign * k
    s.peak = s.entryK
    s.gapK = (p.gapPct / 100) * k
    s.stop = s.entryK - seedTicks
    s.ideal = s.stop
    s.qty = notional / px
    s.tradeFee = fee * notional
    s.realized -= s.tradeFee
    s.opens++
    s.openSince = at
    events.push({ t: bars[barOf[i]].t, sub: s.id, kind: 'open', reason: s.opens === 1 ? 'start' : 'reopen', price: px })
    eventPrints.push(i)
  }
  const close = (s: OSub, i: number, k: number, at: number, reason: HedgeEvent['reason']) => {
    const px = k / scale
    const feeOut = fee * s.qty * px
    const priced = s.qty * (s.sign * px - s.entry) - feeOut
    const pnl = p.funding ? priced + bookFunding(s, p.funding, at) : priced
    s.realized += pnl
    const net = pnl - s.tradeFee
    if (net > 0) {
      s.wins++
      s.sumWin += net
    } else {
      s.losses++
      s.sumLoss += net
    }
    s.open = false
    s.pend = 0
    s.closes++
    s.timeIn += at - s.openSince
    s.closedAt = at
    s.low = s.sign * k
    events.push({ t: bars[barOf[i]].t, sub: s.id, kind: 'close', reason, price: px })
    eventPrints.push(i)
  }
  const mark = (b: number, i: number) => {
    for (let j = 0; j < 2; j++) {
      const s = subs[j]
      eq[j][b] = equity(s, s.sign * K[i] / scale)
      stops[j][b] = s.open ? s.sign * (s.stop / scale) : null
    }
  }

  const record = (i: number) => {
    if (!tr) return
    const a = subs[0]
    const b = subs[1]
    tr.eqA[i] = equity(a, K[i] / scale)
    tr.eqB[i] = equity(b, -K[i] / scale)
  }

  for (const s of subs) send(s, true, T[0])
  lastOf[ASK[0]] = 0
  record(0)
  for (let i = 1; i < n; i++) {
    if (barOf[i] !== barOf[i - 1]) mark(barOf[i - 1], i - 1)
    const t = T[i]
    // With a clock, only a slot's last print runs the rules, and the decision is dated at the slot's end.
    const slot = clockMs > 0 ? Math.floor(t / clockMs) : 0
    const decide = clockMs <= 0 || i === n - 1 || Math.floor(T[i + 1] / clockMs) !== slot
    const now = clockMs > 0 ? (slot + 1) * clockMs : t
    // Fills first, both subs: an order due by this print filled before it, so the rules below see both positions as they are.
    for (const s of subs) {
      if (s.pend === 0 || t < s.due) continue
      // Filled at due, from the prints known then: this one only if it is exactly at due. The rules then run on this print.
      const e = t === s.due ? i : i - 1
      const k = fillK(s.need, e, s.due)
      if (s.pend === 1) open(s, e, k, s.due)
      else close(s, e, k, s.due, 'stop')
    }
    for (let j = 0; j < 2; j++) {
      const s = subs[j]
      const x = s.sign * K[i]
      if (s.pend !== 0 || !decide) continue
      if (!s.open) {
        if (x < s.low) s.low = x
        const other = subs[1 - j]
        // The other sub counts as winning while the market's mid is past its entry (as in the seed rule): a print on the wrong side of the book sits a spread away (CASHCAT, 707 of 794 A opens fell while B held a short when judged on the raw print).
        // `>=`, the seed stop's exact complement (it closes on `<`): a print right at the other sub's seed stop (mid at its entry) keeps it open, so it still excludes.
        if (p.exclusion && other.open && other.sign * K[i] >= other.entryK - seedTicks) continue
        if (now - s.closedAt >= pauseMs && x - s.low >= p.confirmTicks) send(s, true, now)
        continue
      }
      if (x > s.peak) s.peak = x
      // Without the SMA the formula only changes on a new peak, so this is the first version's rule.
      const m = smaLine ? smaLine[barOf[i]] : null
      const gap = m !== null && x > s.sign * m * scale ? s.gapK * p.smaK : s.gapK
      const ns = opportunityStopTicks(s.entryK, s.peak, p.lock, gap, seedTicks)
      if (ns > s.ideal) s.ideal = ns
      if (s.ideal > s.stop) {
        s.stop = s.ideal
        s.moves++
        txTimes.push(now)
      }
      if (x < s.stop) send(s, false, now)
    }
    record(i)
    lastOf[ASK[i]] = i
  }
  mark(barOf[n - 1], n - 1)
  for (const s of subs) if (s.open) close(s, n - 1, K[n - 1], T[n - 1], 'end')
  if (tr) {
    tr.eqA[n - 1] = subs[0].realized
    tr.eqB[n - 1] = subs[1].realized
  }
  eq[0][nb - 1] = subs[0].realized
  eq[1][nb - 1] = subs[1].realized
  const eqPair = eq[0].map((v, i) => v + eq[1][i])
  const spanMs = T[n - 1] - T[0]
  const hours = spanMs / 3.6e6
  const subSummary = (s: OSub, series: number[]): HedgeSubSummary => ({
    pnl: s.realized,
    opens: s.opens,
    closes: s.closes,
    stopMoves: s.moves,
    wins: s.wins,
    losses: s.losses,
    avgWin: s.wins ? s.sumWin / s.wins : 0,
    avgLoss: s.losses ? s.sumLoss / s.losses : 0,
    timeInPct: spanMs > 0 ? (s.timeIn / spanMs) * 100 : 0,
    maxDrawdown: maxDrawdown(series),
  })
  const A = subSummary(subs[0], eq[0])
  const B = subSummary(subs[1], eq[1])
  const pairPnl = A.pnl + B.pnl
  const tx = sendTxRate(txTimes, spanMs)
  const summary: HedgeSummary = {
    A,
    B,
    pairPnl,
    pairPnlPct: (pairPnl / (2 * p.margin)) * 100,
    pairMaxDrawdown: maxDrawdown(eqPair),
    funding: sumFunding(subs[0].fund, subs[1].fund),
    hours,
    opens: A.opens + B.opens,
    stopMovesPerHour: hours > 0 ? (A.stopMoves + B.stopMoves) / hours : 0,
    // Market orders only (every open and every close, the data's end included); the program's stop moves are not orders.
    ordersPerHour: hours > 0 ? (A.opens + A.closes + B.opens + B.closes) / hours : 0,
    sendTxPerMin: tx.perMin,
    sendTxPeakMin: tx.peakMin,
  }
  const times = bars.map((b) => b.t)
  const timesMs = times.map((x) => x * 1000)
  const dA = perDay(timesMs, eq[0])
  const dB = perDay(timesMs, eq[1])
  const dP = perDay(timesMs, eqPair)
  const days = [...dP.keys()].map((day) => ({ day, a: dA.get(day) ?? 0, b: dB.get(day) ?? 0, pair: dP.get(day) ?? 0 }))
  const first = K[0] / scale
  const last = K[n - 1] / scale
  const hold = (sign: 1 | -1): HedgeHold => {
    const qty = notional / first
    const series = bars.map((b) => qty * sign * (b.c - first) - fee * notional)
    return { pnl: qty * sign * (last - first) - fee * notional - fee * qty * last, maxDrawdown: maxDrawdown(series) }
  }
  return {
    times,
    stopA: stops[0],
    stopB: stops[1],
    eqA: eq[0],
    eqB: eq[1],
    eqPair,
    events,
    summary,
    days,
    holdA: hold(1),
    holdB: hold(-1),
    sma: smaLine,
    atrEPct: null,
    medianEPct: p.gapPct,
    single: false,
    ms: performance.now() - started,
    prints: n,
    tape,
    latencyMs: lat,
    stress,
    eventPrints,
    trace: tr,
  }
}

/** The unfavourable case: latency at least 1,000 ms, and every order filled at the worse of the two estimates (last print on its side, last print ± the median spread). */
export const stressOpportunity = (tape: OpportunityTape, p: OpportunityParams): OpportunityResult | null => simulateOpportunity(tape, { ...p, latencyMs: Math.max(p.latencyMs, 1000) }, true)

/**
 * A driftless tick-level walk on the real prints' times and sides: a hidden mid moves by sigmaTicks x N(0, 1) at each
 * print, and each print is the mid plus half the median spread for a buy-aggressor print (minus it for a sell), rounded
 * to the tick. Deterministic for a seed.
 */
export function randomWalkTape(tape: OpportunityTape, seed: number): OpportunityTape {
  const n = tape.t.length
  const rnd = lcg(seed)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
  const k = new Float64Array(n)
  const half = tape.spreadTicks / 2
  let mid = tape.k[0]
  for (let i = 0; i < n; i++) {
    if (i > 0) mid += tape.sigmaTicks * gauss()
    k[i] = Math.round(mid + (tape.ask[i] ? half : -half))
  }
  return { ...buildTape(tape.t, k, tape.ask, tape.tick), sigmaTicks: tape.sigmaTicks, spreadTicks: tape.spreadTicks, spreadPct: tape.spreadPct }
}

/** Mean pair PnL of the setting (central fills) over `HEDGE_CONTROL_SEEDS` walks; `null` when the tape is too short. */
export function controlOpportunity(tape: OpportunityTape, p: OpportunityParams): number | null {
  if (tape.t.length < 2) return null
  let sum = 0
  for (const seed of HEDGE_CONTROL_SEEDS) sum += simulateOpportunity(randomWalkTape(tape, seed), p)?.summary.pairPnl ?? 0
  return sum / HEDGE_CONTROL_SEEDS.length
}

/**
 * IDEAL on the prints: `idealHedge` with each print as a flat bar, at a swing of max(gapPct, the tape's median spread)
 * (author, 2026-09-30: never under the spread, so the bid/ask bounce is not counted as swings). Filled at the prints
 * themselves: no slippage, fee as set. Its curve has one point per print, as the LIVE chart draws the prints.
 */
export function opportunityIdeal(tape: OpportunityTape, gapPct: number, notional: number, feePct: number): HedgeIdeal | null {
  const n = tape.t.length
  if (n < 2 || !(gapPct > 0)) return null
  const scale = Math.round(1 / tape.tick)
  const flat = new Array<HedgeBar>(n)
  for (let i = 0; i < n; i++) {
    const px = tape.k[i] / scale
    flat[i] = { t: tape.t[i] / 1000, o: px, h: px, l: px, c: px, gap: false }
  }
  const ideal = idealHedge(flat, opportunityIdealWidth(tape, gapPct), notional, 0, feePct)
  if (!ideal) return null
  ideal.eq[n - 1] = ideal.pnl
  return ideal
}

/** The IDEAL's swing in OPPORTUNITY, in %: the min gap, floored at the tape's measured median spread. */
export const opportunityIdealWidth = (tape: OpportunityTape, gapPct: number): number => Math.max(gapPct, tape.spreadPct ?? 0)

/**
 * BEST in OPPORTUNITY (author, 2026-09-30): min gap x verrou x SMA reinforcement, 12 x 21 x 10 = 2,520 runs. Exclusion, pause, clock and confirmation stay as set, to bound it.
 */
export const OPPORTUNITY_GRID_GAP = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3]
export const OPPORTUNITY_GRID_LOCK = [0.4, 0.425, 0.45, 0.475, 0.5, 0.525, 0.55, 0.575, 0.6, 0.625, 0.65, 0.675, 0.7, 0.725, 0.75, 0.775, 0.8, 0.825, 0.85, 0.875, 0.9]
/** Reinforcement off (N = 0, k left as set), then N x k. */
export const OPPORTUNITY_GRID_SMA: { smaN: number; smaK: number | null }[] = [{ smaN: 0, smaK: null }, ...[30, 60, 120].flatMap((smaN) => [1.5, 2, 3].map((smaK) => ({ smaN, smaK })))]

/** The settings a BEST row varies or carries. */
export type OpportunityGridPoint = Pick<OpportunityParams, 'lock' | 'gapPct' | 'exclusion' | 'clockSec' | 'pauseSec' | 'confirmTicks' | 'smaN' | 'smaK'>

export type OpportunityGridRow = OpportunityGridPoint & {
  pairPnl: number
  stressPnl: number | null
  controlPnl: number | null
  verdict: HedgeVerdict | null
  worstDay: number
  maxDrawdown: number
  ordersPerHour: number
  sendTxPerMin: number
  sendTxPeakMin: number
  idealPnl: number | null
}

export function opportunityGridRow(result: OpportunityResult, q: OpportunityGridPoint, idealPnl: number | null): OpportunityGridRow {
  const s = result.summary
  return { ...q, pairPnl: s.pairPnl, stressPnl: null, controlPnl: null, verdict: null, worstDay: result.days.length ? Math.min(...result.days.map((d) => d.pair)) : 0, maxDrawdown: s.pairMaxDrawdown, ordersPerHour: s.ordersPerHour, sendTxPerMin: s.sendTxPerMin, sendTxPeakMin: s.sendTxPeakMin, idealPnl }
}

/** The verdict of an OPPORTUNITY setting: `hedgeVerdict` without the E rules, with the sendTx cap. */
export const opportunityVerdict = (f: { stressPnl: number | null; worstDay: number; controlPnl: number | null; solidPct: number; margin: number; sendTxPeakMin: number; maxTxPerMin: number }): HedgeVerdict =>
  hedgeVerdict({ stressPnl: f.stressPnl, worstDay: f.worstDay, medianEPct: null, eName: '', spreadMedianPct: null, controlPnl: f.controlPnl, solidPct: f.solidPct, capital: 2 * f.margin, maxFloorLoss: null, txCap: { peakPerMin: f.sendTxPeakMin, max: f.maxTxPerMin } })
