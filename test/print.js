const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const WWW = path.join(__dirname, '..', 'www');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { const f = path.join(WWW, q.url === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] }); r.end(d); }); }).listen(8101);
(async () => {
  const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await page.goto('http://127.0.0.1:8101/');
  await page.fill('input[name=server]', 'http://127.0.0.1:8000'); await page.fill('input[name=login]', 'grace.test@dade.example'); await page.fill('input[name=password]', 'Teacher2026x');
  await page.click('button[type=submit]'); await page.waitForSelector('#pupilForm', { timeout: 60000 });
  await page.screenshot({ path: 'shots/12-home-fixed.png' });
  await page.click('#teacherBtn'); await page.fill('#unlock input[name=pw]', 'Teacher2026x'); await page.click('#unlock .btn--blue');
  await page.waitForSelector('.tiles'); await page.click('[data-tab=slips]');
  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.click('#sOnly'); await page.click('#sPrint');
  await page.waitForFunction(() => window.__printed);
  await page.pdf({ path: 'shots/slips.pdf', format: 'A4' });
  await b.close(); srv.close();
})();
