/**
 * Radinus's two seams (author, 2026-10-05: "the stop is the SL — the bot does not stop anything, it sends orders and watches the position").
 *
 * 1. The bot and the exchange. The bot decides at a minute's close and SENDS an order (`Order`, its stop-loss attached); it WATCHES its position through what the exchange tells it
 *    (`ExchangeEvent`). The exchange fills, holds the stop-loss, triggers it, liquidates. On paper it is `exchange.ts` (the fake account); for real it would be Lighter, the bot's code does not change.
 * 2. The data. A source (`DataSource`) gives prints and the clock to a sink (`Sink`); in a replay it is `replayer.ts` (a recorded file), live it is a data module (src/sources/).
 */

import type { Trail } from './core/playerStop'

/** A print: `t` in ms, `ask` 1 = the buyer was the aggressor, `size` in base units (the format of a recorded prints file). */
export type Print = { t: number; px: number; size: number; ask: number; id: number }

/** What the bot sends: a market order, side 1 long / -1 short, with its stop-loss (in % of the fill price, `null` = none) and its trailing (`trail`, `null` = none). `sentMs` = the instant it is sent (the close), `atMs` = the instant it is filled (the close + the page's latency). `only` = the side a bot of one side takes (`/bot`: 1 long only, -1 short only, absent = both): its order for the other side closes the position and opens none. */
export type Order = { side: 1 | -1; stopPct: number | null; trail: Trail | null; sentMs: number; atMs: number; only?: 1 | -1; /** A script bot's order (`scriptBot.ts`): the sub-account it is for. Its book keeps the stop the script set (`stop`, `stopAt`) and its trailing: `stopPct` / `trail` here are only what was in force when it was sent, written to the journal. */ account?: string }

/** What the exchange tells the bot (times in ms). `replaced` (stop_touche): an order of the bot was on its way, the next side is therefore already decided. A `sortie` is always a closed trade; a `liquidation` is never a trade. */
export type ExchangeEvent =
  | { kind: 'entree'; t: number; side: 1 | -1; px: number; qty: number; notional: number; stake: number; accountBefore: number; stopPx: number | null; liquidationPx: number }
  | { kind: 'stop_touche'; t: number; px: number; stopPx: number; exitAt: number; replaced: boolean }
  | { kind: 'sortie'; t: number; side: 1 | -1; px: number; reason: 'signal' | 'stop' | 'trailing' | 'fin' | 'arret' | 'take'; entryT: number; entryPx: number; pnl100: number; pnl: number; pnlPct: number; account: number }
  | { kind: 'liquidation'; t: number; side: 1 | -1; px: number; liquidationPx: number; stake: number; fee: number; account: number }
  | { kind: 'ordre_sans_prix'; t: number }
  /** An order of the other side of a bot of one side was filled: the position, if any, is closed (its `sortie` came first) and nothing opened. */
  | { kind: 'close_order_filled'; t: number }
  | { kind: 'compte_epuise'; t: number }
  /** A fixed stake above the account at an entry: no entry, the guard halts the bot (cause `stake`, `account.ts`'s `stakeAboveAccount`). */
  | { kind: 'stake_above_account'; t: number; stake: number; account: number }
  | { kind: 'funding'; t: number; side: 1 | -1; qty: number; value: number; amount: number; account: number }

/** The exchange, seen from the bot. */
export type Exchange = {
  send: (order: Order) => void
}

/** What the program gives the bot and the exchange: the clock ("everything dated `ms` or before has arrived"), the prints, the end of the data. */
export type Sink = {
  clock: (ms: number) => void
  print: (p: Print) => void
  end: () => void
}

/** A live source: it does not deliver everything in one go but pushes to the sink, along the PC's clock, what arrives; `start` arms it, `stop` closes it. Same sink (`Sink`) as `DataSource`. */
export type LiveSource = {
  start: (sink: LiveSink) => Promise<void>
  stop: () => void
}

/** What the sink gives a live source on top: the prints of a closed minute, the next due time, the warm-up, the blindness of a catch-up, the cuts, the market journal lines, the hour's funding. */
export type LiveSink = Sink & {
  late: (p: Print) => void
  openMinuteMs: () => number | null
  nextAt: () => number
  seed: (rows: { t: number; o: number; h: number; l: number; c: number; v: number }[], uptoT: number, hours: boolean) => void
  setBlind: (on: boolean) => void
  openCut: (from: number) => void
  closeCut: (to: number) => void
  note: (event: Record<string, unknown>) => void
  hourHeld: (hourMs: number) => number
  settleFunding: (hourMs: number, value: number | null) => void
}

/** Where the prints come from. `run` delivers them to the sink in order, the clock before each print; returns `false` if it stopped before the end. */
export type DataSource = {
  run: (sink: Sink) => boolean
}
