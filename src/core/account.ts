/**
 * The fake account's formulas, ONCE, for the page (`/rsi`, `playerAccount.ts`) and for Radinus (the paper exchange): all as functions of the market's inputs (its margins) and of the bot's two settings (the share at stake):
 *
 *   leverage L          = 10000 / minimum initial margin (hundredths of %), rounded down: the page's `leverageOf`
 *   starting account    = 100 / L / share                    (enough to carry 100 $ of notional at the maximum leverage)
 *   a trade's stake     = account x share
 *   trade notional      = stake x L
 *   PnL in $            = the page's PnL (per 100 $, funding included if given) x notional / 100
 *   PnL in % of stake   = PnL in $ / stake x 100
 *
 * Liquidation. The whole account is the collateral (the share not at stake is part of it: it is the "working margin"). For a position of q = notional / entry price units, at price p:
 *   equity = account + side x q x (p - entry price)        maintenance margin = m x q x p        (m = maintenance margin / 10000)
 * There is liquidation when the equity falls to the maintenance margin. Solved for p, with x = share x L (so that account / q = entry price / x):
 *   long  : p <= entry price x (1 - 1/x) / (1 - m)           short : p >= entry price x (1 + 1/x) / (1 + m)
 * The distance (as a fraction of the entry price) depends neither on the account nor on the price: long (1/x - m) / (1 - m), short (1/x - m) / (1 + m). At the maximum leverage, the whole account at stake (x = L), it is ~ initial - maintenance (0.8 % on BTC).
 * What the liquidation does to the account: it loses the stake and the market's liquidation fee (a percentage of the notional), without going below 0; the bot stops.
 *
 * Two settings change the above (author, 2026-10-10, `StakePolicy`): the start account (empty = 100 / L / part) and the stake policy, `part` (as above) or `fixed` (a fixed $ stake at every trade, no reinvest).
 * x is then notional / account at the entry (share x L in `part`); a fixed stake above the account at an entry halts the bot, no entry (`stakeAboveAccount`).
 *
 * What the formula leaves aside: Lighter's mark price (the last trade is read, as the page's stop does), the fees and the funding accrued during the trade, Lighter's liquidation in several steps
 * (the close-out margin, 40 % of the initial one, is not read), the price at which Lighter really liquidates (here: the account loses stake + fee, whatever the exit price), the insurance fund.
 */

import type { MarketMargins } from './playerSearch'
import { PLAYER_NOTIONAL } from './players'

/** The share of the account a bot puts at stake, by default ("90 % of its collateral, to keep a little working margin"): the bots' and the `part` field of `/rsi`. */
export const SHARE_DEFAULT = 0.9

/** The `stake $` field's value until one is typed (`fixed` policy): a starting point for the field only, `part` stays the default policy. */
export const FIXED_STAKE_DEFAULT = 10

/** The maintenance margin as a fraction (Lighter publishes it in hundredths of a percent). */
export const maintenanceOf = (m: MarketMargins): number => m.maintenance / 10000

/** The account a bot starts with: enough to carry `PLAYER_NOTIONAL` (100 $) at leverage `leverage` with share `share`. */
export const initialAccount = (leverage: number, share: number): number => PLAYER_NOTIONAL / leverage / share

/** A trade's stake and its notional, for an account, a share and a leverage. */
export const stakeOf = (account: number, share: number): number => account * share
export const notionalOf = (stake: number, leverage: number): number => stake * leverage

/** The liquidation price of a position (side 1 long / -1 short) entered at `entryPx`; `x` = notional / account at the entry (`exposureOf`). */
export function liquidationPrice(side: 1 | -1, entryPx: number, x: number, maintenance: number): number {
  return side === 1 ? (entryPx * (1 - 1 / x)) / (1 - maintenance) : (entryPx * (1 + 1 / x)) / (1 + maintenance)
}

/** The liquidation distance, in % of the entry price, for a long and for a short; `x` = notional / account (`exposureOf`). */
export function liquidationDistances(x: number, maintenance: number): { long: number; short: number } {
  return { long: (100 * (1 / x - maintenance)) / (1 - maintenance), short: (100 * (1 / x - maintenance)) / (1 + maintenance) }
}

/** The sides whose stop (in %) is at the liquidation level or behind it: it would be of no use. */
export function stopBehindLiquidation(stopPct: number | null, distances: { long: number; short: number }): ('long' | 'short')[] {
  if (stopPct === null) return []
  const out: ('long' | 'short')[] = []
  if (stopPct >= distances.long) out.push('long')
  if (stopPct >= distances.short) out.push('short')
  return out
}

/**
 * The account's settings (author, 2026-10-10, the same on /rsi, /bot and in radinus/): the leverage, the share (`part`), the start account (`null` = auto, `initialAccount`) and the stake policy:
 * `fixedStake` `null` = `part` (stake = account x share, compounding), else that many $ at every trade (no reinvest). Notional = stake x leverage in both.
 */
export type StakePolicy = { leverage: number; share: number; start: number | null; fixedStake: number | null }

/** What an account fixes: its settings (`StakePolicy`), the maintenance margin (fraction) and the liquidation fee (% of the notional). */
export type AccountParams = StakePolicy & { maintenance: number; liquidationFeePct: number }

/** The account a bot starts with: `start` when given, else `100 / L / share`. */
export const startAccountOf = (p: StakePolicy): number => p.start ?? initialAccount(p.leverage, p.share)

/** The stake of a trade entered with `account`: the fixed stake, else `account x share`. */
export const tradeStakeOf = (p: StakePolicy, account: number): number => p.fixedStake ?? stakeOf(account, p.share)

/** x = notional / account at an entry with `account`, what the liquidation reads: in `part` it is computed as share x L, as it always was (the same floating point); with a fixed stake, fixedStake x L / account. */
export const exposureOf = (p: StakePolicy, account: number): number => (p.fixedStake === null ? p.share * p.leverage : notionalOf(p.fixedStake, p.leverage) / account)

/** The liquidation distance of a first trade entered with `account` (%, the short's, the nearer side): /rsi's risk line and /bot's sub-account lines, one expression. */
export const startLiquidationOf = (p: AccountParams, account: number): number => liquidationDistances(exposureOf(p, account), p.maintenance).short

/** A fixed stake above the account at an entry: the bot does not enter and halts (the guard rules' halt, cause `stake`). Never in `part`. */
export const stakeAboveAccount = (p: StakePolicy, account: number): boolean => p.fixedStake !== null && p.fixedStake > account

/** A trade's PnL in $ at notional `notional`: the page's PnL (per `PLAYER_NOTIONAL`) scaled. */
export const pnlOf = (pnl100: number, notional: number): number => (pnl100 * notional) / PLAYER_NOTIONAL

/** The open position's PnL in $ at `price`: `side` +1 long / -1 short, `size` its notional in USDG; the page's PnL on `PLAYER_NOTIONAL` (`pnlOf`'s input) rescaled to `size`. */
export const openPnlOf = (side: 1 | -1, entry: number, size: number, price: number): number => pnlOf((side * (price - entry) / entry) * PLAYER_NOTIONAL, size)

/** Does print `px` liquidate a position of side `side` whose liquidation price is `liquidationPx`? The one rule, the paper exchange's and the page replay's. */
export const liquidated = (side: 1 | -1, px: number, liquidationPx: number): boolean => (side === 1 ? px <= liquidationPx : px >= liquidationPx)

/** The liquidation fee (% of the notional) and what the account becomes: it loses the stake and this fee, without going below 0. */
export const liquidationFee = (feePct: number, notional: number): number => (feePct / 100) * notional
export const accountAfterLiquidation = (account: number, stake: number, fee: number): number => Math.max(0, account - stake - fee)
