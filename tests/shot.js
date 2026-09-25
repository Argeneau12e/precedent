// Screenshot helper: capture the hero/control area in both themes so spacing
// and combobox styling can be judged by eye, not inferred from source.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3145;
const OUT = path.join(__dirname, '..', '.shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise(r => server.stdout.on('data', d => String(d).includes('running on port') && r()));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const hero = page.locator('.hero');
  await hero.screenshot({ path: path.join(OUT, 'hero-dark.png') });

  // Open the combobox so its popup is visible in the capture.
  await page.click('#comboBtn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'combo-open-dark.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const theme = await page.getAttribute('html', 'data-theme');
  await page.click('#themeBtn');
  await page.waitForTimeout(700);
  await page.locator('.hero').screenshot({ path: path.join(OUT, 'hero-light.png') });
  console.log('captured from theme', theme, '-> toggled');
  console.log('written to', OUT);

  await browser.close();
  server.kill();
})();