/**
 * A script bot: `/bot`'s script run live on paper, as the page's replay runs it (`botScript.ts`'s `newScriptRun`, `playerStop.ts`'s `replayStop` with a script): called ONCE at every print and ONCE at every minute
 * close, with the same skip rules (the run's own "same inputs" and `watch`); each of its decisions names a sub-account, and each sub-account is its own paper account, its own `PaperExchange` (fills, stop, `stopAt`, `takeAt`, trailing, liquidation,
 * guard rules), isolated: a loss on one never touches another's collateral. The script's helpers read the bars from the 24 h seed on, kept as a window of the last `CANDLES_KEPT` (2,000: the oldest leave as new ones close; indices stay counted from the seed's first bar, the older entries deleted, as `indicator.ts` keeps a /rsi bot's), `state.prints(n)` the market's window
 * (`PRINTS_KEPT_MS`, the same 2 minutes on the page). Nothing is computed here that `site/src/core` computes.
 *
 * Three things differ from the page, by construction: an order is filled when the clock passes its fill (the page books it at the decision), so until then the script reads the position as it was and an order on its way (`PaperExchange.target`)
 * stands for the position, so the prints before the fill do not send it again; the registers start empty at the launch
 * (the script is not called on the seed: the helpers rewarm from the bars by themselves). The call budget is the page's (`SCRIPT_BUDGET_MS`, 50 ms, its rule: a call over it is made once more, a second one pauses every sub-account); every call is timed by that same measure.
 */

import { SHARE_DEFAULT, exposureOf, liquidationDistances, maintenanceOf, startAccountOf, tradeStakeOf } from './core/account'
import type { AccountParams } from './core/account'
import { CANDLES_KEPT, PRINTS_KEPT_MS, SCRIPT_BUDGET_MS, newScriptRun } from './core/botScript'
import type { BotScriptRun, ScriptEnv, ScriptRunState, ScriptTiming } from './core/botScript'
import { LEAN_SIM_LATENCY_MS } from './core/leanSim'
import { NO_RULES, guardState, resetGuard, restoreGuard } from './core/playerRules'
import type { Guard, GuardState, Rules } from './core/playerRules'
import { leverageOf } from './core/playerSearch'
import { bound, scriptMayEnter } from './core/playerStop'
import type { ScriptAct, ScriptMoment } from './core/playerStop'
import type { BotLife, BotView, SubAccountView } from './core/radinusMessages'
import { subParams } from './core/subAccounts'
import type { SubAccount } from './core/subAccounts'
import { rollingBars } from './core/zonesBench'
import type { BenchBar, RollingBars } from './core/zonesBench'
import type { BotContext, BotStatus } from './bot'
import type { ResolvedBot, ResolvedScript } from './bots'
import { PaperExchange } from './exchange'
import type { ExchangeState } from './exchange'
import type { Journal } from './journal'
import type { Market } from './market'
import type { ExchangeEvent } from './seam'

/** A guard as `etat.json` keeps it: its state, and the rules the script set (`rules` decisions) with B's floor and the account B tracks. */
export type GuardSaved = GuardState & { rules: Rules; floor: number | null; acct: number | null }
export type SubSaved = { exchange: ExchangeState; status: BotStatus; account0: number; stake0: number; guard: GuardSaved | null }
/** What a restart finds of a script bot (`etat.json`): stopped from the page or not, the run's registers and sub-accounts' fields, each sub-account's paper account by name, and the call times. */
export type ScriptSaved = { paused: boolean; run: ScriptRunState; subs: Record<string, SubSaved>; times?: Times }

type Times = { lastMs: number | null; maxMs: number; sumMs: number; timed: number; over: number }

/** One sub-account: its settings, its paper account, and what the journal and `/bots` say of it. */
type Sub = { def: SubAccount; exchange: PaperExchange; status: BotStatus; account0: number; stake0: number; haltWritten: boolean }

const iso = (ms: number): string => new Date(ms).toISOString()
const sideName = (s: 1 | -1): string => (s === 1 ? 'long' : 'short')

const guardSaved = (g: Guard | null): GuardSaved | null => (g === null ? null : { ...guardState(g), rules: { ...g.rules }, floor: g.floor, acct: g.acct === null ? null : g.acct.account })
function putGuard(g: Guard | null, s: GuardSaved | null): void {
  if (g === null || s === null) return
  restoreGuard(g, s)
  g.rules = { ...s.rules }
  g.floor = s.floor
  if (g.acct !== null && s.acct !== null) g.acct.account = s.acct
  else if (s.acct === null) g.acct = null
}

export class ScriptBot {
  r: ResolvedBot
  readonly journal: Journal
  readonly subs: Sub[] = []
  run: BotScriptRun
  /** Stopped from the page (`arreter`): the script is not called, until `resume`. */
  paused = false
  /** The closed bars from the seed on and their delta, what the script's helpers read: the last `CANDLES_KEPT` only (author, 2026-10-11), indexed from the seed's first bar, the older entries deleted. A helper born later (a `modifier`, a `reprendre` after a failure) starts at the first bar still held (`botScript.ts`). */
  readonly bars: RollingBars
  readonly delta: number[] = []
  /** How many of the first entries of `bars` and `delta` are deleted. */
  private trimmed = 0
  private readonly market: Market
  private readonly ctx: BotContext
  private readonly marketParams: AccountParams
  /** What the run reads besides the books (`ScriptEnv`): the window of prints is put back in it before each call. */
  private env!: ScriptEnv
  private readonly m: ScriptMoment = { close: false, i: 0, x: -1, tMs: 0, px: NaN, o: NaN, h: NaN, l: NaN, c: NaN }
  /** The minute (ms) the moment's o / h / l are of. */
  private minuteMs = -1
  private readonly ignoredSeen = new Set<string>()
  private failureWritten = false
  /** The call times of the runs before this one (a `modifier` or a `reprendre` makes a new run), and how much of the current run's are already counted. */
  private times: Times = { lastMs: null, maxMs: 0, sumMs: 0, timed: 0, over: 0 }
  private seenTiming: ScriptTiming = { lastMs: NaN, maxMs: 0, sumMs: 0, timed: 0, over: 0, overMs: NaN }

  constructor(r: ResolvedBot, journal: Journal, market: Market, ctx: BotContext, resumed: boolean) {
    this.r = r
    this.journal = journal
    this.market = market
    this.ctx = ctx
    this.bars = rollingBars(CANDLES_KEPT)
    market.bars.forEach((b, k) => this.keep(b, market.delta[k]))
    const margins = market.cfg.margins
    // The market's inputs at its MAXIMUM leverage: each sub-account takes its own leverage (capped by it), share and fixed stake (`subParams`), as `/bot`'s `marketParams`.
    this.marketParams = { leverage: leverageOf(margins), share: SHARE_DEFAULT, start: null, fixedStake: null, maintenance: maintenanceOf(margins), liquidationFeePct: market.cfg.liquidationFeePct }
    this.run = this.makeRun(this.script(), null)
    if (resumed) journal.write({ evenement: 'redemarrage', bot: r.spec.id, bougiesAmorce: this.bars.length - this.trimmed })
    else journal.write({ evenement: 'demarrage', heure: iso(r.startMs), bot: r.spec.id, marche: r.spec.marche, joueur: r.spec.joueur, ...(r.spec.name === undefined ? {} : { name: r.spec.name }), script: this.script().text, subAccounts: this.script().subs, drawings: this.script().drawings, ...this.startWords() })
  }

  private script(): ResolvedScript {
    return this.r.script as ResolvedScript
  }

  /** What the `demarrage` and `modifie` lines say of the run: the prints a script reads here, the loop cut, and each sub-account's start. */
  private startWords(): Record<string, unknown> {
    return {
      prints: `state.prints(n): the prints of the last ${PRINTS_KEPT_MS / 60000} minutes at most (the window Radinus keeps; the page's replay gives the same)`,
      budgetMs: SCRIPT_BUDGET_MS,
      bougiesAmorce: this.bars.length - this.trimmed,
      candles: `state.candles(n): at most ${CANDLES_KEPT} (the bars Radinus keeps for a script bot; the page gives the same)`,
      comptes: this.subs.map((s) => {
        const p = subParams(this.marketParams, s.def)
        return { account: s.def.name, levier: p.leverage, compteDepart: s.account0, miseDepart: s.stake0, compte: s.exchange.account, distanceLiquidationPct: liquidationDistances(exposureOf(p, s.exchange.account), p.maintenance) }
      }),
    }
  }

  /**
   * A run of `sc`'s script on its sub-accounts: a sub-account already here (same name) keeps its paper account, position, stop and guard state (its settings apply from its next entry), a new one starts at its collateral; `carry` = the state of the run before
   * (registers, each sub-account's fields; a failure is dropped), `null` at the launch. The sub-accounts not in `sc` leave.
   */
  private makeRun(sc: ResolvedScript, carry: ScriptRunState | null): BotScriptRun {
    const env: ScriptEnv = { bars: this.bars, spreadPct: this.market.tape.spreadPct ?? 0, account: this.marketParams, subs: sc.subs, rules: NO_RULES, delta: this.delta, tape: this.market.tape.view(), drawings: sc.drawings }
    this.env = env
    const run = newScriptRun(sc.compiled, env)
    const before = new Map(this.subs.map((s) => [s.def.name, s]))
    this.subs.length = 0
    sc.subs.forEach((def, k) => {
      const params = subParams(this.marketParams, def)
      const h = run.accounts[k]
      const old = before.get(def.name)
      if (old !== undefined) {
        const g = guardSaved(old.exchange.book.guard)
        old.def = def
        old.exchange.setParams(params)
        putGuard(h.guard, g)
        old.exchange.attach(h)
        this.subs.push(old)
        return
      }
      const account0 = startAccountOf(params)
      // The exchange tells the sub-account it belongs to (`learn`): the object is made right after, before any event.
      let sub: Sub | null = null
      const exchange = new PaperExchange(this.market, params, account0, (e) => {
        if (sub !== null) this.learn(sub, e)
      })
      sub = { def, exchange, status: 'actif', account0, stake0: tradeStakeOf(params, account0), haltWritten: false }
      exchange.attach(h)
      this.subs.push(sub)
    })
    if (carry !== null) run.restoreState(carry, false)
    // The script reads each sub-account's account as its paper exchange holds it (funding included).
    this.subs.forEach((s, k) => (run.accounts[k].account = s.exchange.account))
    return run
  }

  /** Folds the current run's call times into the bot's (a new run starts its own count). */
  private foldTimes(): void {
    const t = this.run.timing()
    const s = this.seenTiming
    if (t.timed > s.timed) {
      this.times.lastMs = t.lastMs
      this.times.maxMs = Math.max(this.times.maxMs, t.maxMs)
      this.times.sumMs += t.sumMs - s.sumMs
      this.times.timed += t.timed - s.timed
    }
    if (t.over > s.over) {
      this.times.over += t.over - s.over
      this.journal.write({ evenement: 'appel_lent', heure: iso(this.m.tMs), ms: t.overMs, budgetMs: SCRIPT_BUDGET_MS, remarque: 'over the budget: the call is made once more; over it again, every sub-account is paused (script_echec)' })
    }
    this.seenTiming = t
  }

  private newRun(sc: ResolvedScript): void {
    this.foldTimes()
    const carry = this.run.saveState()
    this.run = this.makeRun(sc, carry)
    this.seenTiming = this.run.timing()
    this.failureWritten = false
  }

  /** Whether any sub-account can still trade. */
  private alive(): boolean {
    return this.subs.some((s) => s.status === 'actif')
  }

  /** A print of the open minute, at index `i` of the market's window: every sub-account's exchange has read it (stop, take-profit, liquidation); now the script, once. */
  onPrint(i: number): void {
    if (this.paused || !this.alive() || this.ctx.blind() || !this.run.live) return
    const tape = this.market.tape
    const t = tape.t[i]
    const px = tape.k[i] / tape.scale
    const m = this.m
    const minute = Math.floor(t / 60000) * 60000
    if (minute !== this.minuteMs) {
      this.minuteMs = minute
      m.o = px
      m.h = px
      m.l = px
    } else {
      if (px > m.h) m.h = px
      if (px < m.l) m.l = px
    }
    m.c = px
    m.close = false
    m.i = this.bars.length
    m.x = i
    m.tMs = t
    m.px = px
    this.call(t)
  }

  /** One more closed bar for the helpers; the one `CANDLES_KEPT` behind leaves. */
  private keep(bar: BenchBar, delta: number): void {
    this.bars.push(bar)
    this.delta.push(delta)
    for (; this.trimmed < this.bars.length - CANDLES_KEPT; this.trimmed++) {
      delete this.bars[this.trimmed]
      delete this.delta[this.trimmed]
    }
  }

  /** A minute closed (`bar`, closed at `closeMs`): the helpers' window moves, then the script, once. */
  onClose(bar: BenchBar, delta: number, closeMs: number): void {
    this.keep(bar, delta)
    if (this.paused || !this.alive()) return
    if (this.ctx.blind()) {
      this.journal.write({ evenement: 'minute_sans_decision', heure: iso(closeMs) })
      return
    }
    if (!this.run.live) return
    const m = this.m
    const tape = this.market.tape
    m.close = true
    m.i = this.bars.length - 1
    m.x = bound(tape.t.subarray(0, tape.n), closeMs, false) - 1
    m.tMs = closeMs
    m.px = bar.c
    m.o = bar.o
    m.h = bar.h
    m.l = bar.l
    m.c = bar.c
    this.call(closeMs)
  }

  private call(t: number): void {
    const run = this.run
    // The window moves (prints added, the oldest dropped at a close): the script reads it as it is now (`state.prints`).
    this.env.tape = this.market.tape.view()
    const acts = run.call(this.subs.map((s) => s.exchange.book), this.m)
    this.foldTimes()
    // Each `state.print` of the call, one line; taken from the run, so a live run is never capped at `PRINTS_MAX`.
    for (const p of run.takePrints()) this.journal.write({ evenement: 'print', heure: iso(p.tMs), prix: p.px, texte: p.text })
    const rep = run.report()
    for (const note of rep.ignored) {
      if (this.ignoredSeen.has(note)) continue
      this.ignoredSeen.add(note)
      this.journal.write({ evenement: 'script_ignore', heure: iso(t), note })
    }
    if (rep.failure !== null && !this.failureWritten) {
      this.failureWritten = true
      this.journal.write({ evenement: 'script_echec', heure: iso(rep.failure.tMs), raison: rep.failure.reason, consequence: 'every sub-account paused (positions kept, entries ignored), the script no longer called: modify or resume' })
    }
    this.subs.forEach((s, k) => {
      s.exchange.noteTake()
      if (s.status === 'actif') this.order(s, k, acts[k], t)
    })
  }

  /** The script's act for sub-account `k` as an order (`replayStop`'s rule: an `enter` other than the side held, if the sub-account may enter, else a `close` of what is held); an order on its way stands for the position. */
  private order(s: Sub, k: number, act: ScriptAct, t: number): void {
    const ex = s.exchange
    const b = ex.book
    const target = ex.target()
    const held = target ?? (b.pos === null ? 0 : b.pos.side)
    let side: 1 | -1
    let only: 1 | -1 | undefined
    if (act.enter !== 0 && held !== act.enter) {
      if (!scriptMayEnter(b, this.run.accounts[k], act.enter, t)) return
      side = act.enter
    } else if (act.close && held !== 0) {
      side = held === 1 ? -1 : 1
      only = held
    } else return
    const stopPct = b.stopPct !== null && Number.isFinite(b.stopPct) ? b.stopPct : null
    this.journal.write({ evenement: 'decision', heure: iso(t), account: s.def.name, ordre: only === undefined ? sideName(side) : 'close', moment: this.m.close ? 'close' : 'print', prix: this.m.px, stop: stopPct })
    ex.send({ side, stopPct, trail: null, sentMs: t, atMs: t + LEAN_SIM_LATENCY_MS, account: s.def.name, ...(only === undefined ? {} : { only }) })
  }

  /** What a sub-account's exchange tells: written with the sub-account's name; the script reads the account as the exchange holds it. */
  private learn(s: Sub, e: ExchangeEvent): void {
    const account = s.def.name
    const k = this.subs.indexOf(s)
    switch (e.kind) {
      case 'entree':
        this.journal.write({ evenement: 'entree', heure: iso(e.t), account, ...this.cut(e.t), cote: sideName(e.side), prix: e.px, taille: e.qty, notionnel: e.notional, mise: e.stake, compteAvant: e.accountBefore, stopPrix: e.stopPx, liquidationPrix: e.liquidationPx })
        break
      case 'stop_touche':
        this.journal.write({ evenement: 'stop_touche', heure: iso(e.t), account, ...this.cut(e.t), prix: e.px, stopPrix: e.stopPx, sortieAttendue: iso(e.exitAt) })
        break
      case 'sortie':
        this.writeHalt(s)
        this.journal.write({ evenement: 'sortie', heure: iso(e.t), account, ...this.cut(e.t), cote: sideName(e.side), prix: e.px, motif: e.reason, entreeHeure: iso(e.entryT), entreePrix: e.entryPx, pnlSur100: e.pnl100, pnl: e.pnl, pnlPctMise: e.pnlPct, compte: e.account })
        break
      case 'liquidation':
        s.status = 'liquide'
        this.journal.write({ evenement: 'liquidation', heure: iso(e.t), account, ...this.cut(e.t), cote: sideName(e.side), prix: e.px, liquidationPrix: e.liquidationPx, mise: e.stake, frais: e.fee, compte: e.account })
        break
      case 'funding':
        this.journal.write({ evenement: 'funding', heure: iso(e.t), account, ...this.cut(e.t), cote: sideName(e.side), taille: e.qty, valeur: e.value, montant: e.amount, compte: e.account })
        break
      case 'close_order_filled':
        this.journal.write({ evenement: 'close_order', heure: iso(e.t), account })
        break
      case 'ordre_sans_prix':
        this.journal.write({ evenement: 'ordre_sans_prix', heure: iso(e.t), account })
        break
      case 'stake_above_account':
        this.writeHalt(s)
        break
      case 'compte_epuise':
        s.status = 'epuise'
        this.journal.write({ evenement: 'compte_epuise', heure: iso(e.t), account })
        break
    }
    if (k >= 0 && k < this.run.accounts.length) this.run.accounts[k].account = s.exchange.account
  }

  /** The guard rule that just halted sub-account `s`, written once. */
  private writeHalt(s: Sub): void {
    const h = s.exchange.book.guard?.halt ?? null
    if (h === null || s.haltWritten) return
    s.haltWritten = true
    this.journal.write({ evenement: 'arret_regle', heure: iso(h.t), account: s.def.name, cause: h.cause, valeur: h.value, compte: s.exchange.account })
  }

  private cut(t: number): { pendantCoupure?: true } {
    return this.ctx.inCut(t) ? { pendantCoupure: true } : {}
  }

  /** `arreter`: the script is no longer called; the engine cancels each sub-account's orders and closes its position. */
  pause(atMs: number): void {
    this.paused = true
    this.journal.write({ evenement: 'arret_demande', heure: iso(atMs) })
  }

  /** `reprendre`: the script is called again from the next print; each sub-account's guard halt is cleared; a script that failed gets a new run (registers kept). */
  resume(atMs: number): void {
    this.paused = false
    for (const s of this.subs) {
      const g = s.exchange.book.guard
      if (g !== null) resetGuard(g)
      s.haltWritten = false
    }
    if (!this.run.live) this.newRun(this.script())
    this.journal.write({ evenement: 'reprise', heure: iso(atMs) })
  }

  /** Whether any sub-account is halted by a guard rule. */
  halted(): boolean {
    return this.subs.some((s) => s.exchange.book.guard?.halt != null)
  }

  /**
   * `modifier` (author, 2026-10-10: "modify does nothing to an open position"): the new script, drawings and sub-account settings; every open position, its stop, take-profit and trailing, the registers and each kept sub-account's account and counters stay.
   * Refused when a sub-account that holds a position or has an order on its way is removed.
   */
  modify(r: ResolvedBot, atMs: number): string | null {
    const sc = r.script
    if (sc === null) return 'a script bot stays a script bot'
    for (const s of this.subs) {
      if (sc.subs.some((d) => d.name === s.def.name)) continue
      if (!s.exchange.isFlat()) return `sub-account "${s.def.name}" holds a position or has an order on its way: it cannot be removed (close it first)`
    }
    const removed = this.subs.filter((s) => !sc.subs.some((d) => d.name === s.def.name)).map((s) => s.def.name)
    const added = sc.subs.filter((d) => !this.subs.some((s) => s.def.name === d.name)).map((d) => d.name)
    this.r = r
    this.newRun(sc)
    this.journal.write({ evenement: 'modifie', heure: iso(atMs), script: sc.text, subAccounts: sc.subs, drawings: sc.drawings, retires: removed, ajoutes: added, remarque: "open positions, their stops and take-profits, the registers and each kept sub-account's account are kept; a kept sub-account's collateral is its start, already spent: its new leverage, share and fixed stake apply from its next entry", ...this.startWords() })
    return null
  }

  snapshot(): ScriptSaved {
    this.foldTimes()
    const subs: Record<string, SubSaved> = {}
    for (const s of this.subs) subs[s.def.name] = { exchange: s.exchange.snapshot(), status: s.status, account0: s.account0, stake0: s.stake0, guard: guardSaved(s.exchange.book.guard) }
    return { paused: this.paused, run: this.run.saveState(), subs, times: { ...this.times } }
  }

  /** A restart: each sub-account's paper account, the run's registers and fields (a failed script stays failed until `reprendre` or `modifier`). */
  restore(saved: ScriptSaved): void {
    this.paused = saved.paused
    for (const s of this.subs) {
      const x = saved.subs[s.def.name]
      if (x === undefined) continue
      s.exchange.restore(x.exchange)
      s.status = x.status
      s.account0 = x.account0
      s.stake0 = x.stake0
      putGuard(s.exchange.book.guard, x.guard)
      s.haltWritten = s.exchange.book.guard?.halt != null
    }
    this.run.restoreState(saved.run, true)
    this.failureWritten = saved.run.failure !== null
    this.subs.forEach((s, k) => (this.run.accounts[k].account = s.exchange.account))
    if (saved.times !== undefined) this.times = { ...saved.times }
    this.seenTiming = this.run.timing()
  }

  private totals(): { trades: number; wins: number; losses: number; account: number; account0: number; stake0: number } {
    const t = { trades: 0, wins: 0, losses: 0, account: 0, account0: 0, stake0: 0 }
    this.subs.forEach((s, k) => {
      const a = this.run.accounts[k]
      t.trades += a.trades
      t.wins += a.wins
      t.losses += a.losses
      t.account += s.exchange.account
      t.account0 += s.account0
      t.stake0 += s.stake0
    })
    return t
  }

  /** The bot as `/bots` shows it: its figures the sub-accounts' sums, one `SubAccountView` per sub-account, its call times. */
  view(levierMax: number, debut: number): BotView {
    const t = this.totals()
    const subs: SubAccountView[] = this.subs.map((s, k) => {
      const pos = s.exchange.position()
      const a = this.run.accounts[k]
      const life: BotLife = s.status === 'liquide' ? 'liquide' : s.status === 'epuise' ? 'epuise' : this.paused || a.paused || s.exchange.book.guard?.halt != null ? 'arrete' : pos === null ? 'dehors' : pos.side === 1 ? 'long' : 'short'
      return { name: s.def.name, etat: life, levier: subParams(this.marketParams, s.def).leverage, entree: pos === null ? null : pos.entry, stopPrix: pos === null ? null : pos.stop, takePrix: s.exchange.book.pos?.take?.px ?? null, liquidationPrix: pos === null ? null : pos.liquidation, stake: pos === null ? null : pos.stake, size: pos === null ? null : pos.size, trades: a.trades, gagnants: a.wins, perdants: a.losses, pnl: s.exchange.account - s.account0, compte: s.exchange.account, compteDepart: s.account0 }
    })
    const open = subs.find((s) => s.etat === 'long' || s.etat === 'short')
    const etat: BotLife = this.paused || !this.run.live ? 'arrete' : subs.every((s) => s.etat === 'liquide') ? 'liquide' : subs.every((s) => s.etat === 'liquide' || s.etat === 'epuise') ? 'epuise' : open !== undefined ? open.etat : subs.some((s) => s.etat === 'arrete') ? 'arrete' : 'dehors'
    const first = subs[0]
    const sc = this.script()
    const pnl = t.account - t.account0
    const times = this.times
    return {
      id: this.r.spec.id, marche: this.r.spec.marche, levier: first?.levier ?? levierMax, levierMax, joueur: this.r.spec.joueur, reglages: {}, seuilBas: null, seuilHaut: null, regle: null, stop: null, trail: false, trailSeuil: 0, trailDistance: 0, part: sc.subs[0]?.share ?? SHARE_DEFAULT,
      ...(this.r.spec.name === undefined ? {} : { name: this.r.spec.name }), ...(this.r.spec.formerId === undefined ? {} : { formerId: this.r.spec.formerId }), debut: iso(debut),
      etat, entree: open?.entree ?? null, stopPrix: open?.stopPrix ?? null, liquidationPrix: open?.liquidationPrix ?? null,
      trades: t.trades, gagnants: t.wins, perdants: t.losses, pnl, pnlPct: t.stake0 > 0 ? (100 * pnl) / t.stake0 : 0, compte: t.account, compteDepart: t.account0,
      alerte: this.run.live ? null : `script failed: ${this.run.report().failure?.reason ?? ''}`,
      subAccounts: subs,
      scriptMs: { dernier: times.lastMs, max: times.maxMs, moyenne: times.timed === 0 ? null : times.sumMs / times.timed, auDela: times.over },
    }
  }

  /** The bot's line in the summaries (`BotSummary`), as a player's bot. */
  summary(): { trades: number; wins: number; losses: number; pnl: number; pnlPct: number; account: number; account0: number; status: BotStatus | 'arrete' } {
    const t = this.totals()
    const pnl = t.account - t.account0
    const status: BotStatus | 'arrete' = this.paused || !this.run.live || this.halted() ? 'arrete' : this.subs.every((s) => s.status === 'liquide') ? 'liquide' : this.alive() ? 'actif' : 'epuise'
    return { trades: t.trades, wins: t.wins, losses: t.losses, pnl, pnlPct: t.stake0 > 0 ? (100 * pnl) / t.stake0 : 0, account: t.account, account0: t.account0, status }
  }

  private endLine(evenement: 'arret' | 'fin', atMs: number): void {
    this.foldTimes()
    const s = this.summary()
    const times = this.times
    this.journal.write({ evenement, heure: iso(atMs), etat: s.status, trades: s.trades, gagnants: s.wins, perdants: s.losses, pnl: s.pnl, pnlPctMiseDepart: s.pnlPct, compte: s.account, comptes: Object.fromEntries(this.subs.map((x) => [x.def.name, x.exchange.account])), appelMs: { dernier: times.lastMs, max: times.maxMs, moyenne: times.timed === 0 ? null : times.sumMs / times.timed, auDela: times.over } })
  }

  /** The program stops: positions stay open (the state keeps them). */
  stopped(atMs: number): void {
    this.endLine('arret', atMs)
  }

  /** The end of the data (`rejouer`): the exchanges closed what was open, then the summary. */
  finish(endMs: number): void {
    this.endLine('fin', endMs)
  }
}
