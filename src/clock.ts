/**
 * The program's clock: the PC's, injected. Nothing in the live logic reads `Date.now()` or sets a `setTimeout` itself: everything goes through a `Clock`, so that the proofs
 * (a fake socket, a fake clock, in process) run the real live code. `at(ms, fn)` calls `fn` when the clock reaches `ms` (at once if it is already past) and returns what cancels it.
 *
 * `RawClock` is what the PC gives: the wall time (`now`, which Windows can reset in one jump), a MONOTONIC clock (`mono`, ms from an arbitrary origin, never reset: the one of
 * `performance.now()`), and a RELATIVE wait (`after`). The clock the logic reads is a `PrintClock` (`printClock.ts`), built on those three.
 */

export type Clock = {
  now: () => number
  at: (ms: number, fn: () => void) => () => void
}

export type RawClock = Clock & {
  /** The PC's monotonic clock (ms, arbitrary origin): a reset of the wall time does not touch it. */
  mono: () => number
  /** Calls `fn` in `ms` milliseconds of the monotonic clock; returns what cancels it. */
  after: (ms: number, fn: () => void) => () => void
}

/** The longest delay a `setTimeout` accepts (beyond it, it fires at once). */
const MAX_DELAY_MS = 2 ** 31 - 1

export const realClock: RawClock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  at: (ms, fn) => {
    let handle: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      const left = ms - Date.now()
      if (left > MAX_DELAY_MS) handle = setTimeout(arm, MAX_DELAY_MS)
      else handle = setTimeout(fn, Math.max(0, left))
    }
    arm()
    return () => {
      if (handle !== null) clearTimeout(handle)
    }
  },
  after: (ms, fn) => {
    const end = performance.now() + ms
    let handle: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      const left = end - performance.now()
      if (left > MAX_DELAY_MS) handle = setTimeout(arm, MAX_DELAY_MS)
      else handle = setTimeout(fn, Math.max(0, left))
    }
    arm()
    return () => {
      if (handle !== null) clearTimeout(handle)
    }
  },
}
