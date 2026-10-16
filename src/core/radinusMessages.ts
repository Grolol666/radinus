/**
 * What `radinus/` (the program that runs the bots on paper) and the page `/bots` say to each other, in ONE file: the program imports it by a relative path
 * (as it already imports `core/` for the players and the fills) and the page's store imports it from here, so the message shapes exist once and cannot drift.
 * Plain types and three small functions, no React, no Node: JSON over one WebSocket, `ws://127.0.0.1:4664` by default.
 */

import type { Drawing } from './chartDrawings'
import type { HaltCause } from './playerRules'
import type { SubAccount } from './subAccounts'

/** The program's default port, and the address the page proposes. */
export const RADINUS_PORT = 4664
export const RADINUS_ADDRESS = `ws://127.0.0.1:${RADINUS_PORT}`
/** The page's own close code when the program refused its origin (the program accepts the handshake, journals the refusal and closes with this: a browser cannot tell a refused handshake from a program that is not running). */
export const RADINUS_CLOSE_REFUSED = 4403
/** The most lines of a journal the page can ask for in one `journal` message. */
export const JOURNAL_LINES_MAX = 1000

/** The `joueur` of a script bot (`/bot`'s script, author's go 2026-10-10): its definition carries `script`, `subAccounts` and `drawings` instead of a player's fields. */
export const SCRIPT_ID = 'script'

/** One sub-account of a script bot as `/bots` shows it: its life, its open position (entry, stop, take-profit, liquidation, stake in USDG, size = its notional in USDG; `null` when flat, absent from a Radinus built before them), its counters and its account (USDG, the start being its collateral). */
export type SubAccountView = { name: string; etat: BotLife; levier: number; entree: number | null; stopPrix: number | null; takePrix: number | null; liquidationPrix: number | null; stake: number | null; size: number | null; trades: number; gagnants: number; perdants: number; pnl: number; compte: number; compteDepart: number }

/** A bot's life, as the page shows it: `attente` = not launched yet (its start is later, or the market is not yet seeded). */
export type BotLife = 'attente' | 'dehors' | 'long' | 'short' | 'arrete' | 'liquide' | 'epuise'

/** A bot: its definition (the `/rsi` row it was frozen from) and its state. Prices are the paper account's; `pnlPct` is the PnL in % of the stake at the start. */
export type BotView = {
  id: string
  marche: string
  /** The leverage in force for the bot's next entry (a position already open keeps the one it was taken with). */
  levier: number
  /** The market's maximum leverage (`10000 / initial margin`). */
  levierMax: number
  /** The id of the `/rsi` row (`RSI_TABLE_PLAYERS`) and its settings by key, defaults filled in. */
  joueur: string
  reglages: Record<string, number>
  seuilBas: number | null
  seuilHaut: number | null
  regle: string | null
  stop: number | null
  /** The trailing's three values, always sent: its box and its two numbers (0 = empty); applied only with the box checked and both above 0. */
  trail: boolean
  trailSeuil: number
  trailDistance: number
  /** The four guard rules (`playerRules.ts`) the bot was launched with, absent = off: N losses in a row, X % of the starting stake, M minutes after a stop, M minutes after two stops on one side. */
  pertesDeSuite?: number
  perteMise?: number
  tempsMort?: number
  coteInterdit?: number
  /** Why and when a guard rule stopped it (A `pertes` or B `perte`, `valeur` = its N or X, `heure` ISO); absent while it runs. `etat` is then `arrete`, until `reprendre`. */
  arret?: { cause: HaltCause; valeur: number; heure: string }
  part: number
  /** The start account ($) and the fixed stake ($) it was launched with (`account.ts`'s `StakePolicy`), absent = auto and the `part` policy. */
  startAccount?: number
  fixedStake?: number
  /** The objective it was launched with, absent for a bot launched without one (before this field, or from a `bots.json`). */
  attendu?: BotAttendu
  /** The composition of a bot launched from `/bot` (its `joueur` is then `'bot'`, with no settings, thresholds or rule of its own); absent for a bot of one player. */
  compose?: BotCompose
  /** The name given at launch (`/bot` names its bots through `compose.nom`; any definition may carry one), absent when there is none: `/bots` shows it in place of the id. */
  name?: string
  /** The id the bot had before the family was renumbered (2026-10-08), absent for a bot that never changed id. */
  formerId?: string
  /** The instant it plays from (ISO). */
  debut: string
  etat: BotLife
  /** The open position's entry, stop and liquidation prices, `null` when the bot holds nothing (or has no stop). */
  entree: number | null
  stopPrix: number | null
  liquidationPrix: number | null
  trades: number
  gagnants: number
  perdants: number
  pnl: number
  pnlPct: number
  compte: number
  compteDepart: number
  /** The warning when the stop is at or behind the liquidation distance, else `null`. */
  alerte: string | null
  /** A script bot's sub-accounts, in its list's order (its figures above are their sums); absent for any other bot. */
  subAccounts?: SubAccountView[]
  /** A script bot's call times (ms): the last call, the largest, the mean, and the calls over the budget (`SCRIPT_BUDGET_MS`, 50 ms: one is made again, a second one pauses every sub-account); absent for any other bot. */
  scriptMs?: { dernier: number | null; max: number; moyenne: number | null; auDela: number }
}

/** The stream of a market: `amorce` = not seeded yet, `ouvert` = live, `perdu` = cut, `rattrapage` = back, reading what it missed. */
export type StreamState = 'amorce' | 'ouvert' | 'perdu' | 'rattrapage'

export type MarketView = {
  nom: string
  id: number
  levier: number
  /** Lighter's margins, in % of the notional, and the liquidation fee in % of the notional. */
  margeInitiale: number
  margeMaintien: number
  fraisLiquidation: number
  /** The measured median spread (ticks and %), `null` when it was not measured. */
  ecartTicks: number | null
  ecartPct: number | null
  flux: StreamState
}

/** The program: when it started, the wait before a minute closes, the markets it follows, and the clock it keeps (the smallest print delay it saw, what it subtracts from the PC's time, the prints it rests on). */
export type ProgramView = {
  demarre: string
  attenteMs: number
  marches: MarketView[]
  horloge: { plusPetitEcartMs: number | null; correctionMs: number; echantillons: number }
}

export type BotVerb = 'arreter' | 'reprendre' | 'retirer'

/** The bot's objective: the figures of its `/rsi` row as shown at the click (`rsiStore` figures and status, nothing recomputed), with the span they were computed on (`heures`, the replayed first-to-last print) and what they were computed at. `tradesParHeure` = `trades / heures`; `miseFixePct` and `comptePct` are the row's `mise fixe` and `compte`, in % of the starting stake. */
export type BotAttendu = { heures: number; trades: number; gagnants: number; perdants: number; tradesParHeure: number; miseFixePct: number; comptePct: number; marche: string; levier: number; part: number; sansTrailing?: SansTrailing }

/** For a row with a trailing: the same row's figures with the trailing removed (the fixed stop kept), by the same replay, so the live result shows whether the trailing keeps its promise (author, 2026-10-06). */
export type SansTrailing = { miseFixePct: number; comptePct: number; gagnants: number; trades: number }

/** A bot's definition in the shape of a `bots.json` entry, without what the program gives it (its id, its `debut`): what `lancer` carries, and what `radinus/bots.ts` reads and checks, for a launched bot as for a listed one. */
export type BotDefinition = { marche: string; joueur: string; /** A script bot (`joueur` = `SCRIPT_ID`): the script's text, its sub-accounts and the chart's drawings of its market (static for the bot's life, until a `modifier`). */ script?: string; subAccounts?: SubAccount[]; drawings?: Drawing[]; /** A script bot launched from `/bot`: created PAUSED, never started (no decision, no order) until `reprendre`; kept in `bots.json` until then, absent once it runs. */ paused?: boolean; reglages?: Record<string, number>; seuilBas?: number; seuilHaut?: number; regle?: string | null; stop?: number | null; trail?: boolean; trailSeuil?: number; trailDistance?: number; pertesDeSuite?: number; perteMise?: number; tempsMort?: number; coteInterdit?: number; part?: number; levier?: number; startAccount?: number; fixedStake?: number; attendu?: BotAttendu; compose?: BotCompose; name?: string }

/**
 * A composed bot (`/bot`): ONE bot whose signals come from two or three indicators read left to right. `indicateurs` = the players chosen, each with its OWN settings, thresholds and rule (the player group of a `BotDefinition`) and its candle `source`
 * (`lighter` only, for now); `liens` = one fewer than the indicators, `liens[k]` joining what the indicators up to `k` say to indicator `k + 1`: `et` = both say the same side, `ou` = one suffices (opposite sides give nothing), `filtre` = the left one's fresh signal
 * counts only when the right one says the same side. `cote` = `les deux`, or one side only (it exits on the opposite signal, and is out the rest of the time). A link is between two indicators of one bot, never between bots.
 * Sent to `radinus/` as a definition's `compose` (`launch` on `/bot`): when present it replaces the definition's `joueur` / `reglages` / thresholds / `regle` (`joueur` is then `'bot'`); the stop, trailing, guard rules, leverage, share and objective stay the bot's own.
 */
export type BotLien = 'et' | 'ou' | 'filtre'
export type BotCote = 'les deux' | 'long' | 'short'
export type BotIndicateur = Pick<BotDefinition, 'joueur' | 'reglages' | 'seuilBas' | 'seuilHaut' | 'regle'> & { source: 'lighter' }
export type BotCompose = { nom: string; cote: BotCote; indicateurs: BotIndicateur[]; liens: BotLien[] }

/** program -> page */
export type ServerMessage =
  /** At connection: the program, every bot, and the number of the last journal line published (`seq`). */
  | { type: 'etat'; seq: number; programme: ProgramView; bots: BotView[] }
  /** One bot's state, sent when it changed (never the whole list). */
  | { type: 'bot'; bot: BotView }
  | { type: 'programme'; programme: ProgramView }
  /** One journal line as it was written: a bot's, or the program's (`bot` null). `seq` counts every line published, in the order written. */
  | { type: 'ligne'; seq: number; bot: string | null; ligne: Record<string, unknown> }
  /** The answer to `journal`: the last lines of the file, oldest first; `jusqua` = the `seq` of the last live line they already contain (a live line numbered `jusqua` or less is in them). */
  | { type: 'journal'; bot: string | null; lignes: Record<string, unknown>[]; jusqua: number }
  | { type: 'retire'; bot: string }
  /** The answer to `lancer`: the id the program gave the new bot, and the `ref` the page sent with it. */
  | { type: 'lance'; ref: string; bot: string }
  /** The answer to `modifier`: the bot `bot` now runs the definition sent with `ref`. */
  | { type: 'modifie'; ref: string; bot: string }
  /** The answer to `definition`: the bot's definition as `bots.json` holds it (without its id, its start and `paused`), `null` when the program does not know the bot. `/bot` loads a bot from it. */
  | { type: 'definition'; bot: string; definition: BotDefinition | null }
  /** A verb or a launch refused, with its reason in words; for `lancer` and `modifier`, `bot` is the `ref` the page sent. */
  | { type: 'refus'; verbe: BotVerb | 'lancer' | 'levier' | 'modifier'; bot: string; raison: string }

/** page -> program */
export type ClientMessage = { type: BotVerb; bot: string } | { type: 'levier'; bot: string; levier: number } | { type: 'journal'; bot: string | null; n: number } | { type: 'lancer'; ref: string; bot: BotDefinition } | { type: 'modifier'; ref: string; bot: string; definition: BotDefinition } | { type: 'definition'; bot: string }

/** JSON.parse that reports failure as `undefined`: a message off the network can be anything, and `JSON.parse` reports by throwing (the one try/catch the two ends share). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const NUMBER_FIELDS = ['heures', 'trades', 'gagnants', 'perdants', 'tradesParHeure', 'miseFixePct', 'comptePct', 'levier', 'part']

const SANS_TRAILING_FIELDS = ['miseFixePct', 'comptePct', 'gagnants', 'trades']

/** An objective as sent: all its fields or nothing (a malformed one is dropped, not completed); `sansTrailing`, when present, is whole too. */
export function readAttendu(x: unknown): BotAttendu | null {
  if (!isRecord(x) || typeof x.marche !== 'string') return null
  if (!NUMBER_FIELDS.every((k) => typeof x[k] === 'number' && Number.isFinite(x[k]))) return null
  const s = x.sansTrailing
  if (s !== undefined && !(isRecord(s) && SANS_TRAILING_FIELDS.every((k) => typeof s[k] === 'number' && Number.isFinite(s[k])))) return null
  return x as BotAttendu
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** The known fields of a definition, as sent: nothing else goes through (an `id` or a `debut` the page adds is the program's to give), and the values are not checked here, `radinus/bots.ts` does. */
function readDefinition(m: Record<string, unknown>): BotDefinition | null {
  if (typeof m.marche !== 'string' || typeof m.joueur !== 'string') return null
  const d: Record<string, unknown> = { marche: m.marche, joueur: m.joueur }
  for (const k of ['reglages', 'seuilBas', 'seuilHaut', 'regle', 'stop', 'trail', 'trailSeuil', 'trailDistance', 'pertesDeSuite', 'perteMise', 'tempsMort', 'coteInterdit', 'part', 'levier', 'startAccount', 'fixedStake']) if (k in m) d[k] = m[k]
  const attendu = readAttendu(m.attendu)
  if (attendu !== null) d.attendu = attendu
  if (isRecord(m.compose)) d.compose = m.compose
  if (typeof m.name === 'string' && m.name !== '') d.name = m.name
  for (const k of ['script', 'subAccounts', 'drawings', 'paused']) if (k in m) d[k] = m[k]
  return d as BotDefinition
}

/** What the page sent, or `null` when it is not one of the eight messages (the program ignores it). `n` is clamped to 1..`JOURNAL_LINES_MAX`. */
export function readClientMessage(text: string): ClientMessage | null {
  const m = parseJson(text)
  if (!isRecord(m)) return null
  if (m.type === 'arreter' || m.type === 'reprendre' || m.type === 'retirer') return typeof m.bot === 'string' ? { type: m.type, bot: m.bot } : null
  if (m.type === 'levier' && typeof m.bot === 'string' && typeof m.levier === 'number' && Number.isFinite(m.levier)) return { type: 'levier', bot: m.bot, levier: m.levier }
  if (m.type === 'journal' && (m.bot === null || typeof m.bot === 'string') && typeof m.n === 'number' && Number.isFinite(m.n)) return { type: 'journal', bot: m.bot, n: Math.min(JOURNAL_LINES_MAX, Math.max(1, Math.floor(m.n))) }
  if (m.type === 'definition' && typeof m.bot === 'string') return { type: 'definition', bot: m.bot }
  if (m.type === 'lancer' && typeof m.ref === 'string' && isRecord(m.bot)) {
    const bot = readDefinition(m.bot)
    return bot === null ? null : { type: 'lancer', ref: m.ref, bot }
  }
  if (m.type === 'modifier' && typeof m.ref === 'string' && typeof m.bot === 'string' && isRecord(m.definition)) {
    const definition = readDefinition(m.definition)
    return definition === null ? null : { type: 'modifier', ref: m.ref, bot: m.bot, definition }
  }
  return null
}

/** What the program sent, or `null` when it is not one of its messages. The shapes inside are the program's, not re-checked field by field. */
export function readServerMessage(text: string): ServerMessage | null {
  const m = parseJson(text)
  if (!isRecord(m)) return null
  switch (m.type) {
    case 'etat':
    case 'bot':
    case 'programme':
    case 'ligne':
    case 'journal':
    case 'retire':
    case 'lance':
    case 'modifie':
    case 'definition':
    case 'refus':
      return m as ServerMessage
    default:
      return null
  }
}

/** One console line for one journal line, in the words the terminal of `direct` prints: the time (UTC, hh:mm:ss.mmm), the bot, the event, then its scalar fields. The program prints it and the page shows it: one function. */
export function consoleLine(bot: string, e: Record<string, unknown>): string {
  const { evenement, heure, ...rest } = e
  const keep = Object.entries(rest)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toPrecision(8)) : String(v)}`)
    .join(' ')
  return `${typeof heure === 'string' ? heure.slice(11, 23) : '            '} ${bot} ${String(evenement)}${keep === '' ? '' : ` ${keep}`}`
}
