// scripts/buildScenarioDB.js
// Builds scenarioDB.json from real historical daily bars across the symbol
// universe below. Run: npm run build-db

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { classifyRegime } = require('../lib/regimeClassifier');
const { fetchCryptoDaily, fetchEquityDaily } = require('../lib/dataIngest');

const CRYPTO_SYMBOLS = ['BTC', 'ETH'];
const EQUITY_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'SPY'];

function forwardReturn(bars, i, horizon) {
  if (i + horizon >= bars.length) return null;
  return (bars[i + horizon].close - bars[i].close) / bars[i].close;
}

function maxDrawdown(bars, i, horizon) {
  if (i + horizon >= bars.length) return null;
  const window = bars.slice(i, i + horizon + 1);
  let runningPeak = window[0].close;
  let maxDD = 0;
  for (const bar of window) {
    if (bar.close > runningPeak) runningPeak = bar.close;
    const dd = (bar.close - runningPeak) / runningPeak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

async function buildForSymbol(symbol, fetcher) {
  console.log(`Fetching ${symbol}...`);
  const bars = await fetcher(symbol);
  if (bars.length < 250) {
    console.warn(`Skipping ${symbol} — only ${bars.length} bars, need 250+`);
    return [];
  }

  const entries = [];
  for (let i = 200; i < bars.length - 20; i++) {
    try {
      const { regime, features } = classifyRegime(bars.slice(0, i + 1));
      entries.push({
        symbol,
        date: bars[i].date,
        regime,
        features: { momentum20: features.momentum20, atrPercentile: features.atrPercentile },
        forwardReturn5d: forwardReturn(bars, i, 5),
        forwardReturn20d: forwardReturn(bars, i, 20),
        maxDrawdown20d: maxDrawdown(bars, i, 20),
      });
    } catch (e) {
      // not enough warm-up bars yet at this index — skip
    }
  }
  console.log(`  -> ${entries.length} tagged scenarios from ${symbol}`);
  return entries;
}

async function main() {
  let all = [];
  for (const sym of CRYPTO_SYMBOLS) {
    // crypto requests ~2 years so the scenario DB has deep history; the
    // runtime /api/bars path uses a shorter window via the same fetcher.
    all = all.concat(await buildForSymbol(sym, s => fetchCryptoDaily(s, 730)));
  }
  for (const sym of EQUITY_SYMBOLS) {
    all = all.concat(await buildForSymbol(sym, fetchEquityDaily));
  }

  if (all.length === 0) {
    console.warn('WARNING: scenarioDB is empty — every upstream fetch failed. Do not fabricate entries here to fill the gap.');
  }

  fs.writeFileSync(path.join(__dirname, '../scenarioDB.json'), JSON.stringify(all, null, 2));
  console.log(`Wrote ${all.length} scenarios to scenarioDB.json`);
}

main().catch(err => { console.error(err); process.exit(1); });