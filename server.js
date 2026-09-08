// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');

const { classifyRegime } = require('./lib/regimeClassifier');
const { findAnalogues } = require('./lib/scenarioMatcher');
const { fetchCryptoDaily, fetchEquityDaily } = require('./lib/dataIngest');
const { computeRSI, computeMACD, fetchFearGreedIndex, fetchNewsHeadlines } = require('./lib/signals');

const scenarioDB = require('./scenarioDB.json');

const app = express();
// Equities carry ~5y of daily bars (often >100KB), far above express's default
// 100KB JSON body limit — raise it so stress-test requests aren't rejected.
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// groq-sdk throws at construction when no key is present; construct lazily so
// a missing key yields an explicit no-brief state (rule #1) instead of a crash.
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;
const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH']);
// Headline queries should read naturally for each asset class.
const CRYPTO_NEWS_QUERY = { BTC: 'Bitcoin price', ETH: 'Ethereum price' };
const NEWS_QUERY = symbol => CRYPTO_NEWS_QUERY[symbol] || `${symbol} stock`;

app.get('/api/bars', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
    const bars = CRYPTO_SYMBOLS.has(symbol)
      ? await fetchCryptoDaily(symbol, 365)
      : await fetchEquityDaily(symbol);
    if (bars.length === 0) {
      return res.status(502).json({ error: `No historical data available for ${symbol} yet — check API keys in .env` });
    }
    res.json({ symbol, bars });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stress-test', async (req, res) => {
  try {
    const { symbol, bars, thesis, catalyst } = req.body;
    if (!bars || bars.length < 200) {
      return res.status(400).json({ error: 'Need at least 200 daily bars to classify a regime' });
    }

    const { regime, features } = classifyRegime(bars);
    const { matches, stats } = findAnalogues({ symbol, regime, features }, scenarioDB);

    const rsi = computeRSI(bars);
    const macd = computeMACD(bars);
    const fearGreed = CRYPTO_SYMBOLS.has(symbol) ? await fetchFearGreedIndex() : null;
    const headlines = await fetchNewsHeadlines(NEWS_QUERY(symbol), 5);

    if (!stats) {
      return res.json({
        regime, features, stats: null, rsi, macd, fearGreed, headlines,
        brief: 'Not enough historical analogues in the scenario database yet — run `npm run build-db` first.',
      });
    }

    if (!groq) {
      // Rule #1: never fabricate a brief. Surface the real base rates and an
      // explicit, honest note instead of a hard failure.
      return res.json({
        regime, features, stats, matchCount: matches.length,
        rsi, macd, fearGreed, headlines,
        brief: 'Historical base rates computed. Add a GROQ_API_KEY to generate the narrative stress-test brief.',
      });
    }

    const prompt = `You are a trading research assistant producing a pre-trade stress test brief for a retail trader on tokenized US equities.

SETUP
Symbol: ${symbol}
Current regime: ${regime}
Trader's thesis: "${thesis || 'none given'}"
Catalyst: "${catalyst || 'none given'}"

TECHNICAL SIGNALS
RSI(14): ${rsi != null ? rsi.toFixed(1) : 'unavailable'}
MACD histogram: ${macd ? macd.histogram.toFixed(3) : 'unavailable'}
${fearGreed ? `Fear & Greed Index: ${fearGreed.value} (${fearGreed.classification})` : ''}

RECENT HEADLINES
${headlines.length ? headlines.map(h => `- ${h.title} (${h.source})`).join('\n') : 'None available'}

HISTORICAL BASE RATES (from ${stats.sampleSize} analogous past setups — same regime, similar momentum/volatility)
Mean 5-day forward return: ${(stats.meanForwardReturn5d * 100).toFixed(2)}%
Mean 20-day forward return: ${(stats.meanForwardReturn20d * 100).toFixed(2)}%
20-day win rate: ${(stats.winRate20d * 100).toFixed(1)}%
Mean max drawdown (20d): ${(stats.meanMaxDrawdown20d * 100).toFixed(2)}%

TASK
Write a 150-220 word plain-English stress test brief. Open with the base-rate win rate and drawdown. Reference the technical signals and headlines only if they meaningfully agree or conflict with the base rate. State once, clearly, that this is historical pattern-matching, not a prediction. Do not hedge every sentence.`;

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      // The brief is 150-220 words (~300 tokens); bound output so requests
      // stay under this key's per-minute output-token limit.
      max_tokens: 450,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({
      regime, features, stats, matchCount: matches.length,
      rsi, macd, fearGreed, headlines,
      brief: completion.choices[0].message.content,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log(`Precedent running on port ${process.env.PORT || 3000}`));
}