// lib/dataIngest.js
// Real historical OHLCV only. Crypto uses Coinbase Exchange's keyless candles
// endpoint (verified live), paging backward in <=200-day start/end windows.
// Equities use Alpha Vantage's free tier — needs a key. If a key is missing or
// a call fails, return [] and log a warning. Do not fabricate bars.

const fetch = globalThis.fetch; // Node 18+

// Coinbase candle row: [time, low, high, open, close, volume]
const COINBASE_PRODUCTS = { BTC: 'BTC-USD', ETH: 'ETH-USD' };
// Coinbase public candles returns at most ~300 points per query; a 200-day
// window per page keeps us safely under that limit while walking history.
const CRYPTO_PAGE_DAYS = 200;

async function fetchCryptoDaily(symbol, days = 365) {
  const product = COINBASE_PRODUCTS[symbol];
  if (!product) throw new Error(`No Coinbase product mapped for ${symbol}`);
  const byTime = new Map();
  const now = Math.floor(Date.now() / 1000);
  let end = now;
  // Enough pages to cover the requested span (plus one page of slack).
  const pagesNeeded = Math.max(2, Math.ceil(days / CRYPTO_PAGE_DAYS) + 1);
  let page = 0;

  while (page < pagesNeeded) {
    const start = end - CRYPTO_PAGE_DAYS * 86400;
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${start}&end=${end}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase candles fetch failed: ${res.status}`);
    const candles = await res.json();
    if (!Array.isArray(candles) || candles.length === 0) break;
    let oldest = end;
    for (const c of candles) {
      byTime.set(c[0], {
        date: new Date(c[0] * 1000).toISOString().slice(0, 10),
        open: c[3],
        high: c[2],
        low: c[1],
        close: c[4],
      });
      if (c[0] < oldest) oldest = c[0];
    }
    end = oldest - 86400;
    page++;
    if (byTime.size >= Math.min(days, 3000)) break;
  }

  // Deduplicate by calendar date (page boundaries can repeat a day); keep last.
  const byDate = new Map();
  for (const b of byTime.values()) byDate.set(b.date, b);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchEquityDaily(symbol) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    console.warn(`ALPHA_VANTAGE_API_KEY not set — skipping ${symbol}`);
    return [];
  }
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=full&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage fetch failed for ${symbol}: ${res.status}`);
  const data = await res.json();
  const series = data['Time Series (Daily)'];
  if (!series) {
    console.warn(`No data returned for ${symbol}: ${JSON.stringify(data).slice(0, 200)}`);
    return [];
  }
  return Object.entries(series)
    .map(([date, ohlc]) => ({
      date,
      open: parseFloat(ohlc['1. open']),
      high: parseFloat(ohlc['2. high']),
      low: parseFloat(ohlc['3. low']),
      close: parseFloat(ohlc['4. close']),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { fetchCryptoDaily, fetchEquityDaily, COINBASE_PRODUCTS };