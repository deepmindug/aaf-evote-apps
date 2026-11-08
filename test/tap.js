const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const free = require('./free.json'); const WWW = path.join(__dirname, '..', 'www');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { const f = path.join(WWW, q.url === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] }); r.end(d); }); }).listen(8102);
(async () => {
  const b = await chromium.launch(); const page = await (await b.newContext({ ...devices['Pixel 7'] })).newPage();
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('http://127.0.0.1:8102/');
  await page.fill('input[name=server]', 'http://127.0.0.1:8000'); await page.fill('input[name=login]', 'grace.test@dade.example'); await page.fill('input[name=password]', 'Teacher2026x');
  await page.click('button[type=submit]'); await page.waitForSelector('#pupilForm', { timeout: 60000 });
  await page.fill('input[name=username]', free[3][1]); await page.fill('input[name=passcode]', free[3][2]); await page.click('#pupilForm button');
  await page.waitForSelector('.cands');
  const t0 = Date.now(); let n = 0;
  while (true) {
    const h = await page.textContent('.ballot h2');
    if (h === 'Check your choices') break;
    await page.tap('.cand >> nth=0'); n++;
    await page.waitForFunction(old => { const e = document.querySelector('.ballot h2'); return e && e.textContent !== old; }, h);
  }
  console.log('taps', n, 'ms', Date.now() - t0);
  const before = await page.textContent('.review__row:nth-child(5) .review__who b');
  await page.tap('[data-go="4"]'); await page.waitForSelector('.cands');
  console.log('editing', await page.textContent('.ballot h2'), '| back btn:', await page.textContent('#back'));
  await page.tap('.cand >> nth=1');
  await page.waitForSelector('.review__row.is-flash');
  const after = await page.textContent('.review__row.is-flash .review__who b');
  console.log('row5', before, '->', after, '| flashed post', await page.textContent('.review__row.is-flash .review__post'));
  await page.waitForTimeout(300); await page.screenshot({ path: 'shots/30-review-after-change.png' });
  await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
