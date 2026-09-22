// lib/scenarioMatcher.js
// Finds the nearest historical analogues to the current setup and computes
// what actually happened next. Every stat traces to a real entry in
// scenarioDB.json — nothing here is synthesized.

function featureDistance(current, candidate) {
  // current: { regime, features:{ momentum20, atrPercentile } }
  // candidate entry: { regime, features:{ momentum20, atrPercentile } }
  // Regime is compared from the top-level fields (present on both sides),
  // NOT from the features objects, which do not carry it. Fixes the silent
  // never-match on regime from the original draft.
  const regimeMatch = current.regime === candidate.regime ? 0 : 1;
  const momentumDiff = Math.abs(current.features.momentum20 - candidate.features.momentum20);
  const volDiff = Math.abs(current.features.atrPercentile - candidate.features.atrPercentile);
  return regimeMatch * 10 + momentumDiff * 3 + volDiff * 2;
}

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/**
 * Distribution stats over the matched analogues. Means alone hide the risk, so
 * this surfaces the full spread: median, quartiles, best/worst, the worst
 * observed drawdown, and how often an analogue drew down more than 5%.
 */
function summarize(matched) {
  const fwd5 = matched.map(s => s.forwardReturn5d).filter(v => v != null);
  const fwd20 = matched.map(s => s.forwardReturn20d).filter(v => v != null);
  const dd20 = matched.map(s => s.maxDrawdown20d).filter(v => v != null);
  const sorted20 = [...fwd20].sort((a, b) => a - b);

  return {
    sampleSize: matched.length,
    meanForwardReturn5d: fwd5.length ? mean(fwd5) : null,
    winRate5d: fwd5.length ? fwd5.filter(v => v > 0).length / fwd5.length : null,
    meanForwardReturn20d: fwd20.length ? mean(fwd20) : null,
    medianForwardReturn20d: fwd20.length ? median(fwd20) : null,
    p25ForwardReturn20d: fwd20.length ? quantile(sorted20, 0.25) : null,
    p75ForwardReturn20d: fwd20.length ? quantile(sorted20, 0.75) : null,
    bestForwardReturn20d: fwd20.length ? Math.max(...fwd20) : null,
    worstForwardReturn20d: fwd20.length ? Math.min(...fwd20) : null,
    winRate20d: fwd20.length ? fwd20.filter(v => v > 0).length / fwd20.length : null,
    meanMaxDrawdown20d: dd20.length ? mean(dd20) : null,
    worstMaxDrawdown20d: dd20.length ? Math.min(...dd20) : null,
    shareDrawdownOver5pct: dd20.length ? dd20.filter(v => v <= -0.05).length / dd20.length : null,
    // The number a trader can actually plan around: the adverse excursion to
    // survive if this setup behaves like the worse half of its history.
    adverseExcursionP75: dd20.length ? Math.abs(quantile([...dd20].sort((a, b) => a - b), 0.25)) : null,
  };
}

/** Trim a DB row down to what the UI renders, keeping the payload small. */
function toAnalogue(row) {
  return {
    symbol: row.symbol,
    date: row.date,
    regime: row.regime,
    distance: Number(row.distance.toFixed(4)),
    forwardReturn5d: row.forwardReturn5d,
    forwardReturn20d: row.forwardReturn20d,
    maxDrawdown20d: row.maxDrawdown20d,
  };
}

/**
 * @param {{symbol:string, regime:string, features:object}} currentSetup
 * @param {Array} scenarioDB
 * @param {{topN?:number, scope?:'all'|'same'}} opts
 */
function findAnalogues(currentSetup, scenarioDB, { topN = 12, scope = 'all' } = {}) {
  const pool = scope === 'same'
    ? scenarioDB.filter(s => s.symbol === currentSetup.symbol)
    : scenarioDB;

  const scored = pool
    .map(s => ({ ...s, distance: featureDistance(currentSetup, s) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topN);

  if (scored.length === 0) return { matches: [], stats: null };

  return {
    matches: scored.map(toAnalogue),
    stats: summarize(scored),
  };
}

module.exports = { findAnalogues, featureDistance, summarize, toAnalogue };
