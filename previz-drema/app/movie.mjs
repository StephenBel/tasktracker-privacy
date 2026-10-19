// Покадровый рендер аниматика в frames/NNNNN.jpg: node movie.mjs <fps> [доКадра] [сКадра]
// Уже готовые кадры пропускаются, поэтому рендер можно продолжать и делить на параллельные диапазоны.
// Страница должна быть доступна на http://localhost:8765/index.html.
import { chromium } from 'playwright';
import fs from 'node:fs';

const fps = +process.argv[2] || 24, maxFrames = +process.argv[3] || 1e9, from = +process.argv[4] || 0;
fs.mkdirSync('frames', { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 700 } });
p.on('pageerror', e => console.log('[err]', e.message));
await p.goto('http://localhost:8765/index.html?headless=1');
await p.addStyleTag({ content: 'main{display:block!important;padding:0!important;max-width:none!important} header,aside,#hud{display:none!important} #sub{font-size:24px!important}' });
await p.waitForFunction(() => window.previz, null, { timeout: 60000 });
await p.evaluate(() => window.previz.ready);
await p.evaluate(() => window.dispatchEvent(new Event('resize')));
const shots = await p.evaluate(() => window.previz.shots.map(s => ({ id: s.id, dur: s.dur })));
let n = 0; const t0 = Date.now();
for (const s of shots) {
  const frames = Math.round(s.dur * fps);
  for (let f = 0; f < frames && n < maxFrames; f++, n++) {
    if (n < from || fs.existsSync(`frames/${String(n).padStart(5, '0')}.jpg`)) continue;
    await p.evaluate(([id, t]) => window.previz.renderShot(id, t), [s.id, f / frames]);
    await p.locator('.stage').screenshot({ path: `frames/${String(n).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 85 });
  }
}
console.log('frames', n, 'sec', (Date.now() - t0) / 1000);
await b.close();
