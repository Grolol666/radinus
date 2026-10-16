/**
 * `/bot`'s fake sub-accounts (author's go, 2026-10-10): each a name, a collateral in USDG and its own stake settings (leverage, share / fixed stake), isolated like Lighter's sub-accounts. A sub-account's collateral IS its starting account: its stake is computed on it
 * with its own leverage and share / fixed stake (`account.ts`'s `StakePolicy`, `start` = the collateral). Every script order names one (`account: 'sub1'`, `botScript.ts`). No React.
 */

import { notionalOf, startAccountOf, startLiquidationOf, tradeStakeOf } from './account'
import type { AccountParams } from './account'
import type { AccountTrade } from './playerAccount'
import type { Halt } from './playerRules'
import type { StopTrade } from './playerStop'
// Stub for radinus: `PlayerFigures` / `PartFigures` are the /rsi page store's types (rsiStore.ts, browser-only), copied here as they are.
import type { AccountRun } from './playerAccount'
type PlayerFigures = { trades: number | null; wins: number | null; losses: number | null; fixed: number | null; replayed: number | null; account: AccountRun | null; measured: PartFigures | null; estimated: PartFigures | null }
type PartFigures = { trades: number; wins: number; losses: number; fixed: number; replayed: number }

/** A sub-account's own stake settings: `leverage` `null` = the market's maximum (a chosen one is capped by it), `share` the part (0 to 1], `fixedStake` `null` = `part`, else that many $ at every trade (`StakePolicy`). */
export type SubSettings = { leverage: number | null; share: number; fixedStake: number | null }

/** `collateral` in USDG, `null` = auto (`100 / leverage / share`, what the old empty start field gave). */
export type SubAccount = SubSettings & { name: string; collateral: number | null }

/** The longest name a sub-account takes. */
export const SUB_NAME_MAX = 24

/** A draft or sketch from before the sub-accounts: ONE sub-account, `sub1`, whose collateral is the old start account, with the bot's old settings. */
export const subsFromStart = (start: number | null, bot: SubSettings): SubAccount[] => [{ name: 'sub1', collateral: start, ...bot }]

/** A name the list accepts: trimmed, not empty, at most `SUB_NAME_MAX` characters. */
export const subNameOf = (s: string): string | null => {
  const t = s.trim()
  return t === '' || t.length > SUB_NAME_MAX ? null : t
}

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/**
 * A stored list read back: an array of `{name, collateral, leverage, share, fixedStake}`, names valid and distinct, collaterals above 0 or `null`, leverages whole from 1 or `null`, shares in (0, 1], fixed stakes above 0 or `null`, at least one; anything else is `null` (not restored).
 * A settings field ABSENT (a list saved before they were per sub-account) takes `bot`'s: the bot's old leverage / part / fixed stake, so an old draft replays as it did.
 */
export function sanitizeSubs(x: unknown, bot: SubSettings): SubAccount[] | null {
  if (!Array.isArray(x) || x.length === 0) return null
  const out: SubAccount[] = []
  for (const v of x) {
    if (typeof v !== 'object' || v === null) return null
    const o = v as { name?: unknown; collateral?: unknown; leverage?: unknown; share?: unknown; fixedStake?: unknown }
    const n = typeof o.name === 'string' ? subNameOf(o.name) : null
    if (n === null || out.some((s) => s.name === n)) return null
    const collateral = o.collateral
    if (!(collateral === null || positive(collateral))) return null
    const leverage = o.leverage === undefined ? bot.leverage : o.leverage
    if (!(leverage === null || (positive(leverage) && Number.isInteger(leverage)))) return null
    const share = o.share === undefined ? bot.share : o.share
    if (!(positive(share) && share <= 1)) return null
    const fixedStake = o.fixedStake === undefined ? bot.fixedStake : o.fixedStake
    if (!(fixedStake === null || positive(fixedStake))) return null
    out.push({ name: n, collateral, leverage, share, fixedStake })
  }
  return out
}

/** Two lists the same, field by field. */
export const sameSubs = (a: readonly SubAccount[], b: readonly SubAccount[]): boolean =>
  a.length === b.length && a.every((s, k) => s.name === b[k].name && s.collateral === b[k].collateral && s.leverage === b[k].leverage && s.share === b[k].share && s.fixedStake === b[k].fixedStake)

/**
 * The account settings of one sub-account: `market` = the market's (its maintenance and liquidation fee) with `leverage` = the market's MAXIMUM (`rsiStake.ts`'s `marketParams`); the sub-account's leverage (`null` = that maximum, a chosen one capped by it,
 * as `applyLimits` caps /rsi's), share and fixed stake, its collateral as the start account.
 */
export const subParams = (market: AccountParams, s: SubAccount): AccountParams => ({
  ...market,
  leverage: s.leverage === null ? market.leverage : Math.min(s.leverage, market.leverage),
  share: s.share,
  start: s.collateral,
  fixedStake: s.fixedStake,
})

/** A sub-account's first trade at its settings, what its line on /bot shows: the leverage in use, the start account (its collateral, or auto), the stake and the liquidation distance (%, the short's, the nearer side) — /rsi's risk line's figures (`startLiquidationOf`). */
export type SubRisk = { leverage: number; account: number; stake: number; size: number; liquidation: number }
export function subRiskOf(market: AccountParams, s: SubAccount): SubRisk {
  const p = subParams(market, s)
  const account = startAccountOf(p)
  const stake = tradeStakeOf(p, account)
  // `size` = the first trade's notional (stake x leverage, USDG), the order form's "Size" (author, 2026-10-10).
  return { leverage: p.leverage, account, stake, size: notionalOf(stake, p.leverage), liquidation: startLiquidationOf(p, account) }
}

/** One sub-account's result in the bot's last replay: its trades and the guard rule that halted it (`null` = none yet / none), and its figures (`figuresOf` on its own collateral). */
/** A sub-account's trades and halt after a replay (`BotScriptRun.subTrades`). */
export type SubTrades = { name: string; trades: StopTrade[]; halt: Halt | null }

export type BotSub = { name: string; trades: AccountTrade[] | null; halt: Halt | null; figures: PlayerFigures }

/**
 * The sub-accounts together: their trades, wins and losses added, `fixed` and `replayed` in % of the starting stakes added up (each sub-account's own figure weighted by its starting stake), `account0` / `account` = the collaterals at the start and at the end, USDG.
 * With one sub-account it is that sub-account's figures. `null` while one of them has none.
 */
export type SubTotal = { trades: number; wins: number; losses: number; fixed: number; replayed: number; account0: number; account: number }
export function subTotal(subs: readonly BotSub[]): SubTotal | null {
  if (subs.length === 1) {
    const f = subs[0].figures
    const r = f.account
    return r === null || f.trades === null || f.wins === null || f.losses === null || f.fixed === null || f.replayed === null ? null : { trades: f.trades, wins: f.wins, losses: f.losses, fixed: f.fixed, replayed: f.replayed, account0: r.account0, account: r.account }
  }
  const t: SubTotal = { trades: 0, wins: 0, losses: 0, fixed: 0, replayed: 0, account0: 0, account: 0 }
  let stake0 = 0
  for (const s of subs) {
    const f = s.figures
    const r = f.account
    if (r === null || f.trades === null || f.wins === null || f.losses === null || f.fixed === null || f.replayed === null) return null
    t.trades += f.trades
    t.wins += f.wins
    t.losses += f.losses
    t.fixed += f.fixed * r.stake0
    t.replayed += f.replayed * r.stake0
    t.account0 += r.account0
    t.account += r.account
    stake0 += r.stake0
  }
  if (stake0 > 0) {
    t.fixed /= stake0
    t.replayed /= stake0
  }
  return t
}
