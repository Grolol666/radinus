/**
 * A market's engine: it gives the clock and the prints to the market's data (`Market`) and to the bots, in time order. The progress is "forward": at a minute's close the market adds its candle and
 * each bot continues its indicator by one step; at a print the prints window receives it and each open position reads it; at a due time a bot's exchange executes its fill. A bot's work at an event is
 * constant, whatever its age; nothing is recomputed from its start.
 *
 * The events of one clock advance (`clock(ms)`: everything dated `ms` or before has arrived) pass in order of instant: a minute's close (instant = its end, possible as soon as `ms` >= end - 1: all the prints
 * before its end are there), a bot's launch (its start instant, after a close of the same instant: the warm-up is the candles closed until then), the fill of an order or of a stop exit (its due time, possible
 * as soon as `ms` >= due time: the last print before it is there).
 */

import { leverageOf } from './core/playerSearch'
import type { BotLife, BotView } from './core/radinusMessages'
import { exposureOf, liquidationDistances, maintenanceOf, startAccountOf, stopBehindLiquidation, tradeStakeOf } from './core/account'
import { Bot, rulesLine } from './bot'
import type { BotState, BotStatus } from './bot'
import { botLeverage, botPolicy, checkBot, leverageProblem } from './bots'
import type { ResolvedBot } from './bots'
import { PaperExchange } from './exchange'
import type { ExchangeState } from './exchange'
import { Journal } from './journal'
import { ScriptBot } from './scriptBot'
import type { ScriptSaved } from './scriptBot'
import { Market } from './market'
import type { MarketConfig } from './market'
import type { LiveSink, Print } from './seam'

/** A bot in the engine: its line, its journal, and (once launched) the bot and its exchange; a script bot (`r.script`) has `script` instead, which holds one exchange per sub-account. */
export type Runtime = { r: ResolvedBot; journal: Journal; bot: Bot | null; exchange: PaperExchange | null; script: ScriptBot | null }

/** Every paper exchange of a bot: its one, or a script bot's, one per sub-account. */
const exchangesOf = (rt: Runtime): PaperExchange[] => (rt.script !== null ? rt.script.subs.map((s) => s.exchange) : rt.exchange === null ? [] : [rt.exchange])

export type BotSummary = { id: string; marche: string; joueur: string; etat: BotStatus | 'arrete' | 'jamais_demarre'; trades: number; gagnants: number; perdants: number; pnl: number; pnlPctMiseDepart: number; compte: number; compteDepart: number; levier: number; stop: number | null; alerte: string | null }

/** What a bot taken up finds again (`etat.json`): its bot state, its exchange, the instant it started (ms); a script bot, its `ScriptSaved` (`kind: 'script'`). */
export type BotSaved = PlayerSaved | ScriptBotSaved
export type ScriptBotSaved = { kind: 'script'; startMs: number; script: ScriptSaved }
export type PlayerSaved = {
  kind?: undefined
  bot: BotState
  exchange: ExchangeState
  startMs: number
  /** The bot's starting leverage (the starting account and stake are computed from it), absent from an `etat.json` older than the leverage change: the bot's leverage then. */
  levierDepart?: number
  /** This state was rebuilt from the bot's journal (`rebuild.ts`), not read from `etat.json`: `bot.prev` is not known in it, the engine computes it again from the warm-up candles, and the journal gets an `etat_reconstruit` line. Written in `etat.json` only as long as the bot has not been started again (a stop before the market's warm-up), so the next restart computes `prev` again. */
  rebuilt?: { lignes: number; derniereLigne: string | null }
}
/** An engine's state to write: the open minute (s) and its launched bots. */
export type EngineSaved = { openT: number | null; bots: Record<string, BotSaved> }

const HOUR_MS = 3.6e6

export class Engine implements LiveSink {
  readonly market: Market
  readonly runtimes: Runtime[]
  private waiting: Runtime[]
  private readonly active: Runtime[] = []
  /** The minutes closing during a catch-up (the bot did not see them arrive), the cuts of the feed (ms, `to` null = under way), the next hour mark to photograph (ms, `null` = no funding: replay). */
  private blind = false
  private readonly cuts: { from: number; to: number | null }[] = []
  private nextHourMs: number | null = null
  private readonly snapshots = new Map<number, { rt: Runtime; ex: PaperExchange; account: string | null; held: { side: 1 | -1; qty: number } }[]>()
  /** The bots that asked to leave the list (`retirer`) and wait to be flat; called when one of them has left. */
  private readonly leaving = new Set<Runtime>()
  onRemoved: ((id: string, compte: number) => void) | null = null
  /** A bot has just been launched (its state was not that of a launched bot until now). */
  onLaunched: ((id: string) => void) | null = null
  /** The largest `ms` the clock has given: the instant written in the journal when a bot leaves without the request saying when. */
  private horizonMs = 0

  constructor(cfg: MarketConfig, bots: ResolvedBot[], journals: Map<string, Journal>) {
    this.market = new Market(cfg)
    for (const r of bots) {
      const problem = leverageProblem(r, cfg.margins)
      if (problem !== null) throw new Error(problem)
    }
    this.runtimes = bots.map((r) => {
      const journal = journals.get(r.spec.id)
      if (journal === undefined) throw new Error(`no journal for bot ${r.spec.id}`)
      return { r, journal, bot: null, exchange: null, script: null }
    })
    // A bot launched paused (`paused: true`) waits for no instant: it starts at its `reprendre`.
    this.waiting = this.runtimes.filter((rt) => rt.r.spec.paused !== true).sort((a, b) => a.r.startMs - b.r.startMs || (a.r.spec.id < b.r.spec.id ? -1 : 1))
  }

  /** Everything dated `ms` or before has arrived: the due events pass, in order of instant (close before launch before fill at an equal instant). */
  clock(ms: number): void {
    if (ms > this.horizonMs) this.horizonMs = ms
    for (;;) {
      // The earliest due event: the smallest (instant, rank); rank 0 = close, 1 = launch, 2 = fill.
      let time = Infinity
      let rank = 3
      const closeAt = this.market.closeAtMs()
      if (closeAt !== null && closeAt - 1 <= ms) {
        time = closeAt
        rank = 0
      }
      const next = this.waiting.length > 0 ? this.waiting[0] : null
      if (next !== null && next.r.startMs - 1 <= ms && (next.r.startMs < time || (next.r.startMs === time && 1 < rank))) {
        time = next.r.startMs
        rank = 1
      }
      let whoEx: PaperExchange | null = null
      for (const rt of this.active) {
        for (const ex of exchangesOf(rt)) {
          const d = ex.nextDeadline()
          if (d <= ms && (d < time || (d === time && 2 < rank))) {
            time = d
            rank = 2
            whoEx = ex
          }
        }
      }
      // An hour's mark: the prints before it are there (`H - 1 <= ms`), the events of its instant or after not yet passed: a position filled before it is held at it, an exit at its instant has paid it (`fundingPaid`).
      const hour = this.nextHourMs
      if (hour !== null && hour - 1 <= ms && (hour < time || (hour === time && -1 < rank))) {
        time = hour
        rank = -1
      }
      if (rank === 3) {
        this.sweepLeaving()
        return
      }
      if (rank === -1) this.markHour()
      else if (rank === 0) this.closeMinute()
      else if (rank === 1) this.launch(this.waiting.shift() as Runtime)
      else whoEx?.resolveNext()
    }
  }

  print(p: Print): void {
    const i = this.market.ingest(p)
    for (const rt of this.active) for (const ex of exchangesOf(rt)) ex.onPrint(i)
    // A script is called once the stops, take-profits and liquidations of every exchange have read the print (the page's order).
    for (const rt of this.active) rt.script?.onPrint(i)
    this.sweepLeaving()
  }

  // ---- What the live run asks on top of the replay (`LiveSink`).

  /** A print of a minute already closed: the exchange reads it, the closed candle is not rewritten. */
  late(p: Print): void {
    const i = this.market.ingestLate(p)
    for (const rt of this.active) for (const ex of exchangesOf(rt)) ex.onPrint(i)
    this.sweepLeaving()
  }

  /** The start (ms) of the open minute, `null` before the warm-up. */
  openMinuteMs(): number | null {
    return this.market.openT === null ? null : this.market.openT * 1000
  }

  /** The next due time (ms) `clock` would handle: the one whose instant is nearest, `Infinity` if there is none. */
  nextAt(): number {
    let t = Infinity
    const c = this.market.closeAtMs()
    if (c !== null) t = c - 1
    if (this.waiting.length > 0) t = Math.min(t, this.waiting[0].r.startMs - 1)
    for (const rt of this.active) for (const ex of exchangesOf(rt)) t = Math.min(t, ex.nextDeadline())
    if (this.nextHourMs !== null) t = Math.min(t, this.nextHourMs - 1)
    return t
  }

  /** The market's warm-up (the data module's minutes up to minute `uptoT` included); the bots not started yet do not start before the open minute (they play the instant: their warm-up is these minutes), and the hour marks (the funding, if `hours`) start at the next hour. */
  seed(rows: { t: number; o: number; h: number; l: number; c: number; v: number }[], uptoT: number, hours: boolean): void {
    this.market.seed(rows, uptoT)
    const from = (uptoT + 60) * 1000
    for (const rt of this.waiting) if (rt.r.startMs < from) rt.r.startMs = from
    this.waiting.sort((a, b) => a.r.startMs - b.r.startMs || (a.r.spec.id < b.r.spec.id ? -1 : 1))
    this.nextHourMs = hours ? (Math.floor(from / HOUR_MS) + 1) * HOUR_MS : null
  }

  /** Takes up the bots of a restart: they are launched at once, on the market's warm-up, their state read again (their `demarrage` is already in their journal). */
  restore(saved: Record<string, BotSaved>): void {
    for (const rt of this.runtimes) {
      const s = saved[rt.r.spec.id]
      if (s === undefined) continue
      rt.r.startMs = s.startMs
      this.waiting = this.waiting.filter((w) => w !== rt)
      this.launch(rt, s)
    }
  }

  /** The state to write (`etat.json`): the open minute and each launched bot. */
  snapshot(): EngineSaved {
    const bots: Record<string, BotSaved> = {}
    for (const rt of this.active) {
      if (rt.script !== null) bots[rt.r.spec.id] = { kind: 'script', startMs: rt.r.startMs, script: rt.script.snapshot() }
      else if (rt.bot !== null && rt.exchange !== null) bots[rt.r.spec.id] = { bot: rt.bot.snapshot(), exchange: rt.exchange.snapshot(), startMs: rt.r.startMs, levierDepart: rt.bot.info.startLeverage }
    }
    return { openT: this.market.openT, bots }
  }

  setBlind(on: boolean): void {
    this.blind = on
  }

  /** A cut of the feed: from `from` (ms) to `to` (ms) or, while it lasts, `null`. */
  openCut(from: number): void {
    const last = this.cuts[this.cuts.length - 1]
    if (last !== undefined && last.to === null) return
    this.cuts.push({ from, to: null })
  }
  closeCut(to: number): void {
    const c = this.cuts[this.cuts.length - 1]
    if (c !== undefined && c.to === null) c.to = to
  }

  /** A market journal line, written in the journal of each launched bot (`print_en_retard`, `flux_perdu`, ...). */
  note(event: Record<string, unknown>): void {
    for (const rt of this.active) rt.journal.write(event)
  }

  /** How many positions were held at the mark of hour `hourMs` (the funding is read only if there are some). */
  hourHeld(hourMs: number): number {
    return this.snapshots.get(hourMs)?.length ?? 0
  }

  /** The funding of hour `hourMs` on the positions held at its mark; `value` `null` = the row is missing: written as missing, never guessed. */
  settleFunding(hourMs: number, value: number | null): void {
    const held = this.snapshots.get(hourMs) ?? []
    this.snapshots.delete(hourMs)
    for (const h of held) {
      if (value === null) h.rt.journal.write({ evenement: 'funding_manquant', heure: new Date(hourMs).toISOString(), ...(h.account === null ? {} : { account: h.account }), cote: h.held.side === 1 ? 'long' : 'short', taille: h.held.qty })
      else h.ex.settleFunding(hourMs, h.held, value)
    }
  }

  private markHour(): void {
    const hour = this.nextHourMs as number
    const held: { rt: Runtime; ex: PaperExchange; account: string | null; held: { side: 1 | -1; qty: number } }[] = []
    for (const rt of this.active) {
      if (rt.script !== null) {
        for (const s of rt.script.subs) {
          const h = s.exchange.heldAt(hour)
          if (h !== null) held.push({ rt, ex: s.exchange, account: s.def.name, held: h })
        }
        continue
      }
      const h = rt.exchange === null ? null : rt.exchange.heldAt(hour)
      if (h !== null && rt.exchange !== null) held.push({ rt, ex: rt.exchange, account: null, held: h })
    }
    if (held.length > 0) this.snapshots.set(hour, held)
    this.nextHourMs = hour + HOUR_MS
  }

  private inCut(t: number): boolean {
    return this.cuts.some((c) => t >= c.from && (c.to === null || t <= c.to))
  }

  /** The end of the data: the clock moves to the last print (the fills due until then happen), the open positions are closed at that print, the journals end. */
  end(): void {
    const last = this.market.last
    if (last === null) return
    this.clock(last.t)
    for (const rt of this.runtimes) {
      if (rt.script !== null) {
        for (const ex of exchangesOf(rt)) ex.finish()
        rt.script.finish(last.t)
        continue
      }
      if (rt.bot === null || rt.exchange === null) {
        rt.journal.write({ evenement: 'fin', heure: new Date(last.t).toISOString(), etat: 'jamais_demarre', remarque: 'le lancement du bot est après la fin des données' })
        continue
      }
      rt.exchange.finish()
      rt.bot.finish(last.t)
    }
  }

  private closeMinute(): void {
    const { bar, delta } = this.market.closeMinute()
    const closeMs = (bar.t + 60) * 1000
    for (const rt of this.active) {
      rt.bot?.onClose(bar, delta, closeMs)
      rt.script?.onClose(bar, delta, closeMs)
    }
  }

  private launch(rt: Runtime, saved?: BotSaved): void {
    const m = this.market
    if (rt.r.script !== null) {
      const sb = new ScriptBot(rt.r, rt.journal, m, { blind: () => this.blind, inCut: (t) => this.inCut(t) }, saved !== undefined)
      if (saved !== undefined && saved.kind === 'script') sb.restore(saved.script)
      rt.script = sb
      this.active.push(rt)
      this.onLaunched?.(rt.r.spec.id)
      return
    }
    if (saved !== undefined && saved.kind === 'script') throw new Error(`bot "${rt.r.spec.id}": etat.json holds a script bot's state, its definition is not a script`)
    const leverage = botLeverage(rt.r, m.cfg.margins)
    const maintenance = maintenanceOf(m.cfg.margins)
    const startLeverage = saved?.levierDepart ?? leverage
    const account = startAccountOf(botPolicy(rt.r, startLeverage))
    const policy = botPolicy(rt.r, leverage)
    const liquidation = liquidationDistances(exposureOf(policy, account), maintenance)
    const info = { leverage, startLeverage, account, stake: tradeStakeOf(policy, account), liquidation, stopBehind: stopBehindLiquidation(rt.r.stop, liquidation) }
    const bot = new Bot(rt.r, rt.journal, info, { bars: m.bars, delta: m.delta }, { blind: () => this.blind, inCut: (t) => this.inCut(t) }, saved !== undefined)
    const exchange = new PaperExchange(m, { ...policy, maintenance, liquidationFeePct: m.cfg.liquidationFeePct }, account, (e) => bot.learn(e), bot.guard)
    bot.connect(exchange)
    if (saved !== undefined) {
      bot.restore(saved.bot)
      exchange.restore(saved.exchange)
      if (saved.rebuilt !== undefined) {
        // Rebuilt from the journal: the conditions of the previous close are those of the warm-up candles (a bot halted, liquidated or exhausted does not decide with them: 0).
        bot.state.prev = bot.status === 'actif' && !bot.paused ? bot.indicator.bits() : 0
        const pos = exchange.position()
        rt.journal.write({
          evenement: 'etat_reconstruit', bot: rt.r.spec.id, depuis: 'journal', lignesLues: saved.rebuilt.lignes, derniereLigne: saved.rebuilt.derniereLigne,
          etat: bot.paused ? 'arrete' : bot.status, compte: bot.account, trades: bot.trades, gagnants: bot.wins, perdants: bot.losses, apresStop: bot.state.afterStop, conditionsAvant: bot.state.prev, ordresEnAttente: saved.exchange.pending.length,
          position: pos === null ? null : { cote: pos.side === 1 ? 'long' : 'short', entreePrix: pos.entry, stopPrix: pos.stop, liquidationPrix: pos.liquidation },
          provenance: { compte: 'journal', position: 'journal', stop: 'journal', compteurs: 'journal', conditionsAvant: 'bougies amorcées', definition: 'journal (demarrage)' },
        })
      }
    }
    rt.bot = bot
    rt.exchange = exchange
    this.active.push(rt)
    this.onLaunched?.(rt.r.spec.id)
  }

  // ---- The page's verbs (the server sends them through `Control`, direct.ts; neither the bot nor the exchange knows a page exists). They return `null` when done, else the reason of the refusal.

  private find(id: string): Runtime | undefined {
    return this.runtimes.find((rt) => rt.r.spec.id === id)
  }

  has(id: string): boolean {
    return this.find(id) !== undefined
  }

  /** A script bot launched paused (`paused: true`) and never started: no decision, no order, nothing in `etat.json` (`jamais_demarre`) until `reprendre`. */
  private held(rt: Runtime): boolean {
    return rt.bot === null && rt.script === null && rt.r.spec.paused === true
  }

  /** `arreter`: no more decision; the pending order is cancelled; the open position is closed at the market at `atMs` (the page's fill rule, motif `arret`, counted as a trade) and its stop goes with it. */
  pause(id: string, atMs: number): string | null {
    const rt = this.find(id)
    if (rt === undefined) return `unknown bot "${id}"`
    if (this.held(rt)) return `bot "${id}": launched paused, it has never run (reprendre starts it)`
    const sb = rt.script
    if (sb !== null) {
      if (sb.paused) return `bot "${id}" is already stopped`
      // Every sub-account: its orders cancelled, its position closed at market (`arret`), as a player's bot.
      sb.pause(atMs)
      for (const ex of exchangesOf(rt)) {
        ex.cancelOrders()
        ex.closeAt(atMs)
      }
      return null
    }
    const bot = rt.bot
    if (bot === null || rt.exchange === null) return `bot "${id}" is not launched yet`
    if (bot.status === 'liquide') return `bot "${id}" is liquidated`
    if (bot.status === 'epuise') return `the account of bot "${id}" is exhausted`
    if (bot.paused) return `bot "${id}" is already stopped`
    bot.pause(atMs)
    rt.exchange.cancelOrders()
    rt.exchange.closeAt(atMs)
    return null
  }

  /** `reprendre`: the bot decides again at the next close, starting out as at its launch; its indicator has never stopped being continued. */
  resume(id: string, atMs: number): string | null {
    const rt = this.find(id)
    if (rt === undefined) return `unknown bot "${id}"`
    if (this.held(rt)) {
      // Its first start: from now, as a launch (its `demarrage` is written then, its helpers rewarm from the market's bars).
      delete rt.r.spec.paused
      rt.r.startMs = atMs
      rt.r.spec.debut = new Date(atMs).toISOString()
      this.waiting.push(rt)
      this.waiting.sort((a, b) => a.r.startMs - b.r.startMs || (a.r.spec.id < b.r.spec.id ? -1 : 1))
      return null
    }
    const sb = rt.script
    if (sb !== null) {
      if (!sb.paused && sb.run.live && !sb.halted()) return `bot "${id}" is not stopped`
      sb.resume(atMs)
      return null
    }
    if (rt.bot === null) return `bot "${id}" is not launched yet`
    if (!rt.bot.paused && rt.bot.guard.halt === null) return `bot "${id}" is not stopped`
    rt.bot.resume(atMs)
    // A bot halted by a guard rule can hold a position (it is not touched): it knows it holds it, it does not start again as if flat.
    const pos = rt.exchange?.position() ?? null
    if (pos !== null) rt.bot.state.held = pos.side
    return null
  }

  /** `levier`: the bot takes this leverage at its NEXT entry. An open position keeps the stake, the notional and the liquidation price of its fill; an order already sent is filled with the leverage in force at its due time. The starting account and stake do not move. The same check as at the launch (`checkBot`, `leverageProblem`). */
  setLeverage(id: string, leverage: number, atMs: number): string | null {
    const rt = this.find(id)
    if (rt === undefined) return `unknown bot "${id}"`
    if (rt.r.script !== null) return `bot "${id}": a script bot's leverage is per sub-account: modify it from /bot`
    const bot = rt.bot
    if (bot === null || rt.exchange === null) return `bot "${id}" is not launched yet`
    const checked = checkBot({ ...rt.r.spec, levier: leverage })
    if (typeof checked === 'string') return checked
    const tooHigh = leverageProblem(checked, this.market.cfg.margins)
    if (tooHigh !== null) return tooHigh
    const before = botLeverage(rt.r, this.market.cfg.margins)
    if (leverage === before) return `bot "${id}" is already at leverage ${before}`
    rt.r.leverage = leverage
    rt.r.spec.levier = leverage
    rt.exchange.setLeverage(leverage)
    bot.info.leverage = leverage
    bot.info.liquidation = liquidationDistances(exposureOf(botPolicy(rt.r, leverage), bot.info.account), maintenanceOf(this.market.cfg.margins))
    bot.info.stopBehind = stopBehindLiquidation(rt.r.stop, bot.info.liquidation)
    rt.journal.write({ evenement: 'levier_change', heure: new Date(atMs).toISOString(), ancien: before, nouveau: leverage })
    return null
  }

  /** `retirer`: an `arreter`, then the bot leaves the list as soon as it is flat (its exit is written first); its journal stays on disk. A bot not launched yet leaves at once. */
  remove(id: string, atMs: number): string | null {
    const rt = this.find(id)
    if (rt === undefined) return `unknown bot "${id}"`
    if (rt.bot === null && rt.script === null) {
      this.waiting = this.waiting.filter((w) => w !== rt)
      this.leave(rt, atMs)
      return null
    }
    if (rt.script !== null ? !rt.script.paused : rt.bot !== null && !rt.bot.paused && rt.bot.status === 'actif') this.pause(id, atMs)
    this.leaving.add(rt)
    this.sweepLeaving(atMs)
    return null
  }

  /** The bots that asked to leave and are flat (no position, nothing pending) leave the list. `atMs`: the instant written in the journal; by default, the horizon. */
  private sweepLeaving(atMs?: number): void {
    if (this.leaving.size === 0) return
    for (const rt of this.leaving) {
      if (exchangesOf(rt).some((ex) => !ex.isFlat())) continue
      this.leaving.delete(rt)
      this.leave(rt, atMs ?? this.horizonMs)
    }
  }

  private leave(rt: Runtime, atMs: number): void {
    rt.journal.write({ evenement: 'retrait', heure: new Date(atMs).toISOString() })
    const compte = this.view(rt).compte
    const k = this.active.indexOf(rt)
    if (k >= 0) this.active.splice(k, 1)
    this.runtimes.splice(this.runtimes.indexOf(rt), 1)
    this.onRemoved?.(rt.r.spec.id, compte)
  }

  /** One more bot in the list of a market already followed (`lancer`): it waits for its start instant as a `bots.json` bot that has a `debut`; those running are neither delayed nor changed. */
  add(r: ResolvedBot, journal: Journal): void {
    const rt: Runtime = { r, journal, bot: null, exchange: null, script: null }
    this.runtimes.push(rt)
    if (r.spec.paused === true) return
    this.waiting.push(rt)
    this.waiting.sort((a, b) => a.r.startMs - b.r.startMs || (a.r.spec.id < b.r.spec.id ? -1 : 1))
  }

  /**
   * `modifier` (a script bot, author's go 2026-10-10): the new definition (checked by `checkBot` like a launch: its script, sub-accounts, drawings, name) replaces the bot's; its open positions, their stops and take-profits, its registers and each kept
   * sub-account's account stay ("modify does nothing to an open position"). Refused when a sub-account with a position or an order on its way would be removed. `arreter` / `reprendre` are not touched.
   */
  modify(id: string, r: ResolvedBot, atMs: number): string | null {
    const rt = this.find(id)
    if (rt === undefined) return `unknown bot "${id}"`
    if (rt.r.script === null || r.script === null) return `bot "${id}": only a script bot is modified`
    if (r.spec.marche !== rt.r.spec.marche) return `bot "${id}": its market is ${rt.r.spec.marche}, a modify does not move it to ${r.spec.marche}`
    const spec = { ...r.spec, id: rt.r.spec.id, debut: rt.r.spec.debut, ...(rt.r.spec.formerId === undefined ? {} : { formerId: rt.r.spec.formerId }) }
    const next: ResolvedBot = { ...r, spec, startMs: rt.r.startMs }
    if (rt.script === null) {
      // Not launched yet: it will start with the new definition.
      rt.r = next
      return null
    }
    const why = rt.script.modify(next, atMs)
    if (why !== null) return why
    rt.r = next
    return null
  }

  /** A bot as the page shows it: its definition and its state. */
  view(rt: Runtime): BotView {
    const m = this.market
    if (rt.script !== null) return rt.script.view(leverageOf(m.cfg.margins), rt.r.startMs)
    const leverage = botLeverage(rt.r, m.cfg.margins)
    const bot = rt.bot
    const settings: Record<string, number> = {}
    rt.r.def.settings.forEach((s, k) => (settings[s.key] = rt.r.settings[k]))
    const account0 = bot === null ? startAccountOf(botPolicy(rt.r, leverage)) : bot.info.account
    const stake = bot === null ? tradeStakeOf(botPolicy(rt.r, leverage), account0) : bot.info.stake
    const pos = rt.exchange?.position() ?? null
    const pnl = bot === null ? 0 : bot.account - account0
    const etat: BotLife = bot === null ? (this.held(rt) ? 'arrete' : 'attente') : bot.status === 'liquide' ? 'liquide' : bot.status === 'epuise' ? 'epuise' : bot.paused || bot.guard.halt !== null ? 'arrete' : pos === null ? 'dehors' : pos.side === 1 ? 'long' : 'short'
    return {
      id: rt.r.spec.id, marche: rt.r.spec.marche, levier: leverage, levierMax: leverageOf(m.cfg.margins), joueur: rt.r.def.id, reglages: settings,
      seuilBas: rt.r.def.shape === 'zone' ? rt.r.low : null, seuilHaut: rt.r.def.shape === 'zone' ? rt.r.high : null, regle: rt.r.rule, stop: rt.r.stop, trail: rt.r.trailBox.on, trailSeuil: rt.r.trailBox.seuil, trailDistance: rt.r.trailBox.distance, part: rt.r.share, ...(rt.r.start === null ? {} : { startAccount: rt.r.start }), ...(rt.r.fixedStake === null ? {} : { fixedStake: rt.r.fixedStake }), ...rulesLine(rt.r), ...(bot === null || bot.guard.halt === null ? {} : { arret: { cause: bot.guard.halt.cause, valeur: bot.guard.halt.value, heure: new Date(bot.guard.halt.t).toISOString() } }), ...(rt.r.spec.attendu === undefined ? {} : { attendu: rt.r.spec.attendu }), ...(rt.r.spec.compose === undefined ? {} : { compose: rt.r.spec.compose }), ...(rt.r.spec.name === undefined ? {} : { name: rt.r.spec.name }), ...(rt.r.spec.formerId === undefined ? {} : { formerId: rt.r.spec.formerId }), debut: new Date(rt.r.startMs).toISOString(),
      etat, entree: pos === null ? null : pos.entry, stopPrix: pos === null ? null : pos.stop, liquidationPrix: pos === null ? null : pos.liquidation,
      trades: bot === null ? 0 : bot.trades, gagnants: bot === null ? 0 : bot.wins, perdants: bot === null ? 0 : bot.losses, pnl, pnlPct: (100 * pnl) / stake,
      compte: bot === null ? account0 : bot.account, compteDepart: account0,
      alerte: bot === null || bot.info.stopBehind.length === 0 ? null : `stop behind the liquidation (${bot.info.stopBehind.join(', ')})`,
    }
  }

  summaries(): BotSummary[] {
    return this.runtimes.map((rt) => {
      if (rt.script !== null) {
        const s = rt.script.summary()
        return { id: rt.r.spec.id, marche: rt.r.spec.marche, joueur: rt.r.def.id, etat: s.status, trades: s.trades, gagnants: s.wins, perdants: s.losses, pnl: s.pnl, pnlPctMiseDepart: s.pnlPct, compte: s.account, compteDepart: s.account0, levier: 0, stop: null, alerte: rt.script.run.live ? null : 'script failed' }
      }
      const bot = rt.bot
      const leverage = bot === null ? 0 : bot.info.leverage
      if (bot === null) return { id: rt.r.spec.id, marche: rt.r.spec.marche, joueur: rt.r.def.id, etat: 'jamais_demarre', trades: 0, gagnants: 0, perdants: 0, pnl: 0, pnlPctMiseDepart: 0, compte: 0, compteDepart: 0, levier: leverage, stop: rt.r.stop, alerte: null }
      const pnl = bot.account - bot.info.account
      return {
        id: rt.r.spec.id, marche: rt.r.spec.marche, joueur: rt.r.def.id, etat: bot.paused || bot.guard.halt !== null ? 'arrete' : bot.status, trades: bot.trades, gagnants: bot.wins, perdants: bot.losses, pnl, pnlPctMiseDepart: (100 * pnl) / bot.info.stake,
        compte: bot.account, compteDepart: bot.info.account, levier: leverage, stop: rt.r.stop, alerte: bot.info.stopBehind.length === 0 ? null : `stop behind the liquidation (${bot.info.stopBehind.join(', ')})`,
      }
    })
  }
}
