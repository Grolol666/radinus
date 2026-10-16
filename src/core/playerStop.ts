/**
 * `/rsi`'s fixed stop-loss (author, 2026-10-05): a stop of `s` % of the entry fill, triggered on the prints (the last trade, as `/hedging`), exited at market by the simulation's own fill rule
 * (`opportunityFillAt`, `latencyMs` after the trigger print), and the player out until its next fresh signal. It sits beside `replay` (`playerSearch.ts`) and not in `simulateLeanFlips`, which `/lean`, `/test-bench`,
 * `/hedging` and `/demain` share: the stop needs the players' raw side conditions per minute (`playerFlips`' `raw`), which the alternating flips do not carry, and the entry fill it is set from.
 * The row's path and the search both call `replayStop` on the same arrays; `radinus/` calls the shared functions below. No React import.
 */

import { fundingPaid } from './funding'
import type { FundingHours } from './funding'
import { opportunityFillAt } from './hedgeSim'
import type { FillTape, OpportunityTape } from './hedgeSim'
import { sideOf } from './levelFlips'
import type { MinuteFills } from './playerSearch'
import { PLAYER_NOTIONAL } from './players'
import { guardBans, guardEntry, guardGate, guardTrade } from './playerRules'
import type { Guard, Halt } from './playerRules'
import type { BenchBar } from './zonesBench'

/**
 * What the stop reads of the prints, as typed arrays: the tape's own prints and spread (what the fill rule reads), and per bar the index of its first print (`first[i]`..`first[i + 1] - 1` are bar i's prints, `first[bars.length]` = the print count) and its lowest and
 * highest print (Infinity / -Infinity where it has none), taken from the tape's minute bars, so a try locates the trigger's minute from them and reads that minute's prints only. Built once per (bars, tape); a search is given it once.
 */
export type StopPrints = { tape: FillTape; first: Int32Array; low: Float64Array; high: Float64Array }

/** The first index in `t` (sorted) whose value is `>= x` (`strict` false) or `> x` (`strict` true). */
export function bound(t: Float64Array, x: number, strict: boolean): number {
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (strict ? t[mid] <= x : t[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function stopPrints(tape: OpportunityTape, bars: BenchBar[]): StopPrints {
  const nb = bars.length
  const first = new Int32Array(nb + 1)
  const low = new Float64Array(nb).fill(Infinity)
  const high = new Float64Array(nb).fill(-Infinity)
  let j = 0
  for (let i = 0; i < nb; i++) {
    first[i] = bound(tape.t, bars[i].t * 1000, false)
    while (j < tape.bars.length && tape.bars[j].t < bars[i].t) j++
    if (j < tape.bars.length && tape.bars[j].t === bars[i].t) {
      low[i] = tape.bars[j].l
      high[i] = tape.bars[j].h
    }
  }
  first[nb] = nb === 0 ? 0 : bound(tape.t, (bars[nb - 1].t + 60) * 1000, false)
  return { tape: { t: tape.t, k: tape.k, ask: tape.ask, tick: tape.tick, spreadTicks: tape.spreadTicks, spreadPct: tape.spreadPct }, first, low, high }
}

/** One trade of `replayStop`, for the row and the proofs: times in s, `stopped` = closed by the stop, `trailing` = closed by the trailing (display only: it is booked as stopped), `take` = closed by a script's take-profit (`takeAt`; not a stop), `estime` = opened before the first print, on the candles (`replayStop`'s `bars`). */
export type StopTrade = { side: 1 | -1; tIn: number; pxIn: number; tOut: number; pxOut: number; pnl: number; stopped: boolean; trailing: boolean; take?: true; estime?: true }

/**
 * A trailing stop (author, 2026-10-06), both in % of price: `seuil` = the favourable move from the entry fill at which it activates, `distance` = how far behind the best price it then sits. Where a trailing is optional, `null` = none (the fixed stop alone, as before).
 * The rule is `stopHit`, below, the one code the page's replay and `radinus/`'s paper exchange both call.
 */
export type Trail = { seuil: number; distance: number }

/**
 * An open position: its entry fill, the stop price set from it, `bar` = the minute the entry filled in (the minute path) and `lo` = the first print after the fill, where the stop starts to be watched. `trail` = its trailing (null = none), `best` = the best price
 * in its favour seen since the fill (highest for a long, lowest for a short), `trailPx` = the trailing level once active (-Infinity long / Infinity short before), `byTrail` = the last print that reached the effective stop reached it by the trailing.
 * A script's only (`botScript.ts`; absent otherwise): `stopAt` = the fixed stop it set at a price (`setStopAt`: `stopPx` is that price, a `stop` % no longer moves it), `take` = its take-profit (`setTake`). Both live and die with the position.
 */
export type Pos = { side: 1 | -1; tIn: number; pxIn: number; qty: number; stopPx: number; bar: number; lo: number; trail: Trail | null; best: number; trailPx: number; byTrail: boolean; est?: true; stopAt?: number; take?: Take }

/** A script's take-profit (`takeAt`): a resting limit at `px`, set at the print `x` (a tape index) and watched from the print after it; `mkt` = it was already reached by the price when set (a marketable limit, filled at the next print's price), until a print is read. */
export type Take = { px: number; x: number; mkt: boolean }

/** A row's two trailing fields as a `Trail`: both or none (one field alone is no trailing). */
export const trailOf = (seuil: number | null, distance: number | null): Trail | null => (seuil === null || distance === null ? null : { seuil, distance })

/** The stop in force: the tighter of the fixed stop and the trailing level (for a long the higher one, for a short the lower one). */
export const effectiveStop = (pos: Pos): number => (pos.side === 1 ? Math.max(pos.stopPx, pos.trailPx) : Math.min(pos.stopPx, pos.trailPx))

/**
 * One print `px` read by the open position `pos`: the best price in its favour is tracked; once the favourable move from the entry fill has reached the trailing's `seuil` %, its level is best x (1 - distance / 100) for a long, best x (1 + distance / 100) for a short, and never moves back.
 * True when the print reaches the effective stop (at or under it for a long, at or over it for a short); `byTrail` then says whether it was the trailing's level (strictly tighter than the fixed stop) that it reached. With no trailing it is the fixed stop alone.
 */
export function stopHit(pos: Pos, px: number): boolean {
  const t = pos.trail
  if (t !== null && (pos.side === 1 ? px > pos.best : px < pos.best)) {
    pos.best = px
    if (((pos.side * (px - pos.pxIn)) / pos.pxIn) * 100 >= t.seuil) {
      const level = pos.side === 1 ? px * (1 - t.distance / 100) : px * (1 + t.distance / 100)
      pos.trailPx = pos.side === 1 ? Math.max(pos.trailPx, level) : Math.min(pos.trailPx, level)
    }
  }
  const eff = effectiveStop(pos)
  const hit = pos.side === 1 ? px <= eff : px >= eff
  if (hit) pos.byTrail = pos.side === 1 ? pos.trailPx > pos.stopPx : pos.trailPx < pos.stopPx
  return hit
}

/**
 * The book `replayStop` (and `radinus/`'s paper exchange) keeps: the position, what it booked, the side held, whether the player is out after a stop and the raw conditions of the
 * decision before. The stop rule (when it fires, how it exits), the fill rule (`opportunityFillAt`) and the order's book-keeping are the functions below, called by both.
 */
export type Book = { tape: FillTape; sp: StopPrints | null; latencyMs: number; lastT: number; lastPx: number; stopPct: number | null; trail: Trail | null; funding: FundingHours | null; out: StopTrade[] | undefined; pos: Pos | null; realized: number; trades: number; held: 1 | 0 | -1; afterStop: boolean; prev: number; guard: Guard | null; script: ScriptAccount | null }

export function newBook(tape: FillTape, sp: StopPrints | null, latencyMs: number, lastT: number, lastPx: number, stopPct: number | null, funding: FundingHours | null, out: StopTrade[] | undefined, guard: Guard | null = null): Book {
  return { tape, sp, latencyMs, lastT, lastPx, stopPct, trail: null, funding, out, pos: null, realized: 0, trades: 0, held: 0, afterStop: false, prev: 0, guard, script: null }
}

/** The open position closed at `pxOut`: booked with its funding, pushed to `out`. `take` = by a script's take-profit. */
export function bookClose(b: Book, tOut: number, pxOut: number, stopped: boolean, take = false): void {
  const pos = b.pos
  if (pos === null) return
  const priced = pos.side * (pxOut - pos.pxIn) * pos.qty
  const paid = b.funding === null ? null : fundingPaid(pos.side, pos.qty, Math.round(pos.tIn * 1000), Math.round(tOut * 1000), b.funding)
  const pnl = paid === null ? priced : priced + paid.paid
  b.realized += pnl
  b.trades++
  b.out?.push({ side: pos.side, tIn: pos.tIn, pxIn: pos.pxIn, tOut, pxOut, pnl, stopped, trailing: stopped && pos.byTrail, ...(take ? { take: true as const } : {}), ...(pos.est === true ? { estime: true as const } : {}) })
  if (b.guard !== null) guardTrade(b.guard, pos.side, pnl, stopped, Math.round(tOut * 1000))
  b.script?.traded(pos.side, pnl)
  b.pos = null
}

/** The first print in `[a, end)` that reaches the position's effective stop (`stopHit`: each print before it is read by the trailing too); `end` if none. */
export function firstHit(pos: Pos, K: Float64Array, scale: number, a: number, end: number): number {
  let x = a
  while (x < end && !stopHit(pos, K[x] / scale)) x++
  return x
}

/** What a player's side is once its position was stopped out (out until its next fresh signal) and once an order was handled (no longer out after a stop): the player's own fields, which the `Book` carries on the page's path and `radinus/`'s bot keeps itself. */
export type PlayerSide = { held: 1 | 0 | -1; afterStop: boolean; prev: number; guard: Guard | null }
export function afterStopped(s: PlayerSide): void {
  s.held = 0
  s.afterStop = true
}
export function afterFilled(s: PlayerSide): void {
  s.afterStop = false
}

/** The time (ms) a stop that fired on print `x` is filled at: the exit is a market order sent at the print's time, filled by the simulation's own rule `latencyMs` later. */
export const stopExitAt = (b: Book, x: number): number => b.tape.t[x] + b.latencyMs

/**
 * The stop's exit filled at `at` (`stopExitAt`): the open position closed, as a stopped trade, at the simulation's own fill price. False (nothing booked) when there is no position or the tape has no print up to `at`. The stop-loss lives
 * exactly as long as its position (author, 2026-10-05): this is the one place a position is closed by its stop, whatever the player was doing meanwhile.
 */
export function exitByStop(b: Book, at: number): boolean {
  const pos = b.pos
  if (pos === null) return false
  const px = opportunityFillAt(b.tape, pos.side === 1 ? 0 : 1, at)
  if (px === null) return false
  bookClose(b, at / 1000, px, true)
  return true
}

/** The stop's exit filled at `at` (`exitByStop`) with no order on its way: the player is then out until its next fresh signal. */
export function fillStop(b: Book, at: number): void {
  if (exitByStop(b, at)) afterStopped(b)
}

/**
 * The stop fired on print `x`: filled `latencyMs` later, unless that is past the last print. `replaced` = it fired while an order that replaces the position was on its way (see `placeOrder`): the position is closed by the
 * stop all the same, but the player is not out, since that order opens its next side.
 */
function stopExit(b: Book, x: number, replaced: boolean): void {
  const at = stopExitAt(b, x)
  if (b.pos === null || at > b.lastT) return
  if (replaced) exitByStop(b, at)
  else fillStop(b, at)
}

/**
 * A player's decision from its raw conditions `bits` at a decision point (a minute's close): the side it takes (1 long, -1 short), 0 = nothing. Only one condition true is a signal; once stopped out only a condition that became true
 * since the decision before counts; a side already held does nothing. `s.prev` is moved to `bits`, and `s.held` to the side taken. `tMs` = the decision's instant (the minute's close), read by the guard rules (`playerRules.ts`): a halted player takes nothing,
 * a decision inside the pause after a stop is ignored and leaves the player out until a condition becomes true again, a signal for the forbidden side is ignored; `forbid` = a side a script forbids (`StopScript`), ignored the same way. Without a guard (`s.guard` null) the rules do not exist.
 */
export function decideSide(s: PlayerSide, bits: number, tMs: number = NaN, forbid: 1 | 0 | -1 = 0): 1 | 0 | -1 {
  const g = s.guard
  const gate = g === null ? 'ok' : guardGate(g, tMs)
  if (gate !== 'ok') {
    s.prev = bits
    if (gate === 'pause') s.afterStop = true
    return 0
  }
  const w = sideOf(s.afterStop ? bits & ~s.prev : bits)
  s.prev = bits
  if (w === 0 || w === s.held) return 0
  if (g !== null && guardBans(g, w, tMs)) return 0
  if (forbid !== 0 && w === forbid) return 0
  s.held = w
  return w
}

/** The fixed stop's price of a position of side `w` filled at `px`, for a stop of `stopPct` % of that fill (`null` or Infinity = none: -Infinity long, Infinity short). */
export const stopPxOf = (w: 1 | -1, px: number, stopPct: number | null): number => (stopPct === null ? (w === 1 ? -Infinity : Infinity) : w === 1 ? px * (1 - stopPct / 100) : px * (1 + stopPct / 100))

/**
 * A script's `stop` decision (`botScript.ts`): `stopPct` (% of price, Infinity = none) becomes the stop of every later entry, and the open position's fixed stop is re-anchored on ITS ENTRY FILL (`pxIn`), as the field's stop is, not on the price now. The trailing is not touched.
 */
export function setStop(b: Book, stopPct: number): void {
  b.stopPct = stopPct
  const p = b.pos
  if (p !== null && p.stopAt === undefined) p.stopPx = stopPxOf(p.side, p.pxIn, stopPct)
}

/**
 * A script's `stopAt` decision: the open position's fixed stop at the price `px` (the effective stop stays the tighter of it and the trailing, `effectiveStop`), until the position closes or the script moves it; `null` = back to the `stop` % in force,
 * from the entry fill. Nothing is refused: a stop already reached by the price fires at the next print.
 */
export function setStopAt(b: Book, px: number | null): void {
  const p = b.pos
  if (p === null) return
  if (px === null) {
    delete p.stopAt
    p.stopPx = stopPxOf(p.side, p.pxIn, b.stopPct)
  } else {
    p.stopAt = px
    p.stopPx = px
  }
}

/** A script's `takeAt` decision at the print `x`, the price being `now`: the open position's take-profit at `px` (`Take`), `null` = none. */
export function setTake(b: Book, px: number | null, x: number, now: number): void {
  const p = b.pos
  if (p === null) return
  if (px === null) delete p.take
  else p.take = { px, x, mkt: p.side === 1 ? now >= px : now <= px }
}

/**
 * The open position's take-profit read on print `x` at `px` (`scriptPrints`): from the print after it was set and after the entry fill, reached at a print at or over it (long) / at or under it (short); the position closes at that print's time AT the
 * take-profit (a resting limit: no latency, no slippage; this replay books no fee on any fill), or at the print's price when it was marketable when set (`Take.mkt`, the first print read only). Then the player is out, as after a script's close.
 */
function takeHit(b: Book, p: Pos, x: number, px: number): void {
  const t = p.take
  if (t === undefined || x <= t.x || x < p.lo) return
  const fill = takeFill(t, p.side, px)
  if (fill === null) return
  bookClose(b, b.tape.t[x] / 1000, fill, false, true)
  afterStopped(b)
}

/** The take-profit `t` of a position of side `side` read on a print at `px`: the price it fills at (its own, or the print's when it was marketable when set), `null` when the print does not reach it (it is then no longer marketable). `takeHit` and `radinus/`'s paper exchange both call it. */
export function takeFill(t: Take, side: 1 | -1, px: number): number | null {
  if (!(side === 1 ? px >= t.px : px <= t.px)) {
    t.mkt = false
    return null
  }
  return t.mkt ? px : t.px
}

/**
 * An order filled at `at` (ms) at `buy` / `sell` (NaN = no fill): the open position, if still open, is closed on the side opposite to it, the new one opened with its stop set from its fill, and the player is no longer out after a stop.
 * `bar` = the minute the entry filled in.
 *
 * The stop-loss lives exactly as long as its position, so the old position's stop is watched until this fill, not until the decision that sent the order. In the wait, in this order: the prints up to `at` (inclusive: the fill reads them),
 * each one's stop reached or not (a liquidation, in `radinus/`, comes before the stop on a print); then, if the stop was reached, its exit fill (`stopExitAt`, which may fall after `at`: the position was closed by the stop, as a stopped
 * trade); then this order's fill, which opens the new side whether or not the old position was stopped (the signal that sent it is a fresh one). Callers do the wait (`stopInWait`, or `radinus/`'s own), then this.
 */
export function placeOrder(b: Book, w: 1 | -1, at: number, buy: number, sell: number, bar: number, only: 1 | 0 | -1 = 0): void {
  if (b.pos !== null) {
    const px = b.pos.side === 1 ? sell : buy
    if (!Number.isNaN(px)) bookClose(b, at / 1000, px, false)
  }
  // A player of one side only (`only`, `/bot`): the signal of the other side closes the position and opens nothing.
  const px = only !== 0 && w === -only ? NaN : w === 1 ? buy : sell
  if (!Number.isNaN(px)) {
    const stopPct = b.stopPct
    const lo = bound(b.tape.t, at, true)
    if (b.guard !== null) guardEntry(b.guard, w)
    b.pos = { side: w, tIn: at / 1000, pxIn: px, qty: PLAYER_NOTIONAL / px, stopPx: stopPxOf(w, px, stopPct), bar, lo, trail: b.trail, best: px, trailPx: w === 1 ? -Infinity : Infinity, byTrail: false }
  }
  afterFilled(b)
}

/** The wait of `placeOrder`: the open position's stop read on the prints `from` (a print index) up to `to` (excluded), the ones after its own fill only; the first one that fires it closes it by the stop. */
function stopInWait(b: Book, from: number, to: number): void {
  const p = b.pos
  const sp = b.sp
  if (p === null || sp === null || (b.stopPct === null && b.trail === null && p.stopAt === undefined)) return
  const x = firstHit(p, sp.tape.k, Math.round(1 / sp.tape.tick), Math.max(from, p.lo), to)
  if (x < to) stopExit(b, x, true)
}

/**
 * An order decided at a minute's close before the first print, filled at the open of the minute that follows (`nxt`, index `bar`), at `at` ms: a buy pays the open plus the market's spread, a sell receives it less (the tape's own thin-market rule, a full spread on the adverse side).
 * The position it opens, if any, is estimated (`est`): its trade carries `estime`.
 */
export function estimatedOrder(b: Book, w: 1 | -1, at: number, nxt: BenchBar, spread: number, bar: number, only: 1 | 0 | -1): void {
  placeOrder(b, w, at, nxt.o * (1 + spread), nxt.o * (1 - spread), bar, only)
  if (b.pos !== null && b.pos.est === undefined) b.pos.est = true
}

/**
 * The open position `pos` read on a minute's candle before the first print, pessimistically: the candle does not say what came first. The stop in force at the start of the minute (`effectiveStop`) is reached when the low (long) / high (short) touches it: the position closes
 * as a stopped trade at that level, or at the open if the minute opened past it, less (long) / plus (short) the spread, timed at the minute's end. Only when it is not reached does the minute's extreme move the trailing's best price (`stopHit`'s update, on the high / low),
 * so the trailing never protects in the minute it activates. A liquidation in the same minute is the account's, which reads the same candle (`replayAccount`): it wins over the stop.
 */
function candleStop(b: Book, pos: Pos, bar: BenchBar, spread: number): void {
  const long = pos.side === 1
  const eff = effectiveStop(pos)
  if (long ? bar.l <= eff : bar.h >= eff) {
    pos.byTrail = long ? pos.trailPx > pos.stopPx : pos.trailPx < pos.stopPx
    bookClose(b, bar.t + 60, long ? Math.min(eff, bar.o) * (1 - spread) : Math.max(eff, bar.o) * (1 + spread), true)
    afterStopped(b)
    return
  }
  const t = pos.trail
  const extreme = long ? bar.h : bar.l
  if (t !== null && (long ? extreme > pos.best : extreme < pos.best)) {
    pos.best = extreme
    if (((pos.side * (extreme - pos.pxIn)) / pos.pxIn) * 100 >= t.seuil) {
      const level = long ? extreme * (1 - t.distance / 100) : extreme * (1 + t.distance / 100)
      pos.trailPx = long ? Math.max(pos.trailPx, level) : Math.min(pos.trailPx, level)
    }
  }
}

/**
 * The hook a script acts through (`botScript.ts`, author's go 2026-10-08): ONE optional object given to `replayStop` (and, next, to `radinus/`), default none. The replay keeps ONE `Book` per sub-account (`accounts`, author's go 2026-10-10: isolated, as Lighter's sub-accounts),
 * calls `call` ONCE at every print (`close` false) and at every minute close (`close` true) with all of them, and applies what comes back, one act per book, with the mechanics above: an `enter` / `close` is an order (`placeOrder`, filled by the simulation's own rule at the print's time + latency,
 * or at the close's), `forbid` / `paused` gate that book's entries, a trailing is set on its open position (`trailFromNow`). `live` false = the script failed: it is no longer called and every sub-account stays paused.
 */
/** `x` = the tape index of the last print up to this call (the print itself, or at a close the minute's last print; -1 = none): what `state.prints` ends on. */
export type ScriptMoment = { close: boolean; i: number; x: number; tMs: number; px: number; o: number; h: number; l: number; c: number }
export type ScriptAct = { enter: 1 | -1 | 0; close: boolean }
/** One sub-account of a script: its pause and forbid, its guard rules (`null` = none) and the trades its book books (`out`); `traded` is told each of them (`bookClose`), for the script's own counters. */
export type ScriptAccount = { paused: boolean; forbidden: 1 | 0 | -1; guard: Guard | null; out: StopTrade[]; traded: (side: 1 | -1, pnl: number) => void }
/** `call` returns one act per book, in `accounts`' order. */
export type StopScript = { live: boolean; accounts: readonly ScriptAccount[]; call: (books: readonly Book[], m: ScriptMoment) => readonly ScriptAct[] }
export const NO_ACT: ScriptAct = { enter: 0, close: false }

/** A trailing of `distance` % set on the open position from the price `px` now (no activation threshold: -Infinity): its level starts at `px` less / plus that distance and only moves in the position's favour (`stopHit`). */
export function trailFromNow(pos: Pos, px: number, distance: number): void {
  pos.trail = { seuil: -Infinity, distance }
  pos.best = px
  const level = pos.side === 1 ? px * (1 - distance / 100) : px * (1 + distance / 100)
  pos.trailPx = pos.side === 1 ? Math.max(pos.trailPx, level) : Math.min(pos.trailPx, level)
}

/** Whether the script may open `w` at `tMs` on the book of sub-account `h`: not paused, not forbidden by it, and that book's guard rules (halt, pause window, ban) let it. `radinus/`'s script bot calls it too. */
export function scriptMayEnter(b: Book, h: ScriptAccount, w: 1 | -1, tMs: number): boolean {
  const g = b.guard
  return !h.paused && h.forbidden !== w && (g === null || (guardGate(g, tMs) === 'ok' && !guardBans(g, w, tMs)))
}

/**
 * The script's act `act` for book `b` at a minute close, as the side of an order: an `enter` (not the side already held) first, else a `close` of the open position (the opposite order of a player of that side only: it closes and opens nothing, the player then out until a fresh signal),
 * else nothing (the script alone decides). `bits` = the raw conditions of the close. Returns the side, the `only` the order is sent with and whether it is a close.
 */
function scriptClose(b: Book, h: ScriptAccount, act: ScriptAct, m: ScriptMoment, bits: number, only: 1 | 0 | -1): { w: 1 | 0 | -1; only: 1 | 0 | -1; closing: boolean } {
  const pos = b.pos
  if (act.enter !== 0 && !(pos !== null && pos.side === act.enter)) {
    b.prev = bits
    if (!scriptMayEnter(b, h, act.enter, m.tMs)) return { w: 0, only, closing: false }
    b.held = act.enter
    return { w: act.enter, only, closing: false }
  }
  if (act.close && pos !== null) {
    b.prev = bits
    return { w: pos.side === 1 ? -1 : 1, only: pos.side, closing: true }
  }
  b.prev = bits
  return { w: 0, only, closing: false }
}

/**
 * Minute `i`'s prints (`a`..`end - 1`) read with a script: for each one, each book's open position's stop (`stopHit`, from its first print after the fill), then the script once, whether a position is open or not. An `enter` or a `close` it returns for a book is an order at the print's time, filled
 * `latencyMs` later by the simulation's own rule (`opportunityFillAt`) like a signal's: that book's old position's stop is watched until that fill (`stopInWait`), nothing is sent when the fill is past the last print. The prints between the order and its fill see the new position already booked.
 */
function scriptPrints(tape: FillTape, books: readonly Book[], sc: StopScript, m: ScriptMoment, i: number, a: number, end: number, t0: number, only: 1 | 0 | -1): void {
  const K = tape.k
  const T = tape.t
  const scale = Math.round(1 / tape.tick)
  m.close = false
  m.i = i
  for (let x = a; x < end; x++) {
    const px = K[x] / scale
    if (x === a) {
      m.o = px
      m.h = px
      m.l = px
    } else {
      if (px > m.h) m.h = px
      if (px < m.l) m.l = px
    }
    m.c = px
    m.x = x
    for (const b of books) {
      const held = b.pos
      // The stop first: a print that reaches both the stop and the take-profit is the stop's (the pessimistic order).
      if (held !== null && x >= held.lo && stopHit(held, px)) stopExit(b, x, false)
      else if (held !== null && held.take !== undefined) takeHit(b, held, x, px)
    }
    if (!sc.live) continue
    m.tMs = T[x]
    m.px = px
    const acts = sc.call(books, m)
    for (let k = 0; k < books.length; k++) {
      const b = books[k]
      const act = acts[k]
      const pos = b.pos
      let w: 1 | 0 | -1 = 0
      let ord = only
      let closing = false
      if (act.enter !== 0 && !(pos !== null && pos.side === act.enter)) {
        if (scriptMayEnter(b, sc.accounts[k], act.enter, T[x])) w = act.enter
      } else if (act.close && pos !== null) {
        w = pos.side === 1 ? -1 : 1
        ord = pos.side
        closing = true
      }
      if (w === 0) continue
      const at = T[x] + b.latencyMs
      if (at > b.lastT) continue
      stopInWait(b, x + 1, bound(T, at, true))
      // The buy fill is `need` 1, the sell fill `need` 0 (`minuteFills`); they were swapped here until 2026-10-11 (a print-time order filled on the favourable side), found by the script-bot check against Radinus.
      placeOrder(b, w, at, opportunityFillAt(b.tape, 1, at) ?? NaN, opportunityFillAt(b.tape, 0, at) ?? NaN, Math.floor((at / 1000 - t0) / 60), ord)
      if (closing) afterStopped(b)
      else b.held = w
    }
  }
}

/**
 * The script at minute `i`'s close (`bar`, `closeS` in s): called once, its act for each book turned into an order filled at the minute's fills (`fills`' `buy[i]` / `sell[i]`), each book's old position's stop watched until that fill. Before the first print nothing is sent
 * (a close only warms the script's helpers and registers). `false` = an order would fill past the last print: the replay ends there, as with one book.
 */
function scriptMinuteClose(books: readonly Book[], sc: StopScript, m: ScriptMoment, i: number, bar: BenchBar, closeS: number, bits: number, firstPrintT: number, fills: MinuteFills, sp: StopPrints, only: 1 | 0 | -1): boolean {
  m.close = true
  m.i = i
  m.x = sp.first[i + 1] - 1
  m.tMs = closeS * 1000
  m.px = bar.c
  m.o = bar.o
  m.h = bar.h
  m.l = bar.l
  m.c = bar.c
  const acts = sc.live ? sc.call(books, m) : null
  const ds = books.map((b, k) => scriptClose(b, sc.accounts[k], acts === null ? NO_ACT : acts[k], m, bits, only))
  if (ds.every((d) => d.w === 0)) return true
  if (closeS < firstPrintT) {
    // A script trades on the prints only (author's go, 2026-10-10): before the first one its closes only warm its helpers and registers.
    for (let k = 0; k < books.length; k++) if (ds[k].w !== 0 && ds[k].closing) afterStopped(books[k])
    return true
  }
  const at = closeS * 1000 + fills.latencyMs
  if (at > fills.lastT) return false
  for (let k = 0; k < books.length; k++) {
    const d = ds[k]
    if (d.w === 0) continue
    const b = books[k]
    stopInWait(b, sp.first[i + 1], bound(sp.tape.t, at, true))
    placeOrder(b, d.w, at, fills.buy[i], fills.sell[i], i + 1, d.only)
    if (d.closing) afterStopped(b)
  }
  return true
}

/**
 * What the replay of a player's raw conditions (`raw[i]`, bar i's close, `playerFlips`' `raw`) books with a stop of `stopPct` %: the PnL and the number of trades, `out` (when given) getting each trade. The signals are `flipsFrom`'s (a side
 * already held does nothing, both sides or neither nothing, the closes before the first print only move the side held); the fills of a signal are the minute's (`MinuteFills`); the stop is armed at each entry from its fill, watched on the
 * prints strictly after it, and fires at the first print at or under it (long) / at or over it (short): the exit is a market order filled at the trigger + latency, unless that is past the last print. A stop that fires before a close wins over that
 * close's signal; once stopped the player is out and re-enters at the first close where a condition becomes true (true there, false at the close before) and not both. A signal that reverses a position sends an order filled `latencyMs`
 * later; the old position's stop is watched until that fill (`placeOrder`). Same operations in the same order as `replay`, so the same digits.
 *
 * `bars` (the page's candles, one per raw condition), when given, extend the replay back over the minutes before the first print (author's go, 2026-10-07): a signal decided before it fills at the NEXT minute's open (the price after the latency, the closest the candle knows)
 * with the tape's measured spread on the adverse side (`estimatedOrder`), and the stop and the trailing are read on each minute's low / high (`candleStop`), the entry minute included; the trades so opened carry `estime`. From the first print on, nothing changes: a position
 * open then continues on the prints. Absent (`radinus/`, the searches, the calibrations), nothing happens before the first print, as before.
 *
 * `script` (`StopScript`, `botScript.ts`; needs `bars`), when given, is called once at every print and every minute close and acts through the same orders, stop, trailing and gates on one book per sub-account (its `accounts`, each with its own trades `out` and guard: `out` and `guard` here are then
 * not read, the pnl and trades returned are the books' sums), but sends no order before the first print (no estimated trade); absent, the replay is the one above to the last digit.
 */
export function replayStop(raw: Uint8Array, firstPrintT: number, fills: MinuteFills, sp: StopPrints, stopPct: number, funding: FundingHours | null, out?: StopTrade[], trail: Trail | null = null, guard: Guard | null = null, only: 1 | 0 | -1 = 0, bars: readonly BenchBar[] | null = null, script: StopScript | null = null): { pnl: number; trades: number; halt: Halt | null } {
  const { latencyMs, t0, lastT, lastPx, buy, sell } = fills
  const { first, low, high } = sp
  const K = sp.tape.k
  const scale = Math.round(1 / sp.tape.tick)
  const b = newBook(sp.tape, sp, latencyMs, lastT, lastPx, stopPct, funding, out, guard)
  b.trail = trail
  // A script needs the candles (its closes, its regime): without them none is called. It keeps one book per sub-account, each with its own trades and guard (`ScriptAccount`); `b` is then unused.
  const sc = bars === null ? null : script
  const books =
    sc === null
      ? [b]
      : sc.accounts.map((h) => {
          const x = newBook(sp.tape, sp, latencyMs, lastT, lastPx, stopPct, funding, h.out, h.guard)
          x.trail = trail
          x.script = h
          return x
        })
  const m: ScriptMoment = { close: false, i: 0, x: -1, tMs: 0, px: NaN, o: NaN, h: NaN, l: NaN, c: NaN }
  const spread = bars === null ? 0 : (sp.tape.spreadPct ?? 0) / 100
  for (let i = 0; i < raw.length; i++) {
    const closeS = t0 + 60 * (i + 1)
    // A script holds nothing before the first print (it sends no order there), so it never reads the candles' stop: its minute is its prints, then its close.
    if (sc !== null && bars !== null) {
      scriptPrints(sp.tape, books, sc, m, i, first[i], first[i + 1], t0, only)
      if (!scriptMinuteClose(books, sc, m, i, bars[i], closeS, raw[i], firstPrintT, fills, sp, only)) break
      continue
    }
    // The stop, on this minute's prints: located by the minute's low / high, then read in that minute only. A trailing reads every print of the minute once it is active or could activate in it (the favourable extreme reaches its `seuil`, widened by 1e-9 as `firstLiquidation`
    // is: the bars' prices and the prints' ticks are not rounded the same way); before that a minute that reaches neither the fixed stop nor that `seuil` is skipped, which is exact: its prints are all under the level any later best must reach to activate.
    const held0 = b.pos
    if (held0 !== null && bars !== null && bars[i].t < firstPrintT) candleStop(b, held0, bars[i], spread)
    else if (held0 !== null) {
      const t = held0.trail
      const fixed = held0.side === 1 ? low[i] <= held0.stopPx : high[i] >= held0.stopPx
      const read = fixed || (t !== null && (Number.isFinite(held0.trailPx) || ((held0.side * ((held0.side === 1 ? high[i] : low[i]) - held0.pxIn)) / held0.pxIn) * 100 >= t.seuil - 1e-9))
      if (read) {
        const end = first[i + 1]
        const x = firstHit(held0, K, scale, i === held0.bar ? held0.lo : first[i], end)
        if (x < end) stopExit(b, x, false)
      }
    }
    const w = decideSide(b, raw[i], closeS * 1000)
    if (w === 0) continue
    if (closeS < firstPrintT) {
      if (bars !== null && i + 1 < bars.length) estimatedOrder(b, w, closeS * 1000 + latencyMs, bars[i + 1], spread, i + 1, only)
      continue
    }
    const at = closeS * 1000 + latencyMs
    if (at > lastT) break
    stopInWait(b, first[i + 1], bound(sp.tape.t, at, true))
    placeOrder(b, w, at, buy[i], sell[i], i + 1, only)
  }
  let pnl = 0
  let trades = 0
  for (const x of books) {
    bookClose(x, lastT / 1000, lastPx, false)
    pnl += x.realized
    trades += x.trades
  }
  return { pnl, trades, halt: guard === null ? null : guard.halt }
}
