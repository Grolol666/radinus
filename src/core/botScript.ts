/**
 * The bot's script (`/bot`, author's go 2026-10-08): ONE JavaScript arrow function `(state) => decision` the author writes, called by the replay (`playerStop.ts`'s `StopScript` hook) at every print and at every minute close. Pure, no React, no store: `radinus/` imports it as it is.
 * Empty text = no script = the replay as it was, to the last digit (the hook is not given).
 *
 * `state` (one object per replay, assigned at each call): price, time (ISO UTC), close (true at a minute close), candle {o,h,l,c,v} (the forming minute at a print, v NaN there: the tape has no sizes; the closed bar at a close), spread (%),
 * ema(n) / sma(n) / rsi(n) of the closed 1-minute closes, candles(n) (the n last closed candles, at most `CANDLES_KEPT`), prints(n) (the n last prints, the aggressor side; no sizes), side(player, settings, opts) (the regime's, or a /rsi player's, own side at the last closed minute: 'long' | 'short' | null, playerSide.ts), sideValue(player, settings, opts) ({side, value}: the same side and the player's own value, NaN without one: a band player, the MACD, the regime), sideLines(player, settings, opts) ({upper, lower, middle}: a band player's lines, NaN for any other player), drawings, drawing(name),
 * registers (a plain object the script writes, kept for the whole replay; every replay starts it empty), print(text) (a label on the chart at the call's moment and price, `PRINTS_MAX` per replay, `report().prints`), and accounts: the fake sub-accounts by name (author's go 2026-10-10, `subAccounts.ts`), each isolated as Lighter's (`AccountState`: position, entry, since, gain (% of the stake: the move x the leverage; % of price
 * where the margins are not read), stop (the stop in force, % of price, null = none), stopPrice (the open position's effective stop, a price: the tighter of the fixed stop (its `stopAt` if set) and the trailing), takePrice (its take-profit, a price, or null), rules ({losses, loss, pause, ban} in force), trailing, liquidation, collateral (the sub-account now), trades, wins, losses, lossStreak, paused, forbidden).
 * `decision`: one object or an array of them. Every key but `watch` acts on the sub-account the object names (`account`, always, even with one; without it or with an unknown name the object's orders are ignored and listed): enter 'long' | 'short' (an order, the opposite position closed first), close true, forbid 'long' | 'short' | null (until changed), trail n (a trailing of n % behind the price now, on the open
 * position), pause true / resume true, stop n | null (the stop-loss, % of price, null = none; there is none until the script sets one, and it holds from that call until the script gives another value; it is the SL of every later entry, and the open position's SL is re-anchored on its entry fill, see `setStop`; with an `enter` that reverses, the old position's SL
 * moves too until the order fills), stopAt price | null (the open position's fixed stop at that price, before `stop` %, until it closes; null = back to `stop` %; `setStopAt`), takeAt price | null (its take-profit, a resting limit, until it closes; `setTake`: both are ignored with no position open), rules {losses?, loss?, pause?, ban?} (the guard rules A-D of `playerRules.ts`, each a number or null = off, an absent key keeps its value; all are off until the script sets them, and each holds until given again; the counters and windows running are kept). Both act only when a value changes. Every key is applied at a print as at a close. Unknown keys and bad values are ignored and listed once in `report().ignored`.
 *
 * Speed (author's go 2026-10-08), three rules, all in `call`: (1) ONE `state` object per replay, assigned in place (a script must not keep a reference to it or to its `candle`). (2) At a print where nothing a script can read has changed since its last call (same price, same minute's high and low, every sub-account's same position, trade count, pause and forbid: only `time` and `since` differ), the script is not called: its decision
 * would be built from the same inputs, so the last decision is given back (a pure script, no register that counts calls). A call that applied forbid / trail / pause / resume changed what a script reads, so the next print is called. (3) `watch`: the decision may carry `watch: { above?, below? }`; after it the script is not called at prints (nothing is done at them) until a print reaches `above` (>=) or `below` (<=), or a minute closes, or a position changes on any sub-account
 * (a fill, a stop, a trailing, a liquidation, a close: an open position or a trade count moved); then the watch is cleared until the script returns a new one. `watch: {}` = no price trigger: the next call is the next close or position event. A script that never returns `watch` is called as in (2).
 *
 * Safety: compiled once (`compileScript`) by `new Function` with the browser's globals shadowed as undefined parameters (a guard against mistakes, NOT a sandbox: `(() => {}).constructor` reaches the real ones). A call budget of `SCRIPT_BUDGET_MS` (50 ms): checked after the call with `performance.now()` and, to stop a loop that never
 * returns, inside every `while` / `for(;;)` / `do-while` header, where `instrument` inserts a check. Over budget or thrown = every sub-account is paused from that instant (open positions kept, entries ignored), the script is no longer called, `report().failure` says why and when.
 */

import { exposureOf, liquidationPrice, notionalOf, pnlOf, startAccountOf, tradeStakeOf } from './account'
import type { AccountParams } from './account'
import { bound, effectiveStop, setStop, setStopAt, setTake, trailFromNow, NO_ACT } from './playerStop'
import { NO_RULES, guardOf, setGuardRules } from './playerRules'
import type { Guard, Rules } from './playerRules'
import type { Book, ScriptAccount, ScriptAct, ScriptMoment, StopScript, StopTrade } from './playerStop'
import { subParams } from './subAccounts'
import type { SubAccount, SubTrades } from './subAccounts'
import { SideRun, sideSpecOf } from './playerSide'
import type { SideLines, SideOpts } from './playerSide'
import { EmaFollow, RsiFollow, SmaFollow } from './scriptIndicators'
import type { Follow } from './scriptIndicators'
import { FIB_LEVELS } from './chartDrawings'
import type { Drawing } from './chartDrawings'
import type { FillTape } from './hedgeSim'
import type { BenchBar, RollingBars } from './zonesBench'

/** The most one call may take, ms, on the page's replay and in `radinus/` alike (author, 2026-10-10: 50 ms, "no more than 50 ms all the same"; it was 5). */
export const SCRIPT_BUDGET_MS = 50
/** `state.prints(n)` gives the prints of the last 2 minutes before the call at most (author, 2026-10-10): the window Radinus keeps (`radinus/market.ts` imports it), applied on the page's replay too, so both give a script the same prints. */
export const PRINTS_KEPT_MS = 120000
/** `state.candles(n)` gives at most 2,000 closed candles (author, 2026-10-11: "the candles function is capped at 2000, that's all"), on the page and in `radinus/` alike: a script bot in Radinus keeps that many bars, no more (`radinus/scriptBot.ts`). */
export const CANDLES_KEPT = 2000
/** `state.print(text)`: the most labels one replay records (author's go, 2026-10-11); past it nothing more is recorded and the report says so. A label's text is cut at `PRINT_TEXT_MAX` characters. */
export const PRINTS_MAX = 2000
const PRINT_TEXT_MAX = 40
/** The most distinct ignored keys listed. */
const IGNORED_MAX = 20

/** Names a script cannot reach (they are parameters, undefined). */
const SHADOWED = ['window', 'self', 'globalThis', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location', 'Worker', 'importScripts', 'process', 'require', 'setTimeout', 'setInterval', 'Function']

type Clock = { at: number }
class BudgetError extends Error {}

/** A compiled script: its function and the clock its loop guards read. */
export type CompiledScript = { fn: (state: ScriptState) => unknown; clock: Clock }

export type ScriptFailure = { reason: string; tMs: number }
/** The helpers a replay called, each distinct argument once, sorted (`ScriptReport.used`; the chart no longer draws them, author 2026-10-09). `sides` keeps the arguments of `state.side` as the script gave them. */
/** A label `state.print(text)` wrote: the call's moment (ms) and price, its text (a string, at most 40 characters). The page draws it on the chart; `radinus/` journals it. */
export type ScriptPrint = { tMs: number; px: number; text: string }
export type ScriptUsed = { ema: number[]; sma: number[]; rsi: number[]; sides: { player: string; settings: Record<string, number> | null; opts: SideOpts | null }[] }
/** `drawings`: the replay's script read `state.drawings` / `state.drawing(...)` (the store then replays again when the chart's drawings change, and the page warns). */
export type ScriptReport = { failure: ScriptFailure | null; ignored: string[]; used: ScriptUsed; drawings: boolean; /** Whether the replay saw a `stop` decision with a number, or a `stopAt` applied to a position: `null` = no replay has reported yet. */ stopSet: boolean | null; /** What the script did that is applied and worth knowing (a `stopAt` already reached by the price when set): said in grey under the editor, never refused. */ warnings: string[]; /** The labels the script wrote (`state.print`), in call order, at most `PRINTS_MAX`. */ prints: ScriptPrint[]; /** The calls' times by the budget's own measure: how many were timed, their mean and the largest (ms; `null` before any call). Radinus shows the same on /bots. */ time: { calls: number; meanMs: number | null; maxMs: number } }
export const NO_USED: ScriptUsed = { ema: [], sma: [], rsi: [], sides: [] }
/** A report with nothing to say: no failure, nothing ignored, no helper called. */
export const NO_TIME: ScriptReport['time'] = { calls: 0, meanMs: null, maxMs: 0 }
export const EMPTY_REPORT: ScriptReport = { failure: null, ignored: [], used: NO_USED, drawings: false, stopSet: null, warnings: [], prints: [], time: NO_TIME }

/** A chart drawing as the script sees it (`state.drawings`). A `line` is worth its price at the call's time. */
export type ScriptDrawing =
  | { kind: 'hline'; name: string; price: number }
  | { kind: 'line'; name: string; price: number }
  | { kind: 'fib'; name: string; levels: Record<string, number> }

/** The drawings as the script sees them at `tSec` (unix seconds): a line is extended beyond its two points, linear in time (a vertical one, same times, is its first price). Fib level 0 is at point b, level 1 at point a (`chartDrawings.ts`). */
export function scriptDrawings(list: readonly Drawing[], tSec: number): ScriptDrawing[] {
  return list.map((d): ScriptDrawing => {
    const name = d.name ?? ''
    const b = d.b
    if (d.kind === 'hline' || b === null) return { kind: 'hline', name, price: d.a.price }
    if (d.kind === 'line') return { kind: 'line', name, price: b.time === d.a.time ? d.a.price : d.a.price + ((tSec - d.a.time) * (b.price - d.a.price)) / (b.time - d.a.time) }
    const levels: Record<string, number> = {}
    for (const r of FIB_LEVELS) levels[String(r)] = b.price + r * (d.a.price - b.price)
    return { kind: 'fib', name, levels }
  })
}
/** A run's call times, ms (`BotScriptRun.timing`): a call over the budget is timed too (and made once more, `run`). */
export type ScriptTiming = { lastMs: number; maxMs: number; sumMs: number; timed: number; over: number; overMs: number }
/** How many times the script ran in a replay, and how many prints skipped it (same inputs / `watch`). */
export type ScriptStats = { called: number; sameSkipped: number; watchSkipped: number }

/** One sub-account as the script reads it (`state.accounts.<name>`): its position and what protects it, its account and its counters. */
export type AccountState = {
  position: 'long' | 'short' | 'out'
  entry: number | null
  since: number
  gain: number
  /** The stop-loss in force, % of price (none until the script sets one with `stop`), null = none. */
  stop: number | null
  /** The open position's effective stop, a price (the fixed stop, its `stopAt` if set, or the trailing, the tighter), null when out or none. */
  stopPrice: number | null
  /** The open position's take-profit (`takeAt`), a price, null when out or none. */
  takePrice: number | null
  /** The guard rules in force (all off until the script sets them with `rules`), null = off. */
  rules: Rules
  trailing: boolean
  liquidation: number | null
  /** The sub-account's account now, USDG (its collateral moved by its trades). */
  collateral: number
  /** The sub-account's leverage in use (its own, capped by the market's maximum), NaN where the margins are not read. */
  leverage: number
  /** The stake a trade entered now would commit, USDG (its fixed stake, or its collateral x its part), NaN where the margins are not read. */
  stake: number
  trades: number
  wins: number
  losses: number
  lossStreak: number
  paused: boolean
  forbidden: 'long' | 'short' | null
}

export type ScriptState = {
  price: number
  time: string
  close: boolean
  candle: { o: number; h: number; l: number; c: number; v: number }
  spread: number
  ema: (n: number) => number
  sma: (n: number) => number
  rsi: (n: number) => number
  /** The `n` last CLOSED 1-minute candles, oldest first (`t` in ms = the minute's start), at most `CANDLES_KEPT` (2,000): never the minute in progress; fewer when the history is shorter. The array and its objects are reused by the next call: a script must not keep them. */
  candles: (n: number) => { t: number; o: number; h: number; l: number; c: number; v: number }[]
  /** The `n` last prints within the 2 minutes before the call (`PRINTS_KEPT_MS`), oldest first, up to and including the print this call is on (at a minute close: the last print of that minute), never a later one: `side` is the aggressor ('buy' | 'sell'); `size` is NaN (the tape holds no sizes). Reused by the next call like `candles`. */
  prints: (n: number) => { t: number; price: number; size: number; side: 'buy' | 'sell' }[]
  /** The raw side of the regime (settings period, threshold: fast up = long, fast down = short, calm = null) or of a /rsi player with those settings (by key, the player's defaults for the missing ones), thresholds and rule at the last closed minute: 'long' | 'short' | null (neither, or both). Same conditions as the player's row; see playerSide.ts. */
  side: (player: string, settings?: Record<string, number>, opts?: SideOpts) => 'long' | 'short' | null
  /** `side` with the same arguments (the same run) and the player's own value at the last closed minute: NaN while it warms up or when it has no single value (a band player, the MACD, the regime). */
  sideValue: (player: string, settings?: Record<string, number>, opts?: SideOpts) => { side: 'long' | 'short' | null; value: number }
  /** A band player's lines at the last closed minute (same arguments and run as `side`): upper, lower and middle (the SMA, the EMA, the VWAP, the channel's midline); all NaN for another player or while it warms up. */
  sideLines: (player: string, settings?: Record<string, number>, opts?: SideOpts) => { upper: number; lower: number; middle: number }
  /** The chart's drawings of the bot's market, in creation order (read lazily: nothing is computed unless the script reads it). Drawn knowing the whole history, so the past results that use them look better than they are. */
  readonly drawings: ScriptDrawing[]
  /** The first drawing with that name, or null. */
  drawing: (name: string) => ScriptDrawing | null
  /** The sub-accounts by name (`AccountState`), each isolated: its own position, stop, rules, account. */
  accounts: Record<string, AccountState>
  registers: Record<string, unknown>
  /** Writes `text` (made a string, cut at 40 characters) on the chart at this call's moment and price; at most `PRINTS_MAX` per replay. */
  print: (text: unknown) => void
}

/**
 * What a script reads besides the books: the closed candles, the tape's spread (%), the market's account parameters with the market's maximum leverage (`marketParams`; null = margins not read: collateral NaN, no liquidation, gain in % of price; each sub-account brings its own leverage, share, fixed stake and collateral, `subParams`), the sub-accounts (`subs`, at least one),
 * the guard rules each sub-account starts with (`rules`, the row's: none on /bot) and the per-minute aggressor delta (only the players that read it, such as the CVD, need it).
 */
export type ScriptEnv = { /** The closed candles, indexed from the first one the run could ever read; a `RollingBars` (`radinus/`) is a window of its last `keep`, the older entries deleted: a helper born then starts at the window's first bar. */ bars: readonly BenchBar[] | RollingBars; spreadPct: number; account: AccountParams | null; subs: readonly SubAccount[]; rules: Rules; delta?: number[]; /** The prints (`state.prints`); absent = none. */ tape?: FillTape; /** The chart's drawings of the bot's market (`state.drawings`); absent = none. */ drawings?: readonly Drawing[] }

// ---- compile

const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

/** The index after the string literal opening at `i`. */
function endOfString(src: string, i: number): number {
  const q = src[i]
  let j = i + 1
  while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1
  return j + 1
}

/** The index of the `)` matching the `(` at `k`, -1 if none; and, when `splits` is given, the depth-1 `;` met on the way. */
function matchParen(src: string, k: number, splits?: number[]): number {
  let depth = 0
  for (let j = k; j < src.length; j++) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') j = endOfString(src, j) - 1
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return j
    } else if (c === ';' && depth === 1 && splits !== undefined) splits.push(j)
  }
  return -1
}

/**
 * The script's text with `__g()` (the budget check) inserted in the condition of every `while` and `for(;;)` (a `do-while` is a `while`): `while (c)` -> `while ((__g(), c))`, `for (a; c; d)` -> `for (a; (__g(), c); d)`, an empty `c` -> `(__g(), true)`. A `for-of` / `for-in` is left as it is (it ends with what it
 * walks). Strings and comments are skipped; a regex literal containing `while (` would be rewritten too (harmless).
 */
export function instrument(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i)
      const e = j < 0 ? n : j
      out += src.slice(i, e)
      i = e
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      const e = j < 0 ? n : j + 2
      out += src.slice(i, e)
      i = e
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const e = Math.min(n, endOfString(src, i))
      out += src.slice(i, e)
      i = e
      continue
    }
    if (/[A-Za-z_$]/.test(c) && (i === 0 || (!isId(src[i - 1]) && src[i - 1] !== '.'))) {
      let j = i
      while (j < n && isId(src[j])) j++
      const word = src.slice(i, j)
      if (word === 'while' || word === 'for') {
        let k = j
        while (k < n && /\s/.test(src[k])) k++
        const splits: number[] = []
        const close = src[k] === '(' ? matchParen(src, k, splits) : -1
        if (close > 0 && (word === 'while' || splits.length === 2)) {
          if (word === 'while') out += `${src.slice(i, k)}((__g(), ${src.slice(k + 1, close)}))`
          else {
            const cond = src.slice(splits[0] + 1, splits[1])
            out += `${src.slice(i, k)}(${src.slice(k + 1, splits[0])}; ${cond.trim() === '' ? '(__g(), true)' : `(__g(), (${cond}))`}${src.slice(splits[1], close)})`
          }
          i = close + 1
          continue
        }
      }
      out += src.slice(i, j)
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

/** The text compiled once: `script` null with `error` null for an empty text (no script), `script` null with the message for a text that does not compile or is not a function. */
export function compileScript(text: string): { script: CompiledScript | null; error: string | null } {
  if (text.trim() === '') return { script: null, error: null }
  const clock: Clock = { at: Infinity }
  const guard = () => {
    if (performance.now() > clock.at) throw new BudgetError(`over the ${SCRIPT_BUDGET_MS} ms budget (loop)`)
  }
  try {
    const make = new Function('__g', ...SHADOWED, `"use strict"; return (${instrument(text)}\n)`) as (g: () => void, ...shadowed: undefined[]) => unknown
    const fn = make(guard, ...SHADOWED.map(() => undefined))
    if (typeof fn !== 'function') return { script: null, error: 'the script must be an arrow function: (state) => decision' }
    return { script: { fn: fn as (state: ScriptState) => unknown, clock }, error: null }
  } catch (e) {
    return { script: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

// ---- run

/** The decision keys that act on a sub-account (every one needs `account`); `watch` is the script's. */
const ACCOUNT_KEYS = ['enter', 'close', 'forbid', 'trail', 'pause', 'resume', 'stop', 'stopAt', 'takeAt', 'rules']

/** One sub-account of a run: its pause and forbid, guard, trades and counters, and the object the script reads of it (`view`, assigned in place at each call). */
class SubRun implements ScriptAccount {
  paused = false
  forbidden: 1 | 0 | -1 = 0
  trades = 0
  wins = 0
  losses = 0
  lossStreak = 0
  account: number
  readonly out: StopTrade[] = []
  readonly name: string
  /** This sub-account's account settings (`subParams`: its leverage, share, fixed stake, its collateral as the start), `null` = margins not read. */
  readonly params: AccountParams | null
  readonly guard: Guard | null
  readonly view: AccountState

  constructor(sub: SubAccount, params: AccountParams | null, rules: Rules) {
    this.name = sub.name
    this.params = params === null ? null : subParams(params, sub)
    this.guard = guardOf(rules, this.params, true)
    this.account = this.params === null ? NaN : startAccountOf(this.params)
    this.view = { position: 'out', entry: null, since: 0, gain: 0, stop: null, stopPrice: null, takePrice: null, rules: { ...NO_RULES }, trailing: false, liquidation: null, collateral: NaN, leverage: NaN, stake: NaN, trades: 0, wins: 0, losses: 0, lossStreak: 0, paused: false, forbidden: null }
  }

  traded = (_side: 1 | -1, pnl: number): void => {
    this.trades++
    if (pnl > 0) this.wins++
    else this.losses++
    this.lossStreak = pnl < 0 ? this.lossStreak + 1 : 0
    const a = this.params
    if (a !== null) this.account += pnlOf(pnl, notionalOf(tradeStakeOf(a, this.account), a.leverage))
  }
}

/** What a call's inputs were of the books and sub-accounts: each book's open position and trade count, each sub-account's pause and forbid. */
type Snap = { pos: Book['pos'][]; trades: number[]; paused: boolean[]; forbidden: number[] }
const newSnap = (n: number): Snap => ({ pos: new Array<Book['pos']>(n).fill(null), trades: new Array<number>(n).fill(0), paused: new Array<boolean>(n).fill(false), forbidden: new Array<number>(n).fill(0) })

/** One sub-account's own fields as `radinus/` saves them (`etat.json`) and carries across a `modifier`: its pause and forbid, its counters and its account. */
export type SubRunState = { paused: boolean; forbidden: 1 | 0 | -1; trades: number; wins: number; losses: number; lossStreak: number; account: number }
/** What `radinus/` keeps of a run (`saveState` / `restoreState`): the registers (as JSON), each sub-account's own fields by name, and the failure that paused them all (`null` = none). The helpers are not kept: they rewarm from the bars. */
export type ScriptRunState = { registers: Record<string, unknown>; accounts: Record<string, SubRunState>; failure: ScriptFailure | null }

/** What the script said it would do besides the ignored: the hook the replay calls. One per replay (registers, counters and caches start empty). */
export class BotScriptRun implements StopScript {
  live = true
  /** The sub-accounts, in the list's order: the replay keeps one book for each. */
  readonly accounts: SubRun[]
  /** A name's index in `accounts`. */
  private readonly index = new Map<string, number>()
  private readonly registers: Record<string, unknown> = {}
  private failure: ScriptFailure | null = null
  private readonly ignored = new Set<string>()
  /** The number of closed minutes the helpers answer for, set before each call. */
  private closed = 0
  /** How many bars `env.bars` holds behind the last one: its `keep` for a window (`radinus/`), Infinity on the page (nothing is dropped, every helper starts at bar 0). */
  private readonly kept: number
  // The helpers' running state, one per (kind, period): each is moved forward over the closes that are new since the last call (a close or two), never from the first bar.
  private readonly emas = new Map<number, EmaFollow>()
  private readonly smas = new Map<number, SmaFollow>()
  private readonly rsis = new Map<number, RsiFollow>()
  private readonly sides = new Map<string, SideRun | null>()
  /** The arguments of each valid `state.side` call, by the same key as `sides`. */
  private readonly sideArgs = new Map<string, ScriptUsed['sides'][number]>()
  /** The reused answers of `candles` / `prints`: objects are made once and rewritten, the arrays cut to the answer's length. */
  private readonly candleBuf: ReturnType<ScriptState['candles']> = []
  private readonly printBuf: ReturnType<ScriptState['prints']> = []
  /** The labels written by `state.print`, and whether one was dropped past `PRINTS_MAX`. */
  private labels: ScriptPrint[] = []
  private labelsDropped = false
  /** The tape index of the print the call is on (-1 = none yet). */
  private printAt = -1
  /** Set once the script has read `prints`: two prints at the same price and range are no longer the same input, so the "same inputs" skip is off. */
  private readPrints = false
  /** Set once the script has read `drawings` / `drawing`: a line's price moves with the time, so the "same inputs" skip is off too, and the report says so. */
  private readDrawings = false
  /** Set by `apply` when a decision changed what a script reads besides the positions (a trailing, a forbid, a stop, the rules). */
  private moved = false
  private called = 0
  private sameSkipped = 0
  private watchSkipped = 0
  /** The `watch` in force: the prices, with the books' positions and trade counts it was set with (`watchSnap`); `null`: none. */
  private watch: { above: number; below: number } | null = null
  private readonly watchSnap: Snap
  /** The inputs of the last print called (`lastSnap` for the books and sub-accounts); its decision is `acts` as they stand (`null`: none, or the call changed what a script reads). */
  private last: { px: number; h: number; l: number; i: number } | null = null
  private lastSnap: Snap
  /** The books and sub-accounts before the call in progress: becomes `lastSnap` when the call qualifies. */
  private pre: Snap
  /** The acts of the last call, one per sub-account, rewritten by each call (the replay reads them at once); `none` = all empty. */
  private readonly acts: ScriptAct[]
  private readonly none: readonly ScriptAct[]

  private readonly compiled: CompiledScript
  private readonly env: ScriptEnv

  constructor(compiled: CompiledScript, env: ScriptEnv) {
    this.compiled = compiled
    this.env = env
    this.kept = 'keep' in env.bars ? env.bars.keep : Infinity
    this.accounts = env.subs.map((s) => new SubRun(s, env.account, env.rules))
    const n = this.accounts.length
    this.accounts.forEach((a, k) => {
      this.index.set(a.name, k)
      this.state.accounts[a.name] = a.view
    })
    this.acts = this.accounts.map(() => ({ enter: 0, close: false }))
    this.none = this.accounts.map(() => NO_ACT)
    this.watchSnap = newSnap(n)
    this.lastSnap = newSnap(n)
    this.pre = newSnap(n)
  }

  /** Set once a decision carried a `stop` with a number (null does not count), or a `stopAt` applied to a position. */
  private stopSet = false
  /** The first `stopAt` set already reached by the price (ms), NaN = none. */
  private wrongStopAt = NaN

  report = (): ScriptReport => ({
    failure: this.failure,
    ignored: [...this.ignored],
    used: this.used(),
    drawings: this.readDrawings,
    stopSet: this.stopSet,
    time: { calls: this.time.timed, meanMs: this.time.timed === 0 ? null : this.time.sumMs / this.time.timed, maxMs: this.time.maxMs },
    warnings: [
      ...(Number.isNaN(this.wrongStopAt) ? [] : [`stopAt already reached by the price when set (a long's above it, a short's under it), first at ${new Date(this.wrongStopAt).toISOString()}: it fires at the next print`]),
      ...(this.labelsDropped ? [`print: ${PRINTS_MAX.toLocaleString('en-US')} labels, the rest dropped`] : []),
    ],
    prints: this.labels,
  })

  /** The labels written since the last take, removed from the run (`radinus/` journals each, so a live run is never capped by `PRINTS_MAX`). The page never calls it. */
  takePrints = (): ScriptPrint[] => {
    if (this.labels.length === 0) return []
    const out = this.labels
    this.labels = []
    return out
  }

  /** The registers and each sub-account's own fields (`radinus/`: `etat.json`, `modifier`). The registers go through JSON: what it cannot hold (a function, a Map, NaN) is lost or changed. The page never calls it. */
  saveState = (): ScriptRunState => ({
    registers: JSON.parse(JSON.stringify(this.registers) ?? '{}') as Record<string, unknown>,
    accounts: Object.fromEntries(this.accounts.map((a) => [a.name, { paused: a.paused, forbidden: a.forbidden, trades: a.trades, wins: a.wins, losses: a.losses, lossStreak: a.lossStreak, account: a.account }])),
    failure: this.failure,
  })

  /** Puts a saved state back (`radinus/`): the registers, and the fields of each sub-account the state names that this run has (`keepFailure` false: a failure saved is dropped, the run starts live, as `reprendre` or a new script asks). */
  restoreState = (s: ScriptRunState, keepFailure = true): void => {
    for (const k of Object.keys(this.registers)) delete this.registers[k]
    Object.assign(this.registers, s.registers)
    for (const a of this.accounts) {
      const x = s.accounts[a.name]
      if (x === undefined) continue
      a.paused = x.paused
      a.forbidden = x.forbidden
      a.trades = x.trades
      a.wins = x.wins
      a.losses = x.losses
      a.lossStreak = x.lossStreak
      a.account = x.account
    }
    if (keepFailure && s.failure !== null) {
      this.failure = s.failure
      this.live = false
      for (const a of this.accounts) a.paused = true
    }
  }

  /** Each sub-account's trades and the guard rule that halted it, once the replay is done. */
  subTrades = (): SubTrades[] => this.accounts.map((a) => ({ name: a.name, trades: a.out, halt: a.guard === null ? null : a.guard.halt }))

  /** The helpers called so far, sorted so two equal sets compare equal. */
  private used(): ScriptUsed {
    const keys = (m: Map<number, unknown>) => [...m.keys()].sort((x, y) => x - y)
    return { ema: keys(this.emas), sma: keys(this.smas), rsi: keys(this.rsis), sides: [...this.sideArgs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, v]) => v) }
  }
  stats = (): ScriptStats => ({ called: this.called, sameSkipped: this.sameSkipped, watchSkipped: this.watchSkipped })

  /** The calls' own times, from the budget's measure (`run`): the last one, the largest, the sum and the number of timed calls, and how many went over the budget (the last such time in `overMs`). `radinus/` shows and journals them; the page does not read them. */
  private readonly time: ScriptTiming = { lastMs: NaN, maxMs: 0, sumMs: 0, timed: 0, over: 0, overMs: NaN }
  timing = (): ScriptTiming => ({ ...this.time })

  /** The first bar `env.bars` still holds at this call (0 on the page). */
  private first(): number {
    return this.kept === Infinity ? 0 : Math.max(0, this.closed - this.kept)
  }

  /** One running state per distinct period, moved to the last closed minute; born at the first bar still held. */
  private follow<F extends Follow>(map: Map<number, F>, n: number, make: (n: number, from: number) => F): number {
    if (!Number.isInteger(n) || n < 1) return NaN
    let f = map.get(n)
    if (f === undefined) {
      f = make(n, this.first())
      map.set(n, f)
    }
    f.advance(this.env.bars, this.closed)
    return f.val
  }

  private readonly ema = (n: number): number => this.follow(this.emas, n, (k, from) => new EmaFollow(k, undefined, from))
  private readonly sma = (n: number): number => this.follow(this.smas, n, (k, from) => new SmaFollow(k, undefined, from))
  private readonly rsi = (n: number): number => this.follow(this.rsis, n, (k, from) => new RsiFollow(k, undefined, from))

  private readonly candles = (n: number): ReturnType<ScriptState['candles']> => {
    const out = this.candleBuf
    const k = Number.isInteger(n) && n >= 1 ? Math.min(n, CANDLES_KEPT, this.closed) : 0
    const bars = this.env.bars
    for (let j = 0; j < k; j++) {
      const b = bars[this.closed - k + j]
      let c = out[j]
      if (c === undefined) {
        c = { t: 0, o: 0, h: 0, l: 0, c: 0, v: 0 }
        out[j] = c
      }
      c.t = b.t * 1000
      c.o = b.o
      c.h = b.h
      c.l = b.l
      c.c = b.c
      c.v = b.v
    }
    out.length = k
    return out
  }

  private readonly prints = (n: number): ReturnType<ScriptState['prints']> => {
    this.readPrints = true
    const out = this.printBuf
    const tape = this.env.tape
    const last = this.printAt
    let k = tape === undefined || !Number.isInteger(n) || n < 1 ? 0 : Math.min(n, last + 1)
    // At most the prints of the last `PRINTS_KEPT_MS` before the call.
    if (tape !== undefined && k > 0) k = Math.max(0, Math.min(k, last + 1 - bound(tape.t, this.state.tMs - PRINTS_KEPT_MS, false)))
    if (tape !== undefined && k > 0) {
      const scale = Math.round(1 / tape.tick)
      for (let j = 0; j < k; j++) {
        const x = last - k + 1 + j
        let p = out[j]
        if (p === undefined) {
          p = { t: 0, price: 0, size: NaN, side: 'buy' }
          out[j] = p
        }
        p.t = tape.t[x]
        p.price = tape.k[x] / scale
        p.side = tape.ask[x] === 1 ? 'buy' : 'sell'
      }
    }
    out.length = k
    return out
  }

  /** The `SideRun` of `side` / `sideValue` / `sideLines` for these arguments (one per key, shared by both), moved to the last closed minute; null when the arguments are wrong (noted under `name`). */
  private sideRun(name: string, player: string, settings?: Record<string, number>, opts?: SideOpts): { run: SideRun; w: 1 | 0 | -1 } | null {
    const key = JSON.stringify([player, settings ?? null, opts ?? null])
    let run = this.sides.get(key)
    if (run === undefined) {
      const spec = sideSpecOf(player, settings, opts)
      if (typeof spec === 'string') this.note(`${name}: ${spec}`)
      run = typeof spec === 'string' ? null : new SideRun(spec, this.first(), this.kept)
      this.sides.set(key, run)
      if (run !== null) this.sideArgs.set(key, { player, settings: settings ?? null, opts: opts ?? null })
    }
    if (run === null) return null
    return { run, w: run.at(this.env.bars, this.env.delta ?? [], this.closed) }
  }

  private readonly side = (player: string, settings?: Record<string, number>, opts?: SideOpts): 'long' | 'short' | null => {
    const r = this.sideRun('side', player, settings, opts)
    return r === null ? null : r.w === 1 ? 'long' : r.w === -1 ? 'short' : null
  }

  private readonly sideValue = (player: string, settings?: Record<string, number>, opts?: SideOpts): { side: 'long' | 'short' | null; value: number } => {
    const r = this.sideRun('sideValue', player, settings, opts)
    if (r === null) return { side: null, value: NaN }
    return { side: r.w === 1 ? 'long' : r.w === -1 ? 'short' : null, value: r.run.value() }
  }

  private readonly sideLines = (player: string, settings?: Record<string, number>, opts?: SideOpts): SideLines => {
    const r = this.sideRun('sideLines', player, settings, opts)
    return r === null ? { upper: NaN, lower: NaN, middle: NaN } : r.run.lines()
  }

  private readonly print = (text: unknown): void => {
    if (this.labels.length >= PRINTS_MAX) {
      this.labelsDropped = true
      return
    }
    this.labels.push({ tMs: this.state.tMs, px: this.state.price, text: String(text).slice(0, PRINT_TEXT_MAX) })
  }

  /** The drawings at the call's time, built when the script asks. */
  private readonly drawingsNow = (): ScriptDrawing[] => {
    this.readDrawings = true
    return scriptDrawings(this.env.drawings ?? [], this.state.tMs / 1000)
  }

  private readonly drawing = (name: string): ScriptDrawing | null => {
    const all = this.drawingsNow()
    const list = this.env.drawings ?? []
    const i = list.findIndex((d) => d.name === name)
    return i < 0 ? null : all[i]
  }

  /** The state a script reads: ONE object per replay, its fields assigned in place at each call (no allocation per call; a script must not keep a reference to it, to its `candle` or to an account's object). `time` is a getter, so the ISO string is built only when the script reads it. */
  private readonly state: ScriptState & { tMs: number; drawingsNow: () => ScriptDrawing[] } = {
    price: NaN,
    get time() {
      return new Date(this.tMs).toISOString()
    },
    tMs: 0,
    drawingsNow: this.drawingsNow,
    get drawings() {
      return this.drawingsNow()
    },
    drawing: this.drawing,
    close: false,
    candle: { o: NaN, h: NaN, l: NaN, c: NaN, v: NaN },
    spread: NaN,
    ema: this.ema,
    sma: this.sma,
    rsi: this.rsi,
    candles: this.candles,
    prints: this.prints,
    side: this.side,
    sideValue: this.sideValue,
    sideLines: this.sideLines,
    accounts: {},
    registers: this.registers,
    print: this.print,
  }

  /** Sub-account `s`'s object (`AccountState`) from its book `b` at the moment `m`. */
  private viewOf(s: SubRun, b: Book, m: ScriptMoment): void {
    const pos = b.pos
    const a = s.params
    const eff = pos === null ? NaN : effectiveStop(pos)
    const v = s.view
    v.position = pos === null ? 'out' : pos.side === 1 ? 'long' : 'short'
    v.entry = pos === null ? null : pos.pxIn
    v.since = pos === null ? 0 : Math.max(0, (m.tMs / 1000 - pos.tIn) / 60)
    v.gain = pos === null ? 0 : ((pos.side * (m.px - pos.pxIn)) / pos.pxIn) * 100 * (a === null ? 1 : a.leverage)
    v.stop = Number.isFinite(b.stopPct) ? b.stopPct : null
    v.stopPrice = Number.isFinite(eff) ? eff : null
    v.takePrice = pos === null || pos.take === undefined ? null : pos.take.px
    Object.assign(v.rules, b.guard === null ? NO_RULES : b.guard.rules)
    v.trailing = pos !== null && pos.trail !== null
    v.liquidation = pos === null || a === null ? null : liquidationPrice(pos.side, pos.pxIn, exposureOf(a, s.account), a.maintenance)
    v.collateral = s.account
    v.leverage = a === null ? NaN : a.leverage
    v.stake = a === null ? NaN : tradeStakeOf(a, s.account)
    v.trades = s.trades
    v.wins = s.wins
    v.losses = s.losses
    v.lossStreak = s.lossStreak
    v.paused = s.paused
    v.forbidden = s.forbidden === 1 ? 'long' : s.forbidden === -1 ? 'short' : null
  }

  private stateOf(books: readonly Book[], m: ScriptMoment): ScriptState {
    this.closed = m.close ? m.i + 1 : m.i
    this.printAt = m.x
    const s = this.state
    s.tMs = m.tMs
    s.price = m.px
    s.close = m.close
    const c = s.candle
    c.o = m.o
    c.h = m.h
    c.l = m.l
    c.c = m.c
    c.v = m.close ? this.env.bars[m.i].v : NaN
    s.spread = this.env.spreadPct
    for (let k = 0; k < this.accounts.length; k++) this.viewOf(this.accounts[k], books[k], m)
    return s
  }

  private snap(into: Snap, books: readonly Book[]): void {
    for (let k = 0; k < this.accounts.length; k++) {
      into.pos[k] = books[k].pos
      into.trades[k] = books[k].trades
      into.paused[k] = this.accounts[k].paused
      into.forbidden[k] = this.accounts[k].forbidden
    }
  }
  /** Every book holds the position and the trade count it held in `s`. */
  private samePositions(s: Snap, books: readonly Book[]): boolean {
    for (let k = 0; k < books.length; k++) if (books[k].pos !== s.pos[k] || books[k].trades !== s.trades[k]) return false
    return true
  }
  /** Every sub-account has the pause and the forbid it had in `s`. */
  private sameFlags(s: Snap): boolean {
    for (let k = 0; k < this.accounts.length; k++) if (this.accounts[k].paused !== s.paused[k] || this.accounts[k].forbidden !== s.forbidden[k]) return false
    return true
  }

  private fail(reason: string, m: ScriptMoment): readonly ScriptAct[] {
    this.live = false
    for (const a of this.accounts) a.paused = true
    this.failure = { reason, tMs: m.tMs }
    return this.none
  }

  private note(text: string): void {
    if (this.ignored.size < IGNORED_MAX) this.ignored.add(text)
  }

  /**
   * One call within the budget, for every book at once. A call over budget is made once more before the bot is paused: a garbage collection of 84 ms (measured 2026-10-08, Node 24, ticks-38-all: a major GC inside one of 2,000 calls of a one-line script, every run) is not the script's time.
   * A script really over budget is over it twice, and a loop that never returns is cut by its guard both times. The cost: a register written by the script is written twice in that one call.
   */
  call = (books: readonly Book[], m: ScriptMoment): readonly ScriptAct[] => {
    if (m.close) {
      this.watch = null
      this.last = null
    } else {
      const w = this.watch
      if (w !== null) {
        if (this.samePositions(this.watchSnap, books) && !(m.px >= w.above) && !(m.px <= w.below)) {
          this.watchSkipped++
          return this.none
        }
        this.watch = null
      }
      const l = this.last
      if (l !== null && !this.readPrints && !this.readDrawings && m.px === l.px && m.h === l.h && m.l === l.l && m.i === l.i && this.samePositions(this.lastSnap, books) && this.sameFlags(this.lastSnap)) {
        this.sameSkipped++
        return this.acts
      }
    }
    this.called++
    this.snap(this.pre, books)
    this.last = null
    this.moved = false
    const acts = this.run(books, m)
    if (!m.close && this.live && this.sameFlags(this.pre) && !this.moved) {
      const was = this.lastSnap
      this.lastSnap = this.pre
      this.pre = was
      this.last = { px: m.px, h: m.h, l: m.l, i: m.i }
    }
    return acts
  }

  private run(books: readonly Book[], m: ScriptMoment): readonly ScriptAct[] {
    const clock = this.compiled.clock
    let reason = ''
    // A call made once more (over the budget) writes its labels once: the first attempt's are taken back.
    const labelsAt = this.labels.length
    for (let attempt = 0; attempt < 2; attempt++) {
      this.labels.length = labelsAt
      const t = performance.now()
      clock.at = t + SCRIPT_BUDGET_MS
      let r: unknown
      try {
        r = this.compiled.fn(this.stateOf(books, m))
      } catch (e) {
        if (e instanceof BudgetError) {
          reason = e.message
          continue
        }
        return this.fail(e instanceof Error ? `${e.name}: ${e.message}` : String(e), m)
      }
      const spent = performance.now() - t
      this.time.lastMs = spent
      if (spent > this.time.maxMs) this.time.maxMs = spent
      this.time.sumMs += spent
      this.time.timed++
      if (spent > SCRIPT_BUDGET_MS) {
        this.time.over++
        this.time.overMs = spent
        reason = `over the ${SCRIPT_BUDGET_MS} ms budget (${spent.toFixed(1)} ms)`
        continue
      }
      return this.apply(r, books, m)
    }
    return this.fail(reason, m)
  }

  /** The decision (one object, or an array of them for several sub-accounts) checked and applied: pause / resume / forbid / trail / stop / rules act here, `enter` and `close` are given back to the replay, one act per sub-account. */
  private apply(r: unknown, books: readonly Book[], m: ScriptMoment): readonly ScriptAct[] {
    for (const a of this.acts) {
      a.enter = 0
      a.close = false
    }
    this.moved = false
    if (r === undefined || r === null) return this.acts
    if (typeof r !== 'object') {
      this.note('the decision must be an object or an array of objects')
      return this.acts
    }
    if (Array.isArray(r)) for (const d of r) this.applyOne(d, books, m)
    else this.applyOne(r, books, m)
    return this.acts
  }

  /** One decision object: its `watch` (the script's), then its keys for the sub-account it names (`account`); without `account`, or with a name the list does not have, those keys are ignored and listed. */
  private applyOne(d: unknown, books: readonly Book[], m: ScriptMoment): void {
    if (d === undefined || d === null) return
    if (typeof d !== 'object' || Array.isArray(d)) {
      this.note('each decision must be an object')
      return
    }
    const o = d as Record<string, unknown>
    const name = o.account
    const k = typeof name === 'string' ? (this.index.get(name) ?? -1) : -1
    let orders = false
    let stop: number | undefined
    let stopAt: number | null | undefined
    let takeAt: number | null | undefined
    for (const [key, v] of Object.entries(o)) {
      if (key === 'account') continue
      if (key === 'watch') {
        const w = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as { above?: unknown; below?: unknown }) : null
        if (w !== null && (w.above === undefined || typeof w.above === 'number') && (w.below === undefined || typeof w.below === 'number')) {
          this.watch = { above: w.above ?? Infinity, below: w.below ?? -Infinity }
          this.snap(this.watchSnap, books)
        } else this.note(`watch: bad value ${JSON.stringify(v)}`)
        continue
      }
      if (!ACCOUNT_KEYS.includes(key)) {
        this.note(`unknown key ${key}`)
        continue
      }
      orders = true
      if (k < 0) continue
      const s = this.accounts[k]
      const b = books[k]
      const act = this.acts[k]
      if (key === 'enter' && (v === 'long' || v === 'short')) act.enter = v === 'long' ? 1 : -1
      else if (key === 'close' && v === true) act.close = true
      else if (key === 'forbid' && (v === 'long' || v === 'short' || v === null)) {
        this.moved = true
        s.forbidden = v === 'long' ? 1 : v === 'short' ? -1 : 0
      } else if (key === 'trail' && typeof v === 'number' && Number.isFinite(v) && v > 0) {
        this.moved = true
        if (b.pos !== null) trailFromNow(b.pos, m.px, v)
      } else if (key === 'pause' && v === true) s.paused = true
      else if (key === 'resume' && v === true) s.paused = false
      else if (key === 'stop' && (v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0))) {
        stop = v ?? Infinity
        if (v !== null) this.stopSet = true
      } else if ((key === 'stopAt' || key === 'takeAt') && (v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0))) {
        if (key === 'stopAt') stopAt = v
        else takeAt = v
      } else if (key === 'rules' && typeof v === 'object' && v !== null && !Array.isArray(v)) this.applyRules(v as Record<string, unknown>, b, s, m)
      else this.note(`${key}: bad value ${JSON.stringify(v)}`)
    }
    if (k < 0) {
      if (orders) this.note(name === undefined ? `a decision without account is ignored: every order names its sub-account (account: '${this.accounts[0]?.name ?? 'sub1'}')` : `a decision for an unknown account ${JSON.stringify(name)} is ignored`)
      return
    }
    const b = books[k]
    // After the loop, so an `enter` anywhere in the decision is filled with this stop (the order is placed by the replay after `apply`).
    if (stop !== undefined && stop !== b.stopPct) {
      setStop(b, stop)
      this.moved = true
    }
    // After `stop`, so `stopAt: null` goes back to the stop % this decision gives. Both are the open position's only: with none open they are ignored (said once).
    const pos = b.pos
    if (stopAt !== undefined) {
      if (pos === null) {
        if (stopAt !== null) this.note('stopAt: no open position')
      } else if (stopAt !== (pos.stopAt ?? null)) {
        setStopAt(b, stopAt)
        this.moved = true
        if (stopAt !== null && Number.isNaN(this.wrongStopAt) && (pos.side === 1 ? stopAt >= m.px : stopAt <= m.px)) this.wrongStopAt = m.tMs
      }
      if (pos !== null && stopAt !== null) this.stopSet = true
    }
    if (takeAt !== undefined) {
      if (pos === null) {
        if (takeAt !== null) this.note('takeAt: no open position')
      } else if (takeAt !== (pos.take?.px ?? null)) {
        setTake(b, takeAt, m.x, m.px)
        this.moved = true
      }
    }
  }

  /** A `rules` decision for sub-account `s` (book `b`): each valid key replaces the rule in force (`setGuardRules`), only when some value changes; a bad key or value is listed and skipped. Bounds: losses whole >= 1, loss in ]0, 100], pause and ban >= 1 (minutes). */
  private applyRules(v: Record<string, unknown>, b: Book, s: SubRun, m: ScriptMoment): void {
    const g = b.guard
    if (g === null) {
      this.note('rules: this replay has no guard')
      return
    }
    const a = s.params
    const next: Rules = { ...g.rules }
    for (const [k, x] of Object.entries(v)) {
      if (k !== 'losses' && k !== 'loss' && k !== 'pause' && k !== 'ban') this.note(`rules: unknown key ${k}`)
      else if (k === 'loss' && x !== null && a === null) this.note('rules.loss: the margins are not read (no account)')
      else if (x === null || (typeof x === 'number' && Number.isFinite(x) && (k === 'loss' ? x > 0 && x <= 100 : x >= 1 && (k !== 'losses' || Number.isInteger(x))))) next[k] = x
      else this.note(`rules.${k}: bad value ${JSON.stringify(x)}`)
    }
    const cur = g.rules
    if (next.losses === cur.losses && next.loss === cur.loss && next.pause === cur.pause && next.ban === cur.ban) return
    const account0 = a === null ? 0 : startAccountOf(a)
    setGuardRules(g, next, account0, a === null ? 0 : tradeStakeOf(a, account0), a, s.account, s.lossStreak, m.tMs)
    this.moved = true
  }
}

/** One replay's hook from a compiled script and what it reads. */
export const newScriptRun = (compiled: CompiledScript, env: ScriptEnv): BotScriptRun => new BotScriptRun(compiled, env)
