/**
 * `live`: the bots play live, on paper, on a data module (src/sources/) and the PC's clock. This file assembles: the list of bots, the markets (their number and margins, read from Lighter), one engine and one live
 * source (`LiveFeed`) per market, one journal per bot (appended to), the state (`etat.json`, rewritten at every event and every minute) and the console. No order, no key: the data module's hosts and nothing else.
 *
 * The output folder: `marche.json` (the wait, the clock's and the spread read's settings, the markets with their spread measured at start; the settings are edited by hand), `journaux/<bot>.jsonl`, `programme.jsonl` (the program's life), `etat.json` (what a restart takes up).
 * A folder that already has an `etat.json` is a restart: every bot taken up finds its account, its position and its stop again, and the time in between is treated as a cut (live.ts). A folder owns ALL its bots (their definitions are in the folder's `bots.json`, written only when the list changes; `etat.json` holds only the state): `--bots` adds only the unknown ids. A bot of which only the journal is left is rebuilt from that journal (`rebuild.ts`), or the program stops with a sentence, having written nothing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leverageOf } from './core/playerSearch'
import { RADINUS_PORT, consoleLine, parseJson } from './core/radinusMessages'
import type { BotDefinition, BotView, ProgramView } from './core/radinusMessages'
import { botIdOf, checkBot, idMarket, leverageProblem, notLiveReason, parseBotId, resolveBots } from './bots'
import type { BotSpec, ResolvedBot } from './bots'
import type { RawClock } from './clock'
import { Engine } from './engine'
import type { BotSaved, BotSummary, EngineSaved } from './engine'
import { Journal } from './journal'
import { startServer } from './server'
import type { Control, ServerHandle } from './server'
import { LiveFeed } from './live'
import type { LiveLoaders } from './sources/types'
import type { MarketConfig } from './market'
import { lastSeenOf, rebuildFromJournal } from './rebuild'
import type { JournalRead } from './rebuild'
import { planRenumbering, startOfJournal } from './renumber'
import type { RenumberItem, RenumberStep } from './renumber'
import { spreadOfPrints } from './core/hedgeSim'
import { CLOCK_DEFAULTS, PrintClock } from './printClock'
import type { ClockSettings } from './printClock'

/** The default wait after the end of a minute before closing it (ms): under the fill rule's 300 ms, so a paper fill is the one the page simulates. */
export const WAIT_DEFAULT_MS = 200
/** The prints read at start, per market, to measure the spread as the page does (one read of the data module's last prints; it may give fewer: Lighter gives 100 at most). */
export const SPREAD_READ_PRINTS_DEFAULT = 20000
/**
 * The origins the page server accepts by default: Vite's dev server and preview on this machine (Vite's default ports, 5173 and 4173), under both of the machine's names. Anything else is added with
 * `--origins a,b` (or `RADINUS_ORIGINS`). The list is written in `marche.json` (`serveur.origines`) and can be edited by hand; a restart reads it again.
 */
export const SERVER_ORIGINS_DEFAULT = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173']

/**
 * `live`'s `marche.json`: what is edited by hand (`attenteMs`, `horloge`: the four settings of the clock set on the prints, `printClock.ts`; `ecartLecturePrints`; a market's `ecartTicks` / `ecartPct`) and what the program reads again from Lighter at every start.
 * A market's spread is MEASURED at start on the last `ecartLecturePrints` prints of the data module (one read per market) with the page's function, and written here; `ecartLecturePrints: 0` = no read, the file's spread is the one written in it
 * (`null` = not measured: fill at the last print). A restart never measures again: the file's spread is the one of the bots' life.
 */
export type DirectMarketFile = {
  genre: 'direct'
  attenteMs: number
  /** Funding on the paper account (yes by default): `false` = no hour mark, no read of `/fundings`. */
  financement: boolean
  horloge: ClockSettings
  ecartLecturePrints: number
  /** The page server, `port` (0 = no server) and the visible list of accepted `origines`. Absent from a folder that never had a server: `--port 0` leaves `marche.json` as it was. */
  serveur?: { port: number; origines: string[] }
  marches: Record<string, { id: number; decimales: number; margeInitiale: number; margeMaintien: number; fraisLiquidation: number; ecartTicks: number | null; ecartPct: number | null }>
}

/**
 * `etat.json`: what a restart finds again. `marches[name].ouverte` = the minute the program held open (s), `vu` = the horizon (ms). A FOLDER OWNS ALL ITS BOTS (fixed 2026-10-05): every bot's definition, wherever it came from
 * (`--bots`, the page), is in the folder, and a restart takes them all up with their state, with or without `--bots`; `--bots` adds only the ids the folder does not know. */
export type DirectState = {
  version: 1
  ecrit: string
  marches: Record<string, { ouverte: number | null; vu: number }>
  bots: EngineSaved['bots']
  /** Only in a state from before the split (2026-10-06): the retired bots. Read for the conversion to `bots.json`, never written. */
  retires?: string[]
  /** Same: the bots' definitions. Read for the conversion, never written. */
  definitions?: BotSpec[]
  /** Same, before the 2026-10-05 fix: only the bots launched from the page. */
  lances?: BotSpec[]
}

/** The family folder's `bots.json`: who its bots are (their definitions, retired ones excluded) and the retired ids. Written only when the list changes. It is NOT the starting `--bots`, which lives outside the folder and is never written. */
export type FamilyList = {
  bots: BotSpec[]
  /** The next number a launch takes (ids are `<number>-<MARKET>`, bots.ts `botIdOf`): it only grows, a removal never lowers it, so a number is never given twice. Absent = a family not renumbered yet (2026-10-08). */
  nextNumber?: number
  retires?: string[]
  /** The ids the retired bots had before the renumbering (or before a `--bots` entry got a number): `--bots` does not bring them back. */
  retiredFormerIds?: string[]
}

/** The folder does not let a bot be rebuilt: the stop's sentence (nothing was written). */
const cannotRebuild = (id: string, why: string): Error => new Error(`the journal of bot "${id}" exists, but etat.json does not hold this bot and its journal cannot rebuild it: ${why}. The program stops without writing anything in the folder: fix or set aside journaux/${id}.jsonl, then start again.`)

export type DirectOptions = {
  sortie: string
  /** The starting list (`--bots`), read once, never rewritten. Absent: no bot at start, no market followed, no outside call; the bots come from the page (`lancer`). */
  bots?: BotSpec[]
  /** The PC's clock (`RawClock`): the program derives its own from it, set on the prints. */
  clock: RawClock
  loaders: LiveLoaders
  say: (line: string) => void
  /** The wait given on the command line, which replaces the one of `marche.json`. */
  waitMs?: number
  /** The page server's port (`--port`), which replaces the one of `marche.json`; 0 = no server. Default: `marche.json`, then 4664. */
  port?: number
  /** Origins the page server accepts besides those of `marche.json` (or the localhost defaults): `--origins`, `RADINUS_ORIGINS`. Added to the file's list. */
  origins?: string[]
  /** A page's send queue beyond which it is cut (bytes); the server's default otherwise. */
  maxBufferBytes?: number
  /** The outside calls made so far, counted by what sends them (the guarded fetch): given in the summary at the stop. */
  calls?: () => string
}

export type DirectRun = {
  /** Stops cleanly: the positions stay open in the state; each bot's summary. */
  stop: () => BotSummary[]
  /** Each market: its engine, its source. */
  markets: { name: string; engine: Engine; feed: LiveFeed }[]
  waitMs: number
  /** The program's clock (`PrintClock`): its estimate is read here. */
  clock: PrintClock
  /** The page server, `null` without a server (`--port 0`, or a port taken). */
  server: ServerHandle | null
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** The last spread `programme.jsonl` gives for market `name` (`ecart_mesure`, `ecart_garde`), `null` if it gives none. Read once, at start, before the program writes in it. */
function lastSpreadOfProgram(path: string, name: string): { ticks: number; pct: number } | null {
  if (!existsSync(path)) return null
  let out: { ticks: number; pct: number } | null = null
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const l = raw.length === 0 ? undefined : parseJson(raw)
    if (typeof l !== 'object' || l === null) continue
    const e = l as Record<string, unknown>
    if ((e.evenement === 'ecart_mesure' || e.evenement === 'ecart_garde') && e.marche === name && typeof e.ecartTicks === 'number') out = { ticks: e.ecartTicks, pct: typeof e.ecartPct === 'number' ? e.ecartPct : 0 }
  }
  return out
}

export async function startDirect(o: DirectOptions): Promise<DirectRun> {
  const { sortie, say } = o
  const initial = o.bots ?? []
  // A restart's state, read first: the bots retired from the page (`retirer`) do not come back from it. NOTHING is written until everything below (the folder's bots, their journals) is read and accepted.
  const statePath = join(sortie, 'etat.json')
  let saved: DirectState | null = null
  if (existsSync(statePath)) {
    const parsed = parseJson(readFileSync(statePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${statePath} is not readable (not JSON): the program stops without writing anything`)
    saved = parsed as DirectState
  }
  // The family's list, read before the state: the folder's `bots.json` (who the bots are, and the retired ones). Without it, a state from before the split (`definitions`, or the older `lances`, and `retires`) is the list: it is converted below, at the first start.
  const listPath = join(sortie, 'bots.json')
  let list: FamilyList | null = null
  if (existsSync(listPath)) {
    const parsed = parseJson(readFileSync(listPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Array.isArray((parsed as FamilyList).bots) || ((parsed as FamilyList).retires !== undefined && !Array.isArray((parsed as FamilyList).retires)) || ((parsed as FamilyList).nextNumber !== undefined && !Number.isInteger((parsed as FamilyList).nextNumber)) || ((parsed as FamilyList).retiredFormerIds !== undefined && !Array.isArray((parsed as FamilyList).retiredFormerIds))) throw new Error(`${listPath} is not readable (expected { "bots": [ ... ], "nextNumber": 12, "retires": [ ... ] }): the program stops without writing anything`)
    list = parsed as FamilyList
  }
  const legacyDefinitions = saved?.definitions ?? saved?.lances
  const converting = list === null && saved !== null && (legacyDefinitions !== undefined || saved.retires !== undefined)
  const retired = new Set<string>(list !== null ? list.retires ?? [] : converting ? saved?.retires ?? [] : [])
  /** The instant of each `retirer` request whose bot has not left the list yet: it is what `bot_retire` writes. */
  const removalAsked = new Map<string, string>()
  // The bots the folder knows: the family's list (`bots.json`, or at the conversion the old state's `definitions`), then those whose state is held without a definition (an older state), then those of which only a journal is left.
  const specs: BotSpec[] = (list !== null ? list.bots : converting ? legacyDefinitions ?? [] : []).filter((b) => !retired.has(b.id))
  const journalsDir = join(sortie, 'journaux')
  const journalPathOf = (id: string): string => join(journalsDir, `${id}.jsonl`)
  const journalIds = existsSync(journalsDir) ? readdirSync(journalsDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).sort() : []
  const holds = (id: string): boolean => saved?.bots[id] !== undefined
  const rebuilt = new Map<string, Extract<JournalRead, { kind: 'ok' }>>()
  /** What the program says at start about the journals it found. */
  const startNotes: string[] = []
  for (const id of journalIds) {
    if (retired.has(id)) continue
    if (holds(id) && specs.some((b) => b.id === id)) continue
    const r = rebuildFromJournal(id, journalPathOf(id))
    if (r.kind === 'impossible') {
      // A bot whose state is held does not need its journal to be taken up: only its missing definition would make it impossible (below).
      if (holds(id)) continue
      throw cannotRebuild(id, r.raison)
    }
    if (r.kind === 'retire') {
      retired.add(id)
      startNotes.push(`bot "${id}": retired from the page (removal line in its journal), not started again`)
      continue
    }
    if (r.kind === 'jamais_demarre') {
      // A journal without a life (empty, or market notes only): nothing to take up; said when the folder does not know a definition for this bot either.
      if (!specs.some((b) => b.id === id) && !initial.some((b) => b.id === id)) startNotes.push(`bot "${id}": its journal is empty (it never started) and the folder does not have its definition: nothing to take up, it is not started again`)
      continue
    }
    if (!specs.some((b) => b.id === id)) specs.push(r.spec)
    if (!holds(id)) rebuilt.set(id, r)
  }
  for (let i = specs.length - 1; i >= 0; i--) if (retired.has(specs[i].id)) specs.splice(i, 1)
  // The bots whose state is held but whose definition is missing (an older state): the journal's, read above, else the one of `--bots`.
  for (const id of Object.keys(saved?.bots ?? {})) {
    if (retired.has(id) || specs.some((b) => b.id === id)) continue
    const given = initial.find((b) => b.id === id)
    if (given === undefined) throw cannotRebuild(id, 'the state is held but neither etat.json, nor --bots, nor its journal gives its definition')
    specs.push(given)
  }
  // The id rule (2026-10-08): `<number>-<MARKET>`, the number from the family's counter. A family without `nextNumber` in its `bots.json` is renumbered here, once: every bot, active and retired, in the order it was launched. Planned in memory now; the files move below, once everything is accepted.
  let nextNumber = list?.nextNumber ?? 1
  const retiredFormer = new Set<string>(list?.retiredFormerIds ?? [])
  let renumbering: RenumberStep[] | null = null
  if (list?.nextNumber === undefined && (specs.length > 0 || retired.size > 0)) {
    const items: RenumberItem[] = [
      ...specs.map((b) => ({ id: b.id, market: b.marche, debutMs: Number.isNaN(Date.parse(b.debut)) ? 0 : Date.parse(b.debut) })),
      ...[...retired].filter((id) => !specs.some((b) => b.id === id)).map((id) => {
        const start = startOfJournal(journalPathOf(id))
        return { id, market: start?.market ?? id.split('-')[0].toUpperCase(), debutMs: start?.debutMs ?? 0 }
      }),
    ]
    const plan = planRenumbering(items)
    const oldIds = new Set(items.map((i) => i.id))
    for (const step of plan.steps) if (step.to !== step.from && (oldIds.has(step.to) || existsSync(journalPathOf(step.to)))) throw new Error(`renumbering: the new id "${step.to}" (for "${step.from}") is already taken by a bot or a journal of the folder: the program stops without writing anything`)
    const toNew = new Map(plan.steps.map((st) => [st.from, st.to]))
    const renamed = (id: string): string => toNew.get(id) ?? id
    for (const b of specs) {
      b.formerId = b.id
      b.id = renamed(b.id)
    }
    const retiredBefore = [...retired]
    retired.clear()
    for (const id of retiredBefore) {
      retired.add(renamed(id))
      retiredFormer.add(id)
    }
    if (saved !== null) saved.bots = Object.fromEntries(Object.entries(saved.bots).map(([id, b]) => [renamed(id), b]))
    const rebuiltBefore = [...rebuilt]
    rebuilt.clear()
    for (const [id, r] of rebuiltBefore) rebuilt.set(renamed(id), r)
    nextNumber = plan.nextNumber
    renumbering = plan.steps
    startNotes.push(`renumbering: ${plan.steps.length} bot(s) numbered in launch order (${plan.steps.map((st) => `${st.from} -> ${st.to}`).join(', ')}); the next number is ${nextNumber}`)
  }
  // `--bots` only adds what the folder does not know: an id known (alive, or under the id it had before), retired or whose journal has started is neither replaced nor reset. A new bot keeps its id only if it is `<number>-<MARKET>` with a free number; otherwise it takes the next number and its old id is kept as `formerId`, so the next start knows it.
  const usedNumbers = new Set<number>()
  for (const id of [...specs.map((b) => b.id), ...retired]) {
    const parsed = parseBotId(id)
    if (parsed !== null) usedNumbers.add(parsed.n)
  }
  const retiredHit = (id: string): boolean => retired.has(id) || retiredFormer.has(id)
  const added: BotSpec[] = []
  const ignored: BotSpec[] = []
  for (const b of initial) {
    const given = typeof b.id === 'string' ? b.id : null
    if (given !== null && retiredHit(given)) continue
    if (given !== null && [...specs, ...added].some((k) => k.id === given || k.formerId === given)) {
      ignored.push(b)
      continue
    }
    const parsed = given === null ? null : parseBotId(given)
    if (typeof b.marche !== 'string') {
      added.push(b)
      continue
    }
    if (parsed !== null && parsed.market === idMarket(b.marche) && !usedNumbers.has(parsed.n)) {
      usedNumbers.add(parsed.n)
      nextNumber = Math.max(nextNumber, parsed.n + 1)
      added.push(b)
      continue
    }
    while (usedNumbers.has(nextNumber)) nextNumber++
    usedNumbers.add(nextNumber)
    const id = botIdOf(nextNumber++, b.marche)
    startNotes.push(`--bots: ${given === null ? 'a bot without id' : `"${given}" is not <number>-<MARKET> with a free number`}: it takes the next number, ${id}`)
    added.push({ ...b, id, ...(given === null ? {} : { formerId: given }) })
  }
  specs.push(...added)
  const resolved = resolveBots(specs)
  for (const r of resolved) {
    const why = notLiveReason(r)
    if (why !== null) throw new Error(why)
  }
  const names = [...new Set(resolved.map((r) => r.spec.marche))]
  /** A folder that has already lived: a state, or at least one bot rebuilt from its journal. */
  const isRestart = saved !== null || rebuilt.size > 0

  // The market file: the wait, the clock's settings and the spread read's are kept (they are edited by hand).
  const marchePath = join(sortie, 'marche.json')
  const previous: DirectMarketFile | null = existsSync(marchePath) ? (JSON.parse(readFileSync(marchePath, 'utf8')) as DirectMarketFile) : null
  const programPath = join(sortie, 'programme.jsonl')
  const waitMs = o.waitMs ?? previous?.attenteMs ?? WAIT_DEFAULT_MS
  const funding = previous?.financement ?? true
  const clockSettings: ClockSettings = { ...CLOCK_DEFAULTS, ...previous?.horloge }
  const readPrints = previous?.ecartLecturePrints ?? SPREAD_READ_PRINTS_DEFAULT
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`the wait must be a positive number of milliseconds (got ${String(waitMs)})`)
  if (!Number.isInteger(readPrints) || readPrints < 0 || readPrints > SPREAD_READ_PRINTS_DEFAULT) throw new Error(`ecartLecturePrints must be an integer from 0 to ${SPREAD_READ_PRINTS_DEFAULT} (0 = no read; one read of the data module's last prints gives at most that many), got ${String(readPrints)}`)
  if (!Number.isFinite(clockSettings.fenetreMinutes) || clockSettings.fenetreMinutes <= 0 || !Number.isFinite(clockSettings.seuilJournalMs) || clockSettings.seuilJournalMs < 0 || !Number.isFinite(clockSettings.sautMs) || clockSettings.sautMs < 0) throw new Error('horloge: fenetreMinutes must be positive, seuilJournalMs and sautMs positive milliseconds (marche.json)')

  // The page server: the port and the list of origins, from `marche.json` else their defaults, plus `--origins`; `--port 0` = no server.
  const port = o.port ?? previous?.serveur?.port ?? RADINUS_PORT
  const fileOrigins = previous?.serveur?.origines ?? SERVER_ORIGINS_DEFAULT
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`the server's port must be an integer from 0 to 65535 (0 = no server), got ${String(port)}`)
  if (!Array.isArray(fileOrigins) || fileOrigins.some((x) => typeof x !== 'string')) throw new Error('serveur.origines (marche.json) must be a list of strings, for example ["http://localhost:5173"]')
  const origins = [...fileOrigins, ...(o.origins ?? []).filter((x) => !fileOrigins.includes(x))]

  // Without `--bots` and without a bot taken up from a state, only the page can give one: without a server, this program would never have anything to do.
  if (o.bots === undefined && resolved.length === 0 && port === 0) throw new Error('without --bots and with --port 0, this program will never have a bot: it has no starting list (--bots) and does not listen to the page (--port 0) that could launch one; give --bots bots.json or drop --port 0')
  // Each bot's and each market's starting state: what `etat.json` holds, plus what the journals allowed to rebuild. A market whose state is lost: the instant last seen is estimated from its bots' journals (rebuild.ts).
  const baseBots: Record<string, BotSaved> = { ...(saved?.bots ?? {}) }
  for (const [id, r] of rebuilt) baseBots[id] = r.saved
  const baseMarkets: DirectState['marches'] = { ...(saved?.marches ?? {}) }
  for (const name of names) {
    const mine = [...rebuilt.values()].filter((r) => r.spec.marche === name)
    if (mine.length === 0 || (baseMarkets[name] !== undefined && baseMarkets[name].ouverte !== null)) continue
    const seen = lastSeenOf(mine, waitMs)
    if (seen !== null) baseMarkets[name] = { ouverte: Math.floor((seen + 1) / 60000) * 60, vu: seen }
  }
  mkdirSync(journalsDir, { recursive: true })
  // The renumbering on disk: the journals take their new names, then etat.json its new keys, then (writeList below) bots.json gets the new ids and `nextNumber`. The old name is kept nowhere else (the mapping is in programme.jsonl).
  const renamedJournals: string[] = []
  if (renumbering !== null) {
    for (const st of renumbering) {
      const from = join(journalsDir, `${st.from}.jsonl`)
      if (!existsSync(from)) continue
      renameSync(from, journalPathOf(st.to))
      renamedJournals.push(`${st.from}.jsonl -> ${st.to}.jsonl`)
    }
    if (saved !== null) {
      const tmpState = `${statePath}.tmp`
      writeFileSync(tmpState, `${JSON.stringify({ version: 1, ecrit: saved.ecrit, marches: saved.marches, bots: saved.bots } satisfies DirectState, null, 1)}\n`)
      renameSync(tmpState, statePath)
    }
  }
  // The family's `bots.json`: written only when the list changes (the content is compared with what is on disk), never every minute. A temporary file, then a rename.
  let listOnDisk = list === null ? null : readFileSync(listPath, 'utf8')
  const writeList = (): void => {
    const body = `${JSON.stringify({ bots: specs.filter((b) => !retired.has(b.id)), nextNumber, ...(retired.size > 0 ? { retires: [...retired] } : {}), ...(retiredFormer.size > 0 ? { retiredFormerIds: [...retiredFormer] } : {}) }, null, 1)}\n`
    if (body === listOnDisk || (listOnDisk === null && specs.length === 0 && retired.size === 0)) return
    const tmp = `${listPath}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, listPath)
    listOnDisk = body
  }
  writeList()

  // The program's life, and the clock: the PC's, set on the prints (printClock.ts); until a print has arrived, the PC's as it is.
  const program = Journal.append(programPath)
  const clock = new PrintClock(o.clock, clockSettings, (e) => program.write(e), say)
  const t0 = o.clock.now()
  if (converting) program.write({ evenement: 'conversion', heure: iso(t0), de: 'etat.json', vers: 'bots.json', bots: specs.length, retires: retired.size })
  if (renumbering !== null) program.write({ evenement: 'renumbering', heure: iso(t0), mapping: Object.fromEntries(renumbering.map((st) => [st.from, st.to])), nextNumber, renamedJournals })
  program.write({ evenement: !isRestart ? 'demarrage_programme' : 'redemarrage_programme', heure: iso(t0), marches: names, bots: resolved.map((r) => r.spec.id), attenteMs: waitMs, horloge: clockSettings, ecartLecturePrints: readPrints })

  // The markets at Lighter: number and decimals (one read of the list), margins and liquidation fee (one read per market), then the spread (one read of the last prints per market, at start only).
  // The list of markets is read only when first needed: at start if there are bots, else at the first launch from the page (no call before).
  type Overview = Awaited<ReturnType<LiveLoaders['markets']>>
  let overviewRead: Promise<Overview> | null = null
  const readOverview = (): Promise<Overview> => {
    overviewRead ??= o.loaders.markets()
    return overviewRead
  }
  const configs = new Map<string, { cfg: MarketConfig; id: number }>()
  const file: DirectMarketFile = { genre: 'direct', attenteMs: waitMs, financement: funding, horloge: clockSettings, ecartLecturePrints: readPrints, ...(port !== 0 ? { serveur: { port, origines: origins } } : previous?.serveur === undefined ? {} : { serveur: previous.serveur }), marches: { ...(previous?.marches ?? {}) } }
  /** What the spread's measurement said, per market: written in programme.jsonl (and in the journal of each bot of the market when the spread is missing: a bot's journal says why it fills at the last print). */
  const spreadNotes = new Map<string, { line: Record<string, unknown>; toBots: boolean; say: string }>()
  /**
   * Market `name` at Lighter: its margins (one read) and its spread (one read of the last prints), written in `configs`, `file` and `spreadNotes`. Returns `null` when done, else the reason. At start (`atStart`) a restart keeps the file's spread; a market launched from the page is measured as at a first start.
   * The same calls in both cases: the program counts them (guard.ts) and writes them (programme.jsonl).
   */
  const measure = async (name: string, atStart: boolean): Promise<string | null> => {
    const when = atStart ? t0 : clock.now()
    const overview = await readOverview()
    if (overview.length === 0) {
      overviewRead = null
      return "Lighter's list of markets did not come back (/orderBookDetails)"
    }
    const m = overview.find((x) => x.symbol === name && x.marketType === 'perp')
    if (m === undefined) return `market "${name}": not a Lighter perp (symbols: ${overview.filter((x) => x.marketType === 'perp').map((x) => x.symbol).join(', ')})`
    const limits = await o.loaders.limits(m.marketId)
    if (limits === null || limits.minInitialMarginFraction === null || limits.maintenanceMarginFraction === null || limits.liquidationFee === null) return `market "${name}": its margins or its liquidation fee cannot be read at Lighter`
    const kept = previous?.marches[name]
    let spread = kept === undefined || kept.ecartTicks === null || kept.ecartTicks === undefined ? null : { ticks: kept.ecartTicks, pct: kept.ecartPct ?? 0 }
    // `marche.json` no longer has this market (an earlier version rewrote it without it): the spread of the bots' life is the last one `programme.jsonl` wrote for it (`ecart_mesure` or `ecart_garde`).
    const fromProgram = kept === undefined && atStart && isRestart ? lastSpreadOfProgram(programPath, name) : null
    if (fromProgram !== null) spread = fromProgram
    if (atStart && isRestart) {
      spreadNotes.set(name, { line: { evenement: 'ecart_garde', heure: iso(when), marche: name, ecartTicks: spread === null ? null : spread.ticks, ecartPct: spread === null ? null : spread.pct, raison: fromProgram === null ? "redémarrage : l'écart de la vie des bots n'est pas remesuré" : "redémarrage : l'écart de la vie des bots n'est pas remesuré ; marche.json n'avait plus ce marché, l'écart est relu de programme.jsonl" }, toBots: false, say: spread === null ? 'spread not set (fill at the last print), kept at the restart' : `spread ${spread.ticks} ticks, kept at the restart${fromProgram === null ? '' : ' (read again from programme.jsonl: marche.json no longer had this market)'}` })
    } else if (readPrints === 0) {
      spreadNotes.set(name, { line: { evenement: 'ecart_fichier', heure: iso(when), marche: name, ecartTicks: spread === null ? null : spread.ticks, ecartPct: spread === null ? null : spread.pct, raison: 'ecartLecturePrints: 0, pas de lecture' }, toBots: false, say: spread === null ? 'spread not set (marche.json, ecartLecturePrints: 0): fill at the last print' : `spread ${spread.ticks} ticks (marche.json, ecartLecturePrints: 0: no read)` })
    } else {
      const read = spreadOfPrints(await o.loaders.lastPrints(m.marketId, readPrints), m.priceDecimals)
      if (read.spread !== null) {
        spread = read.spread
        spreadNotes.set(name, { line: { evenement: 'ecart_mesure', heure: iso(when), marche: name, ecartTicks: read.spread.ticks, ecartPct: read.spread.pct, prints: read.prints, paires: read.pairs, de: iso(read.fromMs), a: iso(read.toMs), lecturePrints: readPrints }, toBots: false, say: `spread measured as the page does: ${read.spread.ticks.toPrecision(4)} ticks, ${read.spread.pct.toPrecision(4)} % (${read.pairs} pairs in ${read.prints} prints, from ${iso(read.fromMs)} to ${iso(read.toMs)})` })
      } else {
        spread = null
        spreadNotes.set(name, { line: { evenement: 'ecart_non_mesure', heure: iso(when), marche: name, raison: read.reason, prints: read.prints, lecturePrints: readPrints, consequence: 'remplissage au dernier print' }, toBots: true, say: `spread not measured (${read.reason}): fill at the last print` })
      }
    }
    configs.set(name, { id: m.marketId, cfg: { name, priceDecimals: m.priceDecimals, margins: { initial: limits.minInitialMarginFraction, maintenance: limits.maintenanceMarginFraction }, liquidationFeePct: limits.liquidationFee, spread, funding: null } })
    file.marches[name] = { id: m.marketId, decimales: m.priceDecimals, margeInitiale: limits.minInitialMarginFraction, margeMaintien: limits.maintenanceMarginFraction, fraisLiquidation: limits.liquidationFee, ecartTicks: spread === null ? null : spread.ticks, ecartPct: spread === null ? null : spread.pct }
    return null
  }
  for (const name of names) {
    const why = await measure(name, true)
    if (why !== null) throw new Error(why)
  }
  writeFileSync(marchePath, `${JSON.stringify(file, null, 2)}\n`)

  // The journals, the state to take up. `server`: the page server, `null` until it is open and without a server; every journal line is published to it.
  let server: ServerHandle | null = null
  let dirty = false
  const journals = new Map<string, Journal>()
  const openJournal = (id: string): Journal => {
    const j = Journal.append(journalPathOf(id))
    j.observer = (e) => {
      dirty = true
      say(consoleLine(id, e))
      server?.line(id, e)
      server?.bot(id)
    }
    journals.set(id, j)
    return j
  }
  for (const r of resolved) openJournal(r.spec.id)
  program.observer = (e) => {
    server?.line(null, e)
    server?.program()
  }
  for (const [name, n] of spreadNotes) {
    program.write(n.line)
    if (n.toBots) for (const r of resolved) if (r.spec.marche === name) (journals.get(r.spec.id) as Journal).write(n.line)
  }

  say(resolved.length === 0 ? 'radinus live: no bot: waiting for a launch from the page (no market followed)' : `radinus live: ${resolved.length} bot(s), ${names.length} market(s) (${names.join(', ')})`)
  say(`wait after the end of a minute: ${waitMs} ms (marche.json, attenteMs)` + (names.length === 0 ? '' : '; the prints\' delay (beyond the fastest one, once the clock is set) is measured and written in programme.jsonl, once an hour and at the stop'))
  say(`clock: until a print has arrived, the PC's time as it is; then the PC's time minus the smallest gap seen between a print's arrival and its time, over the prints of every market of the last ${clockSettings.fenetreMinutes} minutes (marche.json, horloge: correction ${clockSettings.correction ? 'yes' : 'NO'}, fenetreMinutes ${clockSettings.fenetreMinutes}, seuilJournalMs ${clockSettings.seuilJournalMs}, sautMs ${clockSettings.sautMs}); the estimate is said as soon as it exists`)
  say(`funding on the paper account: ${funding ? 'yes' : 'no (marche.json, financement: false)'}`)
  if (names.length === 0) say('outside calls: none for now (no socket, no read); the first launch on a market reads the list of markets (1 /orderBookDetails, once), then for that market 1 /orderBookDetails (margins), 1 read of the last prints (spread), 1 socket of the data module and the minutes of the last 24 h')
  else say(`outside calls: 1 socket of the data module (every market), 1 read of /orderBookDetails for the numbers, then per market the minutes of the last 24 h, 1 /orderBookDetails (margins) and ${!isRestart && readPrints > 0 ? `1 read of the last prints (up to ${readPrints}, for the spread)` : '0 spread read (restart or ecartLecturePrints: 0)'} at start, at most 1 /fundings per hour and per market (unless no position is held at the mark), prints read afterwards only after a cut or a restart`)
  for (const name of names) {
    const c = file.marches[name]
    say(`${name}: number ${c.id}, margins ${c.margeInitiale / 100} % / ${c.margeMaintien / 100} %, liquidation fee ${c.fraisLiquidation} %, ${(spreadNotes.get(name) as { say: string }).say}`)
  }
  for (const b of initial) if (typeof b.id === 'string' && retiredHit(b.id)) say(`bot "${b.id}": retired from the page (bots.json, retires), not started again`)
  if (saved !== null) say(`state found (${saved.ecrit}): restart, every bot taken up finds its account and its position again`)
  for (const line of startNotes) say(line)
  if (ignored.length > 0) say(`--bots: ${ignored.length} bot(s) already known to the folder (${ignored.map((b) => b.id).join(', ')}): neither replaced nor reset`)
  if (added.length > 0 && isRestart) say(`--bots: ${added.length} bot(s) the folder did not know, added (${added.map((b) => b.id).join(', ')})`)
  for (const [id, r] of rebuilt) {
    const b = r.saved
    const pos = b.exchange.bookPos
    say(`bot "${id}": state rebuilt from its journal (${r.lines} lines, last ${r.lastLine ?? '-'} at ${r.lastLineMs === null ? '-' : iso(r.lastLineMs)}): account ${b.bot.account}, ${b.bot.trades} trade(s), ${pos === null ? 'out' : `${pos.side === 1 ? 'long' : 'short'} at ${pos.pxIn}, stop ${pos.stopPx === null ? 'none' : pos.stopPx}`}${b.bot.paused ? ', stopped from the page' : ''}${b.bot.status === 'actif' ? '' : `, ${b.bot.status}`}`)
    program.write({ evenement: 'bot_reconstruit', heure: iso(t0), bot: id, depuis: 'journal', lignes: r.lines, derniereLigne: r.lastLine, derniereHeure: r.lastLineMs === null ? null : iso(r.lastLineMs), compte: b.bot.account, trades: b.bot.trades, position: pos })
  }

  // One engine and one source per market.
  const markets: DirectRun['markets'] = []
  let savedOpen = new Map<string, number | null>()
  const save = (force = false): void => {
    const marchesState: DirectState['marches'] = {}
    const botsState: DirectState['bots'] = {}
    let moved = force
    const nowOpen = new Map<string, number | null>()
    for (const m of markets) {
      if (!m.feed.isSeeded()) {
        // A market not warmed up yet (a restart in progress) has nothing new to write: what the previous state said of it is kept.
        const was = baseMarkets[m.name]
        if (was !== undefined) marchesState[m.name] = was
        for (const [id, b] of Object.entries(baseBots)) if (m.engine.runtimes.some((rt) => rt.r.spec.id === id)) botsState[id] = b
        continue
      }
      const snap = m.engine.snapshot()
      nowOpen.set(m.name, snap.openT)
      if (savedOpen.get(m.name) !== snap.openT) moved = true
      marchesState[m.name] = { ouverte: snap.openT, vu: m.feed.horizonMs() }
      Object.assign(botsState, snap.bots)
    }
    if (!moved && !dirty) return
    // Never fewer bots than before, except one retired from the page: a held state whose bot is still in the list is not lost.
    for (const [id, b] of Object.entries(baseBots)) if (botsState[id] === undefined && !retired.has(id) && specs.some((x) => x.id === id)) botsState[id] = b
    const state: DirectState = { version: 1, ecrit: iso(clock.now()), marches: marchesState, bots: botsState }
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`)
    renameSync(tmp, statePath)
    savedOpen = nowOpen
    dirty = false
  }
  /** One engine and one source for market `name` (measured: `configs`), with its bots. `restart`: at the start of a folder that has a state, the market takes up what the state says of it; a market opened by `lancer` starts fresh. */
  const addMarket = (name: string, mine: ResolvedBot[], restart: boolean): DirectRun['markets'][number] => {
    const c = configs.get(name) as { cfg: MarketConfig; id: number }
    const engine = new Engine(c.cfg, mine, journals)
    const savedMarket = restart ? baseMarkets[name] : undefined
    const savedBots = !isRestart || !restart ? {} : Object.fromEntries(Object.entries(baseBots).filter(([id]) => mine.some((r) => r.spec.id === id)))
    const resume = savedMarket === undefined || savedMarket.ouverte === null ? null : { openMs: savedMarket.ouverte * 1000, vuMs: savedMarket.vu, restore: () => engine.restore(savedBots) }
    const feed = new LiveFeed({ marketId: c.id, name, clock, loaders: o.loaders, waitMs, resume, funding, program: (e) => program.write(e), onStep: () => save(), say, onStatus: () => server?.program() })
    engine.onLaunched = (id) => server?.bot(id)
    // A bot removed from the list: written in the state (a restart does not start it again) before the page learns it.
    engine.onRemoved = (id, compte) => {
      program.write({ evenement: 'bot_retire', heure: removalAsked.get(id) ?? iso(clock.now()), bot: id, marche: name, compte })
      removalAsked.delete(id)
      retired.add(id)
      const former = specs.find((b) => b.id === id)?.formerId
      if (former !== undefined) retiredFormer.add(former)
      writeList()
      dirty = true
      save(true)
      server?.removed(id)
    }
    const entry = { name, engine, feed }
    markets.push(entry)
    return entry
  }
  for (const name of names) addMarket(name, resolved.filter((r) => r.spec.marche === name), true)
  // What the server reads of the program and the commands it passes to it: nothing more.
  const botOf = (id: string): { m: DirectRun['markets'][number]; view: BotView } | null => {
    for (const m of markets) {
      const rt = m.engine.runtimes.find((x) => x.r.spec.id === id)
      if (rt !== undefined) return { m, view: m.engine.view(rt) }
    }
    return null
  }
  const programView = (): ProgramView => ({
    demarre: iso(t0),
    attenteMs: waitMs,
    marches: markets.map((m) => {
      const c = file.marches[m.name]
      return { nom: m.name, id: c.id, levier: leverageOf({ initial: c.margeInitiale, maintenance: c.margeMaintien }), margeInitiale: c.margeInitiale / 100, margeMaintien: c.margeMaintien / 100, fraisLiquidation: c.fraisLiquidation, ecartTicks: c.ecartTicks, ecartPct: c.ecartPct, flux: m.feed.streamState() }
    }),
    horloge: clock.report(),
  })
  // `lancer`: the page's bot goes through the `bots.json` reader (`checkBot`), gets an id from the program, and its `debut` is the instant of the request. A market already followed costs no call: the bot joins its engine and waits for its start instant
  // as a `bots.json` bot that has a `debut`. A market not followed yet is opened as at start (`measure`: same reads, counted and written; then its source's warm-up); only this waits, the other markets' engines are not touched.
  const opening = new Map<string, Promise<string | null>>()
  const openMarket = async (name: string): Promise<string | null> => {
    const why = await measure(name, false)
    if (why !== null) return why
    if (stopped) return 'the program is stopping'
    writeFileSync(marchePath, `${JSON.stringify(file, null, 2)}\n`)
    const note = spreadNotes.get(name) as { line: Record<string, unknown>; toBots: boolean; say: string }
    program.write(note.line)
    const c = file.marches[name]
    program.write({ evenement: 'marche_ouvert', heure: iso(clock.now()), marche: name, numero: c.id, depuis: 'lancer', appels: '1 /orderBookDetails (margins) and 1 read of the last prints (spread); 1 subscription on the data module\'s socket and the minutes of the last 24 h at the warm-up' })
    say(`${name}: market opened by a launch from the page: number ${c.id}, margins ${c.margeInitiale / 100} % / ${c.margeMaintien / 100} %, liquidation fee ${c.fraisLiquidation} %, ${note.say}`)
    const entry = addMarket(name, [], false)
    entry.feed.start(entry.engine).catch((e: unknown) => program.write({ evenement: 'marche_echec', heure: iso(clock.now()), marche: name, raison: e instanceof Error ? e.message : String(e) }))
    return null
  }
  const launch = async (definition: BotDefinition): Promise<{ id: string } | { raison: string }> => {
    const startMs = clock.now()
    // The id is the next number of the family and the market; the counter moves once the definition is accepted (below), so a refusal burns no number, and none is ever given twice.
    const id = botIdOf(nextNumber, typeof definition.marche === 'string' ? definition.marche : '')
    const refuse = (raison: string): { raison: string } => {
      program.write({ evenement: 'lancement_refuse', heure: iso(startMs), definition, raison })
      say(`launch refused: ${raison}`)
      return { raison }
    }
    if (stopped) return { raison: 'the program is stopping' }
    // `paused: true` (a script bot from `/bot`): the bot is listed and kept in `bots.json`, not started; `reprendre` starts it. `paused: false` is the same as absent.
    const { paused, ...given } = definition
    const draft = checkBot({ ...given, ...(paused === true ? { paused: true } : paused === undefined || paused === false ? {} : { paused }), id, debut: iso(startMs) })
    if (typeof draft === 'string') return refuse(draft)
    // A bot of the list always has its three trailing values, even if the request did not carry them (read `trail: false`, 0, 0). A script bot has none: its trailing is its script's.
    const spec: BotSpec = draft.script !== null ? draft.spec : { ...draft.spec, trail: draft.trailBox.on, trailSeuil: draft.trailBox.seuil, trailDistance: draft.trailBox.distance }
    const r = checkBot(spec)
    if (typeof r === 'string') return refuse(r)
    const notLive = notLiveReason(r)
    if (notLive !== null) return refuse(notLive)
    nextNumber++
    const name = spec.marche
    const followed = markets.some((m) => m.name === name)
    if (!followed) {
      // The first launch on this market opens it; those arriving meanwhile wait for the same opening.
      let pending = opening.get(name)
      if (pending === undefined) {
        pending = openMarket(name)
        opening.set(name, pending)
      }
      const why = await pending
      opening.delete(name)
      if (why !== null) return refuse(why)
    }
    const entry = markets.find((m) => m.name === name) as DirectRun['markets'][number]
    const tooHigh = leverageProblem(r, entry.engine.market.cfg.margins)
    if (tooHigh !== null) return refuse(tooHigh)
    const journal = openJournal(id)
    const note = spreadNotes.get(name) as { line: Record<string, unknown>; toBots: boolean }
    if (!followed && note.toBots) journal.write(note.line)
    entry.engine.add(r, journal)
    specs.push(spec)
    writeList()
    dirty = true
    save(true)
    const count = entry.engine.runtimes.length
    program.write({ evenement: 'bot_lance', heure: iso(startMs), bot: id, marche: name, definition: spec, marcheOuvert: !followed, botsDuMarche: count })
    say(`bot "${id}" launched from the page (market ${name} ${followed ? 'already followed: no call' : 'opened just now'}, ${count} bot(s) on this market)${spec.paused === true ? ': paused, nothing runs until reprendre' : ''}`)
    server?.bot(id)
    server?.program()
    entry.feed.poke()
    return { id }
  }
  const control: Control = {
    bots: () => markets.flatMap((m) => m.engine.runtimes.map((rt) => m.engine.view(rt))),
    bot: (id) => botOf(id)?.view ?? null,
    program: programView,
    command: (verb, id) => {
      const found = botOf(id)
      if (found === null) return `unknown bot "${id}"`
      const now = clock.now()
      if (verb === 'retirer') removalAsked.set(id, iso(now))
      const why = verb === 'arreter' ? found.m.engine.pause(id, now) : verb === 'reprendre' ? found.m.engine.resume(id, now) : found.m.engine.remove(id, now)
      if (why !== null && verb === 'retirer') removalAsked.delete(id)
      if (why === null) {
        // A bot launched paused starts at its first `reprendre`: `bots.json` loses its `paused` and takes this instant as its `debut`.
        const k = specs.findIndex((b) => b.id === id)
        const first = verb === 'reprendre' && k >= 0 && specs[k].paused === true
        if (first) {
          const { paused: _held, ...rest } = specs[k]
          specs[k] = { ...rest, debut: iso(now) }
          writeList()
          dirty = true
          save(true)
        }
        if (verb !== 'retirer') program.write({ evenement: verb === 'arreter' ? 'bot_arrete' : 'bot_repris', heure: iso(now), bot: id, marche: found.m.name, compte: botOf(id)?.view.compte ?? found.view.compte, ...(first ? { premierDepart: true } : {}) })
        found.m.feed.poke()
      }
      return why
    },
    definition: (id) => {
      const s = specs.find((b) => b.id === id)
      if (s === undefined || botOf(id) === null) return null
      const { id: _id, debut: _debut, etat: _etat, formerId: _former, paused: _paused, ...definition } = s
      return definition
    },
    leverage: (id, levier) => {
      const found = botOf(id)
      if (found === null) return `unknown bot "${id}"`
      const now = clock.now()
      const why = found.m.engine.setLeverage(id, levier, now)
      if (why === null) {
        program.write({ evenement: 'bot_levier', heure: iso(now), bot: id, marche: found.m.name, ancien: found.view.levier, nouveau: levier })
        writeList()
        dirty = true
        save(true)
      }
      return why
    },
    journalPath: (id) => (id === null ? program.path : journals.get(id)?.path),
    launch,
    // `modifier` (a script bot): the definition is checked by the reader of `bots.json` under the bot's own id and start, then the engine swaps it in (positions and registers kept); `bots.json` is written with it.
    modify: (id, definition) => {
      const found = botOf(id)
      const now = clock.now()
      const refuse = (raison: string): string => {
        program.write({ evenement: 'modification_refusee', heure: iso(now), bot: id, definition, raison })
        say(`modification refused (${id}): ${raison}`)
        return raison
      }
      if (found === null) return refuse(`unknown bot "${id}"`)
      const k = specs.findIndex((b) => b.id === id)
      if (k < 0) return refuse(`bot "${id}": not in the family's list`)
      // A modify never runs nor pauses a bot: a bot launched paused stays so (`paused` is the list's, not the page's).
      const { paused: _asked, ...given } = definition
      const r = checkBot({ ...given, id, debut: specs[k].debut, ...(specs[k].formerId === undefined ? {} : { formerId: specs[k].formerId }), ...(specs[k].paused === true ? { paused: true } : {}) })
      if (typeof r === 'string') return refuse(r)
      const why = found.m.engine.modify(id, r, now)
      if (why !== null) return refuse(why)
      specs[k] = r.spec
      program.write({ evenement: 'bot_modifie', heure: iso(now), bot: id, marche: found.m.name, definition: r.spec })
      say(`bot "${id}" modified from the page (positions and registers kept)`)
      writeList()
      dirty = true
      save(true)
      server?.bot(id)
      found.m.feed.poke()
      return null
    },
  }
  if (port !== 0) {
    server = await startServer({ port, origins, control, say, maxBufferBytes: o.maxBufferBytes, program: (e) => {
      const { evenement, ...rest } = e
      program.write({ evenement, heure: iso(clock.now()), ...rest })
    } })
  }
  if (resolved.length === 0 && server === null) throw new Error('no bot, and the page server could not open (see above): nothing can launch a bot')
  let stopped = false
  const stop = (): BotSummary[] => {
    if (stopped) return markets.flatMap((m) => m.engine.summaries())
    stopped = true
    for (const m of markets) m.feed.stop()
    const now = clock.now()
    for (const m of markets) for (const rt of m.engine.runtimes) rt.bot?.stopped(now)
    save(true)
    const summaries = markets.flatMap((m) => m.engine.summaries())
    program.write({ evenement: 'arret_programme', heure: iso(now), horloge: clock.report(), marches: Object.fromEntries(markets.map((m) => [m.name, m.feed.summary()])), appels: o.calls === undefined ? null : o.calls() })
    server?.close()
    return summaries
  }
  await Promise.all(markets.map((m) => m.feed.start(m.engine)))
  save(true)
  return { stop, markets, waitMs, clock, server }
}
