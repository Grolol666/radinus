/**
 * The command line: four verbs.
 *
 *   radinus replay  --data prints.json --bots bots.json --out DIR --market NAME --decimals N --margins INITIAL/MAINTENANCE --liquidation-fee PCT
 *                   [--market-file market.json] [--spread-ticks T --spread-pct P | --no-spread] [--until 2026-10-01T12:00:00Z]
 *   radinus resume  --out DIR [--data prints.json]
 *   radinus live    [--bots bots.json] --out DIR [--wait MS] [--duration MINUTES] [--port PORT] [--origins A,B] [--source NAME]
 *   radinus control --out DIR --bot ID [--source NAME]
 *
 * `replay` plays a recorded prints file through the list of bots as if it arrived live, writes one journal per bot and
 * `bots.json` / `marche.json` in the output folder, and prints each bot's summary. `resume` takes up an interrupted replay
 * (`--until`, or a hard stop) from the folder's files alone: the replay, deterministic, is redone from the start of the
 * data, checking every line already written, then appends the rest. Neither opens a socket or reads the network.
 * `live` runs the bots live, on paper, on a data module (`--source`, src/sources/) and the PC's clock (direct.ts); Ctrl+C
 * stops it cleanly; it serves the `/bots` page on 127.0.0.1:4664 (`--port 0` = no server). `control` compares a bot's
 * journal with what the page simulates over the same hours (controler.ts). No order and no key in any of the four.
 *
 * The French verbs and flags of earlier versions are still accepted, each printing its English name once.
 * `--source` defaults to the environment variable `RADINUS_SOURCE`, then `lighter`; `--origins` to `RADINUS_ORIGINS`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readBots } from './bots'
import { realClock } from './clock'
import { controler } from './controler'
import { startDirect } from './direct'
import type { BotSummary } from './engine'
import { guardNetwork } from './guard'
import { loadSource } from './sources/types'
import { readRunDir, runReplay } from './run'
import type { MarketFile, RunResult } from './run'

type Flags = Map<string, string | true>

/** The data module of `live` and `control` when `--source` is not given: `RADINUS_SOURCE`, else `lighter` (src/sources/). */
const defaultSource = (): string => process.env.RADINUS_SOURCE || 'lighter'

const VALUE_FLAGS = new Set(['source', 'duration', 'wait', 'port', 'origins', 'bot', 'data', 'bots', 'out', 'market', 'decimals', 'margins', 'liquidation-fee', 'market-file', 'spread-ticks', 'spread-pct', 'until'])
const SWITCH_FLAGS = new Set(['no-spread'])

/** The verbs and flags of earlier versions, kept as aliases (one notice each). */
const VERB_ALIASES: Record<string, string> = { rejouer: 'replay', continuer: 'resume', direct: 'live', controler: 'control' }
const FLAG_ALIASES: Record<string, string> = {
  donnees: 'data',
  sortie: 'out',
  marche: 'market',
  decimales: 'decimals',
  marges: 'margins',
  'frais-liquidation': 'liquidation-fee',
  'marche-fichier': 'market-file',
  'ecart-ticks': 'spread-ticks',
  'ecart-pct': 'spread-pct',
  'sans-ecart': 'no-spread',
  jusqua: 'until',
  attente: 'wait',
  duree: 'duration',
}

const USAGE = `usage: radinus replay  --data prints.json --bots bots.json --out DIR --market NAME --decimals N --margins INITIAL/MAINTENANCE --liquidation-fee PCT
                      [--market-file market.json] [--spread-ticks T --spread-pct P | --no-spread] [--until DATE]
       radinus resume  --out DIR [--data prints.json]
       radinus live    [--bots bots.json] --out DIR [--wait MS] [--duration MINUTES] [--port PORT] [--origins A,B] [--source NAME]
       radinus control --out DIR --bot ID [--source NAME]

  replay   plays a recorded prints file through the bots, one journal per bot (no network)
  resume   takes up an interrupted replay from the folder's own files (no network)
  live     runs the bots live, on paper, until Ctrl+C or --duration; serves the /bots page on 127.0.0.1:4664 (--port 0 = none)
  control  compares a live bot's journal with the page's simulation of the same hours

  --source NAME   the data module (src/sources/NAME.ts); default: $RADINUS_SOURCE, else lighter
  --origins A,B   the page origins the live server accepts besides localhost; default: $RADINUS_ORIGINS
No order and no key, in any verb.`

function parseFlags(args: string[]): Flags {
  const flags: Flags = new Map()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    let name = a.slice(2)
    const alias = FLAG_ALIASES[name]
    if (alias !== undefined) {
      console.log(`(--${name} is now --${alias})`)
      name = alias
    }
    if (SWITCH_FLAGS.has(name)) flags.set(name, true)
    else if (VALUE_FLAGS.has(name)) {
      const v = args[++i]
      if (v === undefined) throw new Error(`--${name} needs a value`)
      flags.set(name, v)
    } else throw new Error(`unknown option: --${name}`)
  }
  return flags
}

const text = (flags: Flags, name: string): string | undefined => {
  const v = flags.get(name)
  return typeof v === 'string' ? v : undefined
}
const need = (flags: Flags, name: string): string => {
  const v = text(flags, name)
  if (v === undefined) throw new Error(`--${name} is required`)
  return v
}
const num = (name: string, v: string): number => {
  const x = Number(v)
  if (!Number.isFinite(x)) throw new Error(`--${name}: "${v}" is not a number`)
  return x
}

/** The market of `replay`: the `--market-file` file if there is one, corrected by the flags on top of it. */
function marketFrom(flags: Flags): MarketFile {
  const file = text(flags, 'market-file')
  const base: Partial<MarketFile> = file === undefined ? {} : (JSON.parse(readFileSync(file, 'utf8')) as Partial<MarketFile>)
  const margins = text(flags, 'margins')
  let initial = base.margeInitiale
  let maintenance = base.margeMaintien
  if (margins !== undefined) {
    const [a, b] = margins.split('/')
    if (a === undefined || b === undefined) throw new Error('--margins: INITIAL/MAINTENANCE, in hundredths of a percent (200/120 = 2 % / 1.2 %)')
    initial = num('margins', a)
    maintenance = num('margins', b)
  }
  const nom = text(flags, 'market') ?? base.nom
  const decimales = text(flags, 'decimals') === undefined ? base.decimales : num('decimals', need(flags, 'decimals'))
  const fee = text(flags, 'liquidation-fee') === undefined ? base.fraisLiquidation : num('liquidation-fee', need(flags, 'liquidation-fee'))
  if (nom === undefined || decimales === undefined || initial === undefined || maintenance === undefined || fee === undefined) {
    throw new Error('the market is incomplete: it needs --market, --decimals, --margins INITIAL/MAINTENANCE and --liquidation-fee (or a --market-file that gives them)')
  }
  const market: MarketFile = { nom, decimales, margeInitiale: initial, margeMaintien: maintenance, fraisLiquidation: fee, funding: base.funding ?? null }
  if (flags.has('no-spread')) {
    market.ecartTicks = null
    market.ecartPct = null
  } else if (text(flags, 'spread-ticks') !== undefined) {
    market.ecartTicks = num('spread-ticks', need(flags, 'spread-ticks'))
    market.ecartPct = text(flags, 'spread-pct') === undefined ? 0 : num('spread-pct', need(flags, 'spread-pct'))
  } else if (base.ecartTicks !== undefined) {
    market.ecartTicks = base.ecartTicks
    market.ecartPct = base.ecartPct ?? null
  }
  return market
}

const money = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(4)
const pct = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2)

function print(result: RunResult, market: MarketFile): void {
  console.log(`market ${market.nom}: ${result.prints.toLocaleString('en-US')} prints${result.completed ? '' : ' (replay interrupted before the end of the data)'}`)
  console.log('')
  printTable(result.summaries)
}

function printTable(summaries: BotSummary[]): void {
  const head = ['bot', 'player', 'state', 'trades', 'wins', 'losses', 'PnL $', 'PnL % stake', 'account', 'leverage', 'stop']
  const rows = summaries.map((s: BotSummary) => [s.id, s.joueur, s.etat, String(s.trades), String(s.gagnants), String(s.perdants), money(s.pnl), `${pct(s.pnlPctMiseDepart)} %`, s.compte.toFixed(4), s.levier === 0 ? '-' : `x${s.levier}`, s.stop === null ? '-' : `${s.stop} %`])
  const widths = head.map((h, k) => Math.max(h.length, ...rows.map((r) => r[k].length)))
  const line = (cells: string[]) => cells.map((c, k) => (k < 3 ? c.padEnd(widths[k]) : c.padStart(widths[k]))).join('  ')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
  for (const s of summaries) if (s.alerte !== null) console.log(`\nWARNING ${s.id}: ${s.alerte}`)
  console.log("\nPnL % stake = the PnL in $ over the bot's starting stake (account x share). A liquidated bot is said liquidated, never counted as a losing trade: its loss is in its account.")
}

/** `live`: the bots play until Ctrl+C (or `--duration`); the stop prints the summary. */
async function live(flags: Flags): Promise<void> {
  const source = await loadSource(text(flags, 'source') ?? defaultSource())
  const net = guardNetwork(source)
  const wait = text(flags, 'wait')
  const port = text(flags, 'port')
  const originsText = text(flags, 'origins') ?? process.env.RADINUS_ORIGINS
  const origins = originsText === undefined || originsText === '' ? undefined : originsText.split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (text(flags, 'bots') !== undefined && resolve(need(flags, 'bots')).toLowerCase() === resolve(need(flags, 'out'), 'bots.json').toLowerCase()) throw new Error("--bots points at the family folder's own bots.json: that is the list of its bots, not a starting list. Give a list outside the folder, or drop --bots (the folder reads its own list).")
  const run = await startDirect({ sortie: need(flags, 'out'), bots: text(flags, 'bots') === undefined ? undefined : readBots(need(flags, 'bots')), clock: realClock, loaders: source.loaders, say: (l) => console.log(l), waitMs: wait === undefined ? undefined : num('wait', wait), port: port === undefined ? undefined : num('port', port), origins, calls: net.summary })
  const duration = text(flags, 'duration')
  await new Promise<void>((resolve) => {
    const onStop = () => resolve()
    process.once('SIGINT', onStop)
    process.once('SIGTERM', onStop)
    // --duration MINUTES: stops by itself after that much play (as Ctrl+C); without it, until Ctrl+C.
    if (duration !== undefined) setTimeout(resolve, num('duration', duration) * 60000)
  })
  console.log('\nstop requested')
  const summaries = run.stop()
  console.log('')
  for (const m of run.markets) {
    const s = m.feed.summary()
    console.log(`${m.name}: ${s.prints} prints received, print delay median ${Number.isNaN(s.medianDelayMs) ? '-' : Math.round(s.medianDelayMs)} ms, minimum ${Number.isFinite(s.minDelayMs) ? Math.round(s.minDelayMs) : '-'} ms, maximum ${Number.isFinite(s.maxDelayMs) ? Math.round(s.maxDelayMs) : '-'} ms, ${s.late} late, ${s.cuts} cut(s)`)
  }
  if (run.markets.length === 0) console.log("no market followed: no print received, no clock adjusted (the PC's time as it is)")
  else console.log(`program clock: ${JSON.stringify(run.clock.report())} (smallest gap between a print's arrival and its time, what the program takes off the PC's time, prints of the window)`)
  console.log('')
  if (summaries.length === 0) console.log('no bot')
  else printTable(summaries)
  console.log(`\ncalls made: ${net.summary()}`)
  console.log('Open positions stay open: they are in etat.json, and a new `live` on the same folder takes them up.')
  process.exit(0)
}

async function control(flags: Flags): Promise<void> {
  const source = await loadSource(text(flags, 'source') ?? defaultSource())
  guardNetwork(source)
  const r = await controler({ sortie: need(flags, 'out'), bot: need(flags, 'bot'), loaders: source.loaders, say: (l) => console.log(l) })
  process.exitCode = r.differences.length === 0 ? 0 : 2
}

async function main(): Promise<void> {
  const [given, ...rest] = process.argv.slice(2)
  let verb = given
  const alias = verb === undefined ? undefined : VERB_ALIASES[verb]
  if (alias !== undefined) {
    console.log(`(${verb} is now ${alias})`)
    verb = alias
  }
  if (verb === 'live') return live(parseFlags(rest))
  if (verb === 'control') return control(parseFlags(rest))
  if (verb !== 'replay' && verb !== 'resume') {
    console.log(USAGE)
    process.exit(verb === undefined || verb === '--help' || verb === 'help' ? 0 : 1)
  }
  const flags = parseFlags(rest)
  const out = need(flags, 'out')
  if (verb === 'replay') {
    const marche = marketFrom(flags)
    const untilText = text(flags, 'until')
    const untilMs = untilText === undefined ? null : Date.parse(untilText)
    if (untilMs !== null && Number.isNaN(untilMs)) throw new Error(`--until: "${String(untilText)}" is not a date`)
    const result = runReplay({ sortie: out, donnees: need(flags, 'data'), marche, bots: readBots(need(flags, 'bots')), mode: 'fresh', untilMs })
    print(result, marche)
    return
  }
  const { marche, bots } = readRunDir(out)
  const data = text(flags, 'data') ?? marche.donnees
  if (data === undefined) throw new Error('--data is required: marche.json does not say where the prints file is')
  const result = runReplay({ sortie: out, donnees: data, marche, bots, mode: 'resume', untilMs: null })
  console.log('replay resumed from the folder\'s files: every line already written was checked, the rest appended.\n')
  print(result, marche)
}

main().catch((e: unknown) => {
  console.error(`radinus: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
