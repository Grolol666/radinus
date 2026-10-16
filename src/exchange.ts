/**
 * The paper exchange: a bot's fake account (formulas and limits in `core/account.ts`, the page's). It fills the orders the bot sends, holds their stop-loss, triggers it when a print reaches it,
 * liquidates, and tells the bot all of it (`ExchangeEvent`): it touches neither its journal nor its state. The fill and stop rules are THE PAGE'S, called one by one (`core/playerStop.ts`,
 * `hedgeSim.ts`): `placeOrder` (close the old position, open the new one, its stop set at the fill price), `firstHit` (the print that reaches the effective stop: the tighter of the fixed stop and the trailing, `stopHit`), `stopExitAt` and `fillStop` (the market exit, the latency
 * after the trigger), `bookClose` (the closing at the end). The book (`Book`) is the page's: its trades are per 100 $; the fake account scales them to its notional.
 *
 * Time. An order is filled at `atMs` (the close + the latency); the exchange knows the last print before `atMs` only once the clock has passed: the order waits, the engine executes it at its due time (`resolveNext`).
 * A position is watched only on the prints STRICTLY after its fill. The stop-loss lives exactly as long as its position (author, 2026-10-05): the old position's stays active until the
 * fill of the order that replaces it, as the liquidation does. While waiting, in order: the prints up to the due time included (each: the liquidation first, then the stop); if the stop was reached, its exit
 * (`exitByStop`, the latency after the print, so sometimes after the order's due time: the order then waits for that exit to be executed, and the old position is booked "stop"); then the order's fill
 * (`placeOrder`), at the price of ITS due time, which opens the new side whatever happens. The rules are the page's (`placeOrder`, `stopInWait`).
 */

import { opportunityFillAt } from './core/hedgeSim'
import { LEAN_SIM_LATENCY_MS } from './core/leanSim'
import { afterStopped, bookClose, effectiveStop, exitByStop, fillStop, firstHit, newBook, placeOrder, stopExitAt, takeFill } from './core/playerStop'
import type { Book, ScriptAccount, StopTrade, Take, Trail } from './core/playerStop'
import { fundingPaid } from './core/funding'
import { guardLoss, guardStake } from './core/playerRules'
import type { Guard } from './core/playerRules'
import { accountAfterLiquidation, exposureOf, liquidated, liquidationFee, liquidationPrice, notionalOf, pnlOf, stakeAboveAccount, tradeStakeOf } from './core/account'
import type { AccountParams } from './core/account'
import type { Market } from './market'
import type { Exchange, ExchangeEvent, Order } from './seam'

const HOUR_MS = 3.6e6

/** What waits: `at` = the due time (ms); an order (else its stop exit, `order` null); `stopAt` = the stop exit of the old position, hit while this order waited (the order then executes at that due time). */
type Pending = { at: number; order: Order | null; stopAt: number | null; close?: true }
/** What `snapshot` writes: of the page book's position, what is needed to find it again (`lo`, a window index, is read only by the page's path). */
export type ExchangeState = {
  account: number
  halted: boolean
  pending: { at: number; order: Order | null; stopAt: number | null; close?: true }[]
  pos: Position | null
  /** `trail`, `best`, `trailPx` (`null` = not active yet) and `byTrail`: the position's trailing and where it stands; absent from a state written before it (no trailing). */
  bookPos: { side: 1 | -1; tIn: number; pxIn: number; qty: number; stopPx: number | null; bar: number; trail?: Trail; best?: number; trailPx?: number | null; byTrail?: boolean; /** A script's stop at a price (`stopAt`) and take-profit (`takeAt`), when set. */ stopAt?: number; take?: { px: number; mkt: boolean } } | null
  /** A script bot's sub-account only: the stop % in force on its book (`null` = none), which its script set. */
  stopPct?: number | null
}

/** The open position, on the exchange's side: its stake and notional at entry, its liquidation price, the instant of the fill and whether its stop has already been hit. */
export type Position = { side: 1 | -1; fillMs: number; stake: number; notional: number; liquidationPx: number; stopTouched: boolean }

export class PaperExchange implements Exchange {
  readonly book: Book
  /** The page book's trades, per 100 $ (what the page shows): proof 1 compares them. */
  readonly out: StopTrade[] = []
  account: number
  halted = false
  private pending: Pending[] = []
  private pos: Position | null = null
  private drained = 0
  /** A script bot's sub-account (`attach`): its book's stop and trailing are its script's, never an order's. */
  private scripted = false
  /** Prints read so far (`onPrint`), and the take-profit armed at that count (`noteTake`): a take-profit is watched from the print after the call that set it, as the page's `takeHit`. */
  private seq = 0
  private takeArm: { take: Take; seq: number } | null = null
  private readonly market: Market
  private params: AccountParams
  private readonly emit: (e: ExchangeEvent) => void

  /** `guard`: the bot's guard rules (`playerRules.ts`), the same object as the bot's; the book updates them at each closed trade, the exchange tells them the account (rule B). */
  constructor(market: Market, params: AccountParams, account0: number, emit: (e: ExchangeEvent) => void, guard: Guard | null = null) {
    this.market = market
    this.params = params
    this.account = account0
    this.emit = emit
    this.book = newBook(market.tape.view(), null, LEAN_SIM_LATENCY_MS, Infinity, NaN, null, market.cfg.funding, this.out, guard)
  }

  /** A script bot's sub-account: its book reads the script's sub-account (`ScriptAccount`: its trades counted, its guard rules) and starts with no stop (Infinity, as the page's `replayStop` on `/bot`). Called again by a `modifier` with the new run's sub-account; the stop is kept. */
  attach(h: ScriptAccount): void {
    if (!this.scripted) this.book.stopPct = Infinity
    this.scripted = true
    this.book.script = h
    this.book.guard = h.guard
  }

  /** The account settings of the next entries (`modifier`: a sub-account's leverage, share, fixed stake); an open position keeps what it was filled with, the account is not touched. */
  setParams(params: AccountParams): void {
    this.params = params
  }

  /** After a script call: a take-profit it set or moved is armed from the next print on. */
  noteTake(): void {
    const tk = this.book.pos?.take
    if (tk === undefined) this.takeArm = null
    else if (this.takeArm === null || this.takeArm.take !== tk) this.takeArm = { take: tk, seq: this.seq }
  }

  /** The side the orders on their way leave (the last one: 1, -1, or 0 for a close), `null` when none is on its way: a script bot reads it as its position until the fill, so the prints before the fill do not send the same order again. */
  target(): 1 | 0 | -1 | null {
    for (let k = this.pending.length - 1; k >= 0; k--) {
      const o = this.pending[k].order
      if (o !== null) return o.only !== undefined && o.side === -o.only ? 0 : o.side
    }
    return null
  }

  /** The leverage of the NEXT entries: an open position keeps its stake, its notional and its liquidation price (`Position`, written at its fill); an order on its way is filled, at its due time, with the leverage of that moment. */
  setLeverage(leverage: number): void {
    this.params = { ...this.params, leverage }
  }

  /** Receives an order from the bot: it waits for its due time. The current position's stop keeps reading until then. */
  send(order: Order): void {
    if (this.halted) return
    this.pending.push({ at: order.atMs, order, stopAt: null })
  }

  /** The nearest due time (ms) of a pending fill, `Infinity` if there is none. */
  nextDeadline(): number {
    let d = Infinity
    for (const p of this.pending) if (p.at < d) d = p.at
    return d
  }

  /** Executes the nearest pending fill (the engine checked that the clock has passed). */
  resolveNext(): void {
    let k = 0
    for (let i = 1; i < this.pending.length; i++) if (this.pending[i].at < this.pending[k].at) k = i
    const [p] = this.pending.splice(k, 1)
    if (p.close === true) this.fillClose(p.at)
    else if (p.order !== null) this.fillEntry(p.order, p.stopAt)
    else this.fillStopExit(p.at)
  }

  // ---- What `arreter` asks of the exchange (the engine calls it; the bot and the source know nothing of it).

  /** The pending orders are cancelled: a decision sent and not filled yet will open nothing. A stop already hit keeps its exit (a market order sent before the request): the order that waited for it leaves it, alone. */
  cancelOrders(): void {
    const kept: Pending[] = []
    for (const p of this.pending) {
      if (p.order === null) kept.push(p)
      else if (p.stopAt !== null) kept.push({ at: p.stopAt, order: null, stopAt: null })
    }
    this.pending = kept
  }

  /** Exit the position at the market, at the request's instant `atMs`: as a fill, it waits until the clock has passed `atMs` (the last print before is then there), then the page's fill rule. False if there is nothing to close. */
  closeAt(atMs: number): boolean {
    if (this.halted || this.pos === null) return false
    this.pending.push({ at: atMs, order: null, stopAt: null, close: true })
    return true
  }

  /** The open position seen from outside: its side, its entry price, its stop (`null` without a stop), its liquidation price, its stake (USDG) and its size in USDG (the `notional` of the `entree` event; the author wants it in $, 2026-10-12). `null` if there is none. */
  position(): { side: 1 | -1; entry: number; stop: number | null; liquidation: number; stake: number; size: number } | null {
    const pos = this.pos
    const book = this.book.pos
    if (pos === null || book === null) return null
    return { side: pos.side, entry: book.pxIn, stop: Number.isFinite(book.stopPx) ? book.stopPx : null, liquidation: pos.liquidationPx, stake: pos.stake, size: pos.notional }
  }

  /** No position and nothing pending: the bot can leave the list (`retirer`). */
  isFlat(): boolean {
    return this.pos === null && this.pending.length === 0
  }

  /** A print has just been added to the window (the last one, or, arrived late, at index `i`): the open position reads it. */
  onPrint(i: number = this.market.tape.n - 1): void {
    this.seq++
    if (this.halted || this.pos === null) return
    this.watch(i)
  }

  /** The position held at instant `atMs` (the hour's funding): its side and its size in units, `null` if there is none or if it was filled at `atMs` or after. */
  heldAt(atMs: number): { side: 1 | -1; qty: number } | null {
    const pos = this.pos
    const book = this.book.pos
    if (this.halted || pos === null || book === null || pos.fillMs >= atMs) return null
    return { side: pos.side, qty: pos.notional / book.pxIn }
  }

  /** An hour's funding on a position held at its mark: the page's rule (`fundingPaid`, one hour), added to the account and told to the bot. `value` = the API's row for that hour. */
  settleFunding(hourMs: number, held: { side: 1 | -1; qty: number }, value: number): void {
    if (this.halted) return
    const amount = fundingPaid(held.side, held.qty, hourMs - 1, hourMs, new Map([[hourMs / HOUR_MS, value]])).paid
    this.account += amount
    this.emit({ kind: 'funding', t: hourMs, side: held.side, qty: held.qty, value, amount, account: this.account })
  }

  /** The state to write in `etat.json`: everything the exchange holds that a restart must find again (the account, the position and its stop, the pending fills). */
  snapshot(): ExchangeState {
    const bp = this.book.pos
    return {
      account: this.account,
      halted: this.halted,
      pending: this.pending.map((p) => ({ at: p.at, order: p.order, stopAt: p.stopAt, ...(p.close === true ? { close: true as const } : {}) })),
      pos: this.pos,
      bookPos: bp === null ? null : { side: bp.side, tIn: bp.tIn, pxIn: bp.pxIn, qty: bp.qty, stopPx: Number.isFinite(bp.stopPx) ? bp.stopPx : null, bar: bp.bar, ...(bp.trail === null ? {} : { trail: bp.trail, best: bp.best, trailPx: Number.isFinite(bp.trailPx) ? bp.trailPx : null, byTrail: bp.byTrail }), ...(bp.stopAt === undefined ? {} : { stopAt: bp.stopAt }), ...(bp.take === undefined ? {} : { take: { px: bp.take.px, mkt: bp.take.mkt } }) },
      ...(this.scripted ? { stopPct: this.book.stopPct !== null && Number.isFinite(this.book.stopPct) ? this.book.stopPct : null } : {}),
    }
  }

  restore(s: ExchangeState): void {
    this.account = s.account
    this.halted = s.halted
    this.pending = s.pending.map((p) => ({ at: p.at, order: p.order, stopAt: p.stopAt, ...(p.close === true ? { close: true as const } : {}) }))
    this.pos = s.pos === null ? null : { ...s.pos }
    const bp = s.bookPos
    this.book.pos = bp === null ? null : { side: bp.side, tIn: bp.tIn, pxIn: bp.pxIn, qty: bp.qty, stopPx: bp.stopPx === null ? (bp.side === 1 ? -Infinity : Infinity) : bp.stopPx, bar: bp.bar, lo: 0, trail: bp.trail ?? null, best: bp.best ?? bp.pxIn, trailPx: bp.trailPx ?? (bp.side === 1 ? -Infinity : Infinity), byTrail: bp.byTrail === true, ...(bp.stopAt === undefined ? {} : { stopAt: bp.stopAt }), ...(bp.take === undefined ? {} : { take: { px: bp.take.px, x: -1, mkt: bp.take.mkt } }) }
    if (this.scripted && s.stopPct !== undefined) this.book.stopPct = s.stopPct ?? Infinity
    this.noteTake()
  }

  /** The end of the data: an open position is closed at the last print, as on the page; what was waiting is dropped. */
  finish(): void {
    if (this.halted) return
    // An order due before the end but waiting for the stop exit of the old position (due after the last print): the page does not fill that exit, the order closes the old position at its fill.
    const due = this.pending.filter((p) => p.order !== null && p.at > p.order.atMs && p.order.atMs <= this.market.tape.t[this.market.tape.n - 1])
    this.pending = []
    for (const p of due) if (p.order !== null && !this.halted) this.fillEntry(p.order, null)
    if (this.halted) return
    const tape = this.market.tape
    if (this.book.pos === null || tape.n === 0) return
    const lastT = tape.t[tape.n - 1]
    this.book.tape = tape.view()
    bookClose(this.book, lastT / 1000, tape.k[tape.n - 1] / tape.scale, false)
    this.drain(lastT, 'fin')
  }

  /** `stopAt`: the stop exit of the old position, if it was hit while this order waited; it is booked before the order, which opens the new side at its own instant. */
  private fillEntry(order: Order, stopAt: number | null): void {
    const at = order.atMs
    const tape = this.market.tape.view()
    this.book.tape = tape
    if (stopAt !== null && exitByStop(this.book, stopAt)) this.drain(stopAt, 'stop')
    const buy = opportunityFillAt(tape, 1, at) ?? NaN
    const sell = opportunityFillAt(tape, 0, at) ?? NaN
    // A script's book keeps its own stop and trailing (`setStop`, `trailFromNow`); a player's order brings them.
    if (order.account === undefined) {
      this.book.stopPct = order.stopPct
      this.book.trail = order.trail
    }
    const before = this.book.pos
    const only = order.only ?? 0
    const fixed = this.params.fixedStake
    // A fixed stake reads the account after the old position's close: the close first (an order of the other side only), then the entry, unless the stake is above the account (the bot halts, no entry).
    // In `part` the one call as before; the two calls book the same as it (the open finds the position closed, or the close found no price either way).
    placeOrder(this.book, order.side, at, buy, sell, -1, fixed === null ? only : ((-order.side) as 1 | -1))
    this.drain(at, 'signal')
    if (this.account <= 0) {
      this.account = 0
      this.halted = true
      this.pending = []
      this.book.pos = null
      this.emit({ kind: 'compte_epuise', t: at })
      return
    }
    if (fixed !== null) {
      const opens = !(only !== 0 && order.side === -only) && !Number.isNaN(order.side === 1 ? buy : sell)
      if (opens && stakeAboveAccount(this.params, this.account)) {
        if (this.book.guard !== null) guardStake(this.book.guard, fixed, at)
        this.emit({ kind: 'stake_above_account', t: at, stake: fixed, account: this.account })
        return
      }
      placeOrder(this.book, order.side, at, buy, sell, -1, only)
    }
    const pos = this.book.pos
    // The other side of a bot of one side: the position closed (or none to close), nothing opened. A close that found no price leaves the position as it was: that is an order without a price.
    if (order.only !== undefined && order.side === -order.only) {
      this.emit(before !== null && pos === before ? { kind: 'ordre_sans_prix', t: at } : { kind: 'close_order_filled', t: at })
      return
    }
    if (pos === null || pos === before) {
      this.emit({ kind: 'ordre_sans_prix', t: at })
      return
    }
    const stake = tradeStakeOf(this.params, this.account)
    const notional = notionalOf(stake, this.params.leverage)
    const liquidationPx = liquidationPrice(pos.side, pos.pxIn, exposureOf(this.params, this.account), this.params.maintenance)
    this.pos = { side: pos.side, fillMs: at, stake, notional, liquidationPx, stopTouched: false }
    this.emit({ kind: 'entree', t: at, side: pos.side, px: pos.pxIn, qty: notional / pos.pxIn, notional, stake, accountBefore: this.account, stopPx: Number.isFinite(pos.stopPx) ? pos.stopPx : null, liquidationPx })
    // The prints already arrived after the fill (a live feed's clock can pass after them): the position reads them.
    const t = this.market.tape
    let lo = 0
    let hi = t.n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (t.t[mid] <= at) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < t.n && this.pos !== null && !this.halted; i++) this.watch(i)
  }

  /** The market exit of `arreter`: the page's rule (`placeOrder` closes at the unfavourable side's price, `opportunityFillAt`), motif `arret`. A position whose stop is already hit keeps its stop exit. */
  private fillClose(at: number): void {
    const pos = this.pos
    const book = this.book.pos
    if (this.halted || pos === null || book === null || pos.stopTouched) return
    const tape = this.market.tape.view()
    this.book.tape = tape
    const px = opportunityFillAt(tape, book.side === 1 ? 0 : 1, at) ?? NaN
    if (Number.isNaN(px)) {
      this.emit({ kind: 'ordre_sans_prix', t: at })
      return
    }
    bookClose(this.book, at / 1000, px, false)
    this.drain(at, 'arret')
  }

  private fillStopExit(at: number): void {
    this.book.tape = this.market.tape.view()
    fillStop(this.book, at)
    this.drain(at, 'stop')
  }

  /** The trades the book has booked since last time: scaled to the position's notional, added to the account, told to the bot. The exhausted account is seen at the next order. */
  private drain(t: number, reason: 'signal' | 'stop' | 'trailing' | 'fin' | 'arret' | 'take'): void {
    while (this.drained < this.out.length) {
      const tr = this.out[this.drained++]
      const pos = this.pos
      if (pos === null) throw new Error('exchange: a trade is booked without an open position')
      const pnl = pnlOf(tr.pnl, pos.notional)
      this.account += pnl
      if (this.book.guard !== null) guardLoss(this.book.guard, this.account, Math.round(tr.tOut * 1000))
      this.pos = null
      this.emit({ kind: 'sortie', t, side: tr.side, px: tr.pxOut, reason: tr.stopped ? (tr.trailing ? 'trailing' : 'stop') : reason, entryT: Math.round(tr.tIn * 1000), entryPx: tr.pxIn, pnl100: tr.pnl, pnl, pnlPct: (100 * pnl) / pos.stake, account: this.account })
    }
  }

  /** The print of index `i` in the window, read by the open position: the liquidation first (a print that jumps the stop liquidates), then the stop, until the position is closed (by the order that replaces it, or by its stop). Only the prints strictly after the fill count. */
  private watch(i: number): void {
    const pos = this.pos
    const book = this.book.pos
    if (pos === null || book === null) return
    const tape = this.market.tape
    const t = tape.t[i]
    if (t <= pos.fillMs) return
    const px = tape.k[i] / tape.scale
    if (liquidated(pos.side, px, pos.liquidationPx)) {
      this.liquidate(t, px, pos)
      return
    }
    if (pos.stopTouched) return
    if (firstHit(book, tape.k, tape.scale, i, i + 1) === i) {
      pos.stopTouched = true
      this.book.tape = tape.view()
      const exitAt = stopExitAt(this.book, i)
      // An order on its way replaces this position: its stop exit is booked at its execution, which waits for that exit; otherwise the exit waits alone.
      const replacing = this.pending.find((p) => p.order !== null)
      if (replacing === undefined) this.pending.push({ at: exitAt, order: null, stopAt: null })
      else {
        replacing.stopAt = exitAt
        replacing.at = Math.max(replacing.at, exitAt)
      }
      this.emit({ kind: 'stop_touche', t, px, stopPx: effectiveStop(book), exitAt, replaced: replacing !== undefined })
      return
    }
    // A script's take-profit (`takeAt`), this print not reaching the stop (the stop wins a print that reaches both, the page's order): filled at this print's time AT its price (`takeFill`, the page's rule), from the print after the call that set it.
    const tk = book.take
    const arm = this.takeArm
    if (tk === undefined || arm === null || arm.take !== tk || this.seq <= arm.seq) return
    const fill = takeFill(tk, book.side, px)
    if (fill === null) return
    this.book.tape = tape.view()
    bookClose(this.book, t / 1000, fill, false, true)
    afterStopped(this.book)
    this.takeArm = null
    this.drain(t, 'take')
  }

  private liquidate(t: number, px: number, pos: Position): void {
    const fee = liquidationFee(this.params.liquidationFeePct, pos.notional)
    this.account = accountAfterLiquidation(this.account, pos.stake, fee)
    this.book.pos = null
    this.pos = null
    this.pending = []
    this.halted = true
    this.emit({ kind: 'liquidation', t, side: pos.side, px, liquidationPx: pos.liquidationPx, stake: pos.stake, fee, account: this.account })
  }
}
