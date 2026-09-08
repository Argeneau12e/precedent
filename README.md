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
| Headlines | NewsAPI | Yes |
| Narrative brief | Groq (`qwen/qwen3.8-27b` by default) | Yes |

Equities are pulled from Yahoo Finance because Alpha Vantage's free tier only
exposes 100 daily bars — below the 200-bar floor the regime classifier needs.
The whole data pipeline (crypto and equities) runs with no market-data key.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env`. `GROQ_API_KEY` is required for the narrative
   brief; without it, Precedent still computes and shows the real base rates
   with an explicit note. `GROQ_MODEL` is optional (defaults to
   `qwen/qwen3.8-27b`); `NEWSAPI_KEY` is recommended but headlines are omitted
   without it.
3. `npm run build-db` — seeds `scenarioDB.json` with real historical scenarios
   across BTC, ETH, and the equity universe. Takes a few minutes.
4. `npm start`, then open http://localhost:3000

## Deploy

Push to `Argeneau12e/precedent`, import into Vercel, set the three env vars in
the Vercel dashboard, and deploy. `vercel.json` routes all traffic through
`server.js` (Node runtime).

## Design

Amber/gold glass palette on a near-black background, Cormorant Garamond
headline, DM Sans body, and IBM Plex Mono for every number. No purple, no
decorative gradients, no emoji.