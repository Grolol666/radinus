/**
 * A market's live source: the data module (src/sources/) and the PC's clock behind the `LiveSource` / `LiveSink` seam (`seam.ts`). The sink is the replay's engine (`Engine`): nothing in the bot, the exchange or the account needs to know
 * where the prints come from. The clock and the feed are injected (`Clock`, `LiveLoaders`); nothing here reads `Date.now()` or opens a socket.
 *
 * THE MINUTE CLOSES BY THE CLOCK, AFTER A WAIT. The sink knows that "at instant `h`, everything dated `h` or before has arrived" (`Sink.clock(h)`). Live, this is never known; it is decided:
 * at the program's instant `now` (the PC's time set on the prints: `printClock.ts`), `h = now - wait` (200 ms by default, under the fill rule's 300 ms). A print that arrives is set aside and delivered only once `h` has reached it; the prints delivered
 * are delivered in (t, id) order, each preceded by `clock(t - 1)`, exactly as the replay does. A minute without a print therefore closes when `h` passes its end: a flat candle, as on the page.
 *
 * A LATE PRINT (arrived after its minute was closed): written (`print_en_retard`, with its delay), counted, the closed candle is not rewritten, but the exchange reads it (a stop is a stop).
 *
 * A CUT is written as a cut: `flux_perdu` (the instant of the loss), `flux_revenu` (the instant of the return). During the cut the sink's clock does not move: nothing closes on incomplete data.
 * On the return, the source reads the missed prints from the data module (`ticks` from the loss's horizon, minus 5 s) and delivers them in order, with those that arrived on the socket during the read (de-duplicated by id):
 * the exchange sees them at their own instants (a stop or a liquidation of the cut is triggered there and written "pendantCoupure"), the candles are built, and the bot does not decide on the minutes that close
 * this way (`minute_sans_decision`). It decides again at the first close after. A restart of the program is the same thing: the written state (`etat.json`) is read again, the time in between is a cut.
 *
 * THE FUNDING: a mark at each hour; one minute later, if a position was held at that mark, a read of Lighter's `fundings` page (the site's read); the row is missing: a second read one minute
 * later; still missing: written as missing, never guessed.
 */

import type { LighterTrade } from './core/lighter'
import type { LiveLoaders } from './sources/types'
import type { PrintClock } from './printClock'
import type { LiveSink, LiveSource, Print } from './seam'

const MINUTE_MS = 60000
const HOUR_MS = 3.6e6
/** The extra margin, after the wait, before reading the candles at start: the data module has finished writing the minute that just closed. */
export const SEED_SETTLE_MS = 2000
/** An hour's funding is read one minute after its mark, then (if the row is not there) one minute later. */
export const FUNDING_DELAY_MS = 60000
/** The prints read again before the loss's horizon on the return from a cut: those which, dated before, would not have arrived. */
export const CUT_OVERLAP_MS = 5000
/** The prints whose id is kept (de-duplication): those of the last 3 minutes. */
const SEEN_KEEP_MS = 180000

export type LiveOptions = {
  marketId: number
  name: string
  /** The program's clock, set on the prints of every market (`printClock.ts`): each print that arrives enters it. */
  clock: PrintClock
  loaders: LiveLoaders
  /** The wait after the end of a minute (ms) before closing it. */
  waitMs: number
  /** A restart: the minute open when the state was written, the instant the program last saw, and what the engine does once warmed up (read the bots again). */
  resume: { openMs: number; vuMs: number; restore: () => void } | null
  /** Funding on the paper account (`marche.json`, `financement`): otherwise no hour mark, no read of `/fundings`. */
  funding: boolean
  /** A line of the program's life (`programme.jsonl`): the prints' delay. */
  program: (event: Record<string, unknown>) => void
  /** Called after each step (the state to write if it changed). */
  onStep: () => void
  /** A line for the console. */
  say: (line: string) => void
  /** Called when the feed's state changes (warmed up, lost, back, catch-up done): nothing else says it outside the bots' journals. */
  onStatus?: () => void
}

const iso = (ms: number): string => new Date(ms).toISOString()
const printOf = (t: LighterTrade): Print => ({ t: t.timestampMs, px: t.price, size: t.size, ask: t.ask ?? 0, id: t.tradeId })
const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b)
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]
}

export class LiveFeed implements LiveSource {
  private readonly o: LiveOptions
  private sink!: LiveSink
  /** The prints arrived and not delivered yet, in (t, id) order. */
  private held: Print[] = []
  private readonly seen = new Map<number, number>()
  /** Everything dated at the horizon or before has arrived (ms); the sink is there. */
  private horizon = -Infinity
  private seeded = false
  private catching = false
  private down = false
  private stopped = false
  private dropped = false
  private lostAt = 0
  private recoverFrom = 0
  /** A catch-up read is due (a cut is open and not caught up yet). */
  private recoverOwed = false
  private timer: (() => void) | null = null
  private readonly cancels = new Set<() => void>()
  private readonly offs: (() => void)[] = []
  private readonly waiters: (() => void)[] = []
  private pendingFunding: { hourMs: number; attempt: 1 | 2 }[] = []
  private nextFundingHour = 0
  /** What the program sees of the feed, per window of one hour: the delays (arrival time at the PC minus the print's time), then the totals. */
  private window: number[] = []
  /** The median of the last closed window (the end summary: the current window is empty once written). */
  private lastMedian = NaN
  readonly stats = { prints: 0, late: 0, cuts: 0, catchUpPrints: 0, minDelayMs: Infinity, maxDelayMs: -Infinity, requests: { minutes: 0, ticks: 0, funding: 0 } }

  constructor(o: LiveOptions) {
    this.o = o
  }

  async start(sink: LiveSink): Promise<void> {
    this.sink = sink
    const { loaders } = this.o
    this.offs.push(loaders.trades(this.o.marketId, (trades) => this.arrive(trades)))
    this.offs.push(loaders.onConnection(() => this.connectionChanged()))
    loaders.connect()
    await this.waitOpen()
    if (this.stopped) return
    if (this.o.resume === null) await this.startFresh()
    else await this.startResumed(this.o.resume)
    if (this.stopped) return
    if (this.o.funding) this.scheduleFunding(this.nextFundingHour)
    this.scheduleStats()
    this.arm()
  }

  stop(): void {
    if (this.stopped) return
    this.step()
    this.stopped = true
    this.timer?.()
    for (const c of this.cancels) c()
    this.cancels.clear()
    for (const off of this.offs) off()
    for (const w of this.waiters.splice(0)) w()
    if (this.seeded) this.reportDelays('arret')
  }

  isSeeded(): boolean {
    return this.seeded
  }

  /** This market's feed state, as read from outside. */
  streamState(): 'amorce' | 'ouvert' | 'perdu' | 'rattrapage' {
    return !this.seeded ? 'amorce' : this.down ? 'perdu' : this.catching ? 'rattrapage' : 'ouvert'
  }

  /** After a command from outside: delivers what the horizon has reached, writes the state and re-arms the wake-up on the next due time (one more order is pending). */
  poke(): void {
    this.step()
  }

  /** The horizon: everything dated at this instant (ms) or before has arrived and the sink is there. */
  horizonMs(): number {
    return this.horizon
  }

  /** A summary of what the source saw (for the end summary). */
  summary(): { prints: number; late: number; cuts: number; medianDelayMs: number; minDelayMs: number; maxDelayMs: number } {
    return { prints: this.stats.prints, late: this.stats.late, cuts: this.stats.cuts, medianDelayMs: this.window.length > 0 ? median(this.window) : this.lastMedian, minDelayMs: this.stats.minDelayMs, maxDelayMs: this.stats.maxDelayMs }
  }

  // ---- the start

  /** Fresh start: until the next full minute B + the wait + a rest time, then the 24 h of the data module's candles up to the minute before B; the prints of B and after are the socket's. No print is missing and none is counted twice. */
  private async startFresh(): Promise<void> {
    const { clock, loaders, marketId, waitMs } = this.o
    for (;;) {
      const boundary = (Math.floor(clock.now() / MINUTE_MS) + 1) * MINUTE_MS
      this.dropped = false
      await this.sleepUntil(boundary + waitMs + SEED_SETTLE_MS)
      if (this.stopped) return
      if (this.dropped || loaders.connection() !== 'open') {
        await this.waitOpen()
        continue
      }
      const uptoT = boundary / 1000 - 60
      this.stats.requests.minutes++
      const read = await loaders.minutes(marketId, uptoT - 86400 + 60)
      if (this.stopped) return
      if (this.dropped) {
        await this.waitOpen()
        continue
      }
      if (read.bars.length === 0) throw new Error(`market ${this.o.name}: the data module gives no candle, no warm-up possible`)
      this.sink.seed(read.bars, uptoT, this.o.funding)
      this.held = this.held.filter((p) => p.t >= boundary)
      this.horizon = boundary - 1
      this.nextFundingHour = (Math.floor(boundary / HOUR_MS) + 1) * HOUR_MS
      this.seeded = true
      this.o.onStatus?.()
      this.o.say(`${this.o.name}: warm-up of ${read.bars.filter((b) => b.t <= uptoT).length} candles from the data module, the market plays from ${iso(boundary)}`)
      this.step()
      return
    }
  }

  /** Restart: the warm-up stops at the minute the program held open, the bots are read again, and the time between the written state and now is a cut (the prints since the start of that minute are read again). */
  private async startResumed(r: NonNullable<LiveOptions['resume']>): Promise<void> {
    const { clock, loaders, marketId } = this.o
    const uptoT = r.openMs / 1000 - 60
    this.stats.requests.minutes++
    const read = await loaders.minutes(marketId, uptoT - 86400 + 60)
    if (this.stopped) return
    if (read.bars.length === 0) throw new Error(`market ${this.o.name}: the data module gives no candle, no warm-up possible`)
    this.sink.seed(read.bars, uptoT, this.o.funding)
    r.restore()
    this.horizon = r.openMs - 1
    this.nextFundingHour = (Math.floor(r.openMs / HOUR_MS) + 1) * HOUR_MS
    this.seeded = true
    this.o.onStatus?.()
    const now = clock.now()
    this.stats.cuts++
    this.sink.openCut(r.vuMs)
    this.sink.note({ evenement: 'flux_perdu', heure: iso(r.vuMs), marche: this.o.name, cause: 'arret_du_programme' })
    this.sink.note({ evenement: 'flux_revenu', heure: iso(now), marche: this.o.name, perduDepuis: iso(r.vuMs), dureeMs: now - r.vuMs, cause: 'arret_du_programme' })
    this.o.say(`${this.o.name}: restart, ${Math.round((now - r.vuMs) / 1000)} s without the program, treated as a cut`)
    this.recoverFrom = r.openMs
    this.recoverOwed = true
    await this.recover(now)
  }

  // ---- what arrives

  private arrive(trades: LighterTrade[]): void {
    // The prints first enter the clock's estimate; the delay is read on the program's time (the delay beyond the fastest print).
    for (const tr of trades) this.o.clock.observe(tr.timestampMs)
    const now = this.o.clock.now()
    for (const tr of trades) {
      const p = printOf(tr)
      const delay = now - p.t
      this.stats.prints++
      this.window.push(delay)
      if (delay < this.stats.minDelayMs) this.stats.minDelayMs = delay
      if (delay > this.stats.maxDelayMs) this.stats.maxDelayMs = delay
      this.hold(p)
    }
    this.step()
  }

  /** Sets a print aside, at its place in (t, id) order; an id already seen does not enter. */
  private hold(p: Print): void {
    if (this.seen.has(p.id)) return
    this.seen.set(p.id, p.t)
    let i = this.held.length
    while (i > 0 && (this.held[i - 1].t > p.t || (this.held[i - 1].t === p.t && this.held[i - 1].id > p.id))) i--
    this.held.splice(i, 0, p)
  }

  // ---- the step: deliver what the horizon has reached

  private step(): void {
    if (!this.seeded || this.catching || this.down || this.stopped) return
    this.deliver(this.o.clock.now() - this.o.waitMs)
    this.o.onStep()
    this.arm()
  }

  private deliver(h: number): void {
    while (this.held.length > 0 && this.held[0].t <= h) this.dispatch(this.held.shift() as Print)
    if (h > this.horizon) {
      this.sink.clock(h)
      this.horizon = h
    }
    if (this.seen.size > 4000) for (const [id, t] of this.seen) if (t < h - SEEN_KEEP_MS) this.seen.delete(id)
  }

  private dispatch(p: Print): void {
    const open = this.sink.openMinuteMs()
    if (open !== null && p.t < open) {
      const now = this.o.clock.now()
      this.stats.late++
      this.sink.note({ evenement: 'print_en_retard', heure: iso(p.t), marche: this.o.name, arrivee: iso(now), retardMs: now - p.t, id: p.id, prix: p.px, taille: p.size, minuteFermee: iso(Math.floor(p.t / MINUTE_MS) * MINUTE_MS) })
      this.sink.late(p)
      // What this print triggered (a stop reached, whose exit is already due) passes at once, not at the next wake-up.
      this.sink.clock(this.horizon)
      return
    }
    this.sink.clock(p.t - 1)
    this.sink.print(p)
  }

  /** The next wake-up: the sink's nearest due time, or the first print set aside, plus the wait. */
  private arm(): void {
    if (this.stopped || !this.seeded || this.catching || this.down) return
    this.timer?.()
    this.timer = null
    const next = Math.min(this.sink.nextAt(), this.held.length > 0 ? this.held[0].t : Infinity)
    if (!Number.isFinite(next)) return
    const at = Math.max(next + this.o.waitMs, this.o.clock.now() + 1)
    const cancel = this.o.clock.at(at, () => {
      this.cancels.delete(cancel)
      this.timer = null
      this.step()
    })
    this.cancels.add(cancel)
    this.timer = () => {
      cancel()
      this.cancels.delete(cancel)
    }
  }

  // ---- a cut

  private connectionChanged(): void {
    const open = this.o.loaders.connection() === 'open'
    if (!this.seeded) {
      if (!open) this.dropped = true
      else for (const w of this.waiters.splice(0)) w()
      return
    }
    if (this.stopped) return
    const now = this.o.clock.now()
    if (!open && !this.down) {
      this.step()
      this.down = true
      this.lostAt = now
      if (!this.recoverOwed) this.recoverFrom = this.horizon - CUT_OVERLAP_MS
      this.recoverOwed = true
      this.stats.cuts++
      this.timer?.()
      this.timer = null
      this.sink.openCut(this.horizon)
      this.sink.note({ evenement: 'flux_perdu', heure: iso(now), marche: this.o.name, horizon: iso(this.horizon) })
      this.o.onStep()
      this.o.onStatus?.()
      this.o.say(`${this.o.name}: feed lost`)
    } else if (open && this.down) {
      this.down = false
      this.sink.note({ evenement: 'flux_revenu', heure: iso(now), marche: this.o.name, perduDepuis: iso(this.lostAt), dureeMs: now - this.lostAt })
      this.o.say(`${this.o.name}: feed back after ${Math.round((now - this.lostAt) / 1000)} s`)
      void this.recover(now)
    }
  }

  /** Reads again from the data module what is missing since `recoverFrom` and delivers it, the minutes closing this way without a decision; then normal life resumes. */
  private async recover(returnAt: number): Promise<void> {
    const { loaders, marketId } = this.o
    this.catching = true
    this.o.onStatus?.()
    this.sink.setBlind(true)
    this.stats.requests.ticks++
    const read = await loaders.ticks(marketId, this.recoverFrom)
    if (this.stopped) return
    if (this.down) {
      // The cut started again during the read: wait for the next return, and read again.
      this.catching = false
      this.o.onStatus?.()
      return
    }
    if (read.failed) this.sink.note({ evenement: 'rattrapage_incomplet', heure: iso(this.o.clock.now()), marche: this.o.name, raison: 'une page de /trades n\'est pas revenue', prints: read.ticks.length })
    // A source with no prints history rebuilds the gap from minute candles (`synthetic`, src/sources/types.ts): said in the journal with the existing event, never passed off as prints.
    if (read.synthetic) this.sink.note({ evenement: 'rattrapage_incomplet', heure: iso(this.o.clock.now()), marche: this.o.name, raison: 'the source has no prints history: one print per closed minute, at its close (minute candles)', prints: read.ticks.length })
    for (const t of read.ticks) this.hold(t)
    this.stats.catchUpPrints += read.ticks.length
    this.deliver(this.o.clock.now() - this.o.waitMs)
    this.sink.setBlind(false)
    this.sink.closeCut(returnAt)
    this.catching = false
    this.o.onStatus?.()
    this.recoverOwed = false
    this.o.say(`${this.o.name}: catch-up of ${read.ticks.length} prints${read.synthetic ? ' (one per minute, rebuilt from candles)' : ''}`)
    const owed = this.pendingFunding.splice(0)
    for (const f of owed) void this.runFunding(f.hourMs, f.attempt)
    this.step()
  }

  // ---- the funding

  private scheduleFunding(hourMs: number): void {
    const cancel = this.o.clock.at(hourMs + FUNDING_DELAY_MS, () => {
      this.cancels.delete(cancel)
      this.scheduleFunding(hourMs + HOUR_MS)
      void this.runFunding(hourMs, 1)
    })
    this.cancels.add(cancel)
  }

  private async runFunding(hourMs: number, attempt: 1 | 2): Promise<void> {
    if (this.stopped) return
    if (this.down || this.catching || this.horizon < hourMs) {
      this.pendingFunding.push({ hourMs, attempt })
      return
    }
    if (this.sink.hourHeld(hourMs) === 0) return
    this.stats.requests.funding++
    const page = await this.o.loaders.fundingPage(this.o.marketId, hourMs / 1000 + 1)
    if (this.stopped) return
    const row = page === null ? undefined : page.find((r) => r.timestamp === hourMs / 1000)
    if (row !== undefined && row.value !== null) {
      this.sink.settleFunding(hourMs, row.value)
      this.o.onStep()
      return
    }
    if (attempt === 1) {
      const cancel = this.o.clock.at(this.o.clock.now() + FUNDING_DELAY_MS, () => {
        this.cancels.delete(cancel)
        void this.runFunding(hourMs, 2)
      })
      this.cancels.add(cancel)
      return
    }
    this.sink.settleFunding(hourMs, null)
    this.o.onStep()
  }

  // ---- what the program measures

  private scheduleStats(): void {
    const next = (Math.floor(this.o.clock.now() / HOUR_MS) + 1) * HOUR_MS + 5000
    const cancel = this.o.clock.at(next, () => {
      this.cancels.delete(cancel)
      this.reportDelays('heure')
      this.scheduleStats()
    })
    this.cancels.add(cancel)
  }

  /** A `delais` line in the program's journal: the delay between a print's time and its arrival at the PC (median, maximum) over the window that ends. */
  private reportDelays(why: 'heure' | 'arret'): void {
    const w = this.window
    this.o.program({
      evenement: 'delais', heure: iso(this.o.clock.now()), marche: this.o.name, fenetre: why, prints: w.length, medianeMs: w.length === 0 ? null : median(w), maximumMs: w.length === 0 ? null : Math.max(...w), minimumMs: w.length === 0 ? null : Math.min(...w),
      enRetardTotal: this.stats.late, coupuresTotal: this.stats.cuts, attenteMs: this.o.waitMs, horloge: this.o.clock.report(),
    })
    if (w.length > 0) this.lastMedian = median(w)
    if (why === 'heure') this.o.say(`${this.o.name}: prints' delay over the hour: median ${w.length === 0 ? '-' : Math.round(median(w))} ms, maximum ${w.length === 0 ? '-' : Math.round(Math.max(...w))} ms (${w.length} prints)`)
    this.window = []
    this.o.onStep()
  }

  // ---- small waiting tools

  private sleepUntil(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.o.clock.at(ms, () => {
        this.cancels.delete(cancel)
        resolve()
      })
      this.cancels.add(cancel)
    })
  }

  private waitOpen(): Promise<void> {
    if (this.o.loaders.connection() === 'open') return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}
