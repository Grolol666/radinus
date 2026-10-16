/**
 * A row's two results on the real stake (author, 2026-10-05): the trades the row's replay booked (`replay` / `replayStop`, on 100 $ of notional) read as the bots' fake account reads them - `account.ts`, the formulas
 * shared with `radinus/`'s paper exchange: the account starts at `100 / leverage / share`, each trade stakes `share` of what it holds at the market's maximum leverage, its PnL (on 100 $) is scaled to that notional and added; the position
 * is liquidated when a print AFTER its fill and up to its exit (the exit's own instant included) reaches its liquidation price (`liquidationPrice`, `liquidated`), the stop's trigger print and the 300 ms of its exit being read too, as
 * the exchange's `watch` does; the account then loses the stake and the liquidation fee (`accountAfterLiquidation`) and the replay ends there - the trades after it do not exist, and the liquidated position is not a trade. An account at 0 or
 * under after a trade ends the replay at the next entry (`compte_epuise`). No React import.
 *
 * The trades the row books are the same whatever the account: this is a pass over them. With a fixed stake (`StakePolicy`) the liquidation level reads the account at the entry, and a stake above it ends the replay there (`arrete`, cause `stake`). What it reads of the prints:
 * per trade, the minutes it spans through the bars' low / high (`StopPrints`), the prints themselves only in a minute whose low (long) / high (short) reaches the level.
 */

import { accountAfterLiquidation, exposureOf, liquidated, liquidationFee, liquidationPrice, notionalOf, pnlOf, stakeAboveAccount, startAccountOf, tradeStakeOf } from './account'
import type { AccountParams } from './account'
import type { Halt, HaltCause } from './playerRules'
import { bound } from './playerStop'
import type { StopPrints } from './playerStop'
import type { BenchBar } from './zonesBench'

/** What the account reads of a trade (a `StopTrade` or a `LeanTrade`): times in s, `pnl` on `PLAYER_NOTIONAL`, funding included when it is on; `estime` = opened before the first print, on the candles (`replayStop`'s `bars`). */
export type AccountTrade = { side: 1 | -1; tIn: number; pxIn: number; tOut: number; pnl: number; estime?: true }

/** How a replay ended before its trades did: liquidated (the print that did it, the position's entry and its level), out of money at an entry (`t` in ms), or stopped by a guard rule (`playerRules.ts`: A `pertes` or B `perte`, `value` = its N or X, `t` = the instant of the trade that fired it). */
export type AccountEnd = { kind: 'liquide'; t: number; px: number; side: 1 | -1; entryT: number; entryPx: number; liquidationPx: number } | { kind: 'epuise'; t: number } | { kind: 'arrete'; t: number; cause: HaltCause; value: number }

/**
 * The replay's result: the starting account and stake (dollars), the account at the end, the trades it counts (up to the end), their PnL on 100 $ added up (`pnl100`), and the two figures of the row in % of the starting stake: `fixed` = every
 * trade on that stake, `account` = the account's own change (`radinus`'s `pnlPctMiseDepart`: `100 * (account - account0) / stake0`).
 */
export type AccountRun = { account0: number; stake0: number; account: number; trades: number; wins: number; losses: number; pnl100: number; fixed: number; pct: number; ended: AccountEnd | null; /** The liquidation level of the last of `trades` when the replay entered it, `null` otherwise (what `openLiquidation` reads). */ lastLevel: number | null }

/**
 * The first print (an index of `sp.tape`) strictly after `tInMs` and up to `tOutMs` that liquidates a position of `side` at `level`, -1 if none. `t0` = the first bar's time (s): a print's minute is `(t - t0 * 1000) / 60000`. A minute inside the bars
 * is read print by print only when its low (long) / high (short) reaches the level (widened by 1e-9, the bars' prices and the prints' ticks not being rounded the same way: the print decides); a print outside the bars is read as it is.
 */
export function firstLiquidation(sp: StopPrints, t0: number, side: 1 | -1, tInMs: number, tOutMs: number, level: number): number {
  const { t: T, k: K } = sp.tape
  const scale = Math.round(1 / sp.tape.tick)
  const nb = sp.low.length
  const hi = bound(T, tOutMs, true)
  let x = bound(T, tInMs, true)
  while (x < hi) {
    const i = Math.floor((T[x] - t0 * 1000) / 60000)
    if (i < 0 || i >= nb) {
      if (liquidated(side, K[x] / scale, level)) return x
      x++
      continue
    }
    const end = Math.min(hi, sp.first[i + 1])
    const reached = side === 1 ? sp.low[i] <= level * (1 + 1e-9) : sp.high[i] >= level * (1 - 1e-9)
    if (!reached) {
      x = end
      continue
    }
    for (; x < end; x++) if (liquidated(side, K[x] / scale, level)) return x
  }
  return -1
}

/**
 * The first candle (an index of `bars`) before the first print that liquidates an ESTIMATED position of `side` at `level`, -1 if none: the minutes from the one the entry filled in up to, excluding, the one the exit filled in (a stop's exit is timed at its minute's end, so its own minute
 * counts), and before the tape's first print, where `firstLiquidation` takes over. The candle does not say what came first, so a minute whose low (long) / high (short) reaches the level liquidates, whatever else it did.
 */
export function candleLiquidation(bars: readonly BenchBar[], sp: StopPrints, t0: number, side: 1 | -1, tInMs: number, tOutMs: number, level: number): number {
  const printed = sp.tape.t.length === 0 ? bars.length : Math.floor((sp.tape.t[0] - t0 * 1000) / 60000)
  const end = Math.min(Math.floor((tOutMs - t0 * 1000) / 60000), printed, bars.length)
  for (let i = Math.max(0, Math.floor((tInMs - t0 * 1000) / 60000)); i < end; i++) if (liquidated(side, side === 1 ? bars[i].l : bars[i].h, level)) return i
  return -1
}

/** The prints of the minute still forming (ms, sorted): not in the tape, which is built from the closed minutes, so the position still open at the tape's end is checked against them apart (`openLiquidation`). */
export type TailPrint = { t: number; px: number }

/**
 * The first print of `tail` strictly after the entry that liquidates `trade` (the account's last one) if it is still open - closed at the tape's last print, the simulation's close of what is held at the end - -1 otherwise.
 * Without it a print of the forming minute that liquidates waits for a print of a later minute to close its minute: 3.5 minutes on ASTS 2026-10-06 (13:57:39 seen at 14:01:02), hours on a quieter market; the bots see it at once.
 */
export function openLiquidation(trade: AccountTrade, sp: StopPrints, level: number, tail: readonly TailPrint[]): number {
  const n = sp.tape.t.length
  if (tail.length === 0 || n === 0 || Math.round(trade.tOut * 1000) < sp.tape.t[n - 1]) return -1
  const tIn = Math.round(trade.tIn * 1000)
  for (let j = 0; j < tail.length; j++) if (tail[j].t > tIn && liquidated(trade.side, tail[j].px, level)) return j
  return -1
}

/** The account replayed over `trades` (in time order): see the file's header. `t0` = the first bar's time (s), `sp` = the prints as the stop reads them, `tail` = the forming minute's prints, read for the last trade only. `halt` = the guard rule that stopped the player (`replayStop`'s): it ends the run as `arrete` unless a liquidation or an empty account ended it first (the trades it let through are already the only ones). `bars` = the candles, read for the trades marked `estime` before the first print (`candleLiquidation`). */
export function replayAccount(trades: AccountTrade[], sp: StopPrints, t0: number, params: AccountParams, tail: readonly TailPrint[] = [], halt: Halt | null = null, bars: readonly BenchBar[] | null = null): AccountRun {
  const { leverage, maintenance, liquidationFeePct } = params
  const account0 = startAccountOf(params)
  const stake0 = tradeStakeOf(params, account0)
  const scale = Math.round(1 / sp.tape.tick)
  let account = account0
  let counted = 0
  let wins = 0
  let pnl100 = 0
  let ended: AccountEnd | null = null
  let lastLevel: number | null = null
  for (const tr of trades) {
    if (account <= 0) {
      account = 0
      ended = { kind: 'epuise', t: tr.tIn * 1000 }
      break
    }
    const tInMs = Math.round(tr.tIn * 1000)
    if (stakeAboveAccount(params, account)) {
      ended = { kind: 'arrete', t: tInMs, cause: 'stake', value: tradeStakeOf(params, account) }
      break
    }
    const stake = tradeStakeOf(params, account)
    const notional = notionalOf(stake, leverage)
    const level = liquidationPrice(tr.side, tr.pxIn, exposureOf(params, account), maintenance)
    if (tr === trades[trades.length - 1]) lastLevel = level
    const tOutMs = Math.round(tr.tOut * 1000)
    const c = bars !== null && tr.estime === true ? candleLiquidation(bars, sp, t0, tr.side, tInMs, tOutMs, level) : -1
    if (c >= 0 && bars !== null) {
      account = accountAfterLiquidation(account, stake, liquidationFee(liquidationFeePct, notional))
      ended = { kind: 'liquide', t: bars[c].t * 1000, px: tr.side === 1 ? bars[c].l : bars[c].h, side: tr.side, entryT: tr.tIn * 1000, entryPx: tr.pxIn, liquidationPx: level }
      break
    }
    const x = firstLiquidation(sp, t0, tr.side, tInMs, tOutMs, level)
    const y = x >= 0 || tr !== trades[trades.length - 1] ? -1 : openLiquidation(tr, sp, level, tail)
    if (y >= 0) {
      account = accountAfterLiquidation(account, stake, liquidationFee(liquidationFeePct, notional))
      ended = { kind: 'liquide', t: tail[y].t, px: tail[y].px, side: tr.side, entryT: tr.tIn * 1000, entryPx: tr.pxIn, liquidationPx: level }
      break
    }
    if (x >= 0) {
      account = accountAfterLiquidation(account, stake, liquidationFee(liquidationFeePct, notional))
      ended = { kind: 'liquide', t: sp.tape.t[x], px: sp.tape.k[x] / scale, side: tr.side, entryT: tr.tIn * 1000, entryPx: tr.pxIn, liquidationPx: level }
      break
    }
    account += pnlOf(tr.pnl, notional)
    counted++
    if (tr.pnl > 0) wins++
    pnl100 += tr.pnl
  }
  if (ended === null && halt !== null) ended = { kind: 'arrete', t: halt.t, cause: halt.cause, value: halt.value }
  return { account0, stake0, account, trades: counted, wins, losses: counted - wins, pnl100, fixed: (100 * pnl100) / stake0, pct: (100 * (account - account0)) / stake0, ended, lastLevel }
}

/** Whether two replays are the same values: the trades, wins, losses, `mise fixe`, `compte`, the dollars and how each ended (liquidated or out of money, and when), digit for digit. */
export function sameRun(a: AccountRun, b: AccountRun): boolean {
  const e = a.ended
  const f = b.ended
  const sameEnd = e === f || (e !== null && f !== null && e.kind === f.kind && e.t === f.t)
  return Object.is(a.trades, b.trades) && Object.is(a.wins, b.wins) && Object.is(a.losses, b.losses) && Object.is(a.fixed, b.fixed) && Object.is(a.pct, b.pct) && Object.is(a.account, b.account) && Object.is(a.account0, b.account0) && Object.is(a.pnl100, b.pnl100) && sameEnd
}
