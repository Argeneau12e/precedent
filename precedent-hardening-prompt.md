# PRECEDENT — Hardening & Validation Pass

**Context:** Groq key has been rotated already — confirm it's updated in the Vercel dashboard env vars too, not just locally, since that's a common silent-failure point. Submission deadline is confirmed **October 8** via Bitget's official X — this document assumes that runway.

This is a patch pass on an already-built, already-deployed product (commit `9199cb6` per your own build document). Where I give full code, it's for new standalone files. Where I don't have your actual current file content, I give precise instructions instead of guessing — apply the same logic to wherever the equivalent code now lives in your evolved codebase, don't wait for exact-match code you don't have.

---

## 0. Non-negotiables (unchanged, restated because they apply doubly here)

1. Never fabricate — this pass adds validation specifically so you can report real numbers, good or bad. If the walk-forward check comes back weak, report it weak. A modest honest edge beats an invented strong one.
2. `scenarioDB.json` is about to change shape (Section 2 below). Every file that currently does `require('./scenarioDB.json')` or reads it as a flat array must be found and updated in the same pass — a half-migrated shape change is worse than the bug it fixes.
3. Re-run your full jsdom suite after all of this, before redeploying. If any of the 43 assertions break, that's real signal, not noise to route around.

---

## 1. Security & ops hygiene — do first

**Rate limiting.** The API is public with no auth and a finite Groq/NewsAPI quota. Add:

```javascript
// In server.js, near the top with other requires
const rateLimit = require('express-rate-limit');

const stressTestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,
  message: { error: 'Too many stress tests from this IP — wait a few minutes and try again.' },
});

// Apply it specifically to the expensive endpoint:
app.post('/api/stress-test', stressTestLimiter, async (req, res) => {
  // ...existing handler body unchanged
});
```

Add `express-rate-limit` to `package.json` dependencies. Also add basic security headers:

```javascript
const helmet = require('helmet');
app.use(helmet());
```

Add `helmet` to dependencies.

**Input caps.** Cheap insurance against abuse and runaway token costs — in the `/api/stress-test` handler, before building the prompt:

```javascript
const safeThesis = (thesis || '').slice(0, 500);
const safeCatalyst = (catalyst || '').slice(0, 200);
// use safeThesis / safeCatalyst in the prompt instead of the raw values
```

Also validate `symbol` against your actual supported list (the 8 equities + BTC/ETH) before doing anything else in both `/api/bars` and `/api/stress-test` — reject anything else with a 400 rather than letting an arbitrary string reach Yahoo/Coinbase.

**Checklist, not code:**
- [ ] Confirm rotated `GROQ_API_KEY` is set in Vercel's dashboard (not just `.env` locally)
- [ ] Decide on `NEWSAPI_KEY` — either refresh it (currently 401 per your own document) or consciously leave headlines permanently absent. Either is fine; a decision beats an open question this close to deadline
- [ ] Confirm `.env` is still git-ignored after all these changes

---

## 2. Fix the provenance date bug

Your own screenshots show the provenance footer reading "scenario DB built 2018-10-20" — reading the wrong signal (file mtime, which git/Vercel don't reliably preserve) instead of a real build timestamp. Right next to your "nothing is synthesized" honesty statement, a nonsense date undercuts exactly the credibility that line is trying to establish.

**Fix — store the timestamp inside the data itself, not the filesystem:**

In `scripts/buildScenarioDB.js`, change the final write from a bare array to an object carrying its own metadata:

```javascript
// Replace your current final write with:
const output = {
  builtAt: new Date().toISOString(),
  scenarios: all,
};
fs.writeFileSync(path.join(__dirname, '../scenarioDB.json'), JSON.stringify(output, null, 2));
console.log(`Wrote ${all.length} scenarios to scenarioDB.json (builtAt: ${output.builtAt})`);
```

**This changes the file's shape — update every consumer:**
- `server.js`: change `const scenarioDB = require('./scenarioDB.json');` to `const { scenarios: scenarioDB, builtAt: dbBuiltAt } = require('./scenarioDB.json');` and have `/api/meta` return `dbBuiltAt` directly instead of reading file mtime.
- `lib/playbook.js`: wherever it currently reads the scenario array, it now needs to destructure `.scenarios` the same way.
- Any script under `scripts/` that reads `scenarioDB.json` directly (including the two new ones below) needs the same `.scenarios` destructure.

Rebuild the DB after this change (`npm run build-db`) and confirm the footer shows a real, current date before moving on.

---

## 3. Statistical rigor — the highest-value addition given the extra time

**3a. Confidence interval on the win rate.** n≈12 with a bare percentage and no interval is the single most obvious thing a careful judge will push on. Add:

```javascript
// lib/confidence.js — new file
// Wilson score interval: a cheap, honest way to show how much a small-n win rate
// should actually be trusted, rather than presenting 75% as if it were precise.

function wilsonInterval(successes, n, z = 1.96) {
  if (!n) return null;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return {
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

module.exports = { wilsonInterval };
```

In whichever function currently computes `stats.winRate20d` (`lib/scenarioMatcher.js` per your document), also count analogues with `forwardReturn20d > 0`, call `wilsonInterval(winCount, sampleSize)`, and attach the result as `stats.winRate20dCI`. Pass it through the `/api/stress-test` response.

In the UI, render it next to the win-rate ring — e.g. `75% (95% CI: 46%–92%)` — and when `sampleSize < 20`, show a small note: "small sample — wide uncertainty." This one line does more for "research quality" than almost anything else on this list, because it's the exact thing a skeptical reviewer reaches for first and most entries in this track won't have it.

**3b. Walk-forward validation — does the matching approach actually have an edge, or is it just descriptive?**

```javascript
// scripts/walkForwardValidate.js — new file
// Honesty check, not a feature: does analogue-matching actually predict direction
// better than a naive baseline, out of sample? Report the real number either way.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { findAnalogues } = require('../lib/scenarioMatcher');

const CUTOFF_DATE = '2025-06-01'; // adjust to your actual data range if needed
const { scenarios: full } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../scenarioDB.json'))
);

const trainSet = full.filter(s => s.date < CUTOFF_DATE);
const testSet = full.filter(s => s.date >= CUTOFF_DATE);

console.log(`Train: ${trainSet.length} scenarios before ${CUTOFF_DATE}`);
console.log(`Test:  ${testSet.length} scenarios on/after ${CUTOFF_DATE}`);

const trainWinRate = trainSet.filter(s => s.forwardReturn20d > 0).length / trainSet.length;
const baselinePredictsWin = trainWinRate >= 0.5;

let correct = 0;
let baselineCorrect = 0;
let total = 0;

for (const testRow of testSet) {
  const setup = { symbol: testRow.symbol, regime: testRow.regime, features: testRow.features };
  const { stats } = findAnalogues(setup, trainSet, { scope: 'same', limit: 12 });
  if (!stats || stats.sampleSize < 5) continue;

  const predictedWin = stats.winRate20d >= 0.5;
  const actualWin = testRow.forwardReturn20d > 0;

  if (predictedWin === actualWin) correct++;
  if (baselinePredictsWin === actualWin) baselineCorrect++;
  total++;
}

console.log(`\nAnalogue-matching directional accuracy: ${((correct / total) * 100).toFixed(1)}% (n=${total})`);
console.log(`Naive baseline accuracy:                ${((baselineCorrect / total) * 100).toFixed(1)}%`);
console.log(`\nReport this honestly in the project description either way — a small or`);
console.log(`negative edge over baseline is still a more credible claim than an unvalidated one.`);
```

Run it, read the output, and put the real result in the hackathon form's Validation Data section (Part 3 of the project description). If the edge is thin, say so and frame the tool's value as transparency/discipline rather than alpha — that's a defensible, honest position. If there's a real edge, that's a genuinely strong claim to lead with.

---

## 4. Investigate the regime anomaly before a judge finds it

TSLA's regime playbook shows `strong_bull` at −1.66% mean 20-day return with a sub-50% win rate — underperforming `weak_bull` and even `weak_bear`. That's either a real momentum-exhaustion finding (sellable insight) or an alignment bug (needs fixing). Find out which:

```javascript
// scripts/verifyAlignment.js — new file
// Manual-review helper — prints sample rows so you can eyeball them against a real
// price chart and confirm the regime label and the forward-return window are
// genuinely non-overlapping (features from bars up to t, returns strictly after t).

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SYMBOL = process.argv[2] || 'TSLA';
const REGIME = process.argv[3] || 'strong_bull';
const N = 5;

const { scenarios: db } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../scenarioDB.json'))
);
const rows = db.filter(s => s.symbol === SYMBOL && s.regime === REGIME).slice(0, N);

console.log(`Sample ${REGIME} rows for ${SYMBOL} — check these against a real price chart:\n`);
for (const r of rows) {
  console.log(`${r.date} | momentum20=${r.features.momentum20.toFixed(3)} | atrPct=${r.features.atrPercentile.toFixed(2)}`);
  console.log(`  -> next 5d: ${(r.forwardReturn5d * 100).toFixed(2)}%  next 20d: ${(r.forwardReturn20d * 100).toFixed(2)}%  maxDD: ${(r.maxDrawdown20d * 100).toFixed(2)}%\n`);
}
console.log('Confirm: (1) the regime label matches what the chart actually shows at that date,');
console.log('(2) the forward-return window genuinely starts AFTER that date — never overlapping the lookback.');
```

Run it (`node scripts/verifyAlignment.js TSLA strong_bull`), pull up a real TSLA chart for those five dates, and settle it. Either fix the alignment bug if you find one, or — if it checks out — consider naming this explicitly in your project description as evidence the tool surfaces real structure rather than naive trend-following. A judge who asks "why does strong bull underperform?" and gets a confident, specific answer will trust the rest of the numbers more, not less.

---

## 5. Verify personalization actually changes the output

Run the same symbol and same day's data through the ask box twice: once phrased bullishly ("thinking about going long, breakout looks real"), once phrased skeptically ("thinking this bull run is exhausted, considering shorting"). The underlying stats will and should stay identical — but the brief's VERDICT and WHAT TO WATCH sections should visibly engage with which view was stated, not just restate the same numbers with a different wrapper sentence.

If it doesn't differentiate enough, tighten the Groq prompt's TASK instructions to explicitly require the model to state whether the historical record supports or challenges the trader's stated view, by name, in the first section — not just "write a brief."

---

## 6. Verify the degraded-mode path actually works

You built a resilience chain (cache → live → snapshot → honest 502) but your own document notes it hasn't been exercised end-to-end. Before Oct 8: hit the app with `?snapshot=1` forced, confirm the UI renders correctly and the source badge honestly shows "snapshot," and confirm the copy doesn't look broken or half-populated in that mode. This is exactly the path that activates if Yahoo/Coinbase block Vercel's IP during judge review — you want to have seen it work, not just trust that it will.

---

## 7. Polish, lower priority but cheap

- Visual QA pass in both themes on a real screen, not just jsdom — check contrast and focus-ring visibility specifically, since your own document flags this as unverified.
- A quick mobile pass — combobox and the long question field are the likeliest pain points on a small screen.
- Consider a short response cache (5–10 min, keyed on symbol+scope+thesis hash) if you want extra insurance against repeated identical Groq calls burning quota — optional, the rate limiter in Section 1 already covers the main risk.

---

## 8. Definition of done (v2)

- [ ] Rotated Groq key confirmed live in Vercel's dashboard
- [ ] Rate limiting + input caps + helmet added and deployed
- [ ] `scenarioDB.json` carries a real `builtAt`; every consumer updated to the new `{ builtAt, scenarios }` shape; footer shows a correct date
- [ ] Wilson interval computed and shown in the UI next to the win-rate ring
- [ ] Walk-forward validation run at least once; real result (whatever it is) written into the project description's Validation Data section
- [ ] `strong_bull` anomaly explained — either fixed or confidently explainable
- [ ] Contrarian-thesis test run; brief confirmed to actually engage with stated direction
- [ ] `?snapshot=1` degraded mode manually verified
- [ ] Full jsdom suite re-run and passing after all of the above
- [ ] Screen recording of one full run — done, not just planned
- [ ] X post confirmed live with `#BitgetHackathon` + `@Bitget_AI`, staying up through judge review

---

## 9. Submission material updates this unlocks

Once Sections 3 and 4 are done, update the form's project description:
- **Validation Data (Part 3):** replace "targeted" language with the actual walk-forward result and the confidence-interval methodology — this is now a real, defensible claim instead of a placeholder.
- **Role of the LLM field:** worth a line noting the brief is explicitly required to engage with the stated thesis direction, not just narrate statistics — ties directly to the "personalized thesis" criterion by name.
