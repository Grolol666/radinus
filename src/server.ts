/**
 * The page server: `live` listens on `127.0.0.1` (never another address) and the `/bots` page connects to it. It reads the bots' state through `Control` (a small interface `direct.ts` fills with the engines) and passes it three
 * commands; the bot, the exchange and the data source do not know a page exists. The messages' shapes are those of `core/radinusMessages.ts`, a copy of the file the page imports too.
 *
 * THE ORIGIN. Any web page can try to reach a port of the PC: the `Origin` header must be in the visible list of `marche.json` (`serveur.origines`). A missing or unlisted origin is refused: the
 * handshake is accepted then closed at once with code 4403, sending nothing (a browser cannot tell a refused handshake from a program that is not running; with this code the page says "refused"), and the refusal is written
 * in `programme.jsonl`. No password at this stage, and nothing listened to outside the machine.
 *
 * THE SERVER NEVER SLOWS THE BOTS DOWN. Each send is without waiting (`ws.send`, empty callback); a page that no longer reads lets its send queue grow (`bufferedAmount`): beyond `maxBufferBytes` its connection is cut
 * and told in `programme.jsonl`. A message received is a few bytes at most (`maxPayload`). The journal line of a cut is written after the send loop, never inside it (a journal line publishes a line: the order of a page's
 * lines must not be inverted).
 */

import { WebSocketServer } from 'ws'
import type { RawData, WebSocket } from 'ws'
import { RADINUS_CLOSE_REFUSED, readClientMessage } from './core/radinusMessages'
import type { BotDefinition, BotVerb, BotView, ProgramView, ServerMessage } from './core/radinusMessages'
import { parseJson } from './core/radinusMessages'
import { tailLines } from './journal'

/** What the server knows of the program and asks of it. */
export type Control = {
  /** The bots of every market, in the list's order, and the program. */
  bots: () => BotView[]
  bot: (id: string) => BotView | null
  program: () => ProgramView
  /** One of the three verbs: `null` = done, else the reason of the refusal. */
  command: (verb: BotVerb, id: string) => string | null
  /** `levier`: the leverage of a bot's next entries: `null` = done, else the reason of the refusal. */
  leverage: (id: string, levier: number) => string | null
  /** `lancer`: the program gives the bot an id and starts it (a script bot with `paused: true` is listed, not started); the answer is late if its market is not followed yet (the program reads it and warms it up first). Never rejects: a refusal is a `raison`. */
  launch: (definition: BotDefinition) => Promise<{ id: string } | { raison: string }>
  /** `modifier`: a script bot's new definition (script, sub-accounts, drawings), its positions and registers kept: `null` = done, else the reason of the refusal. */
  modify: (id: string, definition: BotDefinition) => string | null
  /** `definition`: a listed bot's definition as `bots.json` holds it (no id, start nor `paused`), `null` when the bot is unknown. */
  definition: (id: string) => BotDefinition | null
  /** The file of a bot's journal (`null` = the program's), `undefined` if it has none. */
  journalPath: (id: string | null) => string | undefined
}

export type ServerOptions = {
  port: number
  /** The visible list of accepted origins (`marche.json`, `serveur.origines`). */
  origins: string[]
  control: Control
  /** A line of `programme.jsonl` (the time is set by the caller: it is its clock). */
  program: (event: Record<string, unknown>) => void
  say: (line: string) => void
  /** The send queue beyond which a page is cut (bytes). */
  maxBufferBytes?: number
}

export type ServerHandle = {
  port: number
  /** A journal line has just been written: a bot's (`bot` = its id) or the program's (`null`); it goes to every page with its number. */
  line: (bot: string | null, event: Record<string, unknown>) => void
  /** A bot's state may have changed: it is sent if it changed, never the list. */
  bot: (id: string) => void
  removed: (id: string) => void
  /** The program (the markets, the feed, the clock) may have changed. */
  program: () => void
  clients: () => number
  /** How many pages were cut for a full queue. */
  dropped: () => number
  /** The number of the last line published. */
  seq: () => number
  close: () => void
}

/** A page's send queue, at most (1 MB: thousands of journal lines behind). */
export const MAX_BUFFER_DEFAULT = 1048576
/** A message from the page holds in a few tens of bytes, but a script bot's `lancer` / `modifier` carries its script and its drawings (200 drawings at most, `chartDrawings.ts`): 256 KB. */
const MAX_PAYLOAD = 262144

export async function startServer(o: ServerOptions): Promise<ServerHandle | null> {
  const maxBuffer = o.maxBufferBytes ?? MAX_BUFFER_DEFAULT
  const wss = new WebSocketServer({ host: '127.0.0.1', port: o.port, maxPayload: MAX_PAYLOAD })
  const listening = await new Promise<boolean>((resolve) => {
    wss.once('listening', () => resolve(true))
    wss.once('error', (e) => {
      o.say(`page server: ${e.message} (is port ${o.port} taken? the bots run without the page)`)
      o.program({ evenement: 'serveur_indisponible', raison: e.message, port: o.port })
      resolve(false)
    })
  })
  if (!listening) return null
  wss.on('error', (e) => o.say(`page server: ${e.message}`))

  const clients = new Map<WebSocket, string>()
  const gone = new WeakSet<WebSocket>()
  const lastBot = new Map<string, string>()
  let lastProgram = ''
  let seq = 0
  let droppedCount = 0
  let toJournal: Record<string, unknown>[] = []
  const noop = (): void => {}

  /** Cuts a page whose queue is full; the journal write waits for the end of the send loop. */
  const drop = (ws: WebSocket, origin: string): void => {
    gone.add(ws)
    clients.delete(ws)
    droppedCount++
    toJournal.push({ evenement: 'page_abandonnee', origine: origin, raison: "la file d'envoi de la page dépasse la limite : elle ne lit plus", octets: ws.bufferedAmount, limite: maxBuffer })
    ws.terminate()
  }
  const flushJournal = (): void => {
    const lines = toJournal
    toJournal = []
    for (const e of lines) o.program({ ...e, pages: clients.size })
  }
  const send = (ws: WebSocket, text: string): void => {
    if (ws.bufferedAmount > maxBuffer) drop(ws, clients.get(ws) ?? '')
    else ws.send(text, noop)
  }
  const broadcast = (m: ServerMessage): void => {
    if (clients.size === 0) return
    const text = JSON.stringify(m)
    for (const ws of [...clients.keys()]) send(ws, text)
    flushJournal()
  }

  const stateOf = (id: string): string | null => {
    const b = o.control.bot(id)
    return b === null ? null : JSON.stringify(b)
  }
  const publishBot = (id: string): void => {
    const text = stateOf(id)
    if (text === null || lastBot.get(id) === text) return
    lastBot.set(id, text)
    if (clients.size === 0) return
    const all = `{"type":"bot","bot":${text}}`
    for (const ws of [...clients.keys()]) send(ws, all)
    flushJournal()
  }
  const publishProgram = (): void => {
    const p = JSON.stringify(o.control.program())
    if (p === lastProgram) return
    lastProgram = p
    if (clients.size === 0) return
    const all = `{"type":"programme","programme":${p}}`
    for (const ws of [...clients.keys()]) send(ws, all)
    flushJournal()
  }

  const onMessage = (ws: WebSocket, data: RawData, isBinary: boolean): void => {
    if (isBinary) return
    const msg = readClientMessage(data.toString())
    if (msg === null) return
    if (msg.type === 'journal') {
      const path = o.control.journalPath(msg.bot)
      const lignes: Record<string, unknown>[] = []
      if (path !== undefined) {
        for (const line of tailLines(path, msg.n)) {
          const e = parseJson(line)
          if (typeof e === 'object' && e !== null && !Array.isArray(e)) lignes.push(e as Record<string, unknown>)
        }
      }
      // `seq` does not change during this read: everything the page received live with a number <= `jusqua` is in these lines.
      send(ws, JSON.stringify({ type: 'journal', bot: msg.bot, lignes, jusqua: seq } satisfies ServerMessage))
      flushJournal()
      return
    }
    if (msg.type === 'lancer') {
      // Nothing is awaited here: the answer goes to the page that asked when the program has it, and the bots run in the meantime.
      void o.control.launch(msg.bot).then((r) => {
        if (!clients.has(ws)) return
        send(ws, JSON.stringify('id' in r ? ({ type: 'lance', ref: msg.ref, bot: r.id } satisfies ServerMessage) : ({ type: 'refus', verbe: 'lancer', bot: msg.ref, raison: r.raison } satisfies ServerMessage)))
        flushJournal()
      })
      return
    }
    if (msg.type === 'definition') {
      send(ws, JSON.stringify({ type: 'definition', bot: msg.bot, definition: o.control.definition(msg.bot) } satisfies ServerMessage))
      flushJournal()
      return
    }
    if (msg.type === 'modifier') {
      const no = o.control.modify(msg.bot, msg.definition)
      send(ws, JSON.stringify(no === null ? ({ type: 'modifie', ref: msg.ref, bot: msg.bot } satisfies ServerMessage) : ({ type: 'refus', verbe: 'modifier', bot: msg.ref, raison: no } satisfies ServerMessage)))
      publishBot(msg.bot)
      flushJournal()
      return
    }
    const why = msg.type === 'levier' ? o.control.leverage(msg.bot, msg.levier) : o.control.command(msg.type, msg.bot)
    if (why !== null) send(ws, JSON.stringify({ type: 'refus', verbe: msg.type, bot: msg.bot, raison: why } satisfies ServerMessage))
    publishBot(msg.bot)
    flushJournal()
  }

  wss.on('connection', (ws, req) => {
    // A socket error must never reach the program: the page is cut.
    ws.on('error', () => ws.terminate())
    const origin = req.headers.origin
    if (origin === undefined || !o.origins.includes(origin)) {
      o.program({ evenement: 'page_refusee', origine: origin ?? null, listeOrigines: o.origins })
      o.say(`page refused: origin ${origin ?? '(none)'} not in the list (marche.json, serveur.origines; --origins adds one)`)
      ws.close(RADINUS_CLOSE_REFUSED, 'origin refused')
      return
    }
    clients.set(ws, origin)
    ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary))
    ws.on('close', () => {
      if (gone.has(ws)) return
      clients.delete(ws)
      o.program({ evenement: 'page_deconnectee', origine: origin, pages: clients.size })
    })
    const bots = o.control.bots()
    // What this page receives becomes what the others have seen: a change is compared with that.
    for (const b of bots) lastBot.set(b.id, JSON.stringify(b))
    send(ws, JSON.stringify({ type: 'etat', seq, programme: o.control.program(), bots } satisfies ServerMessage))
    o.program({ evenement: 'page_connectee', origine: origin, pages: clients.size })
  })

  const address = wss.address()
  const port = typeof address === 'object' && address !== null ? address.port : o.port
  o.say(`page server: ws://127.0.0.1:${port}, accepted origins: ${o.origins.join(', ')}`)
  o.program({ evenement: 'serveur_ecoute', adresse: `127.0.0.1:${port}`, origines: o.origins })

  return {
    port,
    line: (bot, event) => {
      seq++
      broadcast({ type: 'ligne', seq, bot, ligne: event })
    },
    bot: publishBot,
    removed: (id) => {
      lastBot.delete(id)
      broadcast({ type: 'retire', bot: id })
    },
    program: publishProgram,
    clients: () => clients.size,
    dropped: () => droppedCount,
    seq: () => seq,
    close: () => {
      for (const ws of clients.keys()) ws.terminate()
      clients.clear()
      wss.close()
    },
  }
}
