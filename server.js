// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');

const { classifyRegime } = require('./lib/regimeClassifier');
const { findAnalogues } = require('./lib/scenarioMatcher');
const { buildPlaybook } = require('./lib/playbook');
const { getBars } = require('./lib/barsCache');
const { computeRSI, computeMACD, fetchFearGreedIndex, fetchNewsHeadlines } = require('./lib/signals');

const scenarioDB = require('./scenarioDB.json');
const fs = require('fs');

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
    // Cache -> live -> committed snapshot. `source` is surfaced so the UI can
    // label cached/fallback data honestly instead of pretending it is live.
    const { bars, source, asOf, snapshotBuiltAt } = await getBars(symbol, {
      isCrypto: CRYPTO_SYMBOLS.has(symbol),
      forceSnapshot: req.query.snapshot === '1',
    });
    if (bars.length === 0) {
      return res.status(502).json({
        error: `No historical data available for ${symbol}. The live source is unreachable and no snapshot covers this symbol — run \`npm run snapshot\` to add one.`,
      });
    }
    res.json({ symbol, bars, source, asOf, snapshotBuiltAt: snapshotBuiltAt || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Provenance for the UI footer: how much real history backs the app, and when
// the scenario database was last rebuilt. Metrics the submission can cite.
app.get('/api/meta', (req, res) => {
  const bySymbol = {};
  const byRegime = {};
  for (const row of scenarioDB) {
    bySymbol[row.symbol] = (bySymbol[row.symbol] || 0) + 1;
    byRegime[row.regime] = (byRegime[row.regime] || 0) + 1;
  }
  let dbBuiltAt = null;
  try {
    dbBuiltAt = fs.statSync(path.join(__dirname, 'scenarioDB.json')).mtime.toISOString();
  } catch { /* leave null */ }

  let snapshotBuiltAt = null;
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'barsSnapshot.json'), 'utf8'));
    snapshotBuiltAt = snap.builtAt;
  } catch { /* no snapshot committed */ }

  res.json({
    scenarioCount: scenarioDB.length,
    symbolCount: Object.keys(bySymbol).length,
    bySymbol,
    byRegime,
    dbBuiltAt,
    snapshotBuiltAt,
    sources: [
      'Yahoo Finance (equity daily OHLC)',
      'Coinbase Exchange (crypto daily candles)',
      'alternative.me Fear & Greed Index',
      'NewsAPI (headlines)',
    ],
    llm: groq ? GROQ_MODEL : null,
  });
});

// Base rates for every regime this symbol has actually traded in.
app.get('/api/playbook', (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  const playbook = buildPlaybook(scenarioDB, symbol);
  if (playbook.total === 0) {
    return res.status(404).json({ error: `No scenarios stored for ${symbol}` });
  }
  res.json(playbook);
});

app.post('/api/stress-test', async (req, res) => {
  try {
    const { symbol, bars, thesis, catalyst, scope = 'all', barsSource = null, barsAsOf = null } = req.body;
    if (!bars || bars.length < 200) {
      return res.status(400).json({ error: 'Need at least 200 daily bars to classify a regime' });
    }

    const { regime, features } = classifyRegime(bars);
    const { matches, stats } = findAnalogues(
      { symbol, regime, features },
      scenarioDB,
      { scope: scope === 'same' ? 'same' : 'all' }
    );

    const rsi = computeRSI(bars);
    const macd = computeMACD(bars);
    const fearGreed = CRYPTO_SYMBOLS.has(symbol) ? await fetchFearGreedIndex() : null;
    const headlines = await fetchNewsHeadlines(NEWS_QUERY(symbol), 5);

    const dataNote = barsSource && barsSource !== 'live'
      ? ` (bar data source: ${barsSource}${barsAsOf ? `, as of ${barsAsOf}` : ''})`
      : '';

    if (!stats) {
      return res.json({
        regime, features, stats: null, matches: [], matchCount: 0,
        barsSource, barsAsOf, rsi, macd, fearGreed, headlines,
        brief: scope === 'same'
          ? `No stored scenarios for ${symbol} yet — run \`npm run build-db\` to include it.`
          : 'Not enough historical analogues in the scenario database yet — run `npm run build-db` first.',
      });
    }

    if (!groq) {
      // Rule #1: never fabricate a brief. Surface the real base rates and an
      // explicit, honest note instead of a hard failure.
      return res.json({
        regime, features, stats, matches, matchCount: matches.length,
        barsSource, barsAsOf, rsi, macd, fearGreed, headlines,
        brief: 'Historical base rates computed. Add a GROQ_API_KEY to generate the narrative stress-test brief.',
      });
    }

    const pct = v => (v == null ? 'unavailable' : `${(v * 100).toFixed(2)}%`);
    const prompt = `You are a trading research assistant producing a pre-trade stress test brief for a retail trader on tokenized US equities.

SETUP
Symbol: ${symbol}
Current regime: ${regime}
Analogue scope: ${scope === 'same' ? `the same asset (${symbol}) only` : 'the whole cross-asset universe'} — the ${stats.sampleSize} closest historical setups by regime, momentum and volatility${dataNote}
Trader's thesis: "${thesis || 'none given'}"
Catalyst: "${catalyst || 'none given'}"

CURRENT REGIME MATH
Price: ${features.price?.toFixed(2)} | MA50: ${features.ma50?.toFixed(2)} | MA200: ${features.ma200?.toFixed(2)}
20-day momentum: ${pct(features.momentum20)}
ATR percentile (vol today vs its own history): ${(features.atrPercentile * 100).toFixed(0)}th percentile

TECHNICAL SIGNALS
RSI(14): ${rsi != null ? rsi.toFixed(1) : 'unavailable'}
MACD histogram: ${macd ? macd.histogram.toFixed(3) : 'unavailable'}
${fearGreed ? `Fear & Greed Index: ${fearGreed.value} (${fearGreed.classification})` : ''}

RECENT HEADLINES
${headlines.length ? headlines.map(h => `- ${h.title} (${h.source})`).join('\n') : 'None available'}

HISTORICAL BASE RATES (from ${stats.sampleSize} analogous past setups — same regime, similar momentum/volatility)
Mean 5-day forward return: ${pct(stats.meanForwardReturn5d)}
Mean 20-day forward return: ${pct(stats.meanForwardReturn20d)}
Median 20-day forward return: ${pct(stats.medianForwardReturn20d)}
Interquartile range (20d): ${pct(stats.p25ForwardReturn20d)} to ${pct(stats.p75ForwardReturn20d)}
Best / worst 20-day outcome: ${pct(stats.bestForwardReturn20d)} / ${pct(stats.worstForwardReturn20d)}
20-day win rate: ${pct(stats.winRate20d)}
Mean max drawdown (20d): ${pct(stats.meanMaxDrawdown20d)}
Worst max drawdown in the sample: ${pct(stats.worstMaxDrawdown20d)}
Share of analogues that drew down more than 5%: ${pct(stats.shareDrawdownOver5pct)}

TASK
Write a 150-220 word plain-English stress test brief. Rules:
1. Open with the base-rate win rate and the drawdown a trader would have had to sit through.
2. Give one concrete invalidation level as a percentage adverse move (use the drawdown figures) and name it as the level at which the thesis should be reconsidered.
3. Reference the technical signals and headlines only if they meaningfully agree or conflict with the base rate.
4. State once, clearly, that this is historical pattern-matching, not a prediction.
5. Do not hedge every sentence. No bullet lists, no headings — flowing prose only.`;

    // The LLM call is isolated on purpose: the base rates, analogue list and
    // signal layers are already computed and real. If Groq is rate-limited or
    // unreachable, return all of that anyway with an explicit note, rather than
    // losing the research output to a failure in the narrative layer.
    let brief;
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        // The brief is 150-220 words (~300 tokens); bound output so requests
        // stay under this key's per-minute output-token limit.
        max_tokens: 450,
        messages: [{ role: 'user', content: prompt }],
      });
      brief = completion.choices[0].message.content;
    } catch (llmErr) {
      console.warn(`Groq brief failed for ${symbol}: ${llmErr.message}`);
      brief = `Narrative brief unavailable this run (${llmErr.message}). The base rates, analogue list and signals above are computed from real history and are unaffected.`;
    }

    res.json({
      regime, features, stats, matches, matchCount: matches.length,
      barsSource, barsAsOf, rsi, macd, fearGreed, headlines,
      brief,
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