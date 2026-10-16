/**
 * The four guard rules of a bot (author, 2026-10-07), each an option of a `/rsi` row and of a bot, empty = off, and ONE code for the page's replay (`replayStop`) and `radinus/`'s paper exchange and bot: both call the functions below through `playerStop.ts`
 * (`decideSide`, `bookClose`, `placeOrder`). No React import.
 *
 *  A. `losses` (N): after N closed trades in a row with a negative PnL (by stop, trailing or signal) the bot is stopped (`halt`, cause `pertes`): no more decision, so no more entry; a position open is not touched (an order already sent is filled).
 *  B. `loss` (X %): when the account falls to or under `account0 - X % x stake0`, stopped the same way (cause `perte`). The page's replay tracks the account itself (`acct`, the formulas of `account.ts`); `radinus/`'s exchange has the account and says it (`guardLoss`).
 *  C. `pause` (M minutes): after an exit by stop or trailing no entry for M minutes: a decision in the window is ignored and the player stays "out until a condition becomes true again", so after the window only a fresh condition enters.
 *  D. `ban` (M minutes): after two exits by stop or trailing in a row on the same side, that side is forbidden for M minutes (the other side stays allowed); a signal for it is ignored.
 *
 * A bot halted by A or B stays so until `reprendre` (`resetGuard`). A trade of PnL 0 is not a loss (it resets the count). The count of D is not reset when the ban begins: a third stop in a row on that side bans again. Times are ms.
 */

import { notionalOf, pnlOf, startAccountOf, tradeStakeOf } from './account'
import type { AccountParams, StakePolicy } from './account'

/** The four values, `null` = the rule is off: N (whole, 1 or more), X (% of the starting stake, above 0 up to 100), M and M (minutes, 1 or more). */
export type Rules = { losses: number | null; loss: number | null; pause: number | null; ban: number | null }
export const NO_RULES: Rules = { losses: null, loss: null, pause: null, ban: null }
export const hasRules = (r: Rules): boolean => r.losses !== null || r.loss !== null || r.pause !== null || r.ban !== null

/** Why and when a bot stopped (ms): `value` = the N or the X that fired; `stake` = its fixed stake ($, `value`) was above the account at an entry (`account.ts`'s `stakeAboveAccount`), no entry. */
export type HaltCause = 'pertes' | 'perte' | 'stake'
export type Halt = { cause: HaltCause; value: number; t: number }

/** What the rules keep between two decisions: the losses in a row, the side of the last stop and how many in a row, the end of the pause, the forbidden side and the end of its ban (0 / 0 = none), the halt. What a restart writes. */
export type GuardState = { streak: number; stopSide: 1 | 0 | -1; stopCount: number; pauseUntil: number; banSide: 1 | 0 | -1; banUntil: number; halt: Halt | null }

/** `floor` = the account at or under which B stops (`null` = B off); `acct` = the page's own account, moved by each booked trade (`null` in `radinus/`, whose exchange tells it to `guardLoss`). */
export type Guard = GuardState & { rules: Rules; floor: number | null; acct: { account: number; policy: StakePolicy } | null }

const FRESH: GuardState = { streak: 0, stopSide: 0, stopCount: 0, pauseUntil: 0, banSide: 0, banUntil: 0, halt: null }

/** `account0` / `stake0` = the starting account and stake (dollars, `account.ts`); `policy` = the account settings the page replays the account with, `null` where the exchange says the account. */
export function newGuard(rules: Rules, account0: number, stake0: number, policy: StakePolicy | null): Guard {
  const floor = rules.loss === null ? null : account0 - (rules.loss / 100) * stake0
  return { ...FRESH, rules, floor, acct: policy === null || floor === null ? null : { account: account0, policy } }
}

/** The guard of a replay from the row's rules and the account (`null` without a rule, unless `script`: a script may set rules mid-run, `rules` decision, so its replay always has one; with no rule on it changes nothing): rule B reads the account the row starts with, so it needs `params`. The one place it is made, for the page's replays, the search's and each sub-account of a script. */
export function guardOf(rules: Rules, params: AccountParams | null, script = false): Guard | null {
  if (!script && !hasRules(rules)) return null
  const account0 = params === null ? 0 : startAccountOf(params)
  return newGuard(rules, account0, params === null ? 0 : tradeStakeOf(params, account0), params)
}

/** `reprendre`: the counters, the pause, the ban and the halt are cleared; the page's account is not (`radinus/` has none). */
export function resetGuard(g: Guard): void {
  Object.assign(g, FRESH)
}

export const guardState = (g: Guard): GuardState => ({ streak: g.streak, stopSide: g.stopSide, stopCount: g.stopCount, pauseUntil: g.pauseUntil, banSide: g.banSide, banUntil: g.banUntil, halt: g.halt === null ? null : { ...g.halt } })
export function restoreGuard(g: Guard, s: GuardState): void {
  Object.assign(g, s, { halt: s.halt === null ? null : { ...s.halt } })
}

/**
 * The rules replaced mid-run by a script (`botScript.ts`'s `rules` decision) at `tMs`: the counters, the pause and the ban running are kept. `account0` / `stake0` give B's floor as `newGuard` does; `policy` / `account` = the account settings and the account now (B tracks it from here
 * when it was off; `policy` null = margins not read, B never fires). A turned on takes `streak` (the losses in a row the script counted), since A's count is kept only while A is on; D's count starts when D is on. A and B are checked at once: a script that sets them already crossed halts now.
 */
export function setGuardRules(g: Guard, rules: Rules, account0: number, stake0: number, policy: StakePolicy | null, account: number, streak: number, tMs: number): void {
  if (g.rules.losses === null && rules.losses !== null) g.streak = streak
  g.rules = rules
  g.floor = rules.loss === null ? null : account0 - (rules.loss / 100) * stake0
  g.acct = policy === null || g.floor === null ? null : (g.acct ?? { account, policy })
  if (g.acct !== null) guardLoss(g, g.acct.account, tMs)
  if (rules.losses !== null && g.halt === null && g.streak >= rules.losses) g.halt = { cause: 'pertes', value: rules.losses, t: tMs }
}

/** B: the account is `account` at `tMs`; stopped when it is at or under the floor. */
export function guardLoss(g: Guard, account: number, tMs: number): void {
  if (g.floor !== null && g.halt === null && account <= g.floor && g.rules.loss !== null) g.halt = { cause: 'perte', value: g.rules.loss, t: tMs }
}

/** The fixed stake `stake` ($) is above the account at an entry at `tMs` (`radinus/`'s exchange): stopped (cause `stake`), with or without guard rules. */
export function guardStake(g: Guard, stake: number, tMs: number): void {
  if (g.halt === null) g.halt = { cause: 'stake', value: stake, t: tMs }
}

/** A trade closed at `tMs` (`bookClose`): A, then C and D by how it ended, then (page only) B on the account it moved. `pnl` is on 100 $, its sign is all A reads. */
export function guardTrade(g: Guard, side: 1 | -1, pnl: number, stopped: boolean, tMs: number): void {
  const { losses, pause, ban } = g.rules
  if (losses !== null) {
    g.streak = pnl < 0 ? g.streak + 1 : 0
    if (g.halt === null && g.streak >= losses) g.halt = { cause: 'pertes', value: losses, t: tMs }
  }
  if (stopped) {
    if (pause !== null) g.pauseUntil = tMs + pause * 60000
    if (ban !== null) {
      g.stopCount = side === g.stopSide ? g.stopCount + 1 : 1
      g.stopSide = side
      if (g.stopCount >= 2) {
        g.banSide = side
        g.banUntil = tMs + ban * 60000
      }
    }
  } else g.stopCount = 0
  const a = g.acct
  if (a !== null) {
    a.account += pnlOf(pnl, notionalOf(tradeStakeOf(a.policy, a.account), a.policy.leverage))
    guardLoss(g, a.account, tMs)
  }
}

/** An entry on `side` (`placeOrder`): an entry on the other side than the last stop's ends the two-stops count of D. */
export function guardEntry(g: Guard, side: 1 | -1): void {
  if (g.stopSide !== side) g.stopCount = 0
}

/**
 * Whether the guard lets the decision at `tMs` go on: `'halt'` = no decision at all, `'pause'` = C's window (the decision is ignored and a fresh condition is needed after it), `'ok'`. D is `guardBans`, which needs the side the decision would take.
 */
export const guardGate = (g: Guard, tMs: number): 'ok' | 'halt' | 'pause' => (g.halt !== null ? 'halt' : tMs < g.pauseUntil ? 'pause' : 'ok')

/** D: `side` is forbidden at `tMs`. */
export const guardBans = (g: Guard, side: 1 | -1, tMs: number): boolean => side === g.banSide && tMs < g.banUntil
