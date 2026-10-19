// Headless-рендер всех шотов в PNG: node render.mjs <url> <outdir> [shotIds...]
import { chromium } from 'playwright';
import fs from 'node:fs';

const [url, out = 'renders', ...only] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1434, height: 600 } });
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.log('[error]', e.message));
await page.goto(url + '?headless=1');
await page.waitForFunction(() => window.previz, null, { timeout: 60000 });
await page.evaluate(() => window.previz.ready);
const ids = only.length ? only : await page.evaluate(() => window.previz.shots.map(s => s.id));
for (const id of ids) {
  for (const t of [0]) {
    await page.evaluate(([id, t]) => window.previz.renderShot(id, t), [id, t]);
    await page.locator('.stage').screenshot({ path: `${out}/${id}.jpg`, type: 'jpeg', quality: 80 });
    console.log('rendered', id);
  }
}
await browser.close();
