/**
 * Lighter's funding in a simulated position, one pure function for every engine (`hedgeSim.ts`, `leanSim.ts`).
 * The rule is Lighter's documentation read 2026-10-04 (docs.lighter.xyz, trading / funding, not measured on an
 * account): paid at each hour mark on the position held then, `funding = -position x index x rate`, no duration term.
 * So a position pays for every hour mark H with `entry < H <= exit`, and one opened at 13:01 and closed at 13:59 pays nothing.
 */

/**
 * The hourly rows of one market, keyed by hour mark / 3600 (UTC): `value` of the API row (`GET /api/v1/fundings`, USDG per
 * unit of base for that hour = `rate / 100 x index`), positive when the longs pay (`direction: "long"`), negative when the shorts do.
 */
export type FundingHours = Map<number, number>

/** `paid` signed as a PnL (a loss is negative); `hours` = the hour marks crossed, `missing` = those without a row (counted for nothing, never filled). */
export type FundingFigure = { paid: number; hours: number; missing: number }

const HOUR_MS = 3.6e6

/**
 * What `notional` USDG on `side` (1 long, -1 short) pays for one hour at `rate` (per-hour fraction, `loadLighterFundingRate`),
 * signed as a PnL: negative when this side pays. Positive rate = longs pay is assumed, not measured, for `/funding-rates`.
 */
export const fundingCurrent = (side: 1 | -1, notional: number, rate: number): number => -side * notional * rate

/** What a position of `size` base units on `side` (1 long, -1 short) held from `entryMs` to `exitMs` pays, hour mark by hour mark. */
export function fundingPaid(side: 1 | -1, size: number, entryMs: number, exitMs: number, rows: FundingHours): FundingFigure {
  let paid = 0
  let hours = 0
  let missing = 0
  for (let k = Math.floor(entryMs / HOUR_MS) + 1, last = Math.floor(exitMs / HOUR_MS); k <= last; k++) {
    hours++
    const value = rows.get(k)
    if (value === undefined) missing++
    else paid -= side * size * value
  }
  return { paid, hours, missing }
}
