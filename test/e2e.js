// End-to-end test of the offline station against the local Laravel server.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const free = require('./free.json');
const WWW = path.join(__dirname, '..', 'www');
const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const f = path.join(WWW, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(8100);

const log = (...a) => console.log('·', ...a);
async function setup(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGE ERROR', name, e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('console', name, m.text()); });
  await page.goto('http://127.0.0.1:8100/');
  await page.check('input[name=where][value=own]');
  await page.fill('input[name=server]', 'http://127.0.0.1:8000');
  await page.fill('input[name=login]', 'grace.test@dade.example');
  await page.fill('input[name=password]', 'Teacher2026x');
  if (name === 'A') await page.screenshot({ path: SHOTS + '/01-setup.png' });
  await page.click('button[type=submit]');
  await page.waitForSelector('#pupilForm', { timeout: 60000 });
  return { ctx, page };
}
async function vote(page, pupil, shots) {
  await page.fill('input[name=username]', pupil[1]);
  await page.fill('input[name=passcode]', pupil[2].toLowerCase());
  await page.click('#pupilForm button');
  await page.waitForSelector('.cands');
  let n = 0;
  while (await page.$('.cands')) {
    await page.click('.cand >> nth=0');
    if (shots && n === 0) await page.screenshot({ path: SHOTS + '/03-ballot.png' });
    await page.click('#next'); n++;
  }
  await page.waitForSelector('#cast');
  if (shots) await page.screenshot({ path: SHOTS + '/04-review.png', fullPage: false });
  await page.click('#cast');
  await page.waitForSelector('.thanks');
  if (shots) await page.screenshot({ path: SHOTS + '/05-thanks.png' });
  await page.click('#done');
  await page.waitForSelector('#pupilForm');
  return n;
}
const state = page => page.evaluate(() => ({ votes: window.__station.S.votes.map(v => [v.pupil_id, v.status, v.reason]), online: window.__station.S.online }));

(async () => {
  const browser = await chromium.launch();
  const A = await setup(browser, 'A');
  await A.page.screenshot({ path: SHOTS + '/02-home.png' });
  log('A set up');

  // Wrong passcode
  await A.page.fill('input[name=username]', free[0][1]);
  await A.page.fill('input[name=passcode]', 'ZZZZ');
  await A.page.click('#pupilForm button');
  await A.page.waitForSelector('.alert--bad');
  log('wrong code:', await A.page.textContent('.alert--bad'));

  // Offline vote on A
  await A.ctx.setOffline(true);
  await A.page.evaluate(() => window.__station.syncNow());
  const posts = await vote(A.page, free[0], true);
  log('A voted offline for', free[0][3], 'posts', posts, await state(A.page));
  await A.page.screenshot({ path: SHOTS + '/06-home-queue.png' });

  // Same pupil again on the same device → blocked locally
  await A.page.fill('input[name=username]', free[0][1]);
  await A.page.fill('input[name=passcode]', free[0][2]);
  await A.page.click('#pupilForm button');
  await A.page.waitForSelector('.alert');
  log('again on A:', await A.page.textContent('.alert'));

  // Device B, offline, the same pupil votes again (two devices) + pupil 2 votes on both
  const B = await setup(browser, 'B');
  await B.ctx.setOffline(true);
  await B.page.evaluate(() => window.__station.syncNow());
  await vote(B.page, free[0]);
  await vote(B.page, free[1]);
  await vote(A.page, free[1]);
  log('B voted offline for', free[0][3], 'and', free[1][3]);

  // B comes online first → its votes win
  await B.ctx.setOffline(false);
  await B.page.waitForFunction(() => !window.__station.S.votes.some(v => v.status === 'pending'), null, { timeout: 30000 });
  log('B after sync', await state(B.page));
  await A.ctx.setOffline(false);
  await A.page.waitForFunction(() => !window.__station.S.votes.some(v => v.status === 'pending'), null, { timeout: 30000 });
  log('A after sync', await state(A.page));

  // Teacher area on A
  await A.page.click('#teacherBtn');
  await A.page.fill('#unlock input[name=pw]', 'wrong');
  await A.page.click('#unlock .btn--blue');
  await A.page.waitForSelector('#unlock .err:not([hidden])');
  await A.page.fill('#unlock input[name=pw]', 'Teacher2026x');
  await A.page.click('#unlock .btn--blue');
  await A.page.waitForSelector('.tiles');
  await A.page.screenshot({ path: SHOTS + '/07-teacher.png', fullPage: true });
  await A.page.click('[data-tab=pupils]');
  await A.page.fill('#pq', free[1][1]);
  await A.page.click('[data-show]');
  await A.page.screenshot({ path: SHOTS + '/08-pupils.png' });
  await A.page.click('[data-tab=slips]');
  await A.page.screenshot({ path: SHOTS + '/09-slips.png' });
  await A.page.click('[data-tab=device]');
  await A.page.screenshot({ path: SHOTS + '/10-device.png' });

  // Reload while offline: data survives
  await A.page.reload();
  await A.page.waitForSelector('#pupilForm');
  log('after offline reload', (await state(A.page)).votes.length, 'votes kept');

  // Phone view
  const P = await browser.newContext({ ...require('playwright').devices['Pixel 7'] });
  const pp = await P.newPage();
  await pp.goto('http://127.0.0.1:8100/');
  await pp.screenshot({ path: SHOTS + '/11-phone-setup.png' });

  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
