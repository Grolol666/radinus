// Cut for radinus: the react import (only the page's hooks, cut below, used it).
// Cut for radinus: parseLighterPosition / LighterPosition, read only by the cut hook useLighterTrades.
import { preserveInt64OrderIds } from './lighter'
import type { LighterOrderRow, LighterTrade } from './lighter'

export type LighterConnectionState = 'connecting' | 'open' | 'closed'

/** `market_stats`/`spot_market_stats`'s prices, folded to one shape - a perp push carries all three, a spot push only `indexPrice`/`midPrice` (`markPrice` stays `null`, point 3, brief S19, 2026-09-24). `core/lighter.ts`'s own doc comment covers why these are distinct from a tradable quote. */
export type LighterMarketStats = { markPrice: number | null; indexPrice: number | null; midPrice: number | null }

/**
 * The top of the book - `null` in every field until the first `ticker` push
 * arrives, never derived from `midPrice` (that is a different number,
 * `core/lighter.ts`'s own doc comment on why - a mark/index/mid triplet, not
 * a tradable quote).
 */
export type LighterOrderBookTop = { bestBid: number | null; bestAsk: number | null; spread: number | null }

type TradeMessage = { channel?: string; trades?: { price?: string; size?: string; timestamp?: number; trade_id?: number; is_maker_ask?: boolean }[] }
type StatsMessage = { channel?: string; market_stats?: { mark_price?: string; index_price?: string; mid_price?: string } }
/** Spot's own stats channel - 12 fields measured (measured 2026-09-24), only the two `LighterMarketStats` can hold are typed here. */
type SpotStatsMessage = { channel?: string; spot_market_stats?: { index_price?: string; mid_price?: string } }
/** `ticker/<id>`'s full state on every push (T4's report, 2026-09-24) - `a` is the ask side, `b` the bid, each `{price, size}`; `subscribeOrderBook` below reads the prices straight off it, no fold against a prior state needed. */
type TickerMessage = { channel?: string; ticker?: { s?: string; a?: { price?: string; size?: string }; b?: { price?: string; size?: string } } }
/** An `error` frame for a channel the server refuses - `{"error":{"code":30005,"message":"Invalid Channel: …"}}`. */
type ErrorMessage = { channel?: string; error?: { code?: number; message?: string } }
type PositionsMessage = {
  channel?: string
  positions?: Record<
    string,
    {
      market_id?: number
      symbol?: string
      sign?: number
      position?: string
      avg_entry_price?: string
      position_value?: string
      unrealized_pnl?: string
      realized_pnl?: string
      liquidation_price?: string
      margin_mode?: number
      allocated_margin?: string
      open_order_count?: number
    }
  >
}

/**
 * `account_all_orders`'s own push (decided and measured
 * 2026-09-22) -
 * `orders` grouped by `market_index` as the object's own keys, one row per
 * order underneath; every row already carries `market_index` itself too, so
 * `core/lighter.ts`'s `parseLighterSocketOrders` flattens the grouping away
 * rather than trust it as the only source of the market id.
 */
type OrdersMessage = { channel?: string; type?: string; orders?: Record<string, LighterOrderRow[]> }

/** One push off the socket, whichever channel it came on - a handler narrows it by the fields it reads. */
export type LighterStreamMessage = TradeMessage & StatsMessage & SpotStatsMessage & TickerMessage & ErrorMessage & PositionsMessage & OrdersMessage
type Handler = (msg: LighterStreamMessage) => void

const readNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const EMPTY_TOP: LighterOrderBookTop = { bestBid: null, bestAsk: null, spread: null }
// Cut for radinus: EMPTY_STATS (read only by useLighterTrades, cut).

/**
 * Two sockets, the same machinery twice (`createConn`): `publicConn` carries the public channels Lighter pushes -
 * `trade/<id>`, `ticker/<id>`, `market_stats/<id>` (perps) and `spot_market_stats/<id>` (spot) - and `lighterConn`
 * every `account_…` channel, always Lighter's own `wss://api.rh.lighter.xyz/stream`. The public socket's address is
 * Lighter's stream too unless the caller names another server that forwards the same frames (`connectPublic`): Radinus's
 * data source decides it (`src/sources/`). Routing is static, by channel name, decided once when a channel's entry is
 * first created (`targetForChannel`), never by a socket's state: a socket that is down leaves its channels waiting and
 * resubscribes them itself when it reopens. An `account_…` subscribe frame can carry an auth token, so a channel outside
 * the four public names never rides the public socket.
 *
 * Shared by both: a 20 s ping (Lighter closes a silent socket after ~60 s, measured 2026-09-22), the reconnect backoff
 * (1 s doubling to 30 s, reset on open), and the deferred teardown in `subscribe`.
 *
 * Channel names and shapes, measured on Lighter's stream:
 *
 * - **Subscribe with a slash**: `{type:"subscribe", channel:"trade/38"}`; **pushes echo the channel with a colon**:
 *   `"trade:38"`, matched with `===`.
 * - `trade:<id>`: the subscribe ack is `"subscribed/trade"` with ~50 recent prints - skipped; every later push is
 *   `"update/trade"`. `liquidation_trades` is ignored: a forced close is not an order print.
 * - `ticker:<id>`: a full state on every push, `{ticker:{s,a:{price,size},b:{price,size}}}` - best ask / best bid.
 * - `market_stats:<id>` (perps) and `spot_market_stats:<id>` (spot): a full state on every push, the last one kept per
 *   channel and replayed to a late subscriber; `account_all_positions:<i>` likewise.
 * - `account_all_orders:<i>` needs `auth` in the subscribe frame; its pushes are deltas after the first.
 * - A refused channel answers `{"error":{"code":30005,…}}`: warned once per channel, not resubscribed.
 *
 * A message from a socket that is no longer the current one is dropped (a stale `onmessage` once wrote one market's
 * mark on another's screen, 2026-09-19).
 */
const LIGHTER_URL = 'wss://api.rh.lighter.xyz/stream'

/** 20 s, module doc comment above - well inside the ~60 s idle close measured. */
const PING_INTERVAL_MS = 20000

/** One socket's own handle - two live instances below (`publicConn`, `lighterConn`), not two implementations. */
type Conn = {
  readonly label: 'public' | 'lighter'
  connect: () => void
  state: () => LighterConnectionState
  sendJson: (payload: object) => void
  dispose: () => void
}

/** A channel's live state plus the socket it is pinned to - `conn` is set once, by `targetForChannel`, when the entry is first created, and never moves. */
type ChannelEntry = { handlers: Set<Handler>; last: LighterStreamMessage | null; auth?: string; conn: Conn }

const channels = new Map<string, ChannelEntry>()
const stateListeners = new Set<() => void>()
/** `label:channel` pairs already warned about an `error` frame: once, not once per push. */
const warnedErrorChannels = new Set<string>()

/** A push echoes `trade/38` back as `trade:38` - the one colon, put back to the slash the subscriber used. */
const slashOf = (echo: string) => echo.replace(':', '/')

// Assigned right after `createConn` runs, below `createConn`'s own
// definition. Referenced only from inside functions that run later (a
// subscribe call, a socket event), never at module-init time, so the
// forward declaration is safe.
let publicConn: Conn
let lighterConn: Conn
/** The public socket's address, `null` = Lighter's own stream; set once by `connectPublic`, before that socket opens. */
let publicUrl: string | null = null

/** The four public channel names - module doc comment above. */
const PUBLIC_CHANNEL_PREFIXES = ['trade/', 'ticker/', 'market_stats/', 'spot_market_stats/']

/**
 * Which socket a channel belongs to, by name alone: the four public prefixes always resolve to `publicConn`, whatever
 * its state; every `account_…` channel always resolves to `lighterConn`. Any other name is a programming error: logged,
 * not routed, so a typo in a channel name fails loudly instead of quietly riding the wrong socket.
 */
const targetForChannel = (channel: string): Conn | null => {
  if (PUBLIC_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))) return publicConn
  if (channel.startsWith('account_')) return lighterConn
  console.error(`lighterStream: unrecognised channel "${channel}" - subscribing nowhere`)
  return null
}

// Cut for radinus: the opened latch and stateSnapshot, read only by the cut hook useLighterSocketState.

const notifyState = () => {
  // Cut for radinus: the snapshot update (stateSnapshot, cut above).
  for (const cb of stateListeners) cb()
}

/**
 * One socket's machinery, kept for the session - `publicConn`/`lighterConn` below are two independent instances of
 * exactly this, each only ever touching the channel entries whose `conn` points at it. `url` is read when the socket
 * opens (and at each reconnect), so the public socket's address can be set before its first `connect`.
 */
const createConn = (url: () => string, label: 'public' | 'lighter'): Conn => {
  let socket: WebSocket | null = null
  let connection: LighterConnectionState = 'closed'
  let retryMs = 1000
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let started = false

  const setConnection = (next: LighterConnectionState) => {
    if (connection === next) return
    connection = next
    notifyState()
  }

  const sendJson = (payload: object) => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  const open = () => {
    setConnection('connecting')
    const ws = new WebSocket(url())
    socket = ws

    ws.onopen = () => {
      if (ws !== socket) return
      retryMs = 1000
      for (const [channel, entry] of channels) {
        if (entry.conn !== self) continue
        ws.send(JSON.stringify({ type: 'subscribe', channel, ...(entry.auth !== undefined ? { auth: entry.auth } : {}) }))
      }
      setConnection('open')
    }

    ws.onmessage = (event) => {
      if (ws !== socket) return
      let msg: LighterStreamMessage
      try {
        // `preserveInt64OrderIds` (`core/lighter.ts`) before every parse, not
        // only on an orders push - it only touches field names an order row
        // carries, and `account_all_orders` is the one channel whose ids
        // would otherwise round (module doc comment above).
        msg = JSON.parse(preserveInt64OrderIds(event.data as string)) as LighterStreamMessage
      } catch {
        return
      }
      // The server's own ping, if it ever sends one (unseen in 8 s of
      // measurement, module doc comment) - answered and dropped before the
      // channel check below, since it carries no `channel` field.
      if (msg.type === 'ping') {
        sendJson({ type: 'pong' })
        return
      }
      // A refusal (`{"error":{"code":30005,…}}`, module doc comment
      // above): warned once per channel, never resubscribed. `warnedErrorChannels` is keyed by label too, so
      // the same channel name refused on both sockets (it shouldn't be, but
      // nothing here promises it can't) warns twice, not once for both.
      if (msg.error) {
        const key = `${label}:${typeof msg.channel === 'string' ? msg.channel : '?'}`
        if (!warnedErrorChannels.has(key)) {
          warnedErrorChannels.add(key)
          console.warn(`lighterStream: ${label} refused "${msg.channel ?? '?'}"`, msg.error.message ?? msg.error)
        }
        return
      }
      if (typeof msg.channel !== 'string') return
      const entry = channels.get(slashOf(msg.channel))
      // Dropped, not routed, if the channel does not exist any more - a
      // stray frame in flight from a subscription that has since torn down.
      if (!entry || entry.conn !== self) return
      entry.last = msg
      for (const handler of entry.handlers) handler(msg)
    }

    ws.onclose = () => {
      if (ws !== socket) return
      socket = null
      setConnection('closed')
      retryTimer = setTimeout(open, retryMs)
      retryMs = Math.min(retryMs * 2, 30000)
    }
    // The close handler is what schedules the retry - this only turns an
    // error into a close instead of a silent stall.
    ws.onerror = () => ws.close()
  }

  const self: Conn = {
    label,
    state: () => connection,
    sendJson,
    connect: () => {
      if (started) return
      started = true
      open()
      pingTimer = setInterval(() => sendJson({ type: 'ping' }), PING_INTERVAL_MS)
    },
    dispose: () => {
      if (retryTimer) clearTimeout(retryTimer)
      if (pingTimer) clearInterval(pingTimer)
      const ws = socket
      socket = null
      ws?.close()
    },
  }
  return self
}

publicConn = createConn(() => publicUrl ?? LIGHTER_URL, 'public')
lighterConn = createConn(() => LIGHTER_URL, 'lighter')
/** Whether the public socket was asked to open (`connectPublic`, `connect`): its address is fixed from then on. */
let publicConnStarted = false

type Book = {
  top: LighterOrderBookTop
  listeners: Set<(top: LighterOrderBookTop) => void>
  unsubscribe: () => void
}
const books = new Map<number, Book>()

/** `ticker/<id>`'s full state, straight to a top of book - point 2, brief S19: no incremental fold any more, `b`/`a` are already the best bid/ask. */
const foldTicker = (book: Book, msg: LighterStreamMessage) => {
  if (!msg.ticker) return
  const bestBid = readNumber(msg.ticker.b?.price)
  const bestAsk = readNumber(msg.ticker.a?.price)
  book.top = { bestBid, bestAsk, spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null }
  for (const listener of book.listeners) listener(book.top)
}

/**
 * `channel` in the slash form (`trade/38`). The first subscriber sends
 * `subscribe`, the last sends `unsubscribe`; `replayLast` hands a new
 * subscriber the channel's last push at once (never for trades, whose
 * replay would print twice). `auth` (`account_all_orders` only, so far) is
 * sent with that first `subscribe` frame and remembered on the channel so
 * `onopen`'s reconnect loop can resend it - it is read only when the
 * channel does not exist yet: re-authenticating an already-open channel
 * means unsubscribing and subscribing again (`core/lighterOrders.ts`'s own
 * token-refresh path), never a second `subscribe` on top of the first
 * (measured 2026-09-22: a double subscribe on the same channel, bare
 * then `auth`, was refused `30003 Already Subscribed`).
 *
 * The teardown below is deferred a tick rather than sent at once - React's
 * StrictMode mounts every subscriber's effect twice on its first mount
 * (setup, cleanup, setup again, all synchronous, measured on the site:
 * `subscribe`/`subscribe`/`unsubscribe`/`unsubscribe`/`subscribe`/`subscribe`
 * for two lanes' order-book channels, one burst, before any reply). Firing
 * `unsubscribe` on the first cleanup would round-trip the channel closed and
 * back open for no reason every single mount, on the exact channel shape
 * (subscribe, drop to zero handlers, subscribe again) the `30003` hazard
 * above already lives on - a bare `setTimeout(0)` lets the synchronous
 * resubscribe find the entry still here and skip the wire entirely; only a
 * cleanup with nobody left a tick later is a real unmount.
 */
const subscribe = (channel: string, handler: Handler, replayLast = false, auth?: string): (() => void) => {
  let entry = channels.get(channel)
  if (!entry) {
    const conn = targetForChannel(channel)
    // `targetForChannel` already logged the programming error; nothing to
    // subscribe, so a no-op unsubscribe (module doc comment, point 1).
    if (!conn) return () => {}
    entry = { handlers: new Set(), last: null, auth, conn }
    channels.set(channel, entry)
    conn.sendJson({ type: 'subscribe', channel, ...(auth !== undefined ? { auth } : {}) })
    notifyState()
  }
  entry.handlers.add(handler)
  if (replayLast && entry.last !== null) handler(entry.last)
  return () => {
    const current = channels.get(channel)
    if (!current) return
    current.handlers.delete(handler)
    if (current.handlers.size > 0) return
    setTimeout(() => {
      const stillIdle = channels.get(channel)
      if (!stillIdle || stillIdle.handlers.size > 0) return
      channels.delete(channel)
      stillIdle.conn.sendJson({ type: 'unsubscribe', channel })
      notifyState()
    }, 0)
  }
}

/**
 * The top of one market's book, now and on every push - reads `ticker/<id>`
 * (point 2, brief S19: the full-depth `order_book/<id>` is not subscribed
 * anywhere here, "The full order book is the one
 * exception"). Its own teardown defers dropping `books`'s entry the same
 * tick `subscribe`'s does and for the same reason (StrictMode's synchronous
 * remount) - deleting the `Book` at once would have a resubscribe rebuild it
 * empty and wait out a fresh push with nothing behind it, since the channel
 * itself never actually closed underneath.
 */
const subscribeOrderBook = (marketId: number, listener: (top: LighterOrderBookTop) => void): (() => void) => {
  let book = books.get(marketId)
  if (!book) {
    const created: Book = { top: EMPTY_TOP, listeners: new Set(), unsubscribe: () => {} }
    created.unsubscribe = subscribe(`ticker/${marketId}`, (msg) => foldTicker(created, msg))
    books.set(marketId, created)
    book = created
  }
  book.listeners.add(listener)
  listener(book.top)
  return () => {
    const current = books.get(marketId)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return
    setTimeout(() => {
      const stillIdle = books.get(marketId)
      if (!stillIdle || stillIdle.listeners.size > 0) return
      stillIdle.unsubscribe()
      books.delete(marketId)
    }, 0)
  }
}

// Cut for radinus: LastTrade (the type of lastTrades, cut).
// Cut for radinus: lastTrades (read only by subscribeLastTrade, cut).

// Cut for radinus: subscribeLastTrade (read only by useLighterLastTrade, cut).

export const lighterSocket = {
  /** Opens both sockets once for the session. Idempotent per socket. */
  connect(): void {
    publicConnStarted = true
    publicConn.connect()
    lighterConn.connect()
  },
  /**
   * Opens the public socket alone (Radinus has no account to listen to), at `url` (`null` = Lighter's own stream). The
   * address is fixed at the first call: a second call with another address throws rather than move channels between
   * servers. Idempotent otherwise.
   */
  connectPublic(url: string | null): void {
    if (publicUrl !== url && publicConnStarted) throw new Error(`lighterStream: the public socket is already open on ${publicUrl ?? LIGHTER_URL}`)
    publicUrl = url
    publicConnStarted = true
    publicConn.connect()
  },
  /** `publicConn`'s own state - the public socket (trades, tickers), what Radinus reads to write a cut as a cut; `onState` calls back on its changes. */
  publicState(): LighterConnectionState {
    return publicConn.state()
  },
  /** `lighterConn`'s own state - the account socket, what the header's logo keeps meaning (module doc comment on `stateSnapshot`). */
  state(): LighterConnectionState {
    return lighterConn.state()
  },
  /** Channels with at least one subscriber, across both sockets - what the header's logo counts on hover. */
  channelCount(): number {
    return channels.size
  },
  /** Called on every connection change on either socket, and on every channel add/remove. */
  onState(cb: () => void): () => void {
    stateListeners.add(cb)
    return () => {
      stateListeners.delete(cb)
    }
  },
  subscribe,
  subscribeOrderBook,
}

// Cut for radinus: Vite's HMR dispose block (import.meta.hot exists only under the dev server).

// Cut for radinus: the React hook useLighterSocketState (browser-only).

// Cut for radinus: the React hook useLighterOrderBook (browser-only).

// Cut for radinus: the React hook useLighterLastTrade (browser-only).

/** The prints of a `trade/<id>` push (the subscribe ack's ~50 seeded ones skipped), as `LighterTrade`s - what `useLighterTrades` and `core/rsiLoaders.ts` both fold. */
export function tradesOfPush(msg: LighterStreamMessage): LighterTrade[] {
  if (!msg.trades || msg.type === 'subscribed/trade') return []
  return msg.trades.flatMap((t) => {
    const price = readNumber(t.price)
    const size = readNumber(t.size)
    if (price === null || size === null || t.timestamp === undefined || t.trade_id === undefined) return []
    return [{ price, size, timestampMs: t.timestamp, tradeId: t.trade_id, ask: t.is_maker_ask ? 1 : 0 }]
  })
}

// Cut for radinus: the React hook useLighterTrades (browser-only).
