// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

const { classifyRegime } = require('./lib/regimeClassifier');
const { findAnalogues } = require('./lib/scenarioMatcher');
const { buildPlaybook } = require('./lib/playbook');
const { getBars } = require('./lib/barsCache');
const { computeRSI, computeMACD, fetchFearGreedIndex, fetchNewsHeadlines } = require('./lib/signals');
const { loadScenarioDB } = require('./lib/dbLoader');
const { wilsonInterval } = require('./lib/stats');

const { scenarios: scenarioDB, builtAt: dbBuiltAt, legacyShape: dbLegacyShape } = loadScenarioDB();
if (dbLegacyShape) {
  console.warn('scenarioDB.json is still the legacy flat-array shape — run `npm run build-db` to write { builtAt, scenarios }.');
}

// One-pass baselines, computed once at boot, so the UI can anchor every analogue
// stat against the full stored history ("is an 83% win rate actually good?").
const baseline = (() => {
  const rets = [];
  for (const row of scenarioDB) if (row.forwardReturn20d != null) rets.push(row.forwardReturn20d);
  if (!rets.length) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const wins = rets.filter(v => v > 0).length;
  return { meanForwardReturn20d: mean, winRate20d: wins / rets.length, n: rets.length };
})();


const app = express();
// Security headers. CSP is configured explicitly rather than left at helmet's
// default so the app's real asset allowlist (Google Fonts, pinned Lucide CDN)
// is stated in one place and can be audited at a glance.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The app is a single self-contained HTML file with two inline scripts
      // (the no-flash theme paint and the client runtime) plus the pinned
      // Lucide bundle. 'unsafe-inline' is required for those inline blocks;
      // everything else is still locked to the explicit allowlist below, and
      // the far more valuable protections here (no framing, no object/embed,
      // no cross-origin connect) are unaffected. If the app is ever split into
      // external JS files, this can be tightened back down.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // The API is consumed by the same-origin page; cross-origin reads add no
  // value here and would only widen the surface.
  crossOriginEmbedderPolicy: false,
}));

// The stress-test endpoint is the expensive one: it classifies ~1,250 bars and
// calls the Groq + NewsAPI quotas. The API is public and unauthenticated, so
// without this a single IP (or a scraper) can burn the keys that judges depend
// on. 20 runs / 10 minutes is far above any human demo pace.
const stressTestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many stress tests from this IP — wait a few minutes and try again.' },
});
// Cheaper reads get a looser cap: they are cache/snapshot-backed and cost
// nothing per call beyond an upstream request.
const readLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP — wait a few minutes and try again.' },
});

// Equities carry ~5y of daily bars (often >100KB), far above express's default
// 100KB JSON body limit — raise it so stress-test requests aren't rejected.
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The allowlist is the security boundary: an arbitrary string must never reach
// Yahoo/Coinbase. Both /api/bars and /api/stress-test validate against it. The
// list is shared with the fetchers and the build scripts so the UI can never
// offer an asset the server would reject.
const { SUPPORTED_SYMBOLS, isCrypto } = require('./lib/dataIngest');

// Normalize + validate a symbol, returning null when unsupported. Case and
// surrounding whitespace are forgiven; everything else is rejected with 400.
function normalizeSymbol(raw) {
  if (typeof raw !== 'string') return null;
  const sym = raw.trim().toUpperCase();
  return SUPPORTED_SYMBOLS.includes(sym) ? sym : null;
}

// groq-sdk throws at construction when no key is present; construct lazily so
// a missing key yields an explicit no-brief state (rule #1) instead of a crash.
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;
// Headline queries should read naturally for each asset class. Crypto assets
// are queried by name because a ticker search returns mostly noise.
const CRYPTO_NEWS_QUERY = {
  BTC: 'Bitcoin price', ETH: 'Ethereum price', SOL: 'Solana price',
  XRP: 'XRP price', DOGE: 'Dogecoin price', ADA: 'Cardano price',
  AVAX: 'Avalanche crypto price',
};
const NEWS_QUERY = symbol => CRYPTO_NEWS_QUERY[symbol] || `${symbol} stock`;

app.get('/api/bars', readLimiter, async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    if (!req.query.symbol) return res.status(400).json({ error: 'symbol query param required' });
    if (!symbol) {
      return res.status(400).json({
        error: `Unsupported symbol. Precedent covers: ${[...SUPPORTED_SYMBOLS].join(', ')}.`,
      });
    }
    // Cache -> live -> committed snapshot. `source` is surfaced so the UI can
    // label cached/fallback data honestly instead of pretending it is live.
    const { bars, source, asOf, snapshotBuiltAt } = await getBars(symbol, {
      isCrypto: isCrypto(symbol),
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
app.get('/api/meta', readLimiter, (req, res) => {
  const bySymbol = {};
  const byRegime = {};
  for (const row of scenarioDB) {
    bySymbol[row.symbol] = (bySymbol[row.symbol] || 0) + 1;
    byRegime[row.regime] = (byRegime[row.regime] || 0) + 1;
  }
  // dbBuiltAt now comes from inside the file (written at build time) rather
  // than from file mtime — git checkouts, clones and Vercel's build step all
  // rewrite mtime, which is what produced the bogus "built 2018-10-20" date
  // in the footer next to our "nothing is synthesized" claim.

  let snapshotBuiltAt = null;
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'barsSnapshot.json'), 'utf8'));
    snapshotBuiltAt = snap.builtAt;
  } catch { /* no snapshot committed */ }

  res.json({
    baseline,
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
    // The UI builds its asset picker from this, so the interface can never
    // offer a symbol the server's allowlist would reject.
    supportedSymbols: [...SUPPORTED_SYMBOLS],
  });
});

// Base rates for every regime this symbol has actually traded in.
app.get('/api/playbook', readLimiter, (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol);
  if (!req.query.symbol) return res.status(400).json({ error: 'symbol query param required' });
  if (!symbol) {
    return res.status(400).json({
      error: `Unsupported symbol. Precedent covers: ${[...SUPPORTED_SYMBOLS].join(', ')}.`,
    });
  }
  const playbook = buildPlaybook(scenarioDB, symbol);
  if (playbook.total === 0) {
    return res.status(404).json({ error: `No scenarios stored for ${symbol}` });
  }
  res.json(playbook);
});

app.post('/api/stress-test', stressTestLimiter, async (req, res) => {
  try {
    const { bars, thesis, catalyst, scope = 'all', barsSource = null, barsAsOf = null } = req.body;
    const symbol = normalizeSymbol(req.body.symbol);
    if (!req.body.symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (!symbol) {
      return res.status(400).json({
        error: `Unsupported symbol. Precedent covers: ${[...SUPPORTED_SYMBOLS].join(', ')}.`,
      });
    }
    if (!bars || bars.length < 200) {
      return res.status(400).json({ error: 'Need at least 200 daily bars to classify a regime' });
    }

    // Cap free-text inputs before they reach the LLM prompt. The thesis is
    // user content that also carries the token bill, and an unbounded string
    // from an unauthenticated endpoint is a trivial way to burn quota.
    const safeThesis = (typeof thesis === 'string' ? thesis : '').slice(0, 500);
    const safeCatalyst = (typeof catalyst === 'string' ? catalyst : '').slice(0, 200);

    const { regime, features } = classifyRegime(bars);
    const { matches, stats } = findAnalogues(
      { symbol, regime, features },
      scenarioDB,
      { scope: scope === 'same' ? 'same' : 'all' }
    );

    // Attach a 95% Wilson interval to the headline win rates. A bare "83%"
    // from n=12 reads as far more precise than it is; the interval is what
    // makes the sample size honest instead of decorative.
    if (stats) {
      stats.winRate20dCI = wilsonInterval(
        Math.round((stats.winRate20d || 0) * stats.sampleSize), stats.sampleSize
      );
      stats.winRate5dCI = wilsonInterval(
        Math.round((stats.winRate5d || 0) * stats.sampleSize), stats.sampleSize
      );
    }

    const rsi = computeRSI(bars);
    const macd = computeMACD(bars);
    const fearGreed = isCrypto(symbol) ? await fetchFearGreedIndex() : null;
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
Trader's thesis: "${safeThesis || 'none given'}"
Catalyst: "${safeCatalyst || 'none given'}"

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
Suggested adverse-excursion level to plan around: ${pct(stats.adverseExcursionP75)}

TASK
Write a 150-220 word plain-English stress test brief as exactly four paragraphs, in this order, each starting with one of these labels on its own line, uppercase:
VERDICT:
THE RECORD:
INVALIDATION:
WHAT TO WATCH:
Rules:
1. VERDICT: one sentence. Open with the base-rate win rate and the drawdown a trader would have had to sit through. You must explicitly say whether the historical record SUPPORTS or CHALLENGES the trader's stated view, naming that view. If the trader is calling a long and the analogues mostly went up, say the record supports it; if the trader is calling a short and the analogues mostly went up, say the record works against it. Never leave this implicit.
2. THE RECORD: what actually happened after these similar setups, in plain English.
3. INVALIDATION: name ONE invalidation level, stated ONLY as a downward adverse move in percent (for example "a 6% adverse move"). Hard rules for this section:
   - Write it as a loss from entry, so the number must be positive and below 100.
   - NEVER express it as a percentage of entry value or an absolute price level. Phrases like "drops below 204% of entry" are wrong and must never appear.
   - Use the "Suggested adverse-excursion level" figure above as the level. Do not invent a different number, and do not contradict it later in the same paragraph.
4. WHAT TO WATCH: reference the technical signals and headlines only if they meaningfully agree or conflict with the base rate; otherwise name what would change the picture.
5. State once, clearly, that this is historical pattern-matching, not a prediction.
6. No bullet lists anywhere. Plain flowing sentences under each label. The four labels must appear exactly as written, each on its own line.`;

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

    // Guard against a brief that states a self-contradictory or impossible
    // invalidation level. We have seen the model write "drops below 204% of
    // the entry value" — above entry, and contradicting the "6% adverse move"
    // in the same sentence. Any "N% of entry" phrasing is a defect regardless
    // of the number, so the section is rebuilt from the computed level. This
    // runs after the call, and only on a brief the model actually produced.
    if (!/^Narrative brief unavailable/.test(brief) && stats.adverseExcursionP75 != null) {
      const INVALIDATION_RE = /INVALIDATION:\s*([\s\S]*?)(?=\n\s*WHAT TO WATCH:|$)/i;
      const invalidationSection = (brief.match(INVALIDATION_RE) || [])[1] || '';
      if (/(\d+(?:\.\d+)?)\s*%\s*of\s+(?:the\s+)?entry/i.test(invalidationSection)) {
        console.warn(`Brief contained an impossible invalidation level for ${symbol}; replacing with the computed adverse-excursion figure.`);
        const level = `${(Math.abs(stats.adverseExcursionP75) * 100).toFixed(1)}%`;
        brief = brief.replace(
          INVALIDATION_RE,
          `INVALIDATION:\nReconsider the thesis at a ${level} adverse move from entry. That is the level at which three quarters of these analogues had already gone further underwater, so past it this setup stops behaving like its typical self.\n\nWHAT TO WATCH:`
        );
      }
    }

    res.json({
      regime, features, stats, matches, matchCount: matches.length,
      barsSource, barsAsOf, rsi, macd, fearGreed, headlines,
      brief, baseline,
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