# Precedent

Pre-trade stress testing for tokenized US equities — built for Bitget AI Base Camp
Hackathon S2, AI Trading Desk track, Decision Stress Testing sub-theme.

Before you open a position, Precedent shows the real historical base rate for
setups that looked like this one — same regime, similar momentum and volatility
— and what actually happened next. Not a prediction: a base rate.

## What it does

1. You pick a symbol and describe your thesis (plus an optional catalyst, e.g.
   earnings or a rate decision).
2. Precedent pulls real historical daily bars, classifies the current market
   regime (strong/weak bull, range-bound, weak/strong bear, vol breakout), and
   finds the nearest past analogues in its scenario database.
3. It overlays technical signals (RSI, MACD), the Fear & Greed Index (crypto),
   and recent headlines, then synthesizes everything into a plain-English
   stress-test brief.

Every number in the stat grid and every analogue traces to a real historical
entry in `scenarioDB.json`. Nothing is synthesized or fabricated: if a key is
missing or there is too little history, you get an explicit empty/error state.

## Data sources

| Asset | Source | Key required |
|---|---|---|
| BTC / ETH | Coinbase Exchange candles (keyless) | No |
| US equities / SPY | Yahoo Finance chart endpoint, ~5y daily OHLC | No |
| Fear & Greed Index | alternative.me (keyless) | No |
| Headlines | NewsAPI | Yes (optional) |
| Narrative brief | Groq (`qwen/qwen3.8-27b` by default) | Yes |

Equities are pulled from Yahoo Finance because Alpha Vantage's free tier only
exposes 100 daily bars — below the 200-bar floor the regime classifier needs.
The whole market-data pipeline runs with no market-data key.

### Reliability: cache and snapshot fallback

Equities and crypto are hosted by third parties that routinely block datacenter
IPs, including serverless hosts. To make sure a judge never sees an error page,
bars are resolved in this order:

1. **In-memory cache** (30 min TTL) — repeat clicks don't re-hit upstream.
2. **Live fetch** — Yahoo Finance or Coinbase Exchange.
3. **Committed snapshot** — `data/barsSnapshot.json`, written by `npm run snapshot`.

Every `/api/bars` response says which one it used (`source`: `live`, `cache`
or `snapshot`) and the UI labels it, so fallback data is never passed off as
live. The snapshot is real observed market data with a recorded build date.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env`. `GROQ_API_KEY` is required for the narrative
   brief; without it, Precedent still computes and shows the real base rates,
   analogue table and playbook with an explicit note instead of a fake brief.
   `NEWSAPI_KEY` is optional — headlines are omitted (never invented) without it.
3. `npm run build-db` — seeds `scenarioDB.json` with real historical scenarios
   across BTC, ETH, and the equity universe. Takes a few minutes.
4. `npm run snapshot` — writes the committed bars fallback. Re-run this before
   deploying if you want the fallback to be recent.
5. `npm start`, then open http://localhost:3000

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/bars?symbol=NVDA` | Daily bars + `source`/`asOf`. Add `&snapshot=1` to force the fallback |
| `POST /api/stress-test` | `{symbol, bars, thesis, catalyst, scope}` → regime, regime math, RSI/MACD/Fear&Greed, distribution stats, the 12 matched analogues, and the LLM brief |
| `GET /api/playbook?symbol=NVDA` | Base rates for every regime this asset has traded in |
| `GET /api/meta` | Scenario DB size, build dates, data sources, model in use |

`scope: 'all'` matches analogues across the whole cross-asset universe;
`scope: 'same'` restricts them to the same asset.

## What the output looks like

For a question like *"Should I open a long in NVDA into earnings?"* the app
returns, from real history:

- the current regime (`weak_bull`) and the math behind it (price vs MA50/MA200,
  20-day momentum, ATR percentile),
- the **12 nearest historical setups**, listed individually with date, asset and
  what happened over the next 5 and 20 days, so every claim is checkable,
- distribution stats rather than a single mean: median, interquartile range,
  best/worst outcome, worst drawdown in the sample, the share that drew down
  more than 5%, and the adverse excursion to plan for,
- a **regime playbook** for that asset — its win rate, mean and median 20-day
  return and worst drawdown in every regime it has actually traded in,
- a plain-English brief from the LLM built strictly from those computed numbers,
  including a concrete invalidation level.

## Deploy

Push to `Argeneau12e/precedent`, import into Vercel, and set these two
environment variables in the dashboard:

- `GROQ_API_KEY` — required for the narrative brief
- `NEWSAPI_KEY` — optional, for headlines

No market-data key is needed. `vercel.json` routes all traffic through
`server.js` (Node runtime). Commit `scenarioDB.json` and `data/barsSnapshot.json`
so the serverless function has both the scenarios and the bar fallback.

## Verification

- `scenarioDB.json`: ~9,400 scenarios across 10 assets, every entry carrying real
  forward returns and drawdowns computed from historical bars.
- `npm run snapshot`: 10 symbols, 500 real daily bars each.
- `/api/stress-test` was exercised end-to-end on both the live path and the
  snapshot-fallback path (the case where the serverless host can't reach the
  upstream) and returns a full brief in both.
- Failure modes are explicit, never fabricated: missing `GROQ_API_KEY` returns
  the real base rates with a note; unknown symbol returns a 502 explaining that
  no snapshot covers it; under 200 bars returns a 400; an invalid NewsAPI key
  logs a warning and omits headlines without breaking the request.

## Design

Amber/gold glass palette on a near-black background, Cormorant Garamond
headline, DM Sans body, and IBM Plex Mono for every number. No purple, no
decorative gradients, no emoji.
