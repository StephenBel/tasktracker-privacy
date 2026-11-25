// Smoke test of the real Electron host (main process, IPC, pairing window,
// real screen capture, input pipeline) on any machine with a display:
//
//   xvfb-run -a node dev/electron-smoke.mjs      (Linux, headless)
//
// The native input helper is replaced by a script that records the commands
// it receives, so nothing is actually clicked.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from './relay.mjs';

const require = createRequire(import.meta.url);
const { chromium, _electron } = require('playwright'); // globally installed
const executablePath = require('electron'); // path of the local Electron binary
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macbridge-electron-'));
const RELAY_PORT = 18797;
const WEB_PORT = 18798;

const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(
  cfgPath,
  JSON.stringify({
    clientUrl: `http://127.0.0.1:${WEB_PORT}/`,
    signal: { type: 'relay', url: `ws://127.0.0.1:${RELAY_PORT}` },
    iceServers: [],
    video: { maxWidth: 2560, maxFps: 30, maxBitrate: 8000000 },
  }),
);
const env = {
  ...process.env,
  MB_CONFIG: cfgPath,
  MB_HOST_DIST: path.join(tmp, 'host'),
  MB_WEB_DIST: path.join(tmp, 'web'),
  MB_USER_DATA: path.join(tmp, 'userdata'),
  MB_INPUT_HELPER: path.join(tmp, 'fake-helper.mjs'),
  MB_DEBUG: '1',
};
if (spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { env, stdio: 'inherit' }).status) process.exit(1);

const inputLog = path.join(tmp, 'input.log');
fs.writeFileSync(
  env.MB_INPUT_HELPER,
  `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
console.log(JSON.stringify({ trusted: true }));
readline.createInterface({ input: process.stdin }).on('line', (l) => fs.appendFileSync(${JSON.stringify(inputLog)}, l + '\\n'));
`,
  { mode: 0o755 },
);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http
  .createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const file = path.join(tmp, 'web', p === '/' ? 'index.html' : p);
    if (!file.startsWith(tmp) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(WEB_PORT, '127.0.0.1');
const relay = startRelay(RELAY_PORT);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

// Quit like the menu item does, then make sure the process is really gone.
async function quit(electronApp) {
  const proc = electronApp.process();
  const exited = new Promise((r) => proc.once('exit', r));
  electronApp.evaluate(({ app }) => app.quit()).catch(() => {});
  if (!(await Promise.race([exited.then(() => true), sleep(8000)]))) proc.kill('SIGKILL');
}

let app;
let browser;
try {
  const launch = () =>
    _electron.launch({
      executablePath,
      args: [root, '--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'],
      env,
    });
  app = await launch();
  app.process().stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[electron] ${d}`));
  app.process().stderr.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[electron] ${d}`));

  // With no paired devices the app opens the pairing window by itself.
  const pairWin = await until(async () => {
    for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Подключить телефон') return w;
    return null;
  }, 15000);
  check('pairing window opens on first launch', !!pairWin);
  const link = await until(() => pairWin.evaluate(() => (typeof current !== 'undefined' && current ? current.link : null)));
  check('pairing window shows a link and QR code',
    !!link && link.startsWith(`http://127.0.0.1:${WEB_PORT}/#p=`) &&
      (await pairWin.evaluate(() => document.getElementById('qr').naturalWidth > 100)), link?.slice(0, 40));
  if (process.env.SHOTS) await pairWin.screenshot({ path: path.join(process.env.SHOTS, 'mac-pair.png') });

  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[client error]', e.message));
  await page.goto(link);
  const live = await until(() => page.evaluate(() => !document.getElementById('view').hidden), 20000);
  check('phone pairs with the Electron host and connects', !!live);
  check('pairing window reports success',
    !!(await until(() => pairWin.evaluate(() => !document.getElementById('done').hidden).catch(() => true))));

  const size = await until(() => page.evaluate(() => {
    const v = document.getElementById('video');
    return v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
  }), 15000);
  const display = await app.evaluate(({ screen }) => {
    const d = screen.getPrimaryDisplay();
    return { ...d.bounds, scale: d.scaleFactor };
  });
  check('real screen capture reaches the phone at the display resolution',
    !!size && size.w === Math.round(display.width * display.scale) && size.h === Math.round(display.height * display.scale),
    `${JSON.stringify(size)} for display ${JSON.stringify(display)}`);

  const state = JSON.parse(fs.readFileSync(path.join(env.MB_USER_DATA, 'state.json'), 'utf8'));
  check('keys are stored with one paired device', state.devices.length === 1 && typeof state.hostKey === 'string');

  // Tap in the middle of the picture: the helper must get global coordinates.
  const v = await page.evaluate(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { ...window.__macbridge.viewer.state, sx: r.left, sy: r.top };
  });
  await page.touchscreen.tap(v.sx + v.tx + v.fitW / 2, v.sy + v.ty + v.fitH / 2);
  await page.tap('#btn-kbd');
  await page.keyboard.type('тест');
  const lines = await until(() => {
    const l = fs.existsSync(inputLog) ? fs.readFileSync(inputLog, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : [];
    return l.filter((x) => x.t === 'text').map((x) => x.s).join('') === 'тест' ? l : null;
  });
  const click = lines?.find((l) => l.t === 'click');
  check('tap arrives at the input helper in screen coordinates',
    !!click && Math.abs(click.x - (display.x + display.width / 2)) < 2 && Math.abs(click.y - (display.y + display.height / 2)) < 2,
    JSON.stringify(click));
  check('typed text arrives at the input helper', !!lines);

  // Restart: the pairing must survive, the phone reconnects on its own.
  await quit(app);
  app = await launch();
  const back = await until(async () => {
    const s = await page.evaluate(() => ({
      live: !document.getElementById('view').hidden && document.getElementById('banner').hidden,
      t: document.getElementById('video').currentTime,
    }));
    if (!s.live) return false;
    await sleep(400);
    return (await page.evaluate(() => document.getElementById('video').currentTime)) > s.t;
  }, 40000);
  check('after the host restarts the phone reconnects without pairing again', !!back);
  check('no pairing window on later launches', app.windows().length === 1, `${app.windows().length} window(s)`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser?.close().catch(() => {});
  if (app) await quit(app);
  server.close();
  relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
