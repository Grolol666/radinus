/**
 * The Lighter module: Lighter's public API at `api.rh.lighter.xyz`, no key, nothing else.
 *
 * - `trades`: the public socket's `trade/<id>` channel (`wss://api.rh.lighter.xyz/stream`).
 * - `minutes`: `GET /api/v1/candles`, 500 one-minute rows a call (the most it gives, measured 2026-10-16), walked
 *   forward by windows of 500 minutes. One-minute history reaches back to mid-July on BTC, mid-August on ANTHROPIC.
 * - `lastPrints`: `GET /api/v1/recentTrades`, 100 prints at most (a larger `limit` is refused) - ~30 s on ANTHROPIC.
 * - `ticks`: Lighter has no prints history, so a range of past prints is rebuilt from the minute candles: one print per
 *   closed minute, at its last millisecond, at the close, with the id of the minute's last trade (the candle's `i`, so
 *   the socket's copy of that trade is the same print) and the minute's volume; the side is unknown and set to 0.
 *   The result is flagged `synthetic`. The warm-up never uses it (it reads `minutes`); the catch-up after a cut does,
 *   and says so.
 * - `fundingPage`, `markets`, `limits`: the readers of `core/lighter.ts`.
 */

import { loadLighterFundingPage, loadLighterMarketLimits, loadLighterMarketOverview } from '../core/lighter'
import type { LighterTapeMinute, LighterTick } from '../core/lighter'
import { lighterSocket, tradesOfPush } from '../core/lighterStream'
import type { Source } from './types'

const HOST = 'api.rh.lighter.xyz'
const API = `https://${HOST}/api/v1`
/** Rows per `/candles` call: the endpoint's own cap, whatever `count_back` asks. */
const CANDLES_PER_CALL = 500
/** `/recentTrades`' cap on `limit`. */
const RECENT_TRADES_MAX = 100

type CandleRow = { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number; i?: number }
type Candle = { minute: LighterTapeMinute; lastTradeId: number | null }

/** The closed and forming 1-minute candles from `fromS` to `toS` (epoch seconds), oldest first, `t` in seconds; `failed` = a window did not answer (what came before it is kept). */
async function candles(marketId: number, fromS: number, toS: number): Promise<{ rows: Candle[]; requests: number; failed: boolean }> {
  const byTime = new Map<number, Candle>()
  let requests = 0
  let failed = false
  const start = Math.floor(fromS / 60) * 60
  for (let from = start; from <= toS; from += CANDLES_PER_CALL * 60) {
    const end = from + (CANDLES_PER_CALL - 1) * 60
    requests++
    let body: { c?: CandleRow[] }
    try {
      const res = await fetch(`${API}/candles?market_id=${marketId}&resolution=1m&start_timestamp=${from}&end_timestamp=${end}&count_back=${CANDLES_PER_CALL}`)
      if (!res.ok) {
        failed = true
        break
      }
      body = (await res.json()) as { c?: CandleRow[] }
    } catch {
      failed = true
      break
    }
    for (const r of body.c ?? []) {
      if (r.t === undefined || r.o === undefined || r.h === undefined || r.l === undefined || r.c === undefined) continue
      const t = Math.floor(r.t / 1000)
      if (t < start || t > end) continue
      byTime.set(t, { minute: { t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v ?? 0, gap: false }, lastTradeId: r.i ?? null })
    }
  }
  return { rows: [...byTime.values()].sort((a, b) => a.minute.t - b.minute.t), requests, failed }
}

type RecentTradeRow = { trade_id?: number; price?: string; size?: string; timestamp?: number; is_maker_ask?: boolean; type?: string }

async function recentPrints(marketId: number, limit: number): Promise<LighterTick[]> {
  const n = Math.max(1, Math.min(RECENT_TRADES_MAX, Math.floor(limit)))
  try {
    const res = await fetch(`${API}/recentTrades?market_id=${marketId}&limit=${n}`)
    if (!res.ok) return []
    const body = (await res.json()) as { trades?: RecentTradeRow[] }
    return (body.trades ?? [])
      .flatMap((t) => {
        const px = Number(t.price)
        const size = Number(t.size)
        if (t.type !== undefined && t.type !== 'trade') return []
        if (t.trade_id === undefined || t.timestamp === undefined || !Number.isFinite(px) || !Number.isFinite(size)) return []
        return [{ t: t.timestamp, px, size, ask: t.is_maker_ask ? 1 : 0, id: t.trade_id }]
      })
      .sort((a, b) => a.t - b.t || a.id - b.id)
  } catch {
    return []
  }
}

/** One synthetic print per closed minute in `[fromMs, toMs]` - module doc comment above. */
async function minutePrints(marketId: number, fromMs: number, toMs: number | undefined): Promise<{ ticks: LighterTick[]; requests: number; failed: boolean; synthetic: boolean }> {
  const now = Date.now()
  const end = Math.min(toMs ?? now, now)
  const read = await candles(marketId, Math.floor(fromMs / 1000), Math.floor(end / 1000))
  const ticks: LighterTick[] = []
  for (const { minute, lastTradeId } of read.rows) {
    const at = minute.t * 1000 + 59999
    if (lastTradeId === null || at < fromMs || at > end) continue
    ticks.push({ t: at, px: minute.c, size: minute.v, ask: 0, id: lastTradeId })
  }
  return { ticks, requests: read.requests, failed: read.failed, synthetic: true }
}

export const source: Source = {
  name: 'lighter',
  fetchHosts: [HOST],
  socketHosts: [HOST],
  loaders: {
    connect: () => lighterSocket.connectPublic(null),
    trades: (marketId, onTrades) =>
      lighterSocket.subscribe(`trade/${marketId}`, (msg) => {
        const trades = tradesOfPush(msg)
        if (trades.length > 0) onTrades(trades)
      }),
    connection: () => lighterSocket.publicState(),
    onConnection: (cb) => lighterSocket.onState(cb),
    minutes: async (marketId, fromS) => {
      const read = await candles(marketId, fromS, Math.floor(Date.now() / 1000))
      return { bars: read.rows.map((r) => r.minute), requests: read.requests }
    },
    ticks: (marketId, fromMs, toMs) => minutePrints(marketId, fromMs, toMs),
    lastPrints: (marketId, limit) => recentPrints(marketId, limit),
    fundingPage: (marketId, endS) => loadLighterFundingPage(marketId, endS),
    markets: () => loadLighterMarketOverview(),
    limits: (marketId) => loadLighterMarketLimits(marketId),
  },
}
