const { _electron } = require('playwright');
const path = require('path');
const free = require('./free.json');
(async () => {
  const app = await _electron.launch({ executablePath: path.join(__dirname, '../node_modules/electron/dist/electron'), args: ['--no-sandbox', path.join(__dirname, '..')] });
  const page = await app.firstWindow();
  page.on('console', m => console.log('console', m.type(), m.text()));
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await page.waitForSelector('#setupForm, #pupilForm');
  console.log('url', page.url(), 'platform', await page.evaluate(() => window.station && window.station.platform));
  if (await page.$('#setupForm')) {
    await page.fill('input[name=server]', 'http://127.0.0.1:8000');
    await page.fill('input[name=login]', 'grace.test@dade.example');
    await page.fill('input[name=password]', 'Teacher2026x');
    await page.click('button[type=submit]');
    await page.waitForSelector('#pupilForm', { timeout: 60000 });
  }
  const p = free[2];
  await page.fill('input[name=username]', p[1]); await page.fill('input[name=passcode]', p[2]);
  await page.click('#pupilForm button'); await page.waitForSelector('.cands');
  while (await page.$('.cands')) { await page.click('.cand >> nth=0'); await page.click('#next'); }
  await page.click('#cast'); await page.waitForSelector('.thanks');
  await page.waitForFunction(() => window.__station.S.votes.every(v => v.status !== 'pending'), null, { timeout: 30000 });
  console.log('votes', JSON.stringify(await page.evaluate(() => window.__station.S.votes.map(v => [v.pupil_id, v.status]))));
  await page.screenshot({ path: path.join(__dirname, 'shots/20-electron.png') });
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
