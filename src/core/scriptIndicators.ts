/**
 * The three indicators a bot script reads (`state.ema(n)`, `sma(n)`, `rsi(n)` of `botScript.ts`) as running states: each is moved forward over the closes that are new since its last call, never from the first bar.
 * The script reads `val`; the chart (`rsiScriptView.ts`) hands a `keep` array and reads the whole line from it - the same arithmetic in the same order, so the line drawn is exactly what the script saw. No React, no store.
 * `from` (0 on the page): the first bar fed, read as the series' first; `radinus/` gives a helper born after its window dropped older bars the first bar still held (`botScript.ts`, `CANDLES_KEPT`).
 */

import { rsiStep } from './zonesBench'
import type { BenchBar, RsiRun } from './zonesBench'

/** The value after the last close fed, then the same value for each bar in `keep` when one is given (NaN where undefined). */
export interface Follow {
  val: number
  /** Moves over the closes up to `closed` (the number of closed minutes). A smaller `closed` than before restarts from the first bar (`from`). */
  advance: (bars: readonly BenchBar[], closed: number) => void
  /** Back to the start (the chart does it when the bars it was fed are no longer the same market's). */
  reset: () => void
}

export class EmaFollow implements Follow {
  val = NaN
  private upto: number
  private readonly from: number
  private readonly a: number
  private readonly keep: number[] | undefined
  constructor(n: number, keep?: number[], from = 0) {
    this.a = 2 / (n + 1)
    this.keep = keep
    this.from = from
    this.upto = from
  }
  advance(bars: readonly BenchBar[], closed: number): void {
    if (this.upto > closed) this.reset()
    while (this.upto < closed) {
      const c = bars[this.upto].c
      this.val = this.upto === this.from ? c : this.val + this.a * (c - this.val)
      if (this.keep !== undefined) this.keep[this.upto] = this.val
      this.upto++
    }
  }
  reset(): void {
    this.upto = this.from
    this.val = NaN
    if (this.keep !== undefined) this.keep.length = 0
  }
}

export class SmaFollow implements Follow {
  val = NaN
  private upto: number
  private sum = 0
  /** The last `n` closes fed (slot = bar mod n): the close leaving the sum is read here, not in `bars`, which `radinus/` keeps as a window shorter than a long period. Same values, same order of operations. */
  private ring: number[] = []
  private readonly from: number
  private readonly n: number
  private readonly keep: number[] | undefined
  constructor(n: number, keep?: number[], from = 0) {
    this.n = n
    this.keep = keep
    this.from = from
    this.upto = from
  }
  advance(bars: readonly BenchBar[], closed: number): void {
    if (this.upto > closed) this.reset()
    const n = this.n
    while (this.upto < closed) {
      const c = bars[this.upto].c
      const fed = this.upto - this.from
      const slot = fed % n
      this.sum += c
      if (fed >= n) this.sum -= this.ring[slot]
      this.ring[slot] = c
      this.upto++
      this.val = fed + 1 >= n ? this.sum / n : NaN
      if (this.keep !== undefined) this.keep[this.upto - 1] = this.val
    }
  }
  reset(): void {
    this.upto = this.from
    this.sum = 0
    this.ring = []
    this.val = NaN
    if (this.keep !== undefined) this.keep.length = 0
  }
}

export class RsiFollow implements Follow {
  val = NaN
  private next: number
  private readonly from: number
  private readonly run: RsiRun = { g: 0, l: 0 }
  private readonly n: number
  private readonly keep: number[] | undefined
  constructor(n: number, keep?: number[], from = 0) {
    this.n = n
    this.keep = keep
    this.from = from
    this.next = from + 1
  }
  advance(bars: readonly BenchBar[], closed: number): void {
    if (this.next - 1 >= closed) this.reset()
    if (closed >= 1 && this.keep !== undefined && this.keep.length === 0) this.keep[0] = NaN
    while (this.next < closed) {
      this.val = rsiStep(this.run, this.run, this.n, this.next - this.from, bars[this.next].c - bars[this.next - 1].c)
      if (this.keep !== undefined) this.keep[this.next] = this.val
      this.next++
    }
  }
  reset(): void {
    this.next = this.from + 1
    this.run.g = 0
    this.run.l = 0
    this.val = NaN
    if (this.keep !== undefined) this.keep.length = 0
  }
}
