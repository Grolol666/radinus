/**
 * The program's clock, set on the prints (fixed 2026-10-05: the first real run measured prints arriving ~550 ms BEFORE their own time, the PC's clock being 0.78 s behind two time servers;
 * Windows lets a clock wander under the second and resets it in one jump).
 *
 * THE PRINCIPLE. The program cannot tell a clock's lag from a print's travel time: it only sees `arrival (PC) - print's time`. It therefore keeps the SMALLEST of these gaps over the recent
 * prints of ALL its markets (one clock, one estimate for the program), and reads the time as "the PC's time minus that smallest gap": it takes the fastest print as arrived at the very instant. Its clock
 * then lags by the fastest one's travel time, never leads; the wait (200 ms) covers what a print takes beyond the fastest one. Until a print has arrived, the PC's time is read as it is.
 *
 * THE WINDOW (`fenetreMinutes`, 5 by default): the smallest gap is taken over the prints of the last minutes (and over the last print alone, if there was none in the window: the estimate does not vanish on a
 * quiet market). What it settles: a smallest gap too old drifts (2 ms per minute measured: 2 ms per minute of its age, so 10 ms at most with 5 minutes, against 200 ms of wait) and would read the time AHEAD; a smallest gap taken over few prints is a little too large, which reads the time late, on the right side. Five minutes of prints, from every market, count hundreds of them on an active market.
 *
 * THE RESET. The gaps are held in the frame of the PC's MONOTONIC clock (`RawClock.mono`, which Windows never resets): for a print, `mono at arrival - print's time`. The program's
 * time is `mono now - the smallest of these gaps`: it no longer reads the wall, whether it is moved back or forward by 0.8 s or by 10 s, it has neither jump nor return. A minute therefore cannot close early because
 * of a reset. The program still SEES it (the wall minus the monotonic moves by more than `sautMs` between two prints: `horloge_saut`), and the correction shown (wall - program's time) follows the wall at once.
 *
 * Nothing is hidden: `correction`, `fenetreMinutes`, `seuilJournalMs`, `sautMs` are in `marche.json` (`horloge`) and said at start. The estimate is written in `programme.jsonl` when it appears (`horloge_estimee`),
 * each time it moves by more than `seuilJournalMs` from the last one written (`horloge`), at each hourly line of the delays, and at each jump of the wall.
 */

import type { Clock, RawClock } from './clock'

export type ClockSettings = {
  /** `false` = the PC's time as it is (the behaviour before the fix); the measures are still made and said. */
  correction: boolean
  fenetreMinutes: number
  /** Writes the estimate in `programme.jsonl` when it has moved by more than this (ms) since the last line. */
  seuilJournalMs: number
  /** A jump of the wall of more than this (ms) between two prints is written (`horloge_saut`). */
  sautMs: number
}

export const CLOCK_DEFAULTS: ClockSettings = { correction: true, fenetreMinutes: 5, seuilJournalMs: 100, sautMs: 100 }

/** The tolerance (ms) under which a timer is taken as due: floating-point noise, not a delay. */
const EPS_MS = 0.001

type Pending = { ms: number; fn: () => void; cancel: (() => void) | null }

const iso = (ms: number): string => new Date(ms).toISOString()

export class PrintClock implements Clock {
  private readonly raw: RawClock
  private readonly s: ClockSettings
  private readonly program: (e: Record<string, unknown>) => void
  private readonly say: (line: string) => void
  /** The window's gaps, a monotonic queue (the smallest first): `mono at arrival` and `mono - print's time`. */
  private readonly monos: number[] = []
  private readonly gaps: number[] = []
  private head = 0
  /** The smallest gap (monotonic frame); `null` until a print has arrived. */
  private est: number | null = null
  private lastOffset: number | null = null
  private journaled: number | null = null
  private readonly pending = new Set<Pending>()

  constructor(raw: RawClock, settings: ClockSettings, program: (e: Record<string, unknown>) => void, say: (line: string) => void) {
    this.raw = raw
    this.s = settings
    this.program = program
    this.say = say
  }

  /** The program's time: before the first print, the PC's; then the monotonic clock minus the smallest gap (or, with the correction off, always the PC's). */
  now(): number {
    return this.est === null || !this.s.correction ? this.raw.now() : this.raw.mono() - this.est
  }

  at(ms: number, fn: () => void): () => void {
    if (!this.s.correction) return this.raw.at(ms, fn)
    const p: Pending = { ms, fn, cancel: null }
    this.pending.add(p)
    this.arm(p)
    return () => {
      p.cancel?.()
      p.cancel = null
      this.pending.delete(p)
    }
  }

  /** The window's smallest gap in today's wall frame (arrival at the PC - print's time); `null` before the first print. */
  smallestDelayMs(): number | null {
    return this.est === null ? null : this.raw.now() - this.raw.mono() + this.est
  }

  /** What the program takes off the PC's time (ms; negative = it adds): 0 before the first print and when the correction is off. */
  correctionMs(): number {
    return this.est === null || !this.s.correction ? 0 : this.raw.now() - this.now()
  }

  /** The numbers of the hourly delays line. */
  report(): { plusPetitEcartMs: number | null; correctionMs: number; echantillons: number } {
    const d = this.smallestDelayMs()
    return { plusPetitEcartMs: d === null ? null : Math.round(d), correctionMs: Math.round(this.correctionMs()), echantillons: this.gaps.length - this.head }
  }

  /** A print has just arrived (its time, ms): it enters the window. Called once per print, before the arrival is read. */
  observe(printMs: number): void {
    const m = this.raw.mono()
    const offset = this.raw.now() - m
    if (this.lastOffset !== null && Math.abs(offset - this.lastOffset) > this.s.sautMs) {
      this.program({ evenement: 'horloge_saut', heure: iso(this.now()), sautMs: Math.round(offset - this.lastOffset), correctionMs: Math.round(this.correctionMs()), note: "l'horloge du PC a été remise à l'heure ; l'heure du programme, tenue sur l'horloge monotone, n'a pas bougé" })
      this.say(`the PC's clock jumped by ${Math.round(offset - this.lastOffset)} ms; the program's time did not move`)
    }
    this.lastOffset = offset
    const gap = m - printMs
    while (this.gaps.length > this.head && this.gaps[this.gaps.length - 1] >= gap) {
      this.gaps.pop()
      this.monos.pop()
    }
    this.gaps.push(gap)
    this.monos.push(m)
    const cutoff = m - this.s.fenetreMinutes * 60000
    while (this.gaps.length - this.head > 1 && this.monos[this.head] < cutoff) this.head++
    if (this.head > 1024) {
      this.gaps.splice(0, this.head)
      this.monos.splice(0, this.head)
      this.head = 0
    }
    const before = this.est
    this.est = this.gaps[this.head]
    if (before === null) this.announce()
    else if (this.est !== before) {
      if (this.s.correction) for (const p of this.pending) this.arm(p)
      const d = this.smallestDelayMs() as number
      if (this.journaled !== null && Math.abs(d - this.journaled) > this.s.seuilJournalMs) this.note('horloge')
    }
  }

  /** A line of the program's life on the estimate (when it appears, when it moved by more than the threshold, at the hourly line). */
  note(evenement: 'horloge' | 'horloge_estimee'): void {
    const d = this.smallestDelayMs()
    if (d === null) return
    this.journaled = d
    this.program({ evenement, heure: iso(this.now()), plusPetitEcartMs: Math.round(d), correctionMs: Math.round(this.correctionMs()), correction: this.s.correction, fenetreMinutes: this.s.fenetreMinutes, echantillons: this.gaps.length - this.head })
  }

  private announce(): void {
    const d = this.smallestDelayMs() as number
    if (this.s.correction) {
      for (const p of this.pending) this.arm(p)
      this.say(`clock: the smallest gap seen between a print's arrival and its time is ${Math.round(d)} ms; the program ${this.correctionMs() >= 0 ? `takes ${Math.round(this.correctionMs())}` : `adds ${Math.round(-this.correctionMs())}`} ms ${this.correctionMs() >= 0 ? 'off' : 'to'} the PC's time (the fastest print is taken as arrived at the very instant; window ${this.s.fenetreMinutes} min)`)
    } else this.say(`clock: the smallest gap seen between a print's arrival and its time is ${Math.round(d)} ms; correction off (marche.json, horloge.correction), the program keeps the PC's time as it is`)
    this.note('horloge_estimee')
  }

  private arm(p: Pending): void {
    p.cancel?.()
    p.cancel = this.raw.after(Math.max(0, p.ms - this.now()), () => {
      p.cancel = null
      if (p.ms - this.now() > EPS_MS) {
        this.arm(p)
        return
      }
      this.pending.delete(p)
      p.fn()
    })
  }
}
