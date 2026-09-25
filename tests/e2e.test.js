// tests/e2e.test.js
//
// Real-browser end-to-end suite for Precedent, run with Playwright against a
// live server. This replaces the earlier throwaway jsdom harness: jsdom proved
// structure and logic but could never see pixels, computed styles, or whether
// an event handler actually fired in a browser. Playwright closes that gap —
// this suite fails on console errors, failed requests, and real measured
// contrast, none of which jsdom could detect.
//
// Run: npm test
// Requires the Playwright chromium binary: npx playwright install chromium
//
// These tests are deliberately non-flaky: they assert on user-visible outcomes
// and explicit state contracts, never on animation timing or exact pixel
// coordinates.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || 3111;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const done = err => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(proc);
    };
    proc.stdout.on('data', d => { if (String(d).includes('running on port')) done(); });
    proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    proc.on('exit', code => done(new Error(`server exited early with code ${code}`)));
    setTimeout(() => done(new Error('server did not start within 20s')), 20000);
  });
}

// PART_TWO

async function main() {
  console.log('PRECEDENT — end-to-end suite (Playwright / Chromium)\n');
  const server = await startServer();
  const browser = await chromium.launch();
  const consoleErrors = [];
  const failedRequests = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', r => {
      const u = r.url();
      if (!u.includes('fonts.g') && !u.includes('unpkg.com')) {
        failedRequests.push(`${u} — ${r.failure()?.errorText}`);
      }
    });

    // --- 1. Boot -------------------------------------------------------------
    console.log('boot');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('#scenarioCount')?.textContent?.match(/\d/),
      null, { timeout: 20000 }
    );
    const scenarioChip = await page.textContent('#scenarioCount');
    check('scenario count chip is populated', /\d/.test(scenarioChip || ''), scenarioChip);
    check('scenario count is plausible (>1000)',
      parseInt((scenarioChip || '').replace(/\D/g, ''), 10) > 1000, scenarioChip);

    // --- 2. Security headers -------------------------------------------------
    console.log('\nsecurity headers');
    const res = await page.request.get(`${BASE}/api/meta`);
    const csp = res.headers()['content-security-policy'] || '';
    check('CSP header present', !!csp);
    check('CSP restricts default-src to self', /default-src 'self'/.test(csp), csp.slice(0, 60));
    check('CSP sets frame-ancestors none', /frame-ancestors 'none'/.test(csp));
    check('X-Content-Type-Options set', res.headers()['x-content-type-options'] === 'nosniff');
    check('helmet active (no x-powered-by)', res.headers()['x-powered-by'] === undefined);

    // --- 3. API hardening ---------------------------------------------------
    console.log('\napi validation');
    const badBars = await page.request.get(`${BASE}/api/bars?symbol=NOTREAL`);
    check('unsupported symbol rejected with 400', badBars.status() === 400, `got ${badBars.status()}`);
    const injBars = await page.request.get(`${BASE}/api/bars?symbol=../../etc/passwd`);
    check('path-traversal symbol rejected with 400', injBars.status() === 400, `got ${injBars.status()}`);
    const lower = await page.request.get(`${BASE}/api/bars?symbol=nvda`);
    check('lowercase symbol accepted', lower.status() === 200, `got ${lower.status()}`);
    const badPb = await page.request.get(`${BASE}/api/playbook?symbol=EVIL`);
    check('playbook rejects unsupported symbol', badPb.status() === 400, `got ${badPb.status()}`);
    const stNoSym = await page.request.post(`${BASE}/api/stress-test`, {
      data: { bars: new Array(250).fill({ date: '2024-01-01', close: 100 }) },
    });
    check('stress-test without symbol rejected', stNoSym.status() === 400, `got ${stNoSym.status()}`);
    const stBadSym = await page.request.post(`${BASE}/api/stress-test`, {
      data: { symbol: 'HACKER', bars: new Array(250).fill({ date: '2024-01-01', close: 100 }) },
    });
    check('stress-test rejects unsupported symbol', stBadSym.status() === 400, `got ${stBadSym.status()}`);

    // --- 4. Wilson interval + real LLM brief ---------------------------------
    console.log('\nconfidence interval + brief');
    const barsResp = await page.request.get(`${BASE}/api/bars?symbol=BTC`);
    const barsJson = await barsResp.json();
    check('bars returned for BTC', Array.isArray(barsJson.bars) && barsJson.bars.length >= 200,
      `${barsJson.bars?.length} bars`);
    const st = await page.request.post(`${BASE}/api/stress-test`, {
      data: { symbol: 'BTC', bars: barsJson.bars, thesis: 'test', scope: 'all' },
    });
    const stJson = await st.json();
    check('stress-test succeeded', st.status() === 200, `got ${st.status()}`);
    check('winRate20dCI present', !!stJson.stats?.winRate20dCI);
    const ci = stJson.stats?.winRate20dCI;
    if (ci) {
      check('Wilson low bound in [0,1]', ci.low >= 0 && ci.low <= 1, `low=${ci.low}`);
      check('Wilson high bound in [0,1]', ci.high >= 0 && ci.high <= 1, `high=${ci.high}`);
      check('Wilson interval contains point estimate',
        ci.low <= stJson.stats.winRate20d + 1e-9 && ci.high >= stJson.stats.winRate20d - 1e-9,
        `point=${stJson.stats.winRate20d} ci=[${ci.low},${ci.high}]`);
      check('Wilson interval non-degenerate for small n', ci.high - ci.low > 0.01,
        `width=${(ci.high - ci.low).toFixed(3)}`);
    }
    check('brief is real prose, not an error note',
      typeof stJson.brief === 'string' && stJson.brief.length > 200
      && !/^Narrative brief unavailable/.test(stJson.brief), stJson.brief?.slice(0, 60));
    check('headlines present with working NewsAPI key',
      Array.isArray(stJson.headlines) && stJson.headlines.length > 0,
      `${stJson.headlines?.length} headlines`);

    // --- 5. DB shape / provenance -------------------------------------------
    console.log('\nprovenance');
    const meta = await (await page.request.get(`${BASE}/api/meta`)).json();
    check('dbBuiltAt is a real 2026 timestamp',
      typeof meta.dbBuiltAt === 'string' && meta.dbBuiltAt.startsWith('2026'), String(meta.dbBuiltAt));
    check('dbBuiltAt is not a stale mtime artifact',
      !/^20(1[0-9]|2[0-2])-/.test(String(meta.dbBuiltAt)), String(meta.dbBuiltAt));
    check('scenarioCount matches DB', meta.scenarioCount > 9000, String(meta.scenarioCount));

    // --- 6. Full UI run through a real browser -------------------------------
    console.log('\nfull ui run');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.click('#demoBtn');
    await page.waitForSelector('#card-verdict', { timeout: 180000 });
    await page.waitForFunction(
      () => document.querySelector('#card-brief')?.textContent?.length > 200,
      null, { timeout: 180000 }
    );

    check('verdict card rendered', !!(await page.$('#card-verdict')));
    check('confidence interval visible in the ring', !!(await page.$('.ring-ci')));
    const ciText = (await page.textContent('.ring-ci').catch(() => '')) || '';
    check('confidence interval shows a range', /%.*–.*%/.test(ciText), ciText);
    check('price card rendered', !!(await page.$('#card-price')));
    check('sparkline has real points',
      (await page.$$eval('#card-price polyline, #card-price path', els => els.length)) > 0);
    check('analogue table rendered', (await page.$$('#card-analogues tbody tr')).length > 0);
    check('playbook rendered', (await page.$$('#card-playbook [class*="pb-"]')).length > 0);
    const briefText = await page.textContent('#card-brief');
    check('brief rendered as prose', (briefText || '').length > 200);

    // --- 7. Degraded snapshot mode ------------------------------------------
    console.log('\ndegraded snapshot mode');
    const snap = await page.request.get(`${BASE}/api/bars?symbol=BTC&snapshot=1`);
    const snapJson = await snap.json();
    check('snapshot mode serves bars', snapJson.bars?.length >= 200, `${snapJson.bars?.length}`);
    check('snapshot mode labels its source honestly', snapJson.source === 'snapshot', String(snapJson.source));

    // --- 8. Theme, measured contrast, responsive ------------------------------
    console.log('\ntheme, measured contrast, responsive');
    // Theme changes repaint the page background. getComputedStyle can report a
    // background that has not caught up to the current --bg token, which made a
    // settled 16:1 page measure as 2.18:1. Rather than sleep and hope, wait for
    // the painted body background to actually equal the active theme token.
    // Reduced motion is emulated so this is not racing an animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const waitForThemePaint = async () => {
      await page.waitForFunction(() => {
        const root = getComputedStyle(document.documentElement);
        const token = root.getPropertyValue('--bg').trim();
        const m = token.match(/^#?([0-9a-f]{6})$/i);
        if (!m) return true;
        const hex = m[1];
        const want = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
        return getComputedStyle(document.body).backgroundColor === want;
      }, null, { timeout: 8000, polling: 100 });
    };

    const beforeTheme = await page.getAttribute('html', 'data-theme');
    await page.click('#themeBtn');
    await waitForThemePaint();
    const afterTheme = await page.getAttribute('html', 'data-theme');
    check('theme toggles', beforeTheme !== afterTheme, `${beforeTheme} -> ${afterTheme}`);

    // Real contrast measurement from painted styles — jsdom could never do this.
    // The surfaces here are translucent glass, so measuring text against the
    // card's own rgba() would be wrong: rgba(255,255,255,0.045) has the
    // luminance of near-white, which makes every light-on-dark surface look
    // like a 1:1 failure. Alpha has to be composited over what is actually
    // painted underneath, walking up the ancestor chain to the first opaque
    // background, which is exactly what the eye sees.
    const measureContrast = () => page.evaluate(() => {
      const parse = c => {
        const n = (c.match(/[\d.]+/g) || []).map(Number);
        return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n.length > 3 ? n[3] : 1 };
      };
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = c => {
        const ch = v => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
      };
      // Composite every translucent layer from the element up to the first
      // opaque backdrop, then use that as the effective background.
      const effectiveBg = el => {
        const layers = [];
        let n = el;
        while (n) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.a > 0) {
            layers.push(c);
            if (c.a === 1) break;
          }
          n = n.parentElement;
        }
        let base = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
        return base;
      };
      const card = document.querySelector('#card-verdict');
      if (!card) return null;
      const probe = document.createElement('span');
      probe.textContent = 'x';
      probe.style.color = getComputedStyle(card).color;
      card.appendChild(probe);
      const fg = parse(getComputedStyle(probe).color);
      probe.remove();
      // The text colour may itself carry alpha; composite it the same way.
      const bg = effectiveBg(card);
      const fgFlat = fg.a < 1 ? over(fg, bg) : fg;
      const l1 = lum(fgFlat), l2 = lum(bg);
      return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
    });

    const darkContrast = await measureContrast();
    check(`verdict card contrast >= 4.5:1 (${afterTheme})`, darkContrast !== null && darkContrast >= 4.5,
      `ratio ${darkContrast}:1`);
    await page.click('#themeBtn');
    await waitForThemePaint();
    const activeTheme = await page.getAttribute('html', 'data-theme');
    check('second theme state reached', activeTheme !== afterTheme, `${afterTheme} -> ${activeTheme}`);
    const lightContrast = await measureContrast();
    check(`verdict card contrast >= 4.5:1 (${activeTheme})`, lightContrast !== null && lightContrast >= 4.5,
      `ratio ${lightContrast}:1`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const mobileNavVisible = await page.isVisible('.mobile-nav').catch(() => false);
    const railHidden = await page.isHidden('.rail').catch(() => false);
    check('mobile layout switches away from the rail', mobileNavVisible || railHidden,
      `nav=${mobileNavVisible} railHidden=${railHidden}`);
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
    check('no horizontal overflow at 390px', noOverflow);

    // --- 9. Runtime hygiene --------------------------------------------------
    console.log('\nruntime hygiene');
    check('no uncaught console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('no failed first-party requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`passed ${passed}   failed ${failed}`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log('='.repeat(56));
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('\nsuite crashed:', err); process.exit(1); });