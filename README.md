# radinus

Trading bots **on paper**, against [Lighter](https://lighter.xyz)'s public market data. A bot is a rule frozen as JSON:
an indicator (RSI, stochastic, Bollinger, MACD, ... 32 of them) with its settings, its thresholds, its rule and its
stop-loss, or a small JavaScript script. Radinus replays bots on recorded prints, or runs them live minute by minute on
a fake account (fills, stop-loss, trailing, liquidation, funding), and writes one journal per bot.

**What it never does**: it holds no key, sends no order, and talks to one host only: `api.rh.lighter.xyz` (Lighter's
public API, no account needed). Every outside call is counted and printed when the program stops; any other host is
refused.

Repository: <https://github.com/Grolol666/radinus>. Licence: MIT ([`LICENSE`](LICENSE)).

## Quick start

```
git clone https://github.com/Grolol666/radinus.git
cd radinus
pnpm install
pnpm run build                      # typecheck, then bundle -> dist/radinus.mjs

node dist/radinus.mjs --help

# live, on paper, the two example bots (Ctrl+C stops; --duration 10 stops after 10 minutes)
node dist/radinus.mjs live --bots bots.example.json --out runs/first --port 0
```

Node 24 and pnpm are needed. [`bots.example.json`](bots.example.json) holds two bots on Lighter's ANTHROPIC perp: an RSI
and a Bollinger band, each with a stop-loss. The four verbs:

- **`replay`** plays a recorded prints file through the bots (no network at all), **`resume`** takes up an interrupted replay.
- **`live`** runs the bots live on a **data module** (`src/sources/`, Lighter's public data by default) and the PC's clock; it can also serve a local page on `127.0.0.1` (below).
- **`control`** compares a live bot's journal with an offline replay of the same hours (it needs a data module that keeps prints history).

The bots compute with the functions of a companion web app (its `/rsi` table of indicators and its `/bot` script
editor, not part of this repository), in Radinus's **own copy** of them, `src/core/`: browser-only parts are cut, each cut
marked `// Cut for radinus` or `// Stub for radinus`.

## Build and run, in full

```
pnpm install          # typescript, esbuild, @types/node, ws
pnpm exec tsc         # typecheck
pnpm run build        # tsc, then esbuild -> dist/radinus.mjs

node dist/radinus.mjs replay \
  --data prints.json --bots bots.json --out runs/a \
  --market ANTHROPIC --decimals 1 --margins 2000/1200 --liquidation-fee 1 [--until 2026-10-02T12:00:00Z]

node dist/radinus.mjs resume  --out runs/a [--data prints.json]

node dist/radinus.mjs live    [--bots bots.json] --out runs/<name> [--wait MS] [--duration MINUTES] [--port PORT] [--origins A,B] [--source NAME]
node dist/radinus.mjs control --out runs/<name> --bot <id> [--source NAME]

node dist/radinus.mjs --help
```

**Earlier names.** The French verbs and flags of earlier versions still work for one release, each printing its English
name once: `rejouer` = `replay`, `continuer` = `resume`, `direct` = `live`, `controler` = `control`; `--donnees` = `--data`,
`--sortie` = `--out`, `--marche` = `--market`, `--decimales` = `--decimals`, `--marges` = `--margins`,
`--frais-liquidation` = `--liquidation-fee`, `--marche-fichier` = `--market-file`, `--ecart-ticks` = `--spread-ticks`,
`--ecart-pct` = `--spread-pct`, `--sans-ecart` = `--no-spread`, `--jusqua` = `--until`, `--attente` = `--wait`,
`--duree` = `--duration`.

- **`replay`** plays a recorded prints file (an array of `{ t, px, size, ask, id }`) through the list of bots *as if it arrived live*, writes one journal per bot (`<out>/journaux/<id>.jsonl`) and prints each bot's summary: trades, wins, losses, PnL in $, PnL in % of the stake, account, state (active, liquidated), leverage, stop, and a warning first if a bot's stop is at the liquidation or behind it. `--until` stops the replay before the first print dated at that instant (the interruption `resume` takes up).
- **`resume`** takes up an interrupted replay **from the folder's own files** (`marche.json`, `bots.json`, `journaux/`, and the prints file, whose path is in `marche.json`). The replay is deterministic: it is redone from the start of the data, every line already written in a journal is **compared** with the one the replay produces (a difference stops everything), then the rest is appended. A replay interrupted and resumed gives the same journals, byte for byte, as one without interruption. The journal's times are the data's, never the machine's.

### A market's margins are inputs

Nothing is a table in the code. Margins as Lighter publishes them (`/orderBookDetails`, hundredths of a percent: `200` = 2 %): `--margins INITIAL/MAINTENANCE`, `--liquidation-fee PCT` (% of the notional), `--decimals N` (the price's decimals: the tick of the page's band), or a `--market-file market.json` that gives them:

```json
{ "nom": "ANTHROPIC", "decimales": 1, "margeInitiale": 2000, "margeMaintien": 1200, "fraisLiquidation": 1 }
```

The maximum leverage is `10000 / initial margin` (rounded down, the page's `leverageOf`): 2000 gives x5, 200 gives x50. The median spread the page's fill rule reads (`ecartTicks`, `ecartPct`) is also a market input: if it is not given (`--spread-ticks T --spread-pct P`, or `--no-spread`), `replay` measures it once over the whole file with the page's band (`opportunityTape`) and writes it in `marche.json`. An optional `funding` (UTC hour index -> value of the `fundings` API) enters the PnL as on the page.

### `bots.json`

```json
{ "bots": [
  { "id": "1-ANTHROPIC", "marche": "ANTHROPIC", "joueur": "rsi", "stop": 0.6, "debut": "2026-10-01T10:00:00Z" },
  { "id": "2-ANTHROPIC", "marche": "ANTHROPIC", "joueur": "bollinger", "reglages": { "period": 20, "k": 2 }, "regle": "retour", "stop": 0.4, "part": 0.9, "debut": "2026-10-01T10:00:00Z" }
] }
```

`joueur` = the id of a `/rsi` row (`rsi`, `stoch`, `cci`, `mfi`, `rsistoch`, `uo`, `zscore`, `bollinger`, ... `cvd`: 32 of them). `reglages`: by key of the player's description (a key left out keeps the page's default; the bounds are those of the `/rsi` fields). `seuilBas` / `seuilHaut` and `regle` for a zone oscillator (`zone` or `exit`), `regle` for a band (`retour` / `cassure`) or the MACD (`cross` / `zero`). `stop` in % of the fill price (absent or `null` = none). `part` = the share of the account at stake (0.9 by default). `debut` = the launch instant: the bot starts **out** and enters at its first signal after it. The output folder's `bots.json` is rewritten at the end of each verb, with an `etat` per bot: an output, never read again.

`startAccount` ($, absent = auto, `100 / L / part`) and `fixedStake` ($, absent = the `part` policy: each trade stakes `account x part`; present: each trade stakes that many $, no reinvestment) are the account settings of `/rsi` and `/bot` (`core/account.ts`). A fixed stake above the account at an entry: no entry, the bot halts (`arret_regle`, cause `stake`, until `reprendre`), as the guard rules do.

## Data modules: `src/sources/`

`live` and `control` read the outside world through one interface, `LiveLoaders` (`src/sources/types.ts`): `connect`, `trades` (the pushed prints of a market), `connection` / `onConnection`, `minutes` (1-minute candles from an instant), `ticks` (past prints of a range), `lastPrints`, `fundingPage`, `markets`, `limits`. A module is a file `src/sources/<name>.ts` that exports `source: { name, fetchHosts, socketHosts, loaders }`; `--source <name>` loads it **by name**, so a module can be left out of a tree without any other file naming it. `RADINUS_SOURCE` selects the default data module (else `lighter`).

This tree ships **`lighter`**: Lighter's public API at `api.rh.lighter.xyz`, no key, nothing else.

| Loader | Lighter | Notes |
|---|---|---|
| `trades` | WebSocket `wss://api.rh.lighter.xyz/stream`, channel `trade/<id>` | one socket for every market; reconnects by itself (1 s doubling to 30 s) |
| `minutes` | `GET /api/v1/candles`, 500 one-minute rows a call, walked forward | 1-minute history back to mid-July (BTC), mid-August (ANTHROPIC) |
| `lastPrints` | `GET /api/v1/recentTrades`, at most 100 | ~30 s of ANTHROPIC |
| `ticks` | **derived from the minute candles**: one print per closed minute, at its close price, stamped at the minute's last millisecond, with the minute's last trade id and its volume, side unknown (0); flagged `synthetic` | Lighter has no prints history |
| `fundingPage`, `markets`, `limits` | `/fundings`, `/orderBookDetails` | |

What `synthetic` changes: the warm-up never uses `ticks` (it reads `minutes`). The catch-up after a cut does: it writes `rattrapage_incomplet` with the reason, and the exchange sees one print per minute for the gap. `control` needs a bot's real prints and refuses a synthetic source.

`guard.ts` wraps `fetch` and `WebSocket`: any host outside the chosen module's lists is refused, and every call is counted and printed at the stop (`calls made: ...`).

## What is in `src/`

| File | Role |
|---|---|
| `seam.ts` | the two seams: bot / exchange (`Order`, `ExchangeEvent`, `Exchange`) and data (`Print`, `Sink`, `DataSource`) |
| `market.ts` | a market's data, **once**, bounded: 24 h of closed candles, a window of prints, the minute being made |
| `indicator.ts` | a bot's indicator, continued by one candle; its side conditions (`playerFlips`) |
| `bot.ts` | the bot: decides at the close, sends the order with its stop, watches its position through the events, writes its journal |
| `exchange.ts` | the paper exchange: the fake account (fills, holds the stop-loss, triggers it, liquidates) |
| `engine.ts` | the clock and the events in time order; a market's list of bots |
| `replayer.ts` | the replay's source: the recorded file, delivered as if live |
| `live.ts` | the live source: the data module and the PC's clock behind the same seam (`LiveSource` / `LiveSink`); the wait, late prints, cuts, the funding |
| `sources/` | the data modules and their interface (above) |
| `clock.ts`, `printClock.ts` | the PC's clock, injected (`RawClock`: the wall, a monotonic clock, a relative wait), and the clock the logic reads: the PC's set on the prints |
| `direct.ts` | the `live` verb: the markets, one engine and one source per market, the journals, the folder's `bots.json` and `etat.json`, the console |
| `rebuild.ts` | a bot rebuilt from its journal (`etat_reconstruit`): the definition and the state `etat.json` would have said |
| `controler.ts` | the `control` verb: a bot's journal against the page's replay |
| `guard.ts` | what leaves the PC: the data module's hosts, counted |
| `server.ts` | the page server (`ws`, `127.0.0.1` only): the origin check, the send queue, the messages |
| `scriptBot.ts` | a `/bot` script run live on paper, one paper account per sub-account |
| `journal.ts`, `bots.ts`, `run.ts`, `renumber.ts`, `cli.ts` | the journal, `bots.json`, a replay end to end, the bot ids, the command line |
| `core/` | Radinus's copy of the page's functions (indicators, players, fill and stop rules, account, Lighter readers, the socket, the page messages) |

### The two roles

**The bot** continues its indicator by one candle at a minute's close, reads its side conditions, decides (`decideSide`, the page's decision) and **sends an order with its stop-loss attached**; it **watches its position** through what the exchange tells it. It fills nothing, triggers nothing, liquidates nothing. **The exchange** (`PaperExchange`) fills the order at the close plus the page's latency (300 ms), holds the stop, triggers it on the first print that reaches it (then exits at market the latency later), liquidates, and tells the bot. The page and the bot share `placeOrder`, `bookClose`, `firstHit`, `stopExitAt`, `fillStop`, `decideSide` (`core/playerStop.ts`).

### The minute closes by the clock

`Sink.clock(ms)` says "everything dated `ms` or before has arrived"; the finished minute closes then, not at the next trade (a quiet market included: a minute without a print becomes a flat candle at the previous close, as the page builds it). An order is filled when the clock passes its fill instant. In `replay` the clock is the next print's time minus 1 ms.

## The 24 hours that leave

The market keeps only the last 1,440 closed candles. Each bot holds a window of references to them and its output arrays, counted **from its first candle**. Older entries are deleted, with no recomputation and no new warm-up: pure windows (CCI, MFI, Ultimate, Z-score, Bollinger, envelopes, SMA, Donchian, Aroon, Vortex, Ichimoku, Awesome, Momentum, CMF) read only their period (at most 240); recurrences (EMA, MACD, TRIX, TSI, Force, Heikin-Ashi, SuperTrend, Parabolic SAR, ATR stop, ADX, OBV, cumulative delta, daily VWAP, RSI) carry their state **in their output**; the stochastic keeps two queues of indices; the warm-ups that read from index 0 fall in the first 481 candles, which the bot all receives before the first one leaves. Every backward read is under 2 x 240 + 2 candles: the players' settings are bounded at 240, and `bots.json` is refused beyond.

Cost: **at a minute's close**, per bot, one indicator step, the side conditions on 2 candles, one decision; per market, one closed candle. **At a print**, per market, one append; per bot in position, two comparisons (liquidation, stop). Nothing depends on a bot's age.

## The fake account

Each bot has its account, at the market's maximum leverage `L` (`10000 / initial margin`) and with the share `s` (0.9):

| | formula |
|---|---|
| starting account | `100 / L / s` (2.22 $ at x50, 36.67 $ at x3, for 100 $ of notional at start) |
| a trade's stake | `account x s` |
| notional | `stake x L` |
| PnL in $ | the page's PnL (per 100 $, funding included if given) `x notional / 100`; added to the account |
| PnL in % of stake | `PnL $ / stake x 100` |

**Liquidation.** The whole account is the collateral. For a position of `q = notional / entry price` units, at price `p`: `equity = account + side x q x (p - entry)` and `maintenance margin = m x q x p`, `m = maintenance margin / 10000`. With `x = s x L` (with `fixedStake`, `x = notional / account` at the entry):

```
long  : liquidated when p <= entry x (1 - 1/x) / (1 - m)
short : liquidated when p >= entry x (1 + 1/x) / (1 + m)
```

A bot whose stop is at that distance or behind it is **flagged** (`stopDerriereLiquidation` in its journal, `WARNING` in the summary). A liquidation costs the stake and the market's liquidation fee, never below 0; the journal writes `liquidation` (never a losing trade); the bot stops. Left aside: Lighter's mark price (the last trade is read), fees and funding accrued during the trade, Lighter's staged liquidation, the insurance fund.

## Live

```
node dist/radinus.mjs live [--bots bots.json] --out runs/<name> [--wait MS] [--duration MINUTES] [--port PORT] [--origins A,B] [--source NAME]
```

**`--bots` is optional.** Without it, the program starts with no bot, follows no market and makes no outside call: it opens its server and waits for launches from the page. With it, the file is the starting list, read at start and never rewritten. **A folder owns all its bots**: a restart takes each one up with its state, with or without `--bots`; on a folder that has lived, `--bots` only **adds** the bots whose id the folder does not know. A player that reads the prints' delta (`cvd`) is refused live: the warm-up is made of candles, without prints. Ctrl+C (or `--duration`) stops cleanly with each bot's summary; **open positions stay open** in `etat.json`, and the next `live` on the same folder takes them up.

### What is read outside, and how often

Said at start, counted at the stop.

| Call | When | How many |
|---|---|---|
| the data module's socket, `trade/<market>` | all the time | **one** socket for every market, one subscription per market |
| `/orderBookDetails` (every market) | at start | 1 (the numbers and the decimals) |
| `/orderBookDetails?market_id=` | at start | 1 per market (margins, liquidation fee) |
| the minutes | at start | 24 h of minutes per market (3 calls on Lighter) |
| the last prints | at start, **a fresh start only** | 1 per market, to measure the spread (`ecartLecturePrints`, 20,000 asked, 100 on Lighter); none when it is 0 or on a restart |
| `/fundings` | one minute after each full hour | at most 1 per market and per hour, **none** if no bot held a position at the mark; a second read one minute later if the row is missing |
| past prints (`ticks`) | after a cut or a restart | the catch-up |

No polling, no loop on a failure: a read that fails is written, and retried at the next natural occasion.

### Settings in `marche.json`

| Key | Default | What it is |
|---|---|---|
| `attenteMs` | 200 | the wait after a minute's end before closing it (`--wait` replaces it), under the fill rule's 300 ms |
| `financement` | yes | funding on the paper account |
| `horloge.correction` | yes | `false` = the PC's time as it is; the measures are still made and written |
| `horloge.fenetreMinutes` | 5 | the window of the smallest gap (below) |
| `horloge.seuilJournalMs` | 100 | the estimate is written in `programme.jsonl` when it moved more than this |
| `horloge.sautMs` | 100 | a jump of the PC's wall clock larger than this between two prints is written (`horloge_saut`) |
| `ecartLecturePrints` | 20000 | how many last prints measure the spread; **0 = no read** |
| `marches.<name>.ecartTicks` / `ecartPct` | measured | the fill spread, **written by the program at start**; with `ecartLecturePrints: 0`, the value written by hand (`null` = fill at the last print) |
| `serveur.port` / `serveur.origines` | 4664 / localhost | the page server; see "The `/bots` page" |

At the program's instant `now` (the PC's time set on the prints), the horizon is `h = now - wait`: everything dated `h` or before is taken as arrived. A print that arrives is set aside and delivered once `h` has reached it, in (t, id) order, each preceded by `clock(t - 1)`: the replay's own path. A minute closes when `h` passes its end, with or without a print.

### The clock is set on the prints

The program cannot tell a clock's lag from a print's travel time: it sees `arrival (PC) - print's time`. It keeps the **smallest** of these gaps over the prints of the last `fenetreMinutes`, of **every** market, and reads the time as "the PC's time minus that smallest gap": the fastest print is taken as arrived at the very instant, so the clock lags by the fastest one's travel time and never leads; the wait covers the rest. The gaps are held on the PC's **monotonic** clock, so a reset of the wall clock can never close a minute early; the jump is still seen and written (`horloge_saut`). Before the first print, the PC's time is read as it is. The estimate is written in `programme.jsonl` (`horloge_estimee`, `horloge`, `delais`) and said at the console.

### The fill spread is measured at start

The page's fill rule reads the market's median spread: without it, the bot fills at the last print; with it, on the unfavourable side when the last print of the right side is older than 60 s. At a fresh start, per market, the program reads the last prints **once**, measures the spread with **the page's function** (`opportunityTape`), writes it in `marche.json` and in `programme.jsonl` (`ecart_mesure`) and says it. If the read fails or too few buy / sell pairs exist, the spread is **not guessed** (`ecart_non_mesure`, fill at the last print). A restart never measures again (`ecart_garde`); `ecartLecturePrints: 0` keeps the file's value (`ecart_fichier`). On Lighter the read gives 100 prints at most, so the measure is coarser than on 20,000.

### Late prints, cuts, restarts

- **A late print** (arrived after its minute was closed): `print_en_retard` in each bot's journal; the closed candle is not rewritten; the exchange reads it (a stop is a stop).
- **A cut**: `flux_perdu` / `flux_revenu` in each bot's journal. **During the cut the sink's clock does not move**. On the return, the program reads the missed prints (`ticks`) from the loss's horizon minus 5 s, joins those the socket gave meanwhile (de-duplicated by id) and delivers them in order: the exchange sees them at their own instants (a stop or a liquidation of the cut is written with `pendantCoupure: true`), the candles are built, and **the bot does not decide** on the minutes that close this way (`minute_sans_decision`). A failed read writes `rattrapage_incomplet`.
- **A stop and a restart are the same thing**: `etat.json` is rewritten (temporary file then rename) at each journal line and each minute. A folder that has one is a restart: the warm-up stops at the minute the program held open, each bot is read again (`redemarrage`), and the time in between is a cut (`cause: arret_du_programme`).
- **The program never forgets a bot in silence**: before writing anything, a bot whose journal exists but whose state is missing is **rebuilt from its journal** (`rebuild.ts`, `etat_reconstruit`), or the program **stops with a sentence** naming the bot and the reason, having written nothing.

### What a `live` folder holds

- `bots.json`: **the family's list**: each bot's definition (wherever it came from, `--bots` or the page), `nextNumber`, `retires`. Written only when the list changes. Not the starting `--bots`, which stays outside the folder.
- `etat.json`: the current state only, per bot and per market.
- `journaux/<id>.jsonl`: one journal per bot, never deleted; its first line (`demarrage`) carries the bot's whole definition.
- `marche.json`: the settings (above) and, per market, its margins, number and measured spread.
- `programme.jsonl`: the program's life.

**Bot ids** are `<number>-<MARKET>` (`1-BTC`, `3-ANTHROPIC`), the number from the family's `nextNumber`: unique, growing, never reused. A launch may carry an optional `name`.

### Funding on the paper account

At each full hour H the exchange notes the positions held at that instant. One minute later, if there are any, the program reads Lighter's `fundings` page; the hour's row gives `-side x size x value`, added to the account, `funding` written. A missing row: a second read one minute later, then `funding_manquant`, never guessed. A trade's PnL is the price's alone; the funding is in the account. `financement: false`: no mark, no read.

### `control`

```
node dist/radinus.mjs control --out runs/<name> --bot <id> [--source NAME]
```

Reads, changes nothing. From the bot's journal: its settings, its launch, the last closed minute. From the data module: the candles and the prints of its life. It runs the page's replay (`replayStop` and its functions) with the bot's settings and prints, trade by trade, what the journal and the page say, then the **first difference with its cause** when the journal gives one (a cut, a late print, a minute closed by the clock without a print, a liquidation). Exit code 0 when there is no difference, 2 otherwise. It needs real prints: a synthetic source (`lighter`) is refused.

## The `/bots` page (the companion web app)

`live` opens a WebSocket server on **`127.0.0.1` only**, port **4664** by default (`--port N`; **`--port 0` = no server**). A taken port does not stop the bots: the program says so and plays without the page.

- **The messages** (JSON) are in `core/radinusMessages.ts`, a copy of the file the page imports. Program to page: `etat`, `bot`, `programme`, `ligne`, `journal`, `retire`, `refus`, `lance`, `modifie`, `definition`. Page to program: `arreter`, `reprendre`, `retirer`, `levier`, `lancer`, `modifier`, `definition`, `journal`.
- **The origin.** `marche.json` holds `serveur: { port, origines }`, the visible list of accepted origins: by default `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173` (Vite's dev server and preview). `--origins a,b` (or `RADINUS_ORIGINS`) adds others, and they are written to the list. A missing or unlisted origin is refused: the handshake is closed with code 4403 without sending anything, and `page_refusee` is written. No password.
- **The verbs**: `arreter` (no more decisions; the pending order cancelled; an open position closed at market, motif `arret`), `reprendre` (decides again at the next close, starting out), `retirer` (an `arreter`, then the bot leaves the list once flat; its journal stays), `levier` (the leverage of the next entries), `lancer` (a bot from the page: the same reader as `bots.json`, an id from the program), `modifier` and `definition` (a script bot).
- **The server never slows the bots down**: every send is without waiting, a page's send queue is bounded (1 MB) and a page that no longer reads is cut (`page_abandonnee`).

## Script bots (`/bot`)

A `bots.json` entry (or a `lancer` from `/bot`) with `joueur: "script"`:

```json
{ "id": "7-BTC", "marche": "BTC", "joueur": "script", "name": "cross", "debut": "2026-10-10T12:00:00Z",
  "script": "(s) => s.close ? { account: 'sub1', stop: 0.5, enter: s.ema(5) > s.ema(20) ? 'long' : 'short' } : null",
  "subAccounts": [{ "name": "sub1", "collateral": 100, "leverage": 5, "share": 0.9, "fixedStake": null }],
  "drawings": [] }
```

No `stop`, trailing, guard rules, `part`, `levier`, start or stake at the top: they are the script's and the sub-accounts'. `src/scriptBot.ts` runs it as the page's replay does: one call at every print and every minute close; each decision names a sub-account, and each sub-account is its own `PaperExchange`. The helpers read the last 2,000 bars (`CANDLES_KEPT`); `state.prints(n)` gives the prints of the last 2 minutes (`PRINTS_KEPT_MS`). The call budget is 50 ms (`SCRIPT_BUDGET_MS`): over it the call is made once more (`appel_lent`), over it twice every sub-account is paused (`script_echec`). A bot launched with `paused: true` is listed and does nothing until its first `reprendre`. `rebuild.ts` does not rebuild a script bot, and `control` refuses one.

## The journals' JSON keys stay French

The journals (`journaux/*.jsonl`, `programme.jsonl`), `bots.json`, `marche.json` and `etat.json` are read by the companion web app's `/bots` page: **their keys, event names and coded values are French and unchanged** (the one French thing left; renaming them waits for the page). Some free-text values written as literals (a few `raison`, `remarque`, `note` strings) are French too.

- Event names (`evenement`): `demarrage`, `redemarrage`, `decision`, `entree`, `stop_touche`, `sortie`, `liquidation`, `funding`, `funding_manquant`, `minutes_sans_donnee`, `minute_sans_decision`, `print_en_retard`, `flux_perdu`, `flux_revenu`, `rattrapage_incomplet`, `ordre_sans_prix`, `compte_epuise`, `arret`, `arret_demande`, `arret_regle`, `reprise`, `retrait`, `levier_change`, `etat_reconstruit`, `fin`, `appel_lent`, `script_echec`, `script_ignore`, `print`, `close_order`, `modifie`; in `programme.jsonl` also `demarrage_programme`, `redemarrage_programme`, `arret_programme`, `conversion`, `renumbering`, `ecart_mesure`, `ecart_garde`, `ecart_fichier`, `ecart_non_mesure`, `horloge_estimee`, `horloge`, `horloge_saut`, `delais`, `marche_ouvert`, `marche_echec`, `bot_lance`, `bot_arrete`, `bot_repris`, `bot_retire`, `bot_levier`, `bot_modifie`, `bot_reconstruit`, `lancement_refuse`, `modification_refusee`, `serveur_ecoute`, `serveur_indisponible`, `page_connectee`, `page_deconnectee`, `page_refusee`, `page_abandonnee`.
- Common keys: `evenement`, `heure`, `marche`, `bot`, `joueur`, `reglages`, `regle`, `seuilBas`, `seuilHaut`, `cote`, `prix`, `taille`, `mise`, `notionnel`, `compte`, `compteDepart`, `compteAvant`, `levier`, `part`, `stop`, `stopPrix`, `liquidationPrix`, `motif`, `pnl`, `pnlSur100`, `pnlPctMise`, `gagnants`, `perdants`, `trades`, `signal`, `valeur`, `raison`, `cause`, `depuis`, `jusqua`, `debut`, `etat`, `retires`, `ecartTicks`, `ecartPct`, `attenteMs`, `horloge`, `financement`, `serveur`, `origines`, `marches`, `appels`.
- Coded values: `etat` `actif` / `liquide` / `epuise` / `jamais_demarre`, `motif` `signal` / `stop` / `trailing` / `fin` / `arret`, `cote` `long` / `short` / `les deux`, links `et` / `ou` / `filtre`, rules `zone` / `exit` / `retour` / `cassure`.

## What it does not do

No real order, no key. One market per replay. `resume` redoes the replay from the start of the data (it does not save the indicators' state) and holds only for recorded data. No settings search. The bots decide at the minute's close, not at every trade.
