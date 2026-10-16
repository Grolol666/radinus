/**
 * A bot rebuilt from its journal (point 3 of the 2026-10-05 fix, after a state was lost: a restart without `--bots` had rewritten `etat.json` without a bot).
 *
 * A bot's journal says everything that matters, in order: its definition (the first `demarrage` line), each order sent (`decision`), each entry (price, side, stop, liquidation, account before), each stop hit
 * (and the instant of its exit), each exit and each funding (account after), the liquidation, the stop asked from the page (`arret_demande`), the resumption (`reprise`), the removal (`retrait`). This function replays these lines
 * IN ORDER with the same rules as the bot (`bot.ts`) and the exchange (`exchange.ts`) and returns what `etat.json` would have said: a `BotSaved`, which the engine takes up through a restart's path (`Engine.restore`).
 *
 * What the journal does not give exactly, and where it comes from:
 *  - `prev` (the conditions of the previous close): never written when there is no decision. The engine computes it again from the warm-up candles (`BotSaved.rebuilt`), as at a restart: exact for a bot that decides; for a bot
 *    stopped from the page, liquidated or exhausted it is frozen in the written state and computed again here, but these bots do not decide with it (`reprendre` resets it to 0).
 *  - `replaced` of a `stop_touche` (was an order on its way?): not written, deduced from the orders sent and not filled yet (a `decision` without `entree` / `ordre_sans_prix` / `compte_epuise` since).
 *  - The page's stop on a position whose stop is already hit, in the 200 ms before the program's stop: the pending "arret" exit is not redone (it would do nothing: `fillClose` leaves it to the stop).
 *  - The trailing of an open position (the best price seen since its entry, the level already reached): never written in the journal, which keeps only its activation and distance (`demarrage`); it starts again from the entry price, as with a lost state. A normal restart keeps it (`etat.json`).
 *  - The fill order of two orders pending at the same time: the smallest instant first, as `resolveNext`.
 *  - The instant the program last saw (`vu`) and the minute it held open: not in a bot's journal; estimated by `lastSeenOf` when `etat.json` no longer has the market (exact when the last line is `arret`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { LEAN_SIM_LATENCY_MS } from './core/leanSim'
import { guardEntry, guardLoss, guardStake, guardState, guardTrade, hasRules, newGuard, resetGuard } from './core/playerRules'
import { PLAYER_NOTIONAL } from './core/players'
import { SCRIPT_ID, parseJson, readAttendu } from './core/radinusMessages'
import type { BotAttendu, BotCompose } from './core/radinusMessages'
import type { BotState } from './bot'
import { resolveBot } from './bots'
import type { BotSpec } from './bots'
import type { PlayerSaved } from './engine'
import type { ExchangeState } from './exchange'

export type JournalRead =
  /** A `retrait` line: the bot left the list from the page, it stays retired. */
  | { kind: 'retire' }
  /** No `demarrage` line: the bot never started, nothing to take up. */
  | { kind: 'jamais_demarre' }
  /** The journal cannot be replayed: the reason. */
  | { kind: 'impossible'; raison: string }
  | { kind: 'ok'; spec: BotSpec; saved: PlayerSaved; lines: number; lastLineMs: number | null; lastLine: string | null; stoppedAtMs: number | null; downHorizonMs: number | null }

type Line = Record<string, unknown>

/** The lines that can only come from the life of a started bot (the market notes written before its start are not). */
const BOT_LINES = new Set(['decision', 'entree', 'sortie', 'stop_touche', 'liquidation', 'funding', 'funding_manquant', 'ordre_sans_prix', 'close_order', 'compte_epuise', 'arret_demande', 'reprise', 'arret', 'redemarrage', 'minute_sans_decision', 'minutes_sans_donnee', 'etat_reconstruit', 'levier_change'])

/** A journal's whole lines. A cut last line (no newline) is set aside IN MEMORY, the file is not touched; a whole line that is not JSON is an error. */
export function readJournalLines(path: string): Line[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  const out: Line[] = []
  let n = 0
  for (const raw of whole.split('\n')) {
    if (raw.length === 0) continue
    n++
    const v = parseJson(raw)
    if (v === undefined) throw new Error(`line ${n} is not JSON`)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`line ${n} is not an object`)
    out.push(v as Line)
  }
  return out
}

const ms = (v: unknown, what: string, n: number): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  if (Number.isNaN(t)) throw new Error(`line ${n}: "${what}" is not a date`)
  return t
}
const num = (v: unknown, what: string, n: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`line ${n}: "${what}" is not a number`)
  return v
}
const sideOfName = (v: unknown, n: number): 1 | -1 => {
  if (v === 'long') return 1
  if (v === 'short') return -1
  throw new Error(`line ${n}: "cote" is neither long nor short`)
}

/** Bot `id` rebuilt from its journal `path`; `impossible` says why when the journal cannot be replayed (the refusal is a value, as `checkBot`'s). */
export function rebuildFromJournal(id: string, path: string): JournalRead {
  try {
    return replay(id, path)
  } catch (e) {
    return { kind: 'impossible', raison: e instanceof Error ? e.message : String(e) }
  }
}

function replay(id: string, path: string): JournalRead {
  const lines = readJournalLines(path)
  if (lines.some((l) => l.evenement === 'retrait')) return { kind: 'retire' }
  const first = lines.findIndex((l) => l.evenement === 'demarrage')
  if (first < 0) {
    // Lines of a bot's life without the line that defines it: not a bot that never started, a damaged journal.
    const lived = lines.findIndex((l) => typeof l.evenement === 'string' && BOT_LINES.has(l.evenement))
    if (lived >= 0) throw new Error(`the journal does not start with a demarrage line (line ${lived + 1} is "${String(lines[lived].evenement)}"): the bot's definition is lost`)
    return { kind: 'jamais_demarre' }
  }
  const d = lines[first]
  const at = (i: number): number => i + 1
  if (d.joueur === SCRIPT_ID) throw new Error("a script bot: its state (each sub-account's paper account and position, the script's registers) is kept in etat.json only, its journal does not rebuild it (its journal names every decision, order and fill with the sub-account, for the author to read)")
  // The definition: what `demarrage` writes, in the shape of a `bots.json` line; `debut` is the instant of the start.
  const spec: BotSpec = {
    id,
    marche: d.marche as string,
    joueur: d.joueur as string,
    reglages: d.reglages as Record<string, number>,
    ...(typeof d.seuilBas === 'number' ? { seuilBas: d.seuilBas } : {}),
    ...(typeof d.seuilHaut === 'number' ? { seuilHaut: d.seuilHaut } : {}),
    regle: (d.regle ?? null) as string | null,
    ...(typeof d.compose === 'object' && d.compose !== null ? { compose: d.compose as BotCompose } : {}),
    stop: (d.stop ?? null) as number | null,
    ...(typeof d.trail === 'boolean' ? { trail: d.trail, trailSeuil: typeof d.trailSeuil === 'number' ? d.trailSeuil : 0, trailDistance: typeof d.trailDistance === 'number' ? d.trailDistance : 0 } : {}),
    ...(typeof d.pertesDeSuite === 'number' ? { pertesDeSuite: d.pertesDeSuite } : {}),
    ...(typeof d.perteMise === 'number' ? { perteMise: d.perteMise } : {}),
    ...(typeof d.tempsMort === 'number' ? { tempsMort: d.tempsMort } : {}),
    ...(typeof d.coteInterdit === 'number' ? { coteInterdit: d.coteInterdit } : {}),
    part: d.part as number,
    ...(typeof d.levier === 'number' ? { levier: d.levier } : {}),
    ...(typeof d.startAccount === 'number' ? { startAccount: d.startAccount } : {}),
    ...(typeof d.fixedStake === 'number' ? { fixedStake: d.fixedStake } : {}),
    ...(readAttendu(d.attendu) === null ? {} : { attendu: d.attendu as BotAttendu }),
    ...(typeof d.name === 'string' ? { name: d.name } : {}),
    debut: d.heure as string,
  }
  // A journal renamed by the renumbering of 2026-10-08 keeps the id it was written under in its first line: that is the bot's former id.
  if (typeof d.bot !== 'string') throw new Error(`line ${at(first)} (demarrage) carries no bot`)
  if (d.bot !== id) spec.formerId = d.bot
  const startMs = ms(d.heure, 'heure', at(first))
  const resolved = resolveBot(spec)
  const account0 = num(d.compteDepart, 'compteDepart', at(first))
  const stopPct = resolved.stop
  const trail = resolved.trail

  const bot: BotState = { status: 'actif', held: 0, afterStop: false, prev: 0, trades: 0, wins: 0, losses: 0, account: account0 }
  const ex: ExchangeState = { account: account0, halted: false, pending: [], pos: null, bookPos: null }
  // The guard rules (`playerRules.ts`) rebuilt from the exits, the entries and the resumptions, by the bot's functions: the starting stake is the one of `demarrage`.
  const guard = newGuard(resolved.rules, account0, hasRules(resolved.rules) ? num(d.miseDepart, 'miseDepart', at(first)) : 0, null)
  let paused = false
  let lastLineMs: number | null = null
  let lastLine: string | null = null
  let stoppedAtMs: number | null = null
  let downHorizonMs: number | null = null

  /** The nearest pending order fill (`resolveNext`: the smallest instant, the first on a tie), among the orders. */
  const popOrder = (): void => {
    let k = -1
    for (let i = 0; i < ex.pending.length; i++) if (ex.pending[i].order !== null && (k < 0 || ex.pending[i].at < ex.pending[k].at)) k = i
    if (k >= 0) ex.pending.splice(k, 1)
  }

  for (let i = first + 1; i < lines.length; i++) {
    const l = lines[i]
    const n = at(i)
    const ev = l.evenement
    if (typeof l.heure === 'string') {
      const t = Date.parse(l.heure)
      if (!Number.isNaN(t) && ev !== 'etat_reconstruit') {
        lastLineMs = t
        lastLine = ev as string
      }
    } else if (typeof ev === 'string' && ev !== 'etat_reconstruit') lastLine = ev
    stoppedAtMs = ev === 'arret' && typeof l.heure === 'string' ? Date.parse(l.heure) : null
    switch (ev) {
      case 'flux_perdu':
        // A feed lost during the life (`horizon` written): the horizon is that one until the return; a feed "lost" by the program's stop (`cause`) is closed by the next line.
        downHorizonMs = typeof l.horizon === 'string' ? Date.parse(l.horizon) : null
        break
      case 'flux_revenu':
        downHorizonMs = null
        break
      case 'decision': {
        const side = sideOfName(l.signal, n)
        const sentMs = ms(l.heure, 'heure', n)
        bot.held = side
        ex.pending.push({ at: sentMs + LEAN_SIM_LATENCY_MS, order: { side, stopPct, trail, sentMs, atMs: sentMs + LEAN_SIM_LATENCY_MS, ...(resolved.compose === null || resolved.compose.only === 0 ? {} : { only: resolved.compose.only }) }, stopAt: null })
        break
      }
      case 'entree': {
        const side = sideOfName(l.cote, n)
        const fillMs = ms(l.heure, 'heure', n)
        const px = num(l.prix, 'prix', n)
        bot.afterStop = false
        guardEntry(guard, side)
        popOrder()
        ex.pos = { side, fillMs, stake: num(l.mise, 'mise', n), notional: num(l.notionnel, 'notionnel', n), liquidationPx: num(l.liquidationPrix, 'liquidationPrix', n), stopTouched: false }
        ex.bookPos = { side, tIn: fillMs / 1000, pxIn: px, qty: PLAYER_NOTIONAL / px, stopPx: l.stopPrix === null ? null : num(l.stopPrix, 'stopPrix', n), bar: -1, ...(trail === null ? {} : { trail }) }
        break
      }
      case 'stop_touche': {
        if (ex.pos === null) throw new Error(`line ${n}: a stop is hit without an open position`)
        const exitAt = ms(l.sortieAttendue, 'sortieAttendue', n)
        ex.pos.stopTouched = true
        const replacing = ex.pending.find((p) => p.order !== null)
        if (replacing === undefined) {
          ex.pending.push({ at: exitAt, order: null, stopAt: null })
          bot.held = 0
          bot.afterStop = true
        } else {
          replacing.stopAt = exitAt
          replacing.at = Math.max(replacing.at, exitAt)
        }
        break
      }
      case 'sortie': {
        if (ex.pos === null) throw new Error(`line ${n}: an exit without an open position`)
        bot.trades++
        if (num(l.pnlSur100, 'pnlSur100', n) > 0) bot.wins++
        else bot.losses++
        bot.account = num(l.compte, 'compte', n)
        ex.account = bot.account
        guardTrade(guard, sideOfName(l.cote, n), num(l.pnlSur100, 'pnlSur100', n), l.motif === 'stop' || l.motif === 'trailing', ms(l.heure, 'heure', n))
        guardLoss(guard, bot.account, ms(l.heure, 'heure', n))
        ex.pos = null
        ex.bookPos = null
        // What this exit resolves: a stop exit waited alone (or in the order that replaces it, followed by an `entree` line), an "arret" exit waited like a fill.
        if (l.motif === 'arret') {
          const k = ex.pending.findIndex((p) => p.close === true)
          if (k >= 0) ex.pending.splice(k, 1)
        } else if (l.motif === 'stop' || l.motif === 'trailing') {
          const k = ex.pending.findIndex((p) => p.order === null && p.close !== true)
          if (k >= 0) ex.pending.splice(k, 1)
        }
        break
      }
      case 'liquidation':
        bot.status = 'liquide'
        bot.account = num(l.compte, 'compte', n)
        ex.account = bot.account
        ex.halted = true
        ex.pending = []
        ex.pos = null
        ex.bookPos = null
        break
      case 'funding':
        bot.account = num(l.compte, 'compte', n)
        ex.account = bot.account
        break
      case 'ordre_sans_prix':
      case 'close_order':
        bot.afterStop = false
        popOrder()
        break
      case 'compte_epuise':
        bot.status = 'epuise'
        bot.account = 0
        ex.account = 0
        ex.halted = true
        ex.pending = []
        ex.pos = null
        ex.bookPos = null
        break
      case 'arret_demande': {
        paused = true
        // `cancelOrders`: the pending orders are cancelled, a stop already hit keeps its exit; then `closeAt` if there is a position.
        ex.pending = ex.pending.flatMap((p) => (p.order === null ? [p] : p.stopAt !== null ? [{ at: p.stopAt, order: null, stopAt: null }] : []))
        if (!ex.halted && ex.pos !== null && !ex.pos.stopTouched) ex.pending.push({ at: ms(l.heure, 'heure', n), order: null, stopAt: null, close: true })
        break
      }
      case 'levier_change':
        spec.levier = num(l.nouveau, 'nouveau', n)
        break
      case 'arret_regle':
        // The guard rules' halts are rebuilt from the trades (`guardTrade`, `guardLoss`); a fixed stake above the account is not: its line is the halt, and the order it refused is handled (no `entree`).
        if (l.cause === 'stake') {
          guardStake(guard, num(l.valeur, 'valeur', n), ms(l.heure, 'heure', n))
          bot.afterStop = false
          popOrder()
        }
        break
      case 'reprise':
        paused = false
        bot.held = 0
        bot.afterStop = false
        bot.prev = 0
        resetGuard(guard)
        // A rule halt leaves a position held (`Engine.resume`): the bot knows it holds it.
        if (ex.pos !== null) bot.held = ex.pos.side
        break
      default:
        break
    }
  }
  if (paused) bot.paused = true
  if (hasRules(resolved.rules) || guard.halt !== null) bot.guard = guardState(guard)
  const heureOf = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString())
  const saved: PlayerSaved = { bot, exchange: ex, startMs, ...(typeof d.levier === 'number' ? { levierDepart: d.levier } : {}), rebuilt: { lignes: lines.length, derniereLigne: heureOf(lastLineMs) } }
  return { kind: 'ok', spec, saved, lines: lines.length, lastLineMs, lastLine, stoppedAtMs, downHorizonMs }
}

/**
 * `vu` (the program's horizon, ms) of a market, estimated from its rebuilt bots' journals: the last `arret` line of a clean stop is written at `horizon + wait`; a feed lost at the stop sets the horizon at the loss's;
 * without an `arret` line (the program died) it is the time of the last dated line. Also returns the latest of the journals.
 */
export function lastSeenOf(reads: Extract<JournalRead, { kind: 'ok' }>[], waitMs: number): number | null {
  let best: number | null = null
  for (const r of reads) {
    let v: number | null
    if (r.downHorizonMs !== null) v = r.downHorizonMs
    else if (r.stoppedAtMs !== null) v = r.stoppedAtMs - waitMs
    else v = r.lastLineMs
    if (v !== null && (best === null || v > best)) best = v
  }
  return best
}
