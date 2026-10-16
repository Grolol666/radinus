/**
 * A market's data, held ONCE and bounded: at most the last 24 hours of closed one-minute candles, and of the prints what the decisions under way read
 * (the minute being made, the fill being waited for, the stops being watched): a window of a few minutes, never a history. All the market's bots read this same copy.
 * The minute closes by the CLOCK, not at the next print: `closeMinute` is called by the engine when the clock passes the minute's end.
 */

import type { FundingHours } from './core/funding'
import type { FillTape } from './core/hedgeSim'
import type { MarketMargins } from './core/playerSearch'
import { PRINTS_KEPT_MS } from './core/botScript'
import { pushBenchMinute } from './core/zonesBench'
import type { BenchBar } from './core/zonesBench'
import type { Print } from './seam'

/** What a market is, given as input (never a table in the code): its margins as Lighter publishes them (`/orderBookDetails`, hundredths of a percent: 200 = 2 %), the liquidation fee (% of the notional), the median spread measured (in ticks and in %, `OpportunityTape.spreadTicks` / `spreadPct`: the page's fill rule reads it; `null` = not measured, the page then fills at the last print), the funding if any. */
export type MarketConfig = {
  name: string
  priceDecimals: number
  margins: MarketMargins
  liquidationFeePct: number
  spread: { ticks: number; pct: number } | null
  funding: FundingHours | null
}

/** The data module's minutes up to minute `uptoT` (s) included, as the page holds them: a minute without a candle is flat at the previous close (`pushBenchMinute`), and flat up to `uptoT` if the candles stop before. The one place this is written: the market (warm-up) and `controler` use it. */
export function barsOfMinutes(rows: { t: number; o: number; h: number; l: number; c: number; v: number }[], uptoT: number): BenchBar[] {
  const out: BenchBar[] = []
  for (const r of rows) if (r.t <= uptoT) pushBenchMinute(out, r)
  if (out.length === 0) return out
  for (let t = out[out.length - 1].t + 60; t <= uptoT; t += 60) {
    const p = out[out.length - 1].c
    out.push({ t, o: p, h: p, l: p, c: p, v: 0, real: false })
  }
  return out
}

/** 24 hours of one-minute candles: what an indicator must have behind it, and what a market keeps. Every backward read of the indicators is less than 2 x 240 + 2 candles (settings bounded at 240 by the players' descriptions). */
export const MARKET_BARS = 1440
/** The prints kept behind the instant of the last close: the fill rule does not look at a print of the same side more than 60 s before the order (`marketFillK`), twice that is kept. The same 2 minutes bound a script's `state.prints(n)`, on the page as here (`PRINTS_KEPT_MS`, author 2026-10-10). */
export const TAPE_KEEP_MS = PRINTS_KEPT_MS

/**
 * The window's prints, in typed arrays like the page's band (`OpportunityTape`: time in ms, price in whole ticks, the aggressor's side), which moves forward at one end and loses only at the other.
 * `view()` = the same as a `FillTape`, what `opportunityFillAt` and the page's stop functions read. `k` = `Math.round(price / tick)`, the quantization of `opportunityTapeRun`.
 */
export class WindowTape {
  t: Float64Array
  k: Float64Array
  ask: Uint8Array
  n = 0
  readonly tick: number
  readonly scale: number
  readonly spreadTicks: number
  readonly spreadPct: number | null

  constructor(priceDecimals: number, spread: { ticks: number; pct: number } | null) {
    this.t = new Float64Array(4096)
    this.k = new Float64Array(4096)
    this.ask = new Uint8Array(4096)
    this.tick = 10 ** -priceDecimals
    this.scale = Math.round(1 / this.tick)
    this.spreadTicks = spread === null ? 1 : spread.ticks
    this.spreadPct = spread === null ? null : spread.pct
  }

  /** Adds a print in time order and returns its index: at the end in the ordinary case, inserted at its place (after the prints of the same instant) when it arrives out of order (live feed). */
  append(p: Print): number {
    if (this.n === this.t.length) {
      const cap = this.n * 2
      const t = new Float64Array(cap)
      const k = new Float64Array(cap)
      const ask = new Uint8Array(cap)
      t.set(this.t)
      k.set(this.k)
      ask.set(this.ask)
      this.t = t
      this.k = k
      this.ask = ask
    }
    let at = this.n
    if (at > 0 && p.t < this.t[at - 1]) {
      let lo = 0
      let hi = at
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.t[mid] <= p.t) lo = mid + 1
        else hi = mid
      }
      at = lo
      this.t.copyWithin(at + 1, at, this.n)
      this.k.copyWithin(at + 1, at, this.n)
      this.ask.copyWithin(at + 1, at, this.n)
    }
    this.t[at] = p.t
    this.k[at] = Math.round(p.px / this.tick)
    this.ask[at] = p.ask ? 1 : 0
    this.n++
    return at
  }

  /** Drops the prints before `cutoffMs`, except the last of them: it is the one the fill rule reads when nothing has arrived since (the last print before the order, however old). */
  trim(cutoffMs: number): void {
    let lo = 0
    let hi = this.n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.t[mid] < cutoffMs) lo = mid + 1
      else hi = mid
    }
    const drop = Math.max(0, lo - 1)
    if (drop === 0) return
    this.t.copyWithin(0, drop, this.n)
    this.k.copyWithin(0, drop, this.n)
    this.ask.copyWithin(0, drop, this.n)
    this.n -= drop
  }

  view(): FillTape {
    return { t: this.t.subarray(0, this.n), k: this.k.subarray(0, this.n), ask: this.ask.subarray(0, this.n), tick: this.tick, spreadTicks: this.spreadTicks, spreadPct: this.spreadPct }
  }
}

/** The minute being made, in the recorded tape's convention (measured 2026-10-05 on 3,474 minutes of ANTHROPIC: the open = the previous candle's close, high / low widened by it, close = the last print, volume = the sizes added). `delta` = aggressive buys minus aggressive sells. */
type Forming = { o: number; h: number; l: number; c: number; v: number; delta: number; lastT: number }

export class Market {
  readonly cfg: MarketConfig
  /** The closed candles, oldest first, at most `MARKET_BARS`. */
  readonly bars: BenchBar[] = []
  /** The delta of each candle of `bars` (aggressive buys minus aggressive sells, 0 in a minute without a print). */
  readonly delta: number[] = []
  readonly tape: WindowTape
  /** The start (s) of the open minute; `null` before the first print. */
  openT: number | null = null
  private forming: Forming | null = null
  /** The last print received (the program uses it to close a trade at the end of the data). */
  last: Print | null = null

  constructor(cfg: MarketConfig) {
    this.cfg = cfg
    this.tape = new WindowTape(cfg.priceDecimals, cfg.spread)
  }

  /** The instant (ms) at which the open minute closes, `null` as long as no print has arrived. */
  closeAtMs(): number | null {
    return this.openT === null ? null : (this.openT + 60) * 1000
  }

  /**
   * Warms the market up (live): the data module's minutes up to minute `uptoT` (s) included, a minute without a candle filled flat as on the page (`pushBenchMinute`, then flat up to `uptoT`), the delta of each
   * candle unknown (0: the only player that reads it, the cumulative delta, is refused live). The open minute is `uptoT + 60`, empty. Candles older than 24 h are not kept.
   */
  seed(rows: { t: number; o: number; h: number; l: number; c: number; v: number }[], uptoT: number): void {
    for (const b of barsOfMinutes(rows, uptoT)) this.bars.push(b)
    if (this.bars.length === 0) throw new Error(`market ${this.cfg.name}: no candle from the data module to warm up`)
    if (this.bars.length > MARKET_BARS) this.bars.splice(0, this.bars.length - MARKET_BARS)
    this.delta.length = 0
    for (let i = 0; i < this.bars.length; i++) this.delta.push(0)
    this.openT = this.bars[this.bars.length - 1].t + 60
  }

  /** A print of a minute already closed (arrived late): it enters the prints window, which the exchange reads, but the closed candle is not rewritten. Returns its index. */
  ingestLate(p: Print): number {
    return this.tape.append(p)
  }

  /** A print of the open minute (the engine has closed, by the clock, every minute finished before it). Returns its index in the prints window. */
  ingest(p: Print): number {
    const s = Math.floor(p.t / 60000) * 60
    if (this.openT === null) this.openT = s
    if (s !== this.openT) throw new Error(`market ${this.cfg.name}: a print of minute ${s} arrives in the open minute ${this.openT} (the clock did not close the minute)`)
    if (this.forming === null) {
      const o = this.bars.length > 0 ? this.bars[this.bars.length - 1].c : p.px
      this.forming = { o, h: o, l: o, c: o, v: 0, delta: 0, lastT: p.t }
    }
    const f = this.forming
    if (p.t >= f.lastT) {
      f.c = p.px
      f.lastT = p.t
    }
    if (p.px > f.h) f.h = p.px
    if (p.px < f.l) f.l = p.px
    f.v += p.size
    f.delta += p.ask === 1 ? p.size : -p.size
    const at = this.tape.append(p)
    if (this.last === null || p.t >= this.last.t) this.last = p
    return at
  }

  /**
   * Closes the open minute: a real candle if it had prints, flat at the previous close otherwise (as `pushBenchMinute` fills a minute without a candle), added to the candles held; the oldest
   * (beyond 24 h) leave, as do the prints before the window. Returns the candle and its delta.
   */
  closeMinute(): { bar: BenchBar; delta: number } {
    if (this.openT === null) throw new Error(`market ${this.cfg.name}: no open minute`)
    const f = this.forming
    const t = this.openT
    let bar: BenchBar
    let delta = 0
    if (f !== null) {
      bar = { t, o: f.o, h: f.h, l: f.l, c: f.c, v: f.v, real: true }
      delta = f.delta
    } else {
      const p = this.bars[this.bars.length - 1].c
      bar = { t, o: p, h: p, l: p, c: p, v: 0, real: false }
    }
    this.bars.push(bar)
    this.delta.push(delta)
    if (this.bars.length > MARKET_BARS) {
      this.bars.shift()
      this.delta.shift()
    }
    this.openT = t + 60
    this.forming = null
    this.tape.trim((t + 60) * 1000 - TAPE_KEEP_MS)
    return { bar, delta }
  }
}
