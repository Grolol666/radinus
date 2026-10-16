/**
 * The lean's flips traded on history (`/test-bench`, author 2026-10-01): one position at a time, opened at a "→ LONG" /
 * "→ SHORT", closed at a "close" or reversed at the opposite flip, every order at market with OPPORTUNITY's fill
 * (`opportunityFillAt`, `core/hedgeSim.ts`: decided at the minute close, filled latency later at the last print on the
 * order's side, or that print ± the median spread if it is older than 60 s). A position open at the end is closed at
 * the last print. Equity is marked at each minute close.
 */

import { fundingPaid } from './funding'
import type { FundingFigure, FundingHours } from './funding'
import { HEDGE_CONTROL_SEEDS, maxDrawdown, opportunityFillAt, perDay, randomWalkTape } from './hedgeSim'
import type { OpportunityTape } from './hedgeSim'
import { bollingerBands, ema, leanFlips, leanHistory } from './zonesBench'
import type { BenchBar, LeanBook, LeanFlip, LeanFlow } from './zonesBench'

/** OPPORTUNITY's default latency, ms (`HEDGE_DEFAULTS`). */
export const LEAN_SIM_LATENCY_MS = 300

/** `locked` = closed by the gain lock, not by a flip; `estimated` = opened before the first print, at a candle's close. `funding`, only when the sim was given the hourly rows: the hour marks it crossed, `paid` already in `pnl`. */
export type LeanTrade = { side: 1 | -1; tIn: number; pxIn: number; tOut: number; pxOut: number; pnl: number; locked?: true; estimated?: true; funding?: FundingFigure }
/** One span's figures; `from` = its first minute. `funding`, only with the hourly rows: its trades' funding added up, already in `pnl`. */
export type LeanSimPart = { pnl: number; funding?: FundingFigure; trades: LeanTrade[]; wins: number; losses: number; avgWin: number; avgLoss: number; worstDay: { day: string; pnl: number } | null; maxDrawdown: number; from: number; to: number }
/**
 * The prints' part (`from` = the first bar with a print), and, when candles were given, the part filled on them before
 * the first print (`estimated`, its trades included even when they close on a print) and the two together (`total`).
 */
export type LeanSimResult = LeanSimPart & { estimated?: LeanSimPart; total?: LeanSimPart }

/** The gain lock: a position whose best gain at a minute close reached `triggerPct` % closes at market once its gain falls to `keepPct` % of that best, then stays flat until the next flip. */
export type LeanLock = { triggerPct: number; keepPct: number }

function simPart(trades: LeanTrade[], pnl: number, times: number[], eq: number[], from: number, to: number, withFunding: boolean): LeanSimPart {
  const wins = trades.filter((x) => x.pnl > 0)
  const losses = trades.filter((x) => x.pnl <= 0)
  const days = [...perDay(times, eq).entries()].map(([day, pnl]) => ({ day, pnl }))
  const worst = days.length === 0 ? null : days.reduce((a, b) => (b.pnl < a.pnl ? b : a))
  const mean = (xs: LeanTrade[]) => (xs.length ? xs.reduce((s, x) => s + x.pnl, 0) / xs.length : NaN)
  const funding = withFunding ? { funding: trades.reduce((sum, x) => ({ paid: sum.paid + (x.funding?.paid ?? 0), hours: sum.hours + (x.funding?.hours ?? 0), missing: sum.missing + (x.funding?.missing ?? 0) }), { paid: 0, hours: 0, missing: 0 }) } : {}
  return { pnl, ...funding, trades, wins: wins.length, losses: losses.length, avgWin: mean(wins), avgLoss: mean(losses), worstDay: worst, maxDrawdown: maxDrawdown(eq), from, to }
}

/**
 * The flips on `tape`, `notional` $ per position, `feePct` of each fill's notional. `bars` give the marking times. `null`
 * with no print. `candles`, when given: an order decided before the first print fills at the close of its minute's
 * candle (no latency, no spread), the gain lock's too; from the first print on, nothing changes.
 * `funding`, the market's hourly rows: each trade then pays the hour marks between its fills (`fundingPaid`), into its PnL;
 * `null`, none, and the figures are the ones without this parameter.
 */
export function simulateLeanFlips(tape: OpportunityTape, bars: BenchBar[], flips: LeanFlip[], notional: number, feePct: number, latencyMs = LEAN_SIM_LATENCY_MS, lock: LeanLock | null = null, candles: BenchBar[] | null = null, funding: FundingHours | null = null): LeanSimResult | null {
  const n = tape.t.length
  if (n === 0 || bars.length === 0) return null
  const fee = feePct / 100
  const scale = Math.round(1 / tape.tick)
  const lastPx = tape.k[n - 1] / scale
  const closeAt = candles === null ? null : new Map(candles.map((b) => [b.t, b.c]))
  // An order at `at` ms on side `need`, decided at the close of the minute starting `minute`: on the prints, else on that candle.
  const fill = (need: 0 | 1, at: number, minute: number): { px: number; est: boolean } | null => {
    if (closeAt !== null && at < tape.t[0]) {
      const c = closeAt.get(minute)
      return c === undefined ? null : { px: c, est: true }
    }
    const px = opportunityFillAt(tape, need, at)
    return px === null ? null : { px, est: false }
  }
  const trades: LeanTrade[] = []
  // The prints' part and the candles' part are booked apart, so the first is exactly what it is without candles.
  let realized = 0
  let realizedEst = 0
  let pos: { side: 1 | -1; tIn: number; pxIn: number; qty: number; peak: number; est: boolean } | null = null
  const close = (tOut: number, pxOut: number, locked = false) => {
    if (pos === null) return
    const priced = pos.side * (pxOut - pos.pxIn) * pos.qty - fee * notional - fee * pos.qty * pxOut
    const paid = funding === null ? null : fundingPaid(pos.side, pos.qty, Math.round(pos.tIn * 1000), Math.round(tOut * 1000), funding)
    const pnl = paid === null ? priced : priced + paid.paid
    if (pos.est) realizedEst += pnl
    else realized += pnl
    trades.push({ side: pos.side, tIn: pos.tIn, pxIn: pos.pxIn, tOut, pxOut, pnl, ...(locked ? { locked: true as const } : {}), ...(pos.est ? { estimated: true as const } : {}), ...(paid === null ? {} : { funding: paid }) })
    pos = null
  }
  // Equity at each minute close: realized + the open position at the bar's close.
  const times: number[] = []
  const eq: number[] = []
  const eqEst: number[] = []
  let f = 0
  for (const bar of bars) {
    const end = bar.t + 60
    // The lock reads the gain at this close, before this close's flips; its order fills like a flip's.
    const held = pos as { side: 1 | -1; pxIn: number; peak: number } | null
    if (lock !== null && held !== null) {
      const gain = (held.side * (bar.c - held.pxIn) / held.pxIn) * 100
      held.peak = Math.max(held.peak, gain)
      const at = end * 1000 + latencyMs
      if (held.peak >= lock.triggerPct && gain <= (lock.keepPct / 100) * held.peak && at <= tape.t[n - 1]) {
        const x = fill(held.side === 1 ? 0 : 1, at, bar.t)
        if (x !== null) close(at / 1000, x.px, true)
      }
    }
    for (; f < flips.length && flips[f].t <= end; f++) {
      const fl = flips[f]
      const at = fl.t * 1000 + latencyMs
      if (at > tape.t[n - 1]) break
      if (pos !== null) {
        const x = fill(pos.side === 1 ? 0 : 1, at, fl.t - 60)
        if (x !== null) close(at / 1000, x.px)
      }
      if (fl.kind !== 'close') {
        const side = fl.kind === 'long' ? 1 : -1
        const x = fill(side === 1 ? 1 : 0, at, fl.t - 60)
        if (x !== null) pos = { side, tIn: at / 1000, pxIn: x.px, qty: notional / x.px, peak: 0, est: x.est }
      }
    }
    const p = pos as { side: 1 | -1; pxIn: number; qty: number; est: boolean } | null
    const mark = p === null ? 0 : p.side * (bar.c - p.pxIn) * p.qty - fee * notional
    times.push(end * 1000)
    eq.push(realized + (p === null || p.est ? 0 : mark))
    eqEst.push(realizedEst + (p !== null && p.est ? mark : 0))
  }
  close(tape.t[n - 1] / 1000, lastPx)
  if (eq.length > 0) {
    eq[eq.length - 1] = realized
    eqEst[eqEst.length - 1] = realizedEst
  }
  const from = Math.max(bars[0].t, Math.floor(tape.t[0] / 60000) * 60)
  const to = bars[bars.length - 1].t + 60
  const withFunding = funding !== null
  const real = simPart(trades.filter((x) => x.estimated === undefined), realized, times, eq, from, to, withFunding)
  if (candles === null) return real
  const estimated = simPart(trades.filter((x) => x.estimated !== undefined), realizedEst, times, eqEst, bars[0].t, from, withFunding)
  const total = simPart(trades, realizedEst + realized, times, eq.map((x, i) => x + eqEst[i]), bars[0].t, to, withFunding)
  return { ...real, estimated, total }
}

/** The bench bars' minute grid filled from a tape's prints: each minute's OHLC, a quiet minute flat at the previous close. */
function barsOnTape(tape: OpportunityTape, grid: BenchBar[]): BenchBar[] {
  const scale = Math.round(1 / tape.tick)
  const out: BenchBar[] = []
  let i = 0
  let prev = tape.k[0] / scale
  for (const g of grid) {
    const end = (g.t + 60) * 1000
    while (i < tape.t.length && tape.t[i] < g.t * 1000) prev = tape.k[i++] / scale
    let o = NaN
    let h = -Infinity
    let l = Infinity
    let c = prev
    for (; i < tape.t.length && tape.t[i] < end; i++) {
      const px = tape.k[i] / scale
      if (Number.isNaN(o)) o = px
      if (px > h) h = px
      if (px < l) l = px
      c = px
    }
    out.push(Number.isNaN(o) ? { t: g.t, o: prev, h: prev, l: prev, c: prev, v: 0, real: false } : { t: g.t, o, h, l, c, v: g.v, real: true })
    prev = c
  }
  return out
}

/**
 * Random-walk control: the rule re-run on `HEDGE_CONTROL_SEEDS` driftless walks of the prints (`randomWalkTape`: same
 * times and sides, random prices). The lean is recomputed on each walk's bars - EMA slope and SMA deviation from the
 * walk, the flows and the book imbalances the real ones (they are sizes, not prices), the book mid replaced by the
 * walk's close. Mean PnL and trades over the seeds; `null` when the tape is too short. `zoneEnd`: `leanFlips`' zone rule.
 */
export function leanSimControl(tape: OpportunityTape, bars: BenchBar[], flow: Record<LeanFlow, number[]>, books: (LeanBook | null)[], enter: number, exit: number, notional: number, feePct: number, zoneEnd: number | null = null, funding: FundingHours | null = null): { pnl: number; trades: number } | null {
  if (tape.t.length < 2) return null
  let pnl = 0
  let trades = 0
  for (const seed of HEDGE_CONTROL_SEEDS) {
    const walk = randomWalkTape(tape, seed)
    const wb = barsOnTape(walk, bars)
    const closes = wb.map((b) => b.c)
    const wBooks = books.map((b, i) => (b === null ? null : { mid: wb[i].c, imbalances: b.imbalances }))
    const points = leanHistory(wb, ema(closes, 20), bollingerBands(wb).mid, flow, wBooks)
    const r = simulateLeanFlips(walk, wb, leanFlips(points, enter, exit, zoneEnd), notional, feePct, LEAN_SIM_LATENCY_MS, null, null, funding)
    pnl += r?.pnl ?? 0
    trades += r?.trades.length ?? 0
  }
  return { pnl: pnl / HEDGE_CONTROL_SEEDS.length, trades: trades / HEDGE_CONTROL_SEEDS.length }
}
