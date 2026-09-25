// scripts/snapshotBars.js
// Writes data/barsSnapshot.json: the most recent real daily bars for every
// symbol in the universe, so the server has a working fallback if the live
// upstream (Yahoo Finance / Coinbase) is unreachable — notably from serverless
// egress IPs. Run after build-db and before deploying: npm run snapshot

const fs = require('fs');
const path = require('path');
const { fetchCryptoDaily, fetchEquityDaily, EQUITY_SYMBOLS, CRYPTO_SYMBOLS } = require('../lib/dataIngest');
// The regime classifier needs 200 bars; keep extra trailing history so the
// snapshot can still classify a regime and derive a meaningful ATR percentile.
const KEEP_BARS = 500;

async function snapshotFor(symbol, isCrypto) {
  const bars = isCrypto
    ? await fetchCryptoDaily(symbol, Math.ceil(KEEP_BARS * 1.6))
    : await fetchEquityDaily(symbol);
  if (bars.length < 200) {
    console.warn(`Skipping ${symbol} — only ${bars.length} bars (<200), refusing to write a thin snapshot.`);
    return null;
  }
  const trimmed = bars.slice(-KEEP_BARS);
  console.log(`${symbol}: ${bars.length} bars fetched, keeping last ${trimmed.length} (as of ${trimmed[trimmed.length - 1].date})`);
  return { asOf: trimmed[trimmed.length - 1].date, bars: trimmed };
}

async function main() {
  const symbols = {};
  for (const sym of CRYPTO_SYMBOLS) {
    try {
      const entry = await snapshotFor(sym, true);
      if (entry) symbols[sym] = entry;
    } catch (err) {
      console.warn(`Snapshot failed for ${sym}: ${err.message}`);
    }
  }
  for (const sym of EQUITY_SYMBOLS) {
    try {
      const entry = await snapshotFor(sym, false);
      if (entry) symbols[sym] = entry;
    } catch (err) {
      console.warn(`Snapshot failed for ${sym}: ${err.message}`);
    }
  }

  const count = Object.keys(symbols).length;
  if (count === 0) {
    console.error('No symbols could be snapshotted — not writing a file rather than writing an empty one.');
    process.exit(1);
  }

  const out = { builtAt: new Date().toISOString(), keepBars: KEEP_BARS, symbols };
  const dest = path.join(__dirname, '..', 'data', 'barsSnapshot.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${count} symbol snapshots to ${dest}`);
}

main().catch(err => { console.error(err); process.exit(1); });
