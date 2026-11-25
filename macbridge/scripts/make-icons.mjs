// Renders the app and tray icons from inline SVG (run once; output is committed).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // globally installed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A laptop with a phone in front of it.
const glyph = (stroke, w) => `
  <g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 62V32a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v8"/>
    <path d="M12 68h44"/>
    <rect x="62" y="44" width="22" height="36" rx="5"/>
  </g>`;

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#2a6fe8"/>
  <g transform="translate(2 -3)">${glyph('#fff', 5)}</g>
</svg>`;

const trayIcon = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 20 80 64">${glyph(color, 7)}</svg>`;

const jobs = [
  [appIcon, 180, 180, 'web/icon-180.png', false],
  [appIcon, 512, 512, 'web/icon-512.png', false],
  [trayIcon('#000'), 22, 18, 'host/assets/trayTemplate.png', true],
  [trayIcon('#000'), 44, 36, 'host/assets/trayTemplate@2x.png', true],
  [trayIcon('#e8e8e8'), 44, 36, 'host/assets/tray.png', true],
];

const browser = await chromium.launch();
for (const [svg, w, h, file, transparent] of jobs) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${svg}`,
  );
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  await page.screenshot({ path: path.join(root, file), omitBackground: transparent });
  await page.close();
}
await browser.close();
console.log('icons written');
