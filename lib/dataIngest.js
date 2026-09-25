// lib/dataIngest.js
// Real historical OHLCV only. Crypto uses Coinbase Exchange's keyless candles
// endpoint (verified live), paging backward in <=200-day start/end windows.
// Equities use Yahoo Finance's chart endpoint — keyless, ~5y of daily OHLC
// (Alpha Vantage's free tier only exposes 100 daily bars, below the 200-bar
// regime-classification floor, so it is not used for equity history). If a
// fetch fails, return [] and log a warning. Do not fabricate bars.

const fetch = globalThis.fetch; // Node 18+

// Coinbase candle row: [time, low, high, open, close, volume]
const COINBASE_PRODUCTS = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
  DOGE: 'DOGE-USD', ADA: 'ADA-USD', AVAX: 'AVAX-USD',
};
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

// Yahoo Finance ticker mapping. The app exposes GOOGL, but Yahoo quotes
// Alphabet under GOOG after the ticker change.
const YAHOO_SYMBOL = { GOOGL: 'GOOG' };

async function fetchEquityDaily(symbol) {
  const ticker = YAHOO_SYMBOL[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch (err) {
    console.warn(`Yahoo fetch failed for ${symbol}: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);
    return [];
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    console.warn(`Yahoo returned non-JSON for ${symbol}`);
    return [];
  }

  const node = payload?.chart?.result?.[0];
  const timestamps = node?.timestamp;
  const quote = node?.indicators?.quote?.[0];
  if (!Array.isArray(timestamps) || !quote || !Array.isArray(quote.close)) {
    console.warn(`No usable equity series returned for ${symbol}`);
    return [];
  }

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open && quote.open[i];
    const high = quote.high && quote.high[i];
    const low = quote.low && quote.low[i];
    const close = quote.close && quote.close[i];
    // Drop rows where any OHLC value is missing or non-numeric (Yahoo can
    // leave early points null). Remaining bars are still far above minimums.
    if ([open, high, low, close].some(v => v == null || typeof v !== 'number' || Number.isNaN(v))) continue;
    bars.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open, high, low, close,
    });
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

// The supported universe lives here so the allowlist, the fetchers, the DB
// build and the snapshot can never drift apart. Adding an asset in one place
// and forgetting another was the exact failure mode that made a symbol look
// supported in the UI but 502 at runtime.
const EQUITY_SYMBOLS = [
  'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'SPY',
  'QQQ', 'IWM', 'AMD', 'NFLX', 'COIN', 'PLTR', 'TSM',
];
const CRYPTO_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX'];
const SUPPORTED_SYMBOLS = [...new Set([...EQUITY_SYMBOLS, ...CRYPTO_SYMBOLS])];
const isCrypto = symbol => CRYPTO_SYMBOLS.includes(symbol);

module.exports = {
  fetchCryptoDaily, fetchEquityDaily,
  COINBASE_PRODUCTS, EQUITY_SYMBOLS, CRYPTO_SYMBOLS, SUPPORTED_SYMBOLS, isCrypto,
};