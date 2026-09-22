// lib/barsCache.js
// Reliability layer for the bar feed. Two protections, in order:
//   1. In-memory TTL cache — a judge clicking "Run stress test" repeatedly hits
//      upstream at most once per TTL window instead of on every click.
//   2. Committed snapshot fallback (data/barsSnapshot.json, built by
//      `npm run snapshot`) — if the upstream source blocks or fails (Yahoo and
//      Coinbase regularly refuse datacenter/Vercel egress IPs), the app serves
//      the last real snapshot instead of erroring, and says so explicitly.
// The snapshot is real observed market data with a recorded build date, never
// synthesized. The response always carries `source` and `asOf` so the UI can
// label it honestly.

const fs = require('fs');
const path = require('path');
const { fetchCryptoDaily, fetchEquityDaily } = require('./dataIngest');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'barsSnapshot.json');
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    console.warn('No bars snapshot found — run `npm run snapshot` to create a fallback.');
    return null;
  }
}

const snapshot = loadSnapshot();
const memory = new Map(); // symbol -> { bars, source, asOf, fetchedAt }

function snapshotFor(symbol) {
  const entry = snapshot && snapshot.symbols && snapshot.symbols[symbol];
  if (!entry || !Array.isArray(entry.bars) || entry.bars.length < 200) return null;
  return {
    bars: entry.bars,
    source: 'snapshot',
    asOf: entry.asOf,
    snapshotBuiltAt: snapshot.builtAt,
    fetchedAt: Date.now(),
  };
}

/**
 * Resolve daily bars for a symbol: fresh live fetch -> memory cache ->
 * committed snapshot -> whatever stale cache exists -> empty (explicit error).
 * @param {string} symbol
 * @param {{isCrypto:boolean, ttlMs?:number, forceSnapshot?:boolean}} opts
 * @returns {Promise<{bars:Array, source:string, asOf:string|null, fetchedAt:number, snapshotBuiltAt?:string}>}
 */
async function getBars(symbol, { isCrypto, ttlMs = DEFAULT_TTL_MS, forceSnapshot = false } = {}) {
  const now = Date.now();
  const cached = memory.get(symbol);

  if (!forceSnapshot && cached && now - cached.fetchedAt < ttlMs) {
    return { ...cached, source: cached.source === 'live' ? 'cache' : cached.source };
  }

  if (!forceSnapshot) {
    try {
      const bars = isCrypto ? await fetchCryptoDaily(symbol, 365) : await fetchEquityDaily(symbol);
      if (bars.length >= 200) {
        const record = { bars, source: 'live', asOf: bars[bars.length - 1].date, fetchedAt: now };
        memory.set(symbol, record);
        return record;
      }
      console.warn(`Live fetch for ${symbol} returned ${bars.length} bars (<200) — trying snapshot.`);
    } catch (err) {
      console.warn(`Live fetch for ${symbol} failed: ${err.message} — trying snapshot.`);
    }
  }

  const snap = snapshotFor(symbol);
  if (snap) {
    memory.set(symbol, snap);
    return snap;
  }

  if (cached) return { ...cached, source: 'cache-stale' };

  return { bars: [], source: 'unavailable', asOf: null, fetchedAt: now };
}

module.exports = { getBars, SNAPSHOT_PATH, DEFAULT_TTL_MS };
