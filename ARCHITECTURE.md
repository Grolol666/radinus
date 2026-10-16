# Radinus — architecture

What the code does, read in it on 2026-10-16. The user's guide is [`README.md`](README.md).

## 1. How it runs

One Node program, started by hand (`node dist/radinus.mjs live --out runs/<family>`), that stays up. The bots compute as
the page does: the indicators, the signals, the fill rule, the stop, the trailing, the account and the liquidation are
the page's functions, in Radinus's own copy (`src/core/`). What it reads outside goes through one data module
(`src/sources/`, `--source`, `RADINUS_SOURCE`, `lighter` by default).

For each market that has at least one bot:

1. **At the market's start**: 24 hours of one-minute candles from the data module (`minutes`), the market's margins
   from Lighter (`/orderBookDetails`), and once the last prints (`lastPrints`) to measure the buy / sell spread.
2. **Continuously**: one socket for every market (channel `trade/<market>`). Each print received:
   - sets the clock (the fastest print of the last 5 minutes is taken as arrived at the very instant, `printClock.ts`);
   - goes to the paper exchange, which checks whether a stop-loss, a trailing or a liquidation is hit;
   - updates the minute being made.
3. **At each minute's close**, 200 ms after its end by the set clock: the candle is closed, each bot moves its
   indicator by one candle, decides, and sends its order with its stop-loss to the paper exchange, which fills it 300 ms
   later on the prints, on the unfavourable side.
4. **At each full hour**: one read of Lighter's funding (`/fundings`) for the open positions.
5. **A cut** (the feed lost, or the program stopped): on the return, the missed prints are read again (`ticks`) and given
   to the exchange at their own times; no decision for the blind minutes. A data module without prints history (Lighter)
   gives one print per closed minute instead, and the journal says so.

The `/bots` page (and the launch buttons of `/rsi` and `/bot`) talk to the program over a local connection,
`ws://127.0.0.1:4664`: the list of bots, their state, their journals, and the orders `lancer`, `arreter`, `reprendre`,
`retirer`, `levier`; `/bot` adds `modifier` and `definition`, and its `lancer` creates the script bot paused until
`reprendre`.

## 2. Its memory

Deliberately tiny, one copy per market, shared by all the bots of that market.

| What it keeps | How much | Why |
|---|---|---|
| one-minute candles | **24 hours** (1,440, `MARKET_BARS`) per market | an indicator at 240 minutes reads at most 2 x 240 + 2 candles back; the oldest leave |
| prints | **2 minutes** behind the last close (`TAPE_KEEP_MS` = `PRINTS_KEPT_MS`) per market, in typed arrays | an order's fill never looks at a print more than 60 s before the order; twice that is kept; a script's `state.prints(n)` is bounded to the same 2 minutes, on the page too |
| a script bot's bars | the last **2,000** (`CANDLES_KEPT`), from the 24 h seed on | its helpers index the bars from the seed's first, as on the page; each keeps its running state, never recomputed |
| ids of prints already seen | **3 minutes** (`SEEN_KEEP_MS`) | never to count a print twice after a cut |
| each bot's state | a small object | its indicator continued by one candle, its side, its position, its stop-loss, its trailing, its account |

No prints history, ever. A bot's work per minute does not grow with its age.

## 3. Its files

Everything is in the family's folder, for example `runs/essai/`, ignored by git.

| File | What it holds | Written | Read |
|---|---|---|---|
| `bots.json` | **the list of the family's bots**: each one's definition (market, player, settings, thresholds, rule, stop-loss, trailing, leverage, share, id, start), `nextNumber` and the retired ids | only when the list changes: a launch, a removal, a leverage change (and the conversion); never every minute | at start, first |
| `etat.json` | the current state only: each bot's (account, position, stop-loss set, trailing's best price, counters) and the last minute seen per market | rewritten whole at every minute and every event | at start, after `bots.json` |
| `journaux/<bot>.jsonl` | everything the bot did, one line per event, never rewritten | at every event of the bot | at a rebuild, if a bot's state is missing |
| `marche.json` | the markets' settings (margins, measured spread), the 200 ms wait, the clock, the page's port and origins | at start | at a restart |
| `programme.jsonl` | the program's life: starts, stops, cuts, launches, removals, leverage, the prints' delays | at every event | never: it is for the reader |

The `bots.json` given with `--bots` is something else: a starting list, outside the folder; the program creates the
bots the family does not know yet, never writes it, and refuses a `--bots` that points at the folder's own `bots.json`.
The files' JSON keys are French and stay so (README, "The journals' JSON keys stay French").

## 4. Its code

| File | Lines | What it does |
|---|---|---|
| `direct.ts` | 692 | **three jobs**: the start (markets, clock, server), the family's files, the orders from the page |
| `engine.ts` | 519 | the markets and their bots: the closes, the hours, adding and removing a bot |
| `scriptBot.ts` | 474 | a `/bot` script run live, one paper account per sub-account |
| `live.ts` | 435 | the live feed: the wait, late prints, cuts and the catch-up, the hour's funding |
| `exchange.ts` | 374 | the paper exchange: the fake account, the fill, the stop-loss, the trailing, the liquidation |
| `rebuild.ts` | 302 | a bot's state rebuilt from its journal, when `etat.json` lost it |
| `controler.ts` | 245 | the `control` verb: a journal compared with the page's simulation |
| `cli.ts` | 242 | the command line, its English verbs and flags and the French aliases |
| `server.ts` | 240 | the connection with the page |
| `bots.ts` | 239 | reading and checking a bot's definition, its id |
| `bot.ts` | 233 | a bot: it decides, sends, learns what the exchange tells it, writes its journal |
| `market.ts` | 218 | a market's memory: candles, prints, the minute being made, the spread |
| `printClock.ts` | 158 | the clock set on the prints |
| `sources/` | 298 | the data modules (`lighter.ts`, and any other a tree adds) and their interface (`types.ts`) |
| the others | < 150 each | the seams (`seam.ts`), the injected clock, the journal, the recorded replay, the host guard, the ids' renumbering |
| `core/` | 8,801 (23 files) | the copy of the page's functions; browser-only parts cut, each cut marked `// Cut for radinus` |

`direct.ts` is due to be split by jobs: first its functions grouped by job inside the file, then sub-files.

## 5. The family files (2026-10-06, 2026-10-08)

- **At start**: `bots.json` first (who the bots are), then `etat.json` (where they stand), then the journal
  (`rebuild.ts`) for a bot whose state is missing. A damaged `etat.json` no longer loses a bot's definition.
- **`--bots`**: a starting list outside the folder, which only adds the ids unknown to the family, never written.
- **Conversion**: a folder whose `etat.json` carries `definitions` (or the older `lances`, or `retires`) and has no
  `bots.json` is converted at its first start; one `conversion` line in `programme.jsonl`.
- **Bot ids**: `<number>-<MARKET>` (`1-BTC`, `3-ANTHROPIC`). The number is unique in the family, always grows and is
  never reused: `bots.json` holds `nextNumber` and keeps the retired ids. A `--bots` entry keeps its id only if it is
  `<number>-<MARKET>` with a free number; otherwise it takes the next number and its old id becomes `formerId`.
- **Renumbering** (once, at the first start of a family whose `bots.json` has no `nextNumber`): every bot, active and
  retired, gets a number in launch order; journals renamed, `etat.json` re-keyed, one `renumbering` line with the mapping.
