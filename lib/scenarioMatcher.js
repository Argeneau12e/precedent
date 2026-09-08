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

function findAnalogues(currentSetup, scenarioDB, topN = 12) {
  // currentSetup: { symbol, regime, features }
  const scored = scenarioDB
    .map(s => ({ ...s, distance: featureDistance(currentSetup, s) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topN);

  if (scored.length === 0) return { matches: [], stats: null };

  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const winRate = arr => arr.filter(v => v > 0).length / arr.length;
  const fwd5 = scored.map(s => s.forwardReturn5d).filter(v => v != null);
  const fwd20 = scored.map(s => s.forwardReturn20d).filter(v => v != null);
  const maxDD = scored.map(s => s.maxDrawdown20d).filter(v => v != null);

  return {
    matches: scored,
    stats: {
      sampleSize: scored.length,
      meanForwardReturn5d: fwd5.length ? mean(fwd5) : null,
      meanForwardReturn20d: fwd20.length ? mean(fwd20) : null,
      winRate20d: fwd20.length ? winRate(fwd20) : null,
      meanMaxDrawdown20d: maxDD.length ? mean(maxDD) : null,
    },
  };
}

module.exports = { findAnalogues, featureDistance };