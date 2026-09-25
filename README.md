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
| BTC, ETH, SOL, XRP, DOGE, ADA, AVAX | Coinbase Exchange candles (keyless) | No |
| 15 US equities / ETFs | Yahoo Finance chart endpoint, ~5y daily OHLC | No |
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
   across the 22-asset universe (BTC, ETH, SOL, XRP, DOGE, ADA, AVAX and 15
   equities/ETFs). Takes a few minutes.
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

Run the real-browser suite (starts its own server on port 3111):

```bash
npx playwright install chromium   # once
npm test                          # 62 assertions
npm run validate                  # walk-forward validation
```

- `scenarioDB.json`: 19,591 scenarios across 22 assets, every entry carrying real
  forward returns and drawdowns computed from historical bars. The file records
  its own `builtAt` timestamp — the UI reads that, never file mtime, which git
  and Vercel both rewrite. Stored ratios are rounded to 6 decimals, which is
  far below statistical noise and cuts the file roughly in half.
- `npm run snapshot`: 22 symbols, 500 real daily bars each.
- `npm test` drives Chromium: it boots the app, runs a full demo stress test,
  asserts every card renders with real data, checks the security headers, fires
  unsupported/path-traversal symbols at every endpoint, measures **actual
  painted text contrast** in both themes, and confirms no console errors, no
  failed requests, and no horizontal overflow at 390px.
- `npm run validate` runs a purged walk-forward split (train on everything
  before 2025-06-01, test on the 3,282 held-out scenarios after it) using the
  production distance function. See below for what it found.

### What the walk-forward validation actually found

Reported as measured; no thresholds were tuned to improve any of it.

**Holds up.** The regime classifier genuinely separates outcomes. Out of
sample, `weak_bull` realized a 70.1% 20-day win rate and `strong_bull` 61.7%,
while `vol_breakout` (48.0%) and `range_bound` (51.6%) realized the worst. That
ordering is out-of-sample and is the defensible claim. Drawdown also widens
monotonically as conditions weaken: `strong_bull` −6.4% mean max drawdown versus
`strong_bear` −11.8%.

**Does not hold up.** The Brier score of the engine's win-rate estimates is
**0.2703, worse than the 0.25 of always guessing 50%**, and the calibration
buckets show why: when the engine reports an 81% win rate it realized 60%, and
when it reports 33% it realized 50%. The distance weights are hand-set and were
never validated, so tight analogue clusters do not reliably imply better future
outcomes. The engine is over-confident at both extremes and regresses toward
the mean.

This is exactly why the UI presents the win rate as **the base rate of a
historical cluster, not a calibrated probability**, and why a 95% Wilson
interval now sits under the headline number. A bare 83% from 12 analogues would
have been misleading; the interval makes the sample size do honest work.

### Failure modes are explicit, never fabricated

Missing `GROQ_API_KEY` returns the real base rates with an explicit note. An
unsupported symbol is rejected with a 400 before it can reach any upstream
provider. Fewer than 200 bars returns a 400. A failing NewsAPI key logs a
warning and omits headlines without breaking the request. If the LLM returns an
impossible invalidation level (for example "drops below 204% of entry", which
we observed and now guard against), that section is rebuilt from the computed
adverse-excursion figure.

## Security

- `helmet` with an explicit CSP, `frame-ancestors 'none'`, `nosniff`.
- Rate limiting: 20 stress tests per 10 minutes, 120 read requests per 10
  minutes, both keyed by IP. The Groq and NewsAPI quotas are finite and the API
  is public, so this protects the demo from being burned by a single client.
- Input caps: thesis truncated to 500 characters, catalyst to 200, before either
  reaches the LLM prompt.
- Symbol allowlist enforced on `/api/bars`, `/api/playbook` and
  `/api/stress-test`; arbitrary strings never reach Yahoo or Coinbase.
- `.env` is git-ignored and has never been committed.

## Design

Monochrome black/white/grey with semantic red and green reserved strictly for
positive and negative outcomes. Cormorant Garamond headline, DM Sans body, IBM
Plex Mono for every number, and browser surfaces (selection, scrollbars, focus
rings, native accents) themed from the same tokens. Dark and light themes, both
contrast-verified at 4.5:1 or better. No purple, no decorative gradients, no
emoji.
