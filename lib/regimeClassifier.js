// lib/regimeClassifier.js
// A fresh 6-state regime classifier, broadened for a cross-asset universe
// (rTokens, native equities, BTC/ETH). Inspired by an earlier single-asset
// version, rebuilt from scratch for this project — not a copy.

const REGIMES = {
  STRONG_BULL: 'strong_bull',
  WEAK_BULL: 'weak_bull',
  RANGE_BOUND: 'range_bound',
  WEAK_BEAR: 'weak_bear',
  STRONG_BEAR: 'strong_bear',
  VOL_BREAKOUT: 'vol_breakout',
};

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const { high: hi, low: lo } = bars[i];
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose)));
  }
  return sma(trueRanges, period);
}

/**
 * Sliding-window ATR series over the full bar series, in O(n).
 * Computes the exact same values as repeatedly calling atr() at each window
 * end, but walks the series once instead of O(n^2). Used to derive the ATR
 * percentile feature for regime (and scenario) classification.
 * @param {Array} bars chronological OHLC bars
 * @param {number} period ATR window (default 14)
 * @returns {number[]} one ATR per window end (length = bars.length - period)
 */
function atrSeries(bars, period = 14) {
  const n = bars.length;
  if (n < period + 1) return [];
  // true range for bar i (i >= 1): max of the three range conventions
  const trueRanges = [];
  for (let i = 1; i < n; i++) {
    const { high: hi, low: lo } = bars[i];
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose)));
  }
  const trLen = trueRanges.length; // = n - 1
  if (trLen < period) return [];
  const out = [];
  let windowSum = 0;
  for (let i = 0; i < trLen; i++) {
    windowSum += trueRanges[i];
    if (i >= period) windowSum -= trueRanges[i - period];
    if (i >= period - 1) out.push(windowSum / period);
  }
  return out; // out.length = trLen - period + 1 = n - period
}

function percentile(value, series) {
  const sorted = [...series].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= value).length;
  return rank / sorted.length;
}

/**
 * Classify the regime for the most recent bar in a chronological OHLC series.
 * @param {Array<{date:string, open:number, high:number, low:number, close:number}>} bars
 * @returns {{regime: string, features: object}}
 */
function classifyRegime(bars) {
  if (bars.length < 200) {
    throw new Error('Need at least 200 bars for regime classification');
  }

  const closes = bars.map(b => b.close);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const price = closes[closes.length - 1];

  // ATR percentile is measured against the trailing ATRs that preceded the
  // current window, matching the point-in-time logic of the scenario builder:
  // we want to know whether vol TODAY is extreme relative to recent history.
  const atrSeriesOut = atrSeries(bars, 14);
  const currentAtr = atrSeriesOut[atrSeriesOut.length - 1];
  // Reference percentile universe: ATRs across the full series up to today.
  const atrPct = percentile(currentAtr, atrSeriesOut);

  const momentum20 = (price - closes[closes.length - 21]) / closes[closes.length - 21];

  let regime;
  if (atrPct > 0.9) regime = REGIMES.VOL_BREAKOUT;
  else if (price > ma50 && ma50 > ma200 && momentum20 > 0.02) regime = REGIMES.STRONG_BULL;
  else if (price > ma200 && momentum20 > 0) regime = REGIMES.WEAK_BULL;
  else if (price < ma50 && ma50 < ma200 && momentum20 < -0.02) regime = REGIMES.STRONG_BEAR;
  else if (price < ma200 && momentum20 < 0) regime = REGIMES.WEAK_BEAR;
  else regime = REGIMES.RANGE_BOUND;

  return {
    regime,
    features: {
      price, ma50, ma200, momentum20,
      atrPercentile: atrPct,
      asOf: bars[bars.length - 1].date,
    },
  };
}

module.exports = { REGIMES, classifyRegime, sma, atr, atrSeries, percentile };