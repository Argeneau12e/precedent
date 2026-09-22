// lib/playbook.js
// Regime playbook: for one symbol, the real base rates of every market regime
// it has actually been in. This is the "research workbench" view — instead of
// one snapshot of today's setup, it shows the whole historical record of how
// this asset behaves in each regime, with sample sizes so the reader can judge
// how much weight each row deserves. All numbers come from scenarioDB.json.

const REGIME_ORDER = ['strong_bull', 'weak_bull', 'range_bound', 'weak_bear', 'strong_bear', 'vol_breakout'];
const MIN_SAMPLE = 5;

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {Array} scenarioDB full scenario database
 * @param {string} symbol
 * @returns {{symbol:string, total:number, regimes:Array}}
 */
function buildPlaybook(scenarioDB, symbol) {
  const rows = scenarioDB.filter(s => s.symbol === symbol);

  const regimes = REGIME_ORDER.map(regime => {
    const inRegime = rows.filter(s => s.regime === regime);
    const fwd5 = inRegime.map(s => s.forwardReturn5d).filter(v => v != null);
    const fwd20 = inRegime.map(s => s.forwardReturn20d).filter(v => v != null);
    const dd20 = inRegime.map(s => s.maxDrawdown20d).filter(v => v != null);
    return {
      regime,
      sampleSize: inRegime.length,
      meanForwardReturn5d: fwd5.length ? mean(fwd5) : null,
      meanForwardReturn20d: fwd20.length ? mean(fwd20) : null,
      medianForwardReturn20d: fwd20.length ? median(fwd20) : null,
      winRate20d: fwd20.length ? fwd20.filter(v => v > 0).length / fwd20.length : null,
      meanMaxDrawdown20d: dd20.length ? mean(dd20) : null,
      worstMaxDrawdown20d: dd20.length ? Math.min(...dd20) : null,
    };
  })
    .filter(r => r.sampleSize >= MIN_SAMPLE)
    .sort((a, b) => b.sampleSize - a.sampleSize);

  return {
    symbol,
    total: rows.length,
    minSample: MIN_SAMPLE,
    regimes,
  };
}

module.exports = { buildPlaybook, REGIME_ORDER, MIN_SAMPLE };
