/**
 * A bot: a row of `/rsi`, frozen, that plays the instant. At a minute's close it continues its indicator by one candle, reads its side conditions, decides (`decideSide`, the page's decision)
 * and SENDS its order to the exchange, stop-loss attached; it WATCHES its position through what the exchange tells it (`learn`), and that is all: it fills nothing, triggers nothing, liquidates nothing. It starts out and enters at its
 * first signal after its launch: no "taking up" of a position the simulation would have had before. It writes its journal, decisions included.
 */

import { LEAN_SIM_LATENCY_MS } from './core/leanSim'
import { afterFilled, afterStopped, decideSide } from './core/playerStop'
import { guardState, hasRules, newGuard, resetGuard, restoreGuard } from './core/playerRules'
import type { Guard, GuardState } from './core/playerRules'
import type { PlayerSide } from './core/playerStop'
import type { BenchBar } from './core/zonesBench'
import type { ResolvedBot } from './bots'
import { Chain, Indicator } from './indicator'
import type { Signals } from './indicator'
import type { Journal } from './journal'
import type { Exchange, ExchangeEvent } from './seam'

export type BotStatus = 'actif' | 'liquide' | 'epuise'

/** What the bot writes of its account at start (computed by the engine from the market: `core/account.ts`). `leverage` is the leverage of the next entries (the page's `levier` changes it); `startLeverage`, the starting one, from which the starting account and stake stay computed. */
export type AccountInfo = { leverage: number; startLeverage: number; account: number; stake: number; liquidation: { long: number; short: number }; stopBehind: ('long' | 'short')[] }

const iso = (ms: number): string => new Date(ms).toISOString()
const sideName = (s: 1 | -1): string => (s === 1 ? 'long' : 'short')

/** A bot's guard rules as the journal and the list write them: only those that are set. */
export const rulesLine = (r: ResolvedBot): { pertesDeSuite?: number; perteMise?: number; tempsMort?: number; coteInterdit?: number } => ({
  ...(r.rules.losses === null ? {} : { pertesDeSuite: r.rules.losses }),
  ...(r.rules.loss === null ? {} : { perteMise: r.rules.loss }),
  ...(r.rules.pause === null ? {} : { tempsMort: r.rules.pause }),
  ...(r.rules.ban === null ? {} : { coteInterdit: r.rules.ban }),
})

/** What the bot holds and a restart must find again (`etat.json`): its side, whether it waits for a fresh condition after a stop, its conditions of the previous decision, its counters, its account. */
export type BotState = { status: BotStatus; held: 1 | 0 | -1; afterStop: boolean; prev: number; trades: number; wins: number; losses: number; account: number; paused?: boolean; guard?: GuardState }

/** What the engine tells the bot of the instant: `blind()` = the minutes closing now close without the bot having seen them arrive (a catch-up after a cut); `inCut(t)` = the instant `t` falls in a cut of the feed. */
export type BotContext = { blind: () => boolean; inCut: (t: number) => boolean }

export class Bot {
  readonly r: ResolvedBot
  readonly state: PlayerSide = { held: 0, afterStop: false, prev: 0, guard: null }
  /** The bot's guard rules (`playerRules.ts`, with no rule: inert); the bot's exchange holds the same object, it is the exchange that tells it the closed trades and the account. */
  readonly guard: Guard
  /** The `arret_regle` line of the current halt is written. */
  private haltWritten = false
  readonly indicator: Signals
  readonly info: AccountInfo
  readonly journal: Journal
  status: BotStatus = 'actif'
  /** Stopped from the page (`arreter`): the indicator goes on, no decision is taken, until `resume`. Written to `etat.json` (`paused`), so a restart keeps it. */
  paused = false
  trades = 0
  wins = 0
  losses = 0
  /** The account as the exchange told it to the bot (last closed trade or liquidation). */
  account: number
  /** The minutes without a print in a row: written in one go when they end. */
  private empty: { from: number; count: number } | null = null
  private exchange: Exchange | null = null

  private readonly ctx: BotContext

  /** `resumed`: the bot is taken up from a restart, its `demarrage` is already in its journal. */
  constructor(r: ResolvedBot, journal: Journal, info: AccountInfo, seed: { bars: BenchBar[]; delta: number[] }, ctx: BotContext = { blind: () => false, inCut: () => false }, resumed = false) {
    this.r = r
    this.ctx = ctx
    this.journal = journal
    this.info = info
    this.account = info.account
    this.guard = newGuard(r.rules, info.account, info.stake, null)
    this.state.guard = this.guard
    this.indicator = r.compose === null ? new Indicator({ def: r.def, settings: r.settings, rule: r.rule, low: r.low, high: r.high }) : new Chain(r.compose.members, r.compose.links)
    seed.bars.forEach((b, i) => this.indicator.push(b, seed.delta[i]))
    const settings: Record<string, number> = {}
    r.def.settings.forEach((s, k) => (settings[s.key] = r.settings[k]))
    if (resumed) journal.write({ evenement: 'redemarrage', bot: r.spec.id, bougiesAmorce: seed.bars.length })
    else journal.write({
      evenement: 'demarrage', heure: iso(r.startMs), bot: r.spec.id, marche: r.spec.marche, joueur: r.def.id, reglages: settings,
      seuilBas: r.def.shape === 'zone' ? r.low : null, seuilHaut: r.def.shape === 'zone' ? r.high : null, regle: r.rule, ...(r.spec.compose === undefined ? {} : { compose: r.spec.compose }), stop: r.stop, trail: r.trailBox.on, trailSeuil: r.trailBox.seuil, trailDistance: r.trailBox.distance, part: r.share, ...(r.start === null ? {} : { startAccount: r.start }), ...(r.fixedStake === null ? {} : { fixedStake: r.fixedStake }), ...rulesLine(r), ...(r.spec.attendu === undefined ? {} : { attendu: r.spec.attendu }), ...(r.spec.name === undefined ? {} : { name: r.spec.name }),
      levier: info.leverage, compteDepart: info.account, miseDepart: info.stake, distanceLiquidationPct: info.liquidation, stopDerriereLiquidation: info.stopBehind, bougiesAmorce: seed.bars.length,
    })
  }

  /** Plugs in the exchange: where the bot sends its orders. */
  connect(exchange: Exchange): void {
    this.exchange = exchange
  }

  /** A minute's close (`closeMs`): candle `bar` is closed. */
  onClose(bar: BenchBar, delta: number, closeMs: number): void {
    if (this.status !== 'actif') return
    if (!bar.real) {
      if (this.empty === null) this.empty = { from: bar.t, count: 1 }
      else this.empty.count++
    } else this.flushEmpty()
    this.indicator.push(bar, delta)
    if (this.paused) return
    const bits = this.indicator.bits()
    if (this.ctx.blind()) {
      // A minute closed during a cut: the bot reads it (its conditions move on) but does not decide, no order.
      this.state.prev = bits
      this.journal.write({ evenement: 'minute_sans_decision', heure: iso(closeMs), valeur: this.indicator.current(), conditions: bits })
      return
    }
    const w = decideSide(this.state, bits, closeMs)
    if (w === 0) return
    const { def, rule, low, high } = this.r
    this.journal.write({ evenement: 'decision', heure: iso(closeMs), signal: sideName(w), valeur: this.indicator.current(), seuilBas: def.shape === 'zone' ? low : null, seuilHaut: def.shape === 'zone' ? high : null, regle: rule, conditions: bits, ...(this.indicator instanceof Chain ? { members: this.indicator.memberBits() } : {}) })
    if (this.exchange === null) throw new Error('bot: no exchange plugged in')
    const only = this.r.compose === null ? 0 : this.r.compose.only
    this.exchange.send({ side: w, stopPct: this.r.stop, trail: this.r.trail, sentMs: closeMs, atMs: closeMs + LEAN_SIM_LATENCY_MS, ...(only === 0 ? {} : { only }) })
  }

  /** What the exchange tells the bot: its position (entry, stop hit, exit, liquidation); it writes it. */
  learn(e: ExchangeEvent): void {
    switch (e.kind) {
      case 'entree':
        afterFilled(this.state)
        this.journal.write({ evenement: 'entree', heure: iso(e.t), ...this.cut(e.t), cote: sideName(e.side), prix: e.px, taille: e.qty, notionnel: e.notional, mise: e.stake, compteAvant: e.accountBefore, stopPrix: e.stopPx, liquidationPrix: e.liquidationPx })
        return
      case 'stop_touche':
        if (!e.replaced) afterStopped(this.state)
        this.journal.write({ evenement: 'stop_touche', heure: iso(e.t), ...this.cut(e.t), prix: e.px, stopPrix: e.stopPx, sortieAttendue: iso(e.exitAt) })
        return
      case 'sortie':
        this.trades++
        if (e.pnl100 > 0) this.wins++
        else this.losses++
        this.account = e.account
        this.writeHalt()
        this.journal.write({ evenement: 'sortie', heure: iso(e.t), ...this.cut(e.t), cote: sideName(e.side), prix: e.px, motif: e.reason, entreeHeure: iso(e.entryT), entreePrix: e.entryPx, pnlSur100: e.pnl100, pnl: e.pnl, pnlPctMise: e.pnlPct, compte: e.account })
        return
      case 'liquidation':
        this.status = 'liquide'
        this.account = e.account
        this.journal.write({ evenement: 'liquidation', heure: iso(e.t), ...this.cut(e.t), cote: sideName(e.side), prix: e.px, liquidationPrix: e.liquidationPx, mise: e.stake, frais: e.fee, compte: e.account })
        return
      case 'funding':
        this.account = e.account
        this.journal.write({ evenement: 'funding', heure: iso(e.t), ...this.cut(e.t), cote: sideName(e.side), taille: e.qty, valeur: e.value, montant: e.amount, compte: e.account })
        return
      case 'close_order_filled':
        afterFilled(this.state)
        this.journal.write({ evenement: 'close_order', heure: iso(e.t) })
        return
      case 'ordre_sans_prix':
        afterFilled(this.state)
        this.journal.write({ evenement: 'ordre_sans_prix', heure: iso(e.t) })
        return
      case 'stake_above_account':
        // No entry: the order is handled, the guard halted the bot (`arret_regle`, cause `stake`).
        afterFilled(this.state)
        this.writeHalt()
        return
      case 'compte_epuise':
        this.status = 'epuise'
        this.account = 0
        this.journal.write({ evenement: 'compte_epuise', heure: iso(e.t) })
        return
    }
  }

  /** The guard rule that just halted the bot (`playerRules.ts`): written once, after the exit that triggered it (or, cause `stake`, at the entry it refused). */
  private writeHalt(): void {
    const h = this.guard.halt
    if (h === null || this.haltWritten) return
    this.haltWritten = true
    this.journal.write({ evenement: 'arret_regle', heure: iso(h.t), cause: h.cause, valeur: h.value, compte: this.account })
  }

  /** `{ pendantCoupure: true }` if the instant falls in a cut of the feed (the journal says so, nothing else changes). */
  private cut(t: number): { pendantCoupure?: true } {
    return this.ctx.inCut(t) ? { pendantCoupure: true } : {}
  }

  /** `arreter`: the bot takes no more decision; its indicator is still continued at each close. The paper exchange closes the position (the engine asks it), this only stops the deciding and writes the instant. */
  pause(atMs: number): void {
    this.paused = true
    this.journal.write({ evenement: 'arret_demande', heure: iso(atMs) })
  }

  /** `reprendre`: the bot decides again from the next close, out of the market, as at its launch (nothing held, no condition to wait for fresh, no condition seen before). */
  resume(atMs: number): void {
    this.paused = false
    this.state.held = 0
    this.state.afterStop = false
    this.state.prev = 0
    resetGuard(this.guard)
    this.haltWritten = false
    this.journal.write({ evenement: 'reprise', heure: iso(atMs) })
  }

  snapshot(): BotState {
    return { status: this.status, held: this.state.held, afterStop: this.state.afterStop, prev: this.state.prev, trades: this.trades, wins: this.wins, losses: this.losses, account: this.account, ...(this.paused ? { paused: true } : {}), ...(hasRules(this.r.rules) || this.guard.halt !== null ? { guard: guardState(this.guard) } : {}) }
  }

  restore(s: BotState): void {
    this.paused = s.paused === true
    this.status = s.status
    this.state.held = s.held
    this.state.afterStop = s.afterStop
    this.state.prev = s.prev
    this.trades = s.trades
    this.wins = s.wins
    this.losses = s.losses
    this.account = s.account
    if (s.guard !== undefined) restoreGuard(this.guard, s.guard)
    this.haltWritten = this.guard.halt !== null
  }

  /** The program's stop: the minutes without a print under way are written, the position stays open (the state keeps it), the summary is in the journal. */
  stopped(atMs: number): void {
    this.flushEmpty()
    const pnl = this.account - this.info.account
    this.journal.write({ evenement: 'arret', heure: iso(atMs), etat: this.status, trades: this.trades, gagnants: this.wins, perdants: this.losses, pnl, pnlPctMiseDepart: (100 * pnl) / this.info.stake, compte: this.account })
  }

  /** The end of the data: the minutes without a print under way are written, then the end line. */
  finish(endMs: number): void {
    this.flushEmpty()
    const pnl = this.account - this.info.account
    this.journal.write({ evenement: 'fin', heure: iso(endMs), etat: this.status, trades: this.trades, gagnants: this.wins, perdants: this.losses, pnl, pnlPctMiseDepart: (100 * pnl) / this.info.stake, compte: this.account })
  }

  private flushEmpty(): void {
    const e = this.empty
    if (e === null) return
    this.empty = null
    this.journal.write({ evenement: 'minutes_sans_donnee', depuis: iso(e.from * 1000), jusqua: iso((e.from + 60 * e.count) * 1000), minutes: e.count })
  }
}
