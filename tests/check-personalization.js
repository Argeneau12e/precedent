// One-off check: does the brief differentiate a bullish vs bearish thesis, and
// does it ever emit an impossible invalidation level?
const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const bars = (await (await fetch(`${BASE}/api/bars?symbol=NVDA`)).json()).bars;
  const run = async thesis => {
    const r = await (await fetch(`${BASE}/api/stress-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'NVDA', bars, thesis, catalyst: 'earnings' }),
    })).json();
    if (!r.brief) throw new Error(`no brief: ${JSON.stringify(r).slice(0, 300)}`);
    return r.brief;
  };

  const bull = await run('Thinking about going long, breakout looks real and momentum is still building.');
  const bear = await run('Thinking this bull run is exhausted, considering shorting into weakness.');

  const percentOfEntry = /(\d+(?:\.\d+)?)\s*%\s*of\s+(?:the\s+)?entry/i;
  console.log('bull has "% of entry" defect:', percentOfEntry.test(bull));
  console.log('bear has "% of entry" defect:', percentOfEntry.test(bear));
  console.log('briefs identical:', bull === bear);

  const section = (text, label) => {
    const m = text.match(new RegExp(label + ':([\\s\\S]*?)(?=' + 'WHAT TO WATCH:|$)'));
    return m ? m[1].trim() : '(section not found)';
  };

  console.log('\n--- BULL VERDICT ---\n' + section(bull, 'VERDICT'));
  console.log('\n--- BULL INVALIDATION ---\n' + section(bull, 'INVALIDATION'));
  console.log('\n--- BEAR VERDICT ---\n' + section(bear, 'VERDICT'));
  console.log('\n--- BEAR INVALIDATION ---\n' + section(bear, 'INVALIDATION'));

  const engages = /support|challenge|against|works for|argues|corroborat|confirm/i;
  console.log('\nbull verdict names support/challenge:', engages.test(section(bull, 'VERDICT')));
  console.log('bear verdict names support/challenge:', engages.test(section(bear, 'VERDICT')));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });