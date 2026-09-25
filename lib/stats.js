// lib/stats.js
// Statistical helpers for honest presentation of small-sample win rates.

/**
 * Wilson score interval for a binomial proportion.
 *
 * A raw win rate from n=12 is nearly meaningless on its own: 8/12 "67%" and
 * 8/12 "67%" carry very different weight depending on how many were counted,
 * and a naive "67% win rate" invites overconfidence. The Wilson interval is
 * the standard fix — it stays inside [0,1], behaves sensibly at small n and
 * near 0%/100%, and is far more honest than the normal approximation.
 *
 * @param {number} wins number of positive outcomes
 * @param {number} n total observations
 * @param {number} z confidence multiplier (1.96 = ~95%)
 * @returns {{low:number, high:number, center:number}|null}
 */
function wilsonInterval(wins, n, z = 1.96) {
  if (!Number.isFinite(wins) || !Number.isFinite(n) || n <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    center,
  };
}

module.exports = { wilsonInterval };