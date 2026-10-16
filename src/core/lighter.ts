/**
 * Reads from Lighter's own public API, `api.rh.lighter.xyz`, no key: the markets' overview, a market's margins and fees,
 * one page of its hourly funding; and the shapes of a print, a minute and a book that the rest of the program shares.
 * Every reader answers `null`/`[]` on any failure - a 4xx/5xx, a network fault, an upstream shape not measured yet -
 * never a fabricated zero or empty object read as real. Copied from the site's `core/lighter.ts`, kept to what Radinus
 * uses (the account, key, order and vault readers are left out).
 */


const readNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * One market's own limits, from `/orderBookDetails?market_id=…` (the bulk `/orderBooks` carries none of them, measured 2026-09-19).
 *
 * **Leverage - measured on ANTHROPIC (perp, market 38)**: `min_initial_margin_fraction: 2000, maintenance_margin_fraction: 1200`
 * - a ceiling of **5x** (`Math.floor(10000 / minInitialMarginFraction)`, the unit `UpdateLeverage` signs), which Lighter's sequencer
 * confirmed: x2 and x5 accepted, x25 refused `21113 invalid initial margin fraction`. **A spot market carries no margin field**
 * (`market_id=2058`): spot has no leverage to cap, so `minInitialMarginFraction` reads `null` there, not a wrong number.
 *
 * **Minimums - measured on a perp and a spot market, 2026-09-19**: `min_base_amount` / `min_quote_amount` are decimal strings,
 * in the market's base unit and in USDG (ANTHROPIC: `"0.00320"` / `"10.000000"`), present on spot too.
 */
export type LighterMarketLimits = {
  minInitialMarginFraction: number | null
  /** `maintenance_margin_fraction`, same unit (hundredths of a percent; BTC 120 against its 200, 2026-10-05); with the minimum initial one, `/rsi`'s liquidation distance. */
  maintenanceMarginFraction: number | null
  minBaseAmount: number | null
  minQuoteAmount: number | null
  /** `taker_fee`, a decimal string - `"0.0000"` on every market measured (ANTHROPIC 38, ETH 0, BABA/USDG 2058, 2026-09-20, `curl …/orderBookDetails?market_id=<id>`), so whether it is a percent or a fraction is still unmeasured (🟡); the form prints it as a percent. */
  takerFee: number | null
  /** `liquidation_fee`, a percent of the notional (`"1.0000"` = 1 %, ANTHROPIC 38, 2026-10-05): what Radinus's paper account loses on a liquidation, on top of its stake. */
  liquidationFee: number | null
}

type LighterOrderBookDetailsEntry = { market_id?: number; min_initial_margin_fraction?: number; maintenance_margin_fraction?: number; min_base_amount?: string; min_quote_amount?: string; taker_fee?: string; liquidation_fee?: string }

type LighterOrderBookDetailsResponse = {
  order_book_details?: LighterOrderBookDetailsEntry[]
  spot_order_book_details?: LighterOrderBookDetailsEntry[]
}

/** One `/orderBookDetails?market_id=` read per market per program life - the limits, fee and margin fractions of a market do not move. A `null` answer (fetch failure) is not cached, so the next read retries. */
const marketLimitsCache = new Map<number, LighterMarketLimits>()

export async function loadLighterMarketLimits(marketId: number): Promise<LighterMarketLimits | null> {
  const cached = marketLimitsCache.get(marketId)
  if (cached) return cached
  try {
    const res = await fetch(`https://api.rh.lighter.xyz/api/v1/orderBookDetails?market_id=${marketId}`)
    if (!res.ok) return null
    const body = (await res.json()) as LighterOrderBookDetailsResponse
    const entry =
      body.order_book_details?.find((d) => d.market_id === marketId) ?? body.spot_order_book_details?.find((d) => d.market_id === marketId)
    if (!entry) return null
    const limits: LighterMarketLimits = {
      minInitialMarginFraction: typeof entry.min_initial_margin_fraction === 'number' ? entry.min_initial_margin_fraction : null,
      maintenanceMarginFraction: typeof entry.maintenance_margin_fraction === 'number' ? entry.maintenance_margin_fraction : null,
      minBaseAmount: readNumber(entry.min_base_amount),
      minQuoteAmount: readNumber(entry.min_quote_amount),
      takerFee: readNumber(entry.taker_fee),
      liquidationFee: readNumber(entry.liquidation_fee),
    }
    marketLimitsCache.set(marketId, limits)
    return limits
  } catch {
    return null
  }
}

/**
 * One page of `GET /api/v1/fundings` (hourly rows, the ones before `endS`, unix seconds, exclusive): each row's hour mark (seconds) and its `value` signed as `FundingHours` keeps it (positive when the longs pay), `null` for a row
 * without a usable `value`; `null` for the page when the call failed. The one reader of that endpoint's wire format: Radinus reads the newest page once an hour.
 */
export async function loadLighterFundingPage(marketId: number, endS: number): Promise<{ timestamp: number; value: number | null }[] | null> {
  const res = await fetch(`https://api.rh.lighter.xyz/api/v1/fundings?market_id=${marketId}&resolution=1h&start_timestamp=0&end_timestamp=${endS}&count_back=2000`)
  if (!res.ok) return null
  const body = (await res.json()) as { fundings?: { timestamp?: number; value?: string; direction?: string }[] }
  const rows: { timestamp: number; value: number | null }[] = []
  for (const row of body.fundings ?? []) {
    if (typeof row.timestamp !== 'number') continue
    const value = Number(row.value)
    rows.push({ timestamp: row.timestamp, value: row.value !== undefined && Number.isFinite(value) && (row.direction === 'long' || row.direction === 'short') ? (row.direction === 'long' ? value : -value) : null })
  }
  return rows
}

/** One market's live price and daily change - `loadLighterMarketOverview`'s answer. */
export type LighterMarketOverview = {
  marketId: number
  symbol: string
  marketType: 'perp' | 'spot'
  /** `last_trade_price`, `0` folded to `null` (never traded) - `mark_price` stands in when that happens, a perp's fair price with no print yet. */
  lastPrice: number | null
  /** `mark_price`, `0` folded to `null` - a spot market carries none. Kept separate from `lastPrice` above (which already falls back to this). */
  markPrice: number | null
  /** `daily_price_change`, already a percent (e.g. `1.3` for +1.3%). */
  dailyChangePct: number | null
  priceDecimals: number
}

type LighterMarketOverviewEntry = {
  symbol?: string
  market_id?: number
  last_trade_price?: number
  mark_price?: number
  daily_price_change?: number
  supported_price_decimals?: number
}

type LighterMarketOverviewResponse = {
  order_book_details?: LighterMarketOverviewEntry[]
  spot_order_book_details?: LighterMarketOverviewEntry[]
}

/**
 * Every market's live price in one request - `GET /api/v1/orderBookDetails` with no `market_id` (measured 2026-09-19:
 * `order_book_details`, 57 perps, plus `spot_order_book_details`, 27 spot). Radinus reads it for the markets' numbers
 * and price decimals.
 */
export async function loadLighterMarketOverview(): Promise<LighterMarketOverview[]> {
  try {
    const res = await fetch('https://api.rh.lighter.xyz/api/v1/orderBookDetails')
    if (!res.ok) return []
    const body = (await res.json()) as LighterMarketOverviewResponse
    const parse = (entries: LighterMarketOverviewEntry[] | undefined, marketType: 'perp' | 'spot'): LighterMarketOverview[] =>
      (entries ?? []).flatMap((e) => {
        if (typeof e.market_id !== 'number' || typeof e.symbol !== 'string') return []
        const traded = typeof e.last_trade_price === 'number' && e.last_trade_price !== 0 ? e.last_trade_price : null
        const mark = typeof e.mark_price === 'number' && e.mark_price !== 0 ? e.mark_price : null
        return [
          {
            marketId: e.market_id,
            symbol: e.symbol,
            marketType,
            lastPrice: traded ?? mark,
            markPrice: mark,
            dailyChangePct: typeof e.daily_price_change === 'number' ? e.daily_price_change : null,
            priceDecimals: e.supported_price_decimals ?? 2,
          },
        ]
      })
    return [...parse(body.order_book_details, 'perp'), ...parse(body.spot_order_book_details, 'spot')]
  } catch {
    return []
  }
}

/** `ask` = 1 when the maker was the ask, i.e. the buyer was the aggressor (Lighter's `is_maker_ask`); only the live socket path sets it. */
export type LighterTrade = { price: number; size: number; timestampMs: number; tradeId: number; ask?: number }

/** One print with its aggressor side (`ask` 0/1, 1 = the buyer was the aggressor) and size in base units - what `measureSpread` (`core/hedgeSim.ts`) and the order flow of `core/zonesBench.ts` need and `LighterTrade` leaves out. */
export type LighterTick = { t: number; px: number; size: number; ask: number; id: number }

/**
 * One minute of a market's tape - `gap` (1 = the minute follows a hole in the feed) is what `hedgeSim` jumps over.
 * `v` = the minute's traded size in base units (equal to Lighter's candle volume and to the sum of the prints' sizes, checked 2026-10-02; 0 if the row has none).
 */
export type LighterTapeMinute = { t: number; o: number; h: number; l: number; c: number; v: number; gap: boolean }

/** One resting order: its owner account, and its base amount at placement and still resting. */
export type LighterBookOrder = { account: string; initial: number; remaining: number }

/** One price level of a market's resting book: `size` = the sum of the remaining base amounts of the orders at that price. */
export type LighterBookLevel = { price: number; size: number; orders: LighterBookOrder[] }

export type LighterBookDepth = { bids: LighterBookLevel[]; asks: LighterBookLevel[] }

/**
 * One order row of Lighter's `account_all_orders` socket push (`core/lighterStream.ts`), the same fields as the REST
 * `orders[]` rows (the `Order` model of Lighter's Python SDK). Radinus subscribes to no account channel; the type stays for the
 * socket module's message shape.
 */
export type LighterOrderRow = {
  order_index?: number | string
  order_id?: number | string
  market_index?: number
  is_ask?: boolean
  price?: string
  initial_base_amount?: string
  remaining_base_amount?: string
  filled_quote_amount?: string
  filled_base_amount?: string
  type?: string
  time_in_force?: string
  reduce_only?: boolean
  trigger_price?: string
  status?: string
  parent_order_id?: number | string
  created_at?: number
  updated_at?: number
}

/**
 * `order_index`/`client_order_index`/`order_id`/`parent_order_id` are int64s (2^48..2^60, measured 2026-09-22) - past
 * `Number.MAX_SAFE_INTEGER` (2^53), so a plain `JSON.parse` rounds them. Quote the digits first so the exact value
 * survives: `core/lighterStream.ts` applies this to every push (cheap - the regex only matches these field names).
 */
export const preserveInt64OrderIds = (text: string): string => text.replace(/"(order_index|client_order_index|order_id|parent_order_id)":(\d+)/g, '"$1":"$2"')
