/**
 * The replay's data source: a recorded prints file (an array of `{ t, px, size, ask, id }`), delivered to the sink as if it arrived live: the clock
 * before each print ("everything dated before this print has arrived": it is what closes the finished minutes and fills the due orders, a quiet market without a trade for minutes included), then the print. Live, a
 * data module takes this place, through the same seam (`DataSource`).
 */

import { readFileSync } from 'node:fs'
import type { DataSource, Print, Sink } from './seam'

export function readPrints(path: string): Print[] {
  const prints = JSON.parse(readFileSync(path, 'utf8')) as Print[]
  for (let i = 1; i < prints.length; i++) {
    const a = prints[i - 1]
    const b = prints[i]
    if (b.t < a.t || (b.t === a.t && b.id < a.id)) return prints.slice().sort((x, y) => x.t - y.t || x.id - y.id)
  }
  return prints
}

export class Replayer implements DataSource {
  private readonly prints: Print[]
  private readonly untilMs: number | null

  /** `untilMs`: stop before the first print dated at this instant or after (the interruption `resume` takes up); `null` = until the end. */
  constructor(prints: Print[], untilMs: number | null) {
    this.prints = prints
    this.untilMs = untilMs
  }

  run(sink: Sink): boolean {
    for (const p of this.prints) {
      if (this.untilMs !== null && p.t >= this.untilMs) return false
      sink.clock(p.t - 1)
      sink.print(p)
    }
    sink.end()
    return true
  }
}
