// scripts/buildScenarioDB.js
// Builds scenarioDB.json from real historical daily bars across the symbol
// universe below. Run: npm run build-db

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { classifyRegime } = require('../lib/regimeClassifier');
const { fetchCryptoDaily, fetchEquityDaily, EQUITY_SYMBOLS, CRYPTO_SYMBOLS } = require('../lib/dataIngest');

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

  // Round every stored ratio to 6 decimals before writing. These are returns
  // and percentiles where the sixth decimal is far below noise, but full
  // float precision roughly doubles the file. The database has to be committed
  // and loaded into a serverless function on cold start, so its size is a real
  // deployment cost. Values are rounded once, here, and every consumer reads
  // them as-is.
  const round6 = v => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : v);
  const compact = all.map(row => ({
    symbol: row.symbol,
    date: row.date,
    regime: row.regime,
    features: {
      momentum20: round6(row.features.momentum20),
      atrPercentile: round6(row.features.atrPercentile),
    },
    forwardReturn5d: round6(row.forwardReturn5d),
    forwardReturn20d: round6(row.forwardReturn20d),
    maxDrawdown20d: round6(row.maxDrawdown20d),
  }));

  // The build timestamp is written INTO the file. Previously the UI read file
  // mtime, which git checkouts, clones and Vercel's build step all rewrite —
  // that surfaced a bogus "scenario DB built 2018-10-20" in the provenance
  // footer. An embedded, immutable value is the only honest source.
  const output = {
    builtAt: new Date().toISOString(),
    scenarioCount: compact.length,
    scenarios: compact,
  };
  const json = JSON.stringify(output);
  fs.writeFileSync(path.join(__dirname, '../scenarioDB.json'), json);
  console.log(`Wrote ${compact.length} scenarios to scenarioDB.json (builtAt: ${output.builtAt}, ${(json.length / 1048576).toFixed(2)} MB)`);
}

main().catch(err => { console.error(err); process.exit(1); });