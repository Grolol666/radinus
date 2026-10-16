import { SHARE_DEFAULT } from './account'
import { BOT_ID } from './botFlips'
import { sanitizeDrawings } from './chartDrawings'
import type { Drawing } from './chartDrawings'
import { SCRIPT_ID } from './radinusMessages'
import { sameSubs, sanitizeSubs } from './subAccounts'
import type { SubAccount } from './subAccounts'
// Stub for radinus: `BotsConnection` / `LaunchState` are the /bots page store's types (botsStore.ts, browser-only), copied here as they are.
type BotsConnectionState = 'connexion' | 'connecte' | 'ferme' | 'refuse'
type BotsConnection = { state: BotsConnectionState; address: string; refus: string | null }
type LaunchState = { state: 'envoi' } | { state: 'lance'; id: string } | { state: 'refus'; raison: string }
import type { TablePlayer } from './players'
import type { BotCompose, BotDefinition, BotLife } from './radinusMessages'
// Stub for radinus: `PlayerFields` / `RsiSettings` are the /rsi page store's types (rsiStore.ts, browser-only), copied here as they are.
import type { PlayerRule } from './players'
import type { SearchCritere } from './playerSearch'
type StakeMode = 'part' | 'fixed'
type RsiSettings = { marketId: number | null; priceDecimals: number | null; symbol: string | null; periodDays: number; fundingOn: boolean; stopStep: number; share: number; levier: number | null; start: number | null; stakeMode: StakeMode; fixedStake: number; critere: SearchCritere; minTrades: number }
type PlayerFields = { settings: number[]; low: number; high: number; rule: PlayerRule; stop: number | null; trail: boolean; trailSeuil: number | null; trailDistance: number | null; guardLosses: number | null; guardLoss: number | null; guardPause: number | null; guardBan: number | null }

/** Whether the program can run this player live: the ones that read the delta of the prints need what the live seed (minute candles, no prints) does not give. `radinus/bots.ts` asks the same question, so the button and the program agree. */
export function playerRunsLive(def: TablePlayer): boolean {
  return !('needs' in def && def.needs === 'delta')
}

/** Why a launch cannot go now for the sake of the connection to Radinus, `null` when it is connected and no launch is awaiting its answer. Used by `/bot`'s `launch` / `modify`. */
export function connectionWhy(connection: BotsConnection, launch: LaunchState | null): string | null {
  return connection.state === 'connecte'
    ? launch?.state === 'envoi'
      ? 'sending to Radinus…'
      : null
    : connection.state === 'connexion'
      ? `connecting to Radinus (${connection.address})…`
      : connection.state === 'refuse'
        ? 'Radinus refused this page: its origin is not in the list of marche.json (serveur.origines; --origins adds one)'
        : `Radinus is not running (${connection.address})`
}

/**
 * The bot of `/bot` as the definition `launch` sends: its composition (`joueur` being `BOT_ID`), and the bot row's own stop, trailing (its box and both values), guard rules, and the page's account settings (share, leverage, start account, stake policy) as the row shows
 * them at the click; an empty guard rule is left out. Nothing is recomputed. The id and the start are the program's to give.
 */
export function composedDefinitionOf(market: string, compose: BotCompose, fields: PlayerFields, account: Pick<RsiSettings, 'share' | 'levier' | 'start' | 'stakeMode' | 'fixedStake'>): BotDefinition {
  const { guardLosses, guardLoss, guardPause, guardBan } = fields
  const { share, levier, start, stakeMode, fixedStake } = account
  return {
    marche: market,
    joueur: BOT_ID,
    compose,
    stop: fields.stop,
    trail: fields.trail,
    trailSeuil: fields.trailSeuil ?? 0,
    trailDistance: fields.trailDistance ?? 0,
    ...(guardLosses === null ? {} : { pertesDeSuite: guardLosses }),
    ...(guardLoss === null ? {} : { perteMise: guardLoss }),
    ...(guardPause === null ? {} : { tempsMort: guardPause }),
    ...(guardBan === null ? {} : { coteInterdit: guardBan }),
    part: share,
    ...(levier === null ? {} : { levier }),
    ...(start === null ? {} : { startAccount: start }),
    ...(stakeMode === 'fixed' ? { fixedStake } : {}),
  }
}

/**
 * `/bot`'s bot as the definition `launch` (and `modify`) sends: the script's text, the sub-accounts as the page holds them, the chart's drawings of the bot's market, the market's name and the bot's name (left out when empty).
 * Nothing is recomputed; `radinus/bots.ts` checks it. The id and the start are the program's to give.
 */
export function scriptDefinitionOf(market: string, name: string, script: string, subs: readonly SubAccount[], drawings: readonly Drawing[]): BotDefinition {
  return { marche: market, joueur: SCRIPT_ID, ...(name.trim() === '' ? {} : { name: name.trim() }), script, subAccounts: subs.map((s) => ({ ...s })), drawings: drawings.map((d) => ({ ...d })) }
}

/** Whether the page's script, sub-accounts or drawings differ from a loaded bot's definition (what Radinus runs until a `modify`): `/bot` says `modified`. The name and the market are not compared (a `modify` does not move a bot). */
export function definitionDiffers(def: BotDefinition, script: string, subs: readonly SubAccount[], drawings: readonly Drawing[]): boolean {
  if (def.script !== script) return true
  const theirs = sanitizeSubs(def.subAccounts, { leverage: null, share: SHARE_DEFAULT, fixedStake: null })
  if (theirs === null || !sameSubs(theirs, subs)) return true
  return JSON.stringify(sanitizeDrawings(def.drawings ?? [])) !== JSON.stringify(sanitizeDrawings(drawings))
}

const LIFE: Record<BotLife, string> = { attente: 'starting', dehors: 'running', long: 'running · long', short: 'running · short', arrete: 'paused', liquide: 'liquidated', epuise: 'exhausted' }
/** A bot's state in the words of `/bot`'s head and `load` popup (`arrete` = paused: stopped, or launched paused and never run). */
export const lifeWords = (etat: BotLife): string => LIFE[etat]
