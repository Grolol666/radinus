/**
 * A replay from end to end (the command line's two replay verbs are two calls of it): the bots read, the market built, the journals opened (new, or taken up and checked), the prints file replayed as if it
 * arrived live, the folder's `bots.json` rewritten with each bot's state. The output folder holds everything needed to resume: `marche.json`, `bots.json`, `journaux/`, and the prints file given again.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { opportunityTape } from './core/hedgeSim'
import type { FundingHours } from './core/funding'
import { writeBots, resolveBots } from './bots'
import type { BotSpec } from './bots'
import { Engine } from './engine'
import type { BotSummary } from './engine'
import { Journal } from './journal'
import type { MarketConfig } from './market'
import { Replayer, readPrints } from './replayer'
import type { Print } from './seam'

/** The market as the `marche.json` file gives it (margins as Lighter publishes them: hundredths of a percent, 200 = 2 %). `ecartTicks` / `ecartPct`: the median spread, `null` = no spread (the page then fills at the last print); absent, `replay` measures it on the file. */
export type MarketFile = {
  nom: string
  donnees?: string
  decimales: number
  margeInitiale: number
  margeMaintien: number
  fraisLiquidation: number
  ecartTicks?: number | null
  ecartPct?: number | null
  /** The funding per hour (UTC hour index = ms / 3,600,000, value of the `fundings` API), if given: it enters the PnL as on the page. */
  funding?: Record<string, number> | null
}

export function configOf(f: MarketFile): MarketConfig {
  const funding: FundingHours | null = f.funding === undefined || f.funding === null ? null : new Map(Object.entries(f.funding).map(([h, v]): [number, number] => [Number(h), v]))
  const spread = f.ecartTicks === undefined || f.ecartTicks === null ? null : { ticks: f.ecartTicks, pct: f.ecartPct ?? 0 }
  return { name: f.nom, priceDecimals: f.decimales, margins: { initial: f.margeInitiale, maintenance: f.margeMaintien }, liquidationFeePct: f.fraisLiquidation, spread, funding }
}

/** The file's median spread, by the page's band (`opportunityTape`): measured once over the whole recording, it is an INPUT of the market, never what the market keeps. */
export function measureSpread(prints: Print[], decimales: number): { ticks: number; pct: number } | null {
  const tape = opportunityTape(prints, 10 ** -decimales)
  return tape.spreadPct === null ? null : { ticks: tape.spreadTicks, pct: tape.spreadPct }
}

export type RunOptions = { sortie: string; donnees: string; marche: MarketFile; bots: BotSpec[]; mode: 'fresh' | 'resume'; untilMs: number | null; prints?: Print[] }
export type RunResult = { completed: boolean; summaries: BotSummary[]; engine: Engine; prints: number }

export function runReplay(o: RunOptions): RunResult {
  const dir = o.sortie
  mkdirSync(join(dir, 'journaux'), { recursive: true })
  const prints = o.prints ?? readPrints(o.donnees)
  const marche = { ...o.marche }
  if (marche.ecartTicks === undefined && o.mode === 'fresh') {
    const m = measureSpread(prints, marche.decimales)
    marche.ecartTicks = m === null ? null : m.ticks
    marche.ecartPct = m === null ? null : m.pct
  }
  marche.donnees = resolve(o.donnees)
  const resolved = resolveBots(o.bots)
  for (const r of resolved) if (r.spec.marche !== marche.nom) throw new Error(`bot "${r.spec.id}": market "${r.spec.marche}", this replay is the one of "${marche.nom}"`)
  if (o.mode === 'fresh') writeFileSync(join(dir, 'marche.json'), `${JSON.stringify(marche, null, 2)}\n`)
  const journals = new Map<string, Journal>(resolved.map((r): [string, Journal] => [r.spec.id, (o.mode === 'fresh' ? Journal.fresh : Journal.resume)(join(dir, 'journaux', `${r.spec.id}.jsonl`))]))
  const engine = new Engine(configOf(marche), resolved, journals)
  const completed = new Replayer(prints, o.untilMs).run(engine)
  const summaries = engine.summaries()
  // `etat` is an output: what the replay made of each bot (never read again).
  writeBots(join(dir, 'bots.json'), o.bots.map((b) => ({ ...b, etat: { ...summaries.find((s) => s.id === b.id), rejeuTermine: completed } })))
  return { completed, summaries, engine, prints: prints.length }
}

/** What a resume reads again from the folder: the market, the list of bots (without the output `etat`). */
export function readRunDir(dir: string): { marche: MarketFile; bots: BotSpec[] } {
  const marchePath = join(dir, 'marche.json')
  const botsPath = join(dir, 'bots.json')
  if (!existsSync(marchePath) || !existsSync(botsPath)) throw new Error(`${dir}: no marche.json / bots.json, this is not a replay folder`)
  const marche = JSON.parse(readFileSync(marchePath, 'utf8')) as MarketFile
  const bots = (JSON.parse(readFileSync(botsPath, 'utf8')) as { bots: BotSpec[] }).bots.map((b) => {
    const { etat: _etat, ...spec } = b
    return spec
  })
  return { marche, bots }
}
