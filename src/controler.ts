/**
 * `control`: compare a live bot's journal with what the page simulates over the same hours. It reads from the data module the candles and the prints of the bot's life (from the launch to the last closed minute),
 * runs the page's replay on them with the bot's settings, and puts the journal and the page side by side, trade by trade. It reads, it changes nothing.
 *
 * The page's replay is the one of `/rsi` (`stopFigures`), in the same functions: the candles (`barsOfMinutes`: a minute without a candle flat), `tapeBuilder` (the band of the prints), `playerLoader` and `playerFlips`
 * (the side conditions), `minuteFills` and `stopPrints`, then `replayStop`. Two inputs are the live run's and not those the page would measure: the spread (`marche.json`, `ecartTicks` / `ecartPct`, measured at the live start by the page's function: if it is not
 * set the fill is at the last print, as the bot's) and the funding, which the bot journals apart (`funding`): the replay has no funding, its PnLs are compared with the journal's `pnlSur100`, which has none either.
 *
 * The first difference is told with its cause when the journal gives one: a cut of the feed, a late print, a minute closed by the clock without a print, a liquidation. Otherwise: not named.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { botBits } from './core/botFlips'
import { tapeBuilder } from './core/hedgeSim'
import { LEAN_SIM_LATENCY_MS } from './core/leanSim'
import { minuteFills } from './core/playerSearch'
import { playerFlips, playerLoader } from './core/players'
import { hasRules, newGuard } from './core/playerRules'
import { replayStop, stopPrints } from './core/playerStop'
import type { StopTrade } from './core/playerStop'
import { SCRIPT_ID } from './core/radinusMessages'
import type { BotCompose } from './core/radinusMessages'
import type { BotSpec, ResolvedPlayer } from './bots'
import { botPolicy, resolveBot } from './bots'
import type { DirectMarketFile } from './direct'
import type { LiveLoaders } from './sources/types'
import { barsOfMinutes } from './market'

type Line = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN)
const ms = (v: unknown): number => Date.parse(str(v))

export function readJournalLines(path: string): Line[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line)
}

/** A closed trade of the journal (a `sortie` line), in the page's units (time in s). */
export type JournalTrade = { side: 1 | -1; tIn: number; pxIn: number; tOut: number; pxOut: number; pnl: number; stopped: boolean }

export type Difference = { index: number; field: string; journal: string; page: string; atMs: number; cause: string | null }
export type ControlResult = {
  bot: string
  fromMs: number
  toMs: number
  prints: number
  journalTrades: number
  pageTrades: number
  identical: number
  openAtEnd: boolean
  openMatches: boolean | null
  liquidated: boolean
  differences: Difference[]
  lines: string[]
}

const sameNum = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

/** The journal's closed trades, and the entry still open at the end if there is one. */
export function journalTrades(lines: Line[]): { trades: JournalTrade[]; open: { tIn: number; pxIn: number; side: 1 | -1 } | null; liquidated: Line | null } {
  const trades: JournalTrade[] = []
  let open: { tIn: number; pxIn: number; side: 1 | -1 } | null = null
  let liquidated: Line | null = null
  for (const l of lines) {
    if (l.evenement === 'entree') open = { tIn: ms(l.heure) / 1000, pxIn: num(l.prix), side: l.cote === 'long' ? 1 : -1 }
    else if (l.evenement === 'sortie') {
      trades.push({ side: l.cote === 'long' ? 1 : -1, tIn: ms(l.entreeHeure) / 1000, pxIn: num(l.entreePrix), tOut: ms(l.heure) / 1000, pxOut: num(l.prix), pnl: num(l.pnlSur100), stopped: l.motif === 'stop' || l.motif === 'trailing' })
      open = null
    } else if (l.evenement === 'liquidation') {
      liquidated = l
      open = null
    }
  }
  return { trades, open, liquidated }
}

/** What the journal knows of an instant: a cut of the feed, a late print, a minute closed by the clock, a liquidation. */
export function causeAt(lines: Line[], atMs: number): string | null {
  const causes: string[] = []
  let lostFrom: number | null = null
  for (const l of lines) {
    if (l.evenement === 'flux_perdu') lostFrom = ms(l.horizon ?? l.heure)
    else if (l.evenement === 'flux_revenu' && lostFrom !== null) {
      const to = ms(l.heure)
      if (atMs >= lostFrom - 60000 && atMs <= to + 60000) causes.push(`cut of the feed (from ${new Date(lostFrom).toISOString()} to ${str(l.heure)})`)
      lostFrom = null
    } else if (l.evenement === 'print_en_retard' && Math.abs(ms(l.heure) - atMs) <= 120000) causes.push(`late print (id ${String(l.id)}, dated ${str(l.heure)}, arrived ${str(l.arrivee)}, ${String(l.retardMs)} ms)`)
    else if (l.evenement === 'minutes_sans_donnee' && atMs >= ms(l.depuis) - 60000 && atMs <= ms(l.jusqua) + 60000) causes.push(`minute(s) closed by the clock without a print (${str(l.depuis)} to ${str(l.jusqua)})`)
    else if (l.evenement === 'liquidation' && Math.abs(ms(l.heure) - atMs) <= 120000) causes.push(`liquidation at ${str(l.heure)} (the page does not have this rule)`)
  }
  return causes.length === 0 ? null : causes.join(' ; ')
}

/** The journal against the page, trade by trade; the first gap of each trade is noted. */
export function compareTrades(lines: Line[], j: ReturnType<typeof journalTrades>, page: StopTrade[], lastT: number): { rows: string[]; identical: number; differences: Difference[]; openMatches: boolean | null; pageTrades: number } {
  const rows: string[] = []
  const differences: Difference[] = []
  // The page's last trade, closed "at the end of the prints" by `bookClose`, is the bot's position still open.
  let closed = page
  let finalOpen: StopTrade | null = null
  const last = page[page.length - 1]
  if (last !== undefined && !last.stopped && Math.round(last.tOut * 1000) === lastT && page.length > j.trades.length) {
    finalOpen = last
    closed = page.slice(0, -1)
  }
  const n = Math.max(closed.length, j.trades.length)
  let identical = 0
  const iso = (s: number) => new Date(Math.round(s * 1000)).toISOString().slice(11, 23)
  for (let i = 0; i < n; i++) {
    const a = j.trades[i]
    const b = closed[i]
    if (a === undefined || b === undefined) {
      const atMs = Math.round((a ?? (b as StopTrade)).tIn * 1000)
      const d: Difference = { index: i, field: a === undefined ? 'trade missing from the journal' : 'trade missing from the page', journal: a === undefined ? '-' : `${iso(a.tIn)} -> ${iso(a.tOut)}`, page: b === undefined ? '-' : `${iso(b.tIn)} -> ${iso(b.tOut)}`, atMs, cause: causeAt(lines, atMs) }
      differences.push(d)
      rows.push(`${String(i + 1).padStart(3)}  ${d.field}  journal ${d.journal}  page ${d.page}`)
      continue
    }
    const bad: [string, string, string, number][] = []
    if (a.side !== b.side) bad.push(['side', String(a.side), String(b.side), a.tIn * 1000])
    if (Math.round(a.tIn * 1000) !== Math.round(b.tIn * 1000)) bad.push(['entry time', iso(a.tIn), iso(b.tIn), Math.min(a.tIn, b.tIn) * 1000])
    if (!sameNum(a.pxIn, b.pxIn)) bad.push(['entry price', String(a.pxIn), String(b.pxIn), a.tIn * 1000])
    if (Math.round(a.tOut * 1000) !== Math.round(b.tOut * 1000)) bad.push(['exit time', iso(a.tOut), iso(b.tOut), Math.min(a.tOut, b.tOut) * 1000])
    if (!sameNum(a.pxOut, b.pxOut)) bad.push(['exit price', String(a.pxOut), String(b.pxOut), a.tOut * 1000])
    if (a.stopped !== b.stopped) bad.push(['exit by the stop', String(a.stopped), String(b.stopped), a.tOut * 1000])
    if (!sameNum(a.pnl, b.pnl)) bad.push(['PnL per 100 $', String(a.pnl), String(b.pnl), a.tOut * 1000])
    const head = `${String(i + 1).padStart(3)}  ${a.side === 1 ? 'long ' : 'short'}  ${iso(a.tIn)} -> ${iso(a.tOut)}  ${a.pxIn} -> ${a.pxOut}  ${a.stopped ? 'stop ' : 'signal'}  PnL/100$ ${a.pnl.toFixed(6)} / ${b.pnl.toFixed(6)}`
    if (bad.length === 0) {
      identical++
      rows.push(`${head}  identique`)
    } else {
      // The page's replay does not fill an order due after its last print: it closes the position at that print (`replayStop`). The bot fills at the last print before: it is the end of the control's data, not a difference of decision.
      const endOfData = Math.round(b.tOut * 1000) === lastT && !b.stopped && a.tOut * 1000 > lastT
      for (const [field, jv, pv, at] of bad) differences.push({ index: i, field, journal: jv, page: pv, atMs: Math.round(at), cause: endOfData && (field === 'exit time' || field === 'exit price' || field === 'PnL per 100 $') ? `end of the control's prints: the page has no print after ${iso(b.tOut)}, it closes the position at its last print instead of filling the order due at ${iso(a.tOut)} (the bot filled it at the last print before)` : causeAt(lines, Math.round(at)) })
      rows.push(`${head}  DIFFERENT : ${bad.map(([f, jv, pv]) => `${f} journal ${jv} / page ${pv}`).join(' ; ')}`)
    }
  }
  let openMatches: boolean | null = null
  if (j.open !== null || finalOpen !== null) {
    if (j.open === null || finalOpen === null) {
      const atMs = Math.round(((j.open ?? (finalOpen as StopTrade)).tIn) * 1000)
      differences.push({ index: n, field: 'position open at the end', journal: j.open === null ? 'none' : `${iso(j.open.tIn)} at ${j.open.pxIn}`, page: finalOpen === null ? 'none' : `${iso(finalOpen.tIn)} at ${finalOpen.pxIn}`, atMs, cause: causeAt(lines, atMs) })
      openMatches = false
    } else {
      openMatches = j.open.side === finalOpen.side && Math.round(j.open.tIn * 1000) === Math.round(finalOpen.tIn * 1000) && sameNum(j.open.pxIn, finalOpen.pxIn)
      rows.push(`      position open at the end: journal ${iso(j.open.tIn)} at ${j.open.pxIn}, page ${iso(finalOpen.tIn)} at ${finalOpen.pxIn}: ${openMatches ? 'identical' : 'DIFFERENT'}`)
      if (!openMatches) differences.push({ index: n, field: 'position open at the end', journal: `${iso(j.open.tIn)} at ${j.open.pxIn}`, page: `${iso(finalOpen.tIn)} at ${finalOpen.pxIn}`, atMs: Math.round(j.open.tIn * 1000), cause: causeAt(lines, Math.round(j.open.tIn * 1000)) })
    }
  }
  return { rows, identical, differences, openMatches, pageTrades: closed.length }
}

export async function controler(o: { sortie: string; bot: string; loaders: LiveLoaders; say: (line: string) => void }): Promise<ControlResult> {
  const journalPath = join(o.sortie, 'journaux', `${o.bot}.jsonl`)
  const marchePath = join(o.sortie, 'marche.json')
  if (!existsSync(journalPath)) throw new Error(`${journalPath}: no journal for bot "${o.bot}"`)
  if (!existsSync(marchePath)) throw new Error(`${marchePath}: no marche.json, this is not a live folder`)
  const lines = readJournalLines(journalPath)
  const start = lines.find((l) => l.evenement === 'demarrage')
  if (start === undefined) throw new Error(`${journalPath}: no "demarrage" line, the bot has not started`)
  if (start.joueur === SCRIPT_ID) throw new Error(`${o.bot} is a script bot: controler compares a player's bot to /rsi's replay; a script bot's check is a replay of recorded prints against the page's replay`)
  const marche = (JSON.parse(readFileSync(marchePath, 'utf8')) as DirectMarketFile).marches[str(start.marche)]
  if (marche === undefined) throw new Error(`marche.json does not know market "${str(start.marche)}"`)

  // The bot's settings, as its journal wrote them at start.
  const spec: BotSpec = { id: o.bot, marche: str(start.marche), joueur: str(start.joueur), reglages: start.reglages as Record<string, number>, regle: start.regle === null ? null : str(start.regle), stop: start.stop === null ? null : num(start.stop), part: num(start.part), debut: str(start.heure) }
  if (typeof start.levier === 'number') spec.levier = start.levier
  if (typeof start.startAccount === 'number') spec.startAccount = start.startAccount
  if (typeof start.fixedStake === 'number') spec.fixedStake = start.fixedStake
  if (typeof start.trail === 'boolean') {
    spec.trail = start.trail
    spec.trailSeuil = typeof start.trailSeuil === 'number' ? start.trailSeuil : 0
    spec.trailDistance = typeof start.trailDistance === 'number' ? start.trailDistance : 0
  }
  if (typeof start.pertesDeSuite === 'number') spec.pertesDeSuite = start.pertesDeSuite
  if (typeof start.perteMise === 'number') spec.perteMise = start.perteMise
  if (typeof start.tempsMort === 'number') spec.tempsMort = start.tempsMort
  if (typeof start.coteInterdit === 'number') spec.coteInterdit = start.coteInterdit
  if (typeof start.compose === 'object' && start.compose !== null) spec.compose = start.compose as BotCompose
  if (typeof start.seuilBas === 'number') spec.seuilBas = start.seuilBas
  if (typeof start.seuilHaut === 'number') spec.seuilHaut = start.seuilHaut
  const r = resolveBot(spec)

  // The bot's life: from the launch to the last minute closed before the journal's last line.
  const fromMs = ms(start.heure)
  const lastLine = lines.filter((l) => typeof l.heure === 'string').reduce((m, l) => Math.max(m, ms(l.heure)), fromMs)
  const toMs = Math.floor(lastLine / 60000) * 60000
  if (toMs <= fromMs + 60000) throw new Error(`the bot lived less than a minute (${new Date(fromMs).toISOString()} to ${new Date(lastLine).toISOString()}): nothing to compare`)
  o.say(`control of ${o.bot} (${r.def.id} on ${spec.marche}): from ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}`)

  const minutes = await o.loaders.minutes(marche.id, fromMs / 1000 - 86400)
  // The prints go a little beyond the last closed minute: the decision of its close fills 300 ms later.
  const printsEnd = lastLine + 1000
  const read = await o.loaders.ticks(marche.id, fromMs, printsEnd)
  if (read.synthetic) throw new Error("this source has no prints history (one print per minute rebuilt from candles), and the control replays the bot's real prints: run it with a source that keeps them")
  if (minutes.bars.length === 0) throw new Error('the data module gives no candle for these hours')
  if (read.failed) o.say('WARNING: a page of prints did not come back, the comparison is made on what came')
  const prints = read.ticks.filter((p) => p.t >= fromMs && p.t < printsEnd).sort((a, b) => a.t - b.t || a.id - b.id)
  if (prints.length === 0) throw new Error('the data module gives no print for these hours')
  const bars = barsOfMinutes(minutes.bars, toMs / 1000 - 60)

  // The page's replay.
  const tape = tapeBuilder()(prints, 10 ** -marche.decimales)
  const spread = marche.ecartTicks === null ? { spreadTicks: 1, spreadPct: null } : { spreadTicks: marche.ecartTicks, spreadPct: marche.ecartPct }
  const pageTape = { ...tape, ...spread }
  const firstPrintT = Math.floor(prints[0].t / 60000) * 60
  // A composed bot: each member's raw conditions, joined by the links with `botBits`, as the page's bot row does.
  const rawOf = (p: ResolvedPlayer): Uint8Array => {
    const series = playerLoader(p.def, p.settings)(bars, bars.map(() => 0))
    const one = new Uint8Array(bars.length)
    playerFlips(bars, series, p.def, p.rule, p.low, p.high, p.settings, firstPrintT, one)
    return one
  }
  const raw = r.compose === null ? rawOf(r) : botBits(r.compose.members.map(rawOf), r.compose.links)
  // The bot starts out and does not see the closes before its launch (the page does move the held side on them: its "taking up"): these conditions are zeroed.
  for (let i = 0; i < bars.length; i++) if ((bars[i].t + 60) * 1000 <= fromMs) raw[i] = 0
  const page: StopTrade[] = []
  // The bot's guard rules, by the page's replay: the starting stake and the leverage are those the bot wrote at start.
  const guard = hasRules(r.rules) ? newGuard(r.rules, num(start.compteDepart), num(start.miseDepart), botPolicy(r, num(start.levier))) : null
  replayStop(raw, firstPrintT, minuteFills(pageTape, bars, LEAN_SIM_LATENCY_MS), stopPrints(pageTape, bars), r.stop ?? Infinity, null, page, r.trail, guard, r.compose === null ? 0 : r.compose.only)

  const j = journalTrades(lines)
  const lastT = prints[prints.length - 1].t
  const c = compareTrades(lines, j, page, lastT)
  const out = [...c.rows]
  const fundings = lines.filter((l) => l.evenement === 'funding')
  const fundingMissing = lines.filter((l) => l.evenement === 'funding_manquant').length
  out.push('')
  out.push(`${j.trades.length} closed trade(s) in the journal, ${c.pageTrades} on the page (${prints.length} prints, ${bars.length} candles), ${c.identical} identical`)
  if (j.liquidated !== null) out.push(`the bot was liquidated (${str(j.liquidated.heure)}): the page does not have this rule`)
  if (fundings.length > 0 || fundingMissing > 0) out.push(`funding in the journal: ${fundings.length} hour(s) paid or received, ${fundingMissing} missing; the page's replay has no funding`)
  out.push(`fill spread: ${marche.ecartTicks === null ? 'not set (fill at the last print)' : `${marche.ecartTicks} ticks`}, the one of marche.json (measured at the live start by the page's function on the data module's last prints, or written by hand)`)
  if (c.differences.length === 0) out.push("NO DIFFERENCE: the bot's journal is what the page simulates over these hours")
  else {
    const d = c.differences[0]
    out.push(`${c.differences.length} difference(s). The first: trade ${d.index + 1}, ${d.field} (journal ${d.journal}, page ${d.page}) near ${new Date(d.atMs).toISOString()}`)
    out.push(`  cause: ${d.cause ?? "not named: the journal has no cut, no late print, no minute without a print and no liquidation near this instant"}`)
  }
  for (const l of out) o.say(l)
  return { bot: o.bot, fromMs, toMs, prints: prints.length, journalTrades: j.trades.length, pageTrades: c.pageTrades, identical: c.identical, openAtEnd: j.open !== null, openMatches: c.openMatches, liquidated: j.liquidated !== null, differences: c.differences, lines: out }
}
