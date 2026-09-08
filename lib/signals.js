// lib/signals.js
// Additional real-data signal layers that feed the "feature depth" scoring
// criterion. Every function returns null/[] — never a fabricated value — when
// its source is unavailable.

function computeRSI(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const closes = bars.map(b => b.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let emaVal = values[0];
  const result = [emaVal];
  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
    result.push(emaVal);
  }
  return result;
}

function computeMACD(bars, fast = 12, slow = 26, signalPeriod = 9) {
  if (bars.length < slow + signalPeriod) return null;
  const closes = bars.map(b => b.close);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine.slice(slow - fast), signalPeriod);
  const histogram = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
    histogram,
  };
}

async function fetchFearGreedIndex() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!res.ok) return null;
    const data = await res.json();
    const point = data.data && data.data[0];
    return point ? { value: parseInt(point.value, 10), classification: point.value_classification } : null;
  } catch {
    return null;
  }
}

async function fetchNewsHeadlines(query, limit = 5) {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    console.warn('NEWSAPI_KEY not set — skipping headline fetch');
    return [];
  }
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=${limit}&apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.articles || []).map(a => ({ title: a.title, source: a.source.name, publishedAt: a.publishedAt }));
}

module.exports = { computeRSI, computeMACD, fetchFearGreedIndex, fetchNewsHeadlines };