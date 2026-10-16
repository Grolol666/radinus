/**
 * The list of bots: `bots.json`, a text file read and edited by hand. A bot is a row of `/rsi`, frozen: the market, the player (its id in `RSI_TABLE_PLAYERS`), its settings (by key
 * of the player's description; those left out keep the page's default), its thresholds and its rule, its stop, the share of the account at stake, its leverage (absent = the market's maximum), its start account and fixed stake (absent = auto, `part`), the instant of the launch.
 * The file in a replay's folder is rewritten when something changes (a bot liquidated, the end of the replay): `etat` is an OUTPUT there, never read by the replay.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { SHARE_DEFAULT } from './core/account'
import type { StakePolicy } from './core/account'
import { RSI_TABLE_PLAYERS } from './core/players'
import type { PlayerRule, TablePlayer } from './core/players'
import { playerRunsLive } from './core/botLaunch'
import type { Rules } from './core/playerRules'
import type { Trail } from './core/playerStop'
import { BOT_DEF, BOT_MAX, onlyOf } from './core/botFlips'
import type { BotCompose, BotCote, BotDefinition, BotLien } from './core/radinusMessages'
import { SCRIPT_ID, readAttendu } from './core/radinusMessages'
import { compileScript } from './core/botScript'
import type { CompiledScript } from './core/botScript'
import { sanitizeDrawings } from './core/chartDrawings'
import type { Drawing } from './core/chartDrawings'
import { NO_RULES } from './core/playerRules'
import { sanitizeSubs } from './core/subAccounts'
import type { SubAccount } from './core/subAccounts'
import { leverageOf } from './core/playerSearch'
import type { MarketMargins } from './core/playerSearch'

export type BotSpec = BotDefinition & {
  id: string
  /** The id the bot had before the family was renumbered (2026-10-08); absent for a bot that never changed id. */
  formerId?: string
  debut: string
  /** What the last replay left (an output, never read). */
  etat?: Record<string, unknown>
}

/** A bot's three trailing values, always: the box (`trail`), the activation and the distance (% of price, 0 = empty). `ResolvedBot.trail` is the trailing in force: only with the box checked and both values above 0. */
export type TrailBox = { on: boolean; seuil: number; distance: number }

/** A player with everything decided: the description, the settings in the order of `settings`, the rule, the thresholds (NaN for a player without zones). It is what a bot's indicator continues (`IndicatorSetup`). */
export type ResolvedPlayer = { def: TablePlayer; settings: number[]; rule: PlayerRule; low: number; high: number }

/** The composition of a bot launched from `/bot`, checked: its indicators resolved one by one, their links, and the side it takes (`only`: 1 long only, -1 short only, 0 both). */
export type ResolvedCompose = { name: string; side: BotCote; only: 1 | 0 | -1; members: ResolvedPlayer[]; links: BotLien[] }

/** A script bot (`joueur` = `SCRIPT_ID`, `/bot`'s script, author's go 2026-10-10), checked: its text and its compiled function, its sub-accounts, the drawings of its market. */
export type ResolvedScript = { text: string; compiled: CompiledScript; subs: SubAccount[]; drawings: Drawing[] }

/** The player line of a script bot: `/bot`'s bot line under the script's id, no setting, threshold nor rule. */
export const SCRIPT_DEF: TablePlayer = { ...BOT_DEF, id: SCRIPT_ID, name: 'Script' }

/** The fields a script bot does not take: its stop, trailing and guard rules are its script's, its leverage and stake its sub-accounts'. */
const NOT_FOR_SCRIPT = ['reglages', 'seuilBas', 'seuilHaut', 'regle', 'stop', 'trailSeuil', 'trailDistance', 'pertesDeSuite', 'perteMise', 'tempsMort', 'coteInterdit', 'part', 'levier', 'startAccount', 'fixedStake', 'compose', 'attendu'] as const
const SUB_FIELDS = ['name', 'collateral', 'leverage', 'share', 'fixedStake']

/** A script bot's own fields: the text compiles to a function (`compileScript`, the page's), one or more sub-accounts each with all its fields (`sanitizeSubs`, the draft's reader), the drawings as the draft keeps them (`sanitizeDrawings`: a bad one is dropped). */
function resolveScript(spec: BotSpec, fail: (what: string) => never): ResolvedScript {
  for (const k of NOT_FOR_SCRIPT) if (spec[k] !== undefined) fail(`${k}: not for a script bot (its stop, trailing and rules are its script's, its leverage and stake its sub-accounts')`)
  if (spec.trail !== undefined && spec.trail !== false) fail("trail: not for a script bot (its trailing is its script's)")
  const text = spec.script
  if (typeof text !== 'string' || text.trim() === '') return fail("script: the script's text is expected")
  const c = compileScript(text)
  if (c.script === null) return fail(`script: ${c.error ?? 'no script'}`)
  const given: unknown = spec.subAccounts
  if (!Array.isArray(given) || given.some((s) => typeof s !== 'object' || s === null || !SUB_FIELDS.every((k) => k in s))) return fail('subAccounts: a list of { name, collateral, leverage, share, fixedStake }, at least one')
  const subs = sanitizeSubs(given, { leverage: null, share: SHARE_DEFAULT, fixedStake: null })
  if (subs === null) return fail('subAccounts: names distinct (1 to 24 characters), collateral above 0 or null, leverage a whole number from 1 or null, share in (0, 1], fixedStake above 0 or null')
  if (spec.drawings !== undefined && !Array.isArray(spec.drawings)) fail('drawings: a list')
  return { text, compiled: c.script, subs, drawings: sanitizeDrawings(spec.drawings ?? []) }
}

/** A bot with everything decided: the player's description, the settings in the order of `settings`, the thresholds, the rule, the stop, the share, the instant (ms). A composed bot (`compose`) has no player of its own: its `def` is the page's `BOT_DEF` row, without setting, threshold or rule, and its players are `compose.members`. */
export type ResolvedBot = ResolvedPlayer & { spec: BotSpec; stop: number | null; trailBox: TrailBox; trail: Trail | null; rules: Rules; share: number; startMs: number; leverage: number | null; /** The start account ($, `null` = auto) and the fixed stake ($, `null` = the `part` policy): `account.ts`'s `StakePolicy`. */ start: number | null; fixedStake: number | null; compose: ResolvedCompose | null; /** A script bot's script, `null` for a player's bot. */ script: ResolvedScript | null }

/** A bot's leverage: the one it asks, else the market's maximum (`leverageOf`, Lighter's margins). */
export const botLeverage = (r: ResolvedBot, margins: MarketMargins): number => r.leverage ?? leverageOf(margins)

/** A bot's account settings at `leverage` (`account.ts`'s `StakePolicy`). */
export const botPolicy = (r: ResolvedBot, leverage: number): StakePolicy => ({ leverage, share: r.share, start: r.start, fixedStake: r.fixedStake })

/** Why the leverage asked is above the market's maximum, `null` if all is well (no leverage asked = the maximum). */
export function leverageProblem(r: ResolvedBot, margins: MarketMargins): string | null {
  const max = leverageOf(margins)
  return r.leverage !== null && r.leverage > max ? `bot "${r.spec.id}": leverage ${r.leverage} above the maximum of market ${r.spec.marche} (${max})` : null
}

export function readBots(path: string): BotSpec[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = typeof parsed === 'object' && parsed !== null && 'bots' in parsed ? (parsed as { bots: unknown }).bots : parsed
  if (!Array.isArray(list)) throw new Error(`${path}: a list of bots is expected ({ "bots": [ ... ] })`)
  return list as BotSpec[]
}

export function writeBots(path: string, bots: BotSpec[]): void {
  writeFileSync(path, `${JSON.stringify({ bots }, null, 2)}\n`)
}

type PlayerGiven = Pick<BotDefinition, 'joueur' | 'reglages' | 'seuilBas' | 'seuilHaut' | 'regle'>

/** Checks a player (the bot of a single player, or one indicator of a composed bot) against its description: the same bounds as the fields of `/rsi`. `fail` says which bot and, by its prefix, which indicator. */
function resolvePlayer(spec: PlayerGiven, fail: (what: string) => never): ResolvedPlayer {
  const def = RSI_TABLE_PLAYERS.find((d) => d.id === spec.joueur)
  if (def === undefined) return fail(`joueur "${String(spec.joueur)}" unknown (ids: ${RSI_TABLE_PLAYERS.map((d) => d.id).join(', ')})`)
  const given = spec.reglages ?? {}
  for (const k of Object.keys(given)) if (!def.settings.some((s) => s.key === k)) fail(`setting "${k}" unknown for ${def.id} (keys: ${def.settings.map((s) => s.key).join(', ') || 'none'})`)
  const settings = def.settings.map((s) => {
    const v = given[s.key] ?? s.def
    if (typeof v !== 'number' || !Number.isFinite(v) || v < s.lo || v > s.hi) return fail(`setting "${s.key}" = ${String(v)} outside the bounds ${s.lo} to ${s.hi}`)
    return v
  })
  if (def.valid !== undefined && !def.valid(settings)) fail(`settings ${JSON.stringify(given)} not valid together for ${def.id}`)
  let low = NaN
  let high = NaN
  if (def.shape === 'zone') {
    low = spec.seuilBas ?? def.low
    high = spec.seuilHaut ?? def.high
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < def.bounds.lo || high > def.bounds.hi || low > high) fail(`thresholds ${String(low)} / ${String(high)} outside the bounds ${def.bounds.lo} to ${def.bounds.hi} (low <= high)`)
  }
  const rules: PlayerRule[] = def.shape === 'zone' ? ['zone', 'exit'] : def.shape === 'band' ? (def.rule === null ? [] : ['retour', 'cassure']) : def.rules.map((r) => r.id)
  const rule = (spec.regle === undefined ? def.rule : spec.regle) as PlayerRule
  if (rules.length === 0 ? rule !== null : !rules.includes(rule)) fail(`rule "${String(rule)}" unknown for ${def.id} (${rules.length === 0 ? 'this player has none' : rules.join(', ')})`)
  return { def, settings, rule, low, high }
}

const LINKS: BotLien[] = ['et', 'ou', 'filtre']
const SIDES: BotCote[] = ['les deux', 'long', 'short']

/** Checks a `compose` (`BotCompose`): a name, a side, one to `BOT_MAX` indicators each checked like a single player (and read from `lighter` candles, the only source), and one fewer links than indicators, each `et`, `ou` or `filtre`. */
function resolveCompose(c: BotCompose, fail: (what: string) => never): ResolvedCompose {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return fail('compose: an object { nom, cote, indicateurs, liens } is expected')
  if (typeof c.nom !== 'string') fail(`compose.nom ${JSON.stringify(c.nom)}: a string (empty allowed)`)
  if (!SIDES.includes(c.cote)) fail(`compose.cote ${JSON.stringify(c.cote)}: ${SIDES.join(', ')}`)
  if (!Array.isArray(c.indicateurs) || c.indicateurs.length < 1 || c.indicateurs.length > BOT_MAX) return fail(`compose.indicateurs: a list of 1 to ${BOT_MAX} indicators`)
  if (!Array.isArray(c.liens) || c.liens.length !== c.indicateurs.length - 1) return fail(`compose.liens: ${c.indicateurs.length - 1} link(s) for ${c.indicateurs.length} indicator(s) (one fewer than the indicators)`)
  for (const [k, l] of c.liens.entries()) if (!LINKS.includes(l)) fail(`compose.liens[${k}] ${JSON.stringify(l)}: ${LINKS.join(', ')}`)
  const members = c.indicateurs.map((ind, k) => {
    const at = (what: string): never => fail(`indicator ${k + 1}: ${what}`)
    if (typeof ind !== 'object' || ind === null || Array.isArray(ind)) return at('an object is expected')
    if (ind.source !== 'lighter') at(`source ${JSON.stringify(ind.source)}: "lighter" only`)
    return resolvePlayer(ind, at)
  })
  return { name: c.nom, side: c.cote, only: onlyOf(c.cote), members, links: c.liens }
}

/** Checks a line of `bots.json` against its player's description (the same bounds as the fields of `/rsi`); the error says which bot and which field. */
export function resolveBot(spec: BotSpec): ResolvedBot {
  const fail = (what: string): never => {
    throw new Error(`bot "${String(spec.id)}": ${what}`)
  }
  if (typeof spec.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(spec.id)) throw new Error(`a bot has a missing or unreadable id (letters, digits, _ . - only): ${JSON.stringify(spec.id)}`)
  if (spec.joueur === SCRIPT_ID) {
    if (spec.name !== undefined && typeof spec.name !== 'string') fail(`name ${JSON.stringify(spec.name)}: a text`)
    if (spec.paused !== undefined && typeof spec.paused !== 'boolean') fail(`paused ${JSON.stringify(spec.paused)}: true (launched paused, never started) or absent`)
    const script = resolveScript(spec, fail)
    const startMs = Date.parse(spec.debut)
    if (Number.isNaN(startMs)) fail(`debut "${String(spec.debut)}" is not a date (e.g. 2026-10-01T12:00:00Z)`)
    return { spec, def: SCRIPT_DEF, settings: [], rule: null, low: NaN, high: NaN, stop: null, trailBox: { on: false, seuil: 0, distance: 0 }, trail: null, rules: NO_RULES, share: SHARE_DEFAULT, startMs, leverage: null, start: null, fixedStake: null, compose: null, script }
  }
  for (const k of ['script', 'subAccounts', 'drawings', 'paused'] as const) if (spec[k] !== undefined) fail(`${k}: only for a script bot (joueur "${SCRIPT_ID}")`)
  const compose = spec.compose === undefined ? null : resolveCompose(spec.compose, fail)
  const { def, settings, rule, low, high } = compose === null ? resolvePlayer(spec, fail) : { def: BOT_DEF, settings: [] as number[], rule: null as PlayerRule, low: NaN, high: NaN }
  if (spec.name !== undefined && typeof spec.name !== 'string') fail(`name ${JSON.stringify(spec.name)}: a text`)
  const stop = spec.stop ?? null
  if (stop !== null && (typeof stop !== 'number' || !Number.isFinite(stop) || stop <= 0 || stop >= 100)) fail(`stop ${String(stop)}: a percentage between 0 and 100, or null`)
  // The trailing: three values, the box `trail` (boolean) and `trailSeuil`, `trailDistance` (percentages of price in [0, 100), 0 = empty). A bot without `trail` (launched before the box) reads `trail: false`, 0, 0. The trailing is in force only with the box checked and both values above 0.
  if (spec.trail !== undefined && typeof spec.trail !== 'boolean') fail(`trail ${String(spec.trail)}: a boolean (the box of the /rsi row)`)
  const trailBox: TrailBox = spec.trail === undefined ? { on: false, seuil: 0, distance: 0 } : { on: spec.trail, seuil: spec.trailSeuil ?? 0, distance: spec.trailDistance ?? 0 }
  for (const [name, v] of [['trailSeuil', trailBox.seuil], ['trailDistance', trailBox.distance]] as const) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 100) fail(`${name} ${String(v)}: a percentage from 0 included to 100 excluded`)
  const trail: Trail | null = trailBox.on && trailBox.seuil > 0 && trailBox.distance > 0 ? { seuil: trailBox.seuil, distance: trailBox.distance } : null
  // The four guard rules (`playerRules.ts`), absent or `null` = none: N an integer of at least 1, X in ]0, 100], the two durations in minutes, at least 1.
  const guardRule = (v: unknown, name: string, ok: (x: number) => boolean, words: string): number | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) fail(`${name} ${String(v)}: ${words}, or absent`)
    return v as number
  }
  const guards: Rules = {
    losses: guardRule(spec.pertesDeSuite, 'pertesDeSuite', (x) => Number.isInteger(x) && x >= 1, 'an integer of at least 1'),
    loss: guardRule(spec.perteMise, 'perteMise', (x) => x > 0 && x <= 100, 'a percentage above 0 and up to 100'),
    pause: guardRule(spec.tempsMort, 'tempsMort', (x) => x >= 1, 'minutes, at least 1'),
    ban: guardRule(spec.coteInterdit, 'coteInterdit', (x) => x >= 1, 'minutes, at least 1'),
  }
  const share = spec.part ?? SHARE_DEFAULT
  if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 1) fail(`part ${String(share)}: between 0 (excluded) and 1`)
  const leverage = spec.levier ?? null
  if (leverage !== null && (typeof leverage !== 'number' || !Number.isInteger(leverage) || leverage < 1)) fail(`levier ${String(leverage)}: an integer of at least 1 (at most the market's maximum), or absent for the maximum`)
  // The account settings (author, 2026-10-10): `startAccount` and `fixedStake` in $, above 0, absent = auto and the `part` policy.
  const dollars = (v: unknown, name: string): number | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${name} ${String(v)}: dollars above 0, or absent`)
    return v as number
  }
  const start = dollars(spec.startAccount, 'startAccount')
  const fixedStake = dollars(spec.fixedStake, 'fixedStake')
  if (spec.attendu !== undefined && readAttendu(spec.attendu) === null) fail(`attendu unreadable: all its fields are expected (heures, trades, gagnants, perdants, tradesParHeure, miseFixePct, comptePct, marche, levier, part; sansTrailing, if present: miseFixePct, comptePct, gagnants, trades)`)
  const startMs = Date.parse(spec.debut)
  if (Number.isNaN(startMs)) fail(`debut "${String(spec.debut)}" is not a date (e.g. 2026-10-01T12:00:00Z)`)
  return { spec, def, settings, rule, low, high, stop, trailBox, trail, rules: guards, share, startMs, leverage, start, fixedStake, compose, script: null }
}

/** A market name as it is written in an id: any character outside letters, digits, '_', '.', '-' becomes '_' (an id is a file name on Windows). */
export const idMarket = (market: string): string => market.replace(/[^A-Za-z0-9_.-]/g, '_')

/**
 * A bot's id: `<number>-<MARKET>` (author, 2026-10-08), e.g. `3-ANTHROPIC`. The number is unique in the family, all markets together, always grows and is never given twice, even after the bot is removed (the family's `bots.json` keeps `nextNumber`).
 * The bot's settings are not in its id: its name, indicators and launch time are in its definition.
 */
export const botIdOf = (n: number, market: string): string => `${n}-${idMarket(market)}`

/** The number and the market of an id of the form `<number>-<MARKET>`, `null` for any other id. */
export function parseBotId(id: string): { n: number; market: string } | null {
  const m = /^([1-9][0-9]{0,8})-([A-Za-z0-9_.-]+)$/.exec(id)
  return m === null ? null : { n: Number(m[1]), market: m[2] }
}

/** `resolveBot` with its refusal as a value: the reason in words, or the bot. The page's `lancer` goes through the very reader of `bots.json` and reports what it refuses. */
export function checkBot(spec: BotSpec): ResolvedBot | string {
  try {
    return resolveBot(spec)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** The reason a bot cannot run live, `null` when it can: the players that read the prints' delta need what the live warm-up (the data module's candles, no prints) does not give. */
export function notLiveReason(r: ResolvedBot): string | null {
  const blocked = (r.compose === null ? [r] : r.compose.members).find((p) => !playerRunsLive(p.def))
  if (blocked !== undefined) return `bot "${r.spec.id}": player ${blocked.def.id} reads the prints' delta, which the live warm-up (the data module's candles, no prints) does not give; it is not started live`
  return null
}

export function resolveBots(specs: BotSpec[]): ResolvedBot[] {
  const seen = new Set<string>()
  return specs.map((s) => {
    const r = resolveBot(s)
    if (seen.has(s.id)) throw new Error(`two bots carry the id "${s.id}"`)
    seen.add(s.id)
    return r
  })
}
