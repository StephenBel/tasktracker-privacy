// End-to-end test of everything that does not need macOS.
//
// A headless Chromium plays both roles: one page runs the real host engine
// (with a canvas standing in for the Mac screen and a recorder standing in
// for the input helper), another page emulates an iPhone and runs the real
// web client. They talk through the local relay and a real WebRTC connection.
//
//   npm test                   (add SHOTS=dir to save screenshots)
//   SIGNAL=config npm test     use the signaling server from config.json (the
//                              real Supabase project) instead of the local relay
//   SIGNAL=config CLIENT=config npm test
//                              additionally load the phone page from the
//                              published clientUrl instead of the local build

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startRelay } from './relay.mjs';

const { chromium } = createRequire(import.meta.url)('playwright'); // globally installed
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macbridge-test-'));
const shots = process.env.SHOTS;
const realSignal = process.env.SIGNAL === 'config'; // real signaling server
const RELAY_PORT = 18787;
const WEB_PORT = 18788;
const clientBase =
  process.env.CLIENT === 'config'
    ? JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).clientUrl
    : `http://127.0.0.1:${WEB_PORT}/`;

// ------------------------------------------------------------------ setup

const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(
  cfgPath,
  JSON.stringify({
    clientUrl: `http://127.0.0.1:${WEB_PORT}/`,
    signal: realSignal
      ? JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).signal
      : { type: 'relay', url: `ws://127.0.0.1:${RELAY_PORT}` },
    iceServers: [],
    video: { maxWidth: 2560, maxFps: 30, maxBitrate: 8000000 },
  }),
);
const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
  env: {
    ...process.env,
    MB_CONFIG: cfgPath,
    MB_HOST_DIST: path.join(tmp, 'host'),
    MB_WEB_DIST: path.join(tmp, 'web'),
  },
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(1);

// Stand-in for Electron's preload API and for the Mac screen.
fs.writeFileSync(
  path.join(tmp, 'host', 'harness.html'),
  `<!doctype html><meta charset="utf-8"><canvas id="c" width="1600" height="1000"></canvas>
<script>
  const handlers = {};
  const saved = { hostKey: null, devices: [] };
  window.inputs = [];
  window.events = [];
  window.emit = (channel, arg) => handlers[channel]?.(arg);
  const ctx = document.getElementById('c').getContext('2d');
  let frame = 0;
  setInterval(() => {
    ctx.fillStyle = '#20242c'; ctx.fillRect(0, 0, 1600, 1000);
    ctx.strokeStyle = '#3d4654';
    for (let x = 0; x <= 1600; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1000); ctx.stroke(); }
    for (let y = 0; y <= 1000; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1600, y); ctx.stroke(); }
    ctx.fillStyle = '#e8eaee'; ctx.font = '28px sans-serif';
    for (let x = 0; x < 1600; x += 200) for (let y = 0; y < 1000; y += 200) ctx.fillText(x + ',' + y, x + 8, y + 34);
    ctx.fillStyle = '#4c9bff'; ctx.fillRect(200 + (frame++ % 120) * 10, 480, 60, 40);
  }, 33);
  window.mb = {
    invoke: async (channel, arg) => {
      if (channel === 'state:load') return { hostName: 'Test Mac', displayId: null, ...structuredClone(saved) };
      if (channel === 'state:saveHostKey') saved.hostKey = arg;
      if (channel === 'state:addDevice') saved.devices.push(arg);
    },
    send: (channel, arg) => (channel === 'input' ? window.inputs : window.events).push(channel === 'input' ? arg : [channel, arg]),
    on: (channel, fn) => { handlers[channel] = fn; },
    testCapture: async () => ({
      stream: document.getElementById('c').captureStream(30),
      display: { id: '1', label: 'Main', w: 1600, h: 1000, pw: 1600, ph: 1000 },
      displays: [{ id: '1', label: 'Main', w: 1600, h: 1000, pw: 1600, ph: 1000 }],
    }),
  };
</script>
<script src="engine.js"></script>`,
);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const dir = url.pathname.startsWith('/host/') ? tmp : path.join(tmp, 'web');
    const file = path.join(dir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(tmp) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(WEB_PORT, '127.0.0.1');
const relay = startRelay(RELAY_PORT);

// ---------------------------------------------------------------- helpers

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const near = (a, b, eps = 0.012) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

const browser = await chromium.launch({
  args: [
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // Behind an intercepting corporate/sandbox proxy the browser has to use it.
    ...(realSignal && process.env.HTTPS_PROXY
      ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors']
      : []),
  ],
});
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

try {
  // ------------------------------------------------------------ host side
  const hostPage = await (await browser.newContext()).newPage();
  hostPage.on('pageerror', (e) => console.log('[host error]', e.message));
  await hostPage.goto(`http://127.0.0.1:${WEB_PORT}/host/harness.html`);
  const ready = await until(() => hostPage.evaluate(() => window.events.find((e) => e[0] === 'engine:ready')?.[1]));
  check('host engine starts and creates its identity key', !!ready);
  const inputs = () => hostPage.evaluate(() => window.inputs);
  const clearInputs = () => hostPage.evaluate(() => (window.inputs.length = 0));
  const hostEvents = (name) => hostPage.evaluate((n) => window.events.filter((e) => e[0] === n).map((e) => e[1]), name);

  const secret = crypto.randomBytes(16).toString('base64url');
  const pairUrl = `${clientBase}#p=${ready.hostPub}.${secret}`;

  // Record everything that crosses the relay, like an eavesdropper would.
  const sniffed = [];
  const hostId = await hostPage.evaluate(async (pub) => {
    const raw = Uint8Array.from(atob(pub.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).slice(0, 12);
    return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }, ready.hostPub);
  const sniffer = realSignal ? null : new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/?ch=macbridge-${hostId}`);
  sniffer?.on('message', (d) => sniffed.push(JSON.parse(d.toString())));
  if (sniffer) await new Promise((r) => sniffer.on('open', r));

  // ----------------------------------------------------- pairing security
  const strangerCtx = await browser.newContext(phone);
  const stranger = await strangerCtx.newPage();
  await stranger.goto(pairUrl);
  await sleep(realSignal ? 4000 : 1500);
  check('pairing link is refused while no pairing window is open on the Mac',
    (await hostEvents('pair:done')).length === 0);
  await strangerCtx.close();

  // -------------------------------------------------------------- pairing
  await hostPage.evaluate((s) => window.emit('pair:open', { secret: s, expires: Date.now() + 300000 }), secret);
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[client error]', e.message));
  page.on('console', (m) => m.type() === 'warning' && console.log('[client]', m.text()));
  await page.goto(pairUrl);
  const live = await until(() => page.evaluate(() => !document.getElementById('view').hidden), 15000);
  check('phone pairs via the link and connects automatically', !!live);
  check('one-time secret is removed from the address bar', !(await page.url()).includes(secret));
  const paired = await hostEvents('pair:done');
  check('host registers exactly one device', paired.length === 1 && paired[0].name === 'Браузер', JSON.stringify(paired));

  const gotVideo = await until(() => page.evaluate(() => document.getElementById('video').videoWidth), 10000);
  check('video of the screen arrives', gotVideo === 1600, `videoWidth=${gotVideo}`);
  const playing = await until(async () => {
    const t1 = await page.evaluate(() => document.getElementById('video').currentTime);
    await sleep(300);
    return (await page.evaluate(() => document.getElementById('video').currentTime)) > t1;
  });
  check('video is playing', !!playing);
  if (shots) await page.screenshot({ path: path.join(shots, '1-connected.png') });

  const leaked = JSON.stringify(sniffed);
  if (!realSignal) {
    check('relay traffic is opaque (no SDP, no device name)',
      sniffed.length > 3 && !/candidate|fingerprint|v=0|Браузер|Test Mac/.test(leaked), `${sniffed.length} envelopes`);
  }

  const pairEnvelope = sniffed.find((m) => m.t === 'pair');
  const helloEnvelope = sniffed.find((m) => m.t === 'c2h');

  // A second phone that got hold of the same (now used) link.
  const lateCtx = await browser.newContext(phone);
  const late = await lateCtx.newPage();
  await late.goto(pairUrl);
  const refused = await until(() => late.evaluate(() => !document.getElementById('setup-error').hidden), 15000);
  check('used pairing link cannot pair a second device', !!refused && (await hostEvents('pair:done')).length === 1);
  if (shots) await late.screenshot({ path: path.join(shots, '5-refused.png') });
  await lateCtx.close();

  // ------------------------------------------------------------- gestures
  const stage = await page.evaluate(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const view = () => page.evaluate(() => window.__macbridge.viewer.state);
  const expected = async (px, py) => {
    const v = await view();
    return { x: (px - stage.x - v.tx) / (v.fitW * v.zoom), y: (py - stage.y - v.ty) / (v.fitH * v.zoom) };
  };
  const lastInput = async (t) => (await until(async () => (await inputs()).filter((i) => i.t === t).at(-1), 3000)) || {};

  let v = await view();
  check('whole screen fits the portrait width', near(v.fitW, 390, 0.5) && v.zoom === 1, JSON.stringify(v));

  // tap -> click
  let pt = { x: stage.x + 100, y: stage.y + v.ty + 50 };
  let want = await expected(pt.x, pt.y);
  await page.touchscreen.tap(pt.x, pt.y);
  let got = await lastInput('click');
  check('tap becomes a left click at the same spot',
    got.b === 0 && got.n === 1 && near(got.x, want.x) && near(got.y, want.y), JSON.stringify(got));

  // tap outside the picture -> nothing
  await sleep(450);
  await clearInputs();
  await page.touchscreen.tap(stage.x + 100, stage.y + 20);
  await sleep(300);
  check('tap outside the picture is ignored', (await inputs()).length === 0);

  // double tap -> double click
  await page.touchscreen.tap(pt.x, pt.y);
  await sleep(90);
  await page.touchscreen.tap(pt.x, pt.y);
  await until(async () => (await inputs()).length >= 2);
  const clicks = (await inputs()).filter((i) => i.t === 'click');
  check('double tap becomes a double click', clicks.length === 2 && clicks[0].n === 1 && clicks[1].n === 2, JSON.stringify(clicks.map((c) => c.n)));

  // Raw multi-touch through the DevTools protocol.
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });

  // long press -> right click
  await sleep(450);
  await clearInputs();
  await touch('touchStart', [[pt.x, pt.y]]);
  await sleep(600);
  await touch('touchEnd', []);
  got = await lastInput('click');
  check('long press becomes a right click', got.b === 1 && near(got.x, want.x), JSON.stringify(got));

  // two-finger tap -> right click
  await clearInputs();
  await touch('touchStart', [[pt.x - 20, pt.y], [pt.x + 20, pt.y]]);
  await sleep(60);
  await touch('touchEnd', []);
  got = await lastInput('click');
  check('two-finger tap becomes a right click', got.b === 1 && near(got.x, want.x), JSON.stringify(got));

  // pinch -> zoom
  await clearInputs();
  const cy = stage.y + v.ty + v.fitH / 2;
  await touch('touchStart', [[170, cy], [220, cy]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[170 - i * 12, cy], [220 + i * 12, cy]]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  v = await view();
  check('pinch zooms the picture', v.zoom > 3 && v.zoom < 7, `zoom=${v.zoom.toFixed(2)}`);
  check('pinch sends nothing to the Mac', (await inputs()).length === 0);
  if (shots) {
    await sleep(200);
    await page.screenshot({ path: path.join(shots, '2-zoomed.png') });
  }

  // tap while zoomed
  pt = { x: 250, y: stage.y + 300 };
  want = await expected(pt.x, pt.y);
  await page.touchscreen.tap(pt.x, pt.y);
  got = await lastInput('click');
  check('tap is mapped correctly while zoomed', near(got.x, want.x, 0.004) && near(got.y, want.y, 0.004),
    `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);

  // one-finger drag -> pan only
  await sleep(450);
  await clearInputs();
  const before = await view();
  await touch('touchStart', [[300, cy]]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [[300 - i * 15, cy]]);
    await sleep(16);
  }
  await sleep(120);
  await touch('touchEnd', []);
  const after = await view();
  check('one-finger drag pans the picture', after.tx < before.tx - 80 && after.zoom === before.zoom,
    `tx ${before.tx.toFixed(0)} -> ${after.tx.toFixed(0)}`);
  check('panning sends nothing to the Mac', (await inputs()).length === 0);

  // two-finger drag -> scroll
  await touch('touchStart', [[150, cy], [230, cy]]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [[150, cy - i * 10], [230, cy - i * 10]]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  const scrolls = (await inputs()).filter((i) => i.t === 'scroll');
  const total = scrolls.reduce((s, i) => s + i.dy, 0);
  const z = await view();
  check('two-finger drag scrolls, content follows the fingers',
    scrolls.length > 3 && near(total, -70 / (z.fitH * z.zoom), 0.02) && (await view()).zoom === z.zoom,
    `events=${scrolls.length} dy=${total.toFixed(3)}`);

  // long press + move -> drag
  await clearInputs();
  await touch('touchStart', [[120, cy]]);
  await sleep(600);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [[120 + i * 20, cy + i * 5]]);
    await sleep(30);
  }
  await touch('touchEnd', []);
  await until(async () => (await inputs()).some((i) => i.t === 'up'));
  const seq = (await inputs()).map((i) => i.t);
  const up = (await inputs()).find((i) => i.t === 'up');
  const dn = (await inputs()).find((i) => i.t === 'down');
  check('long press and move drags with the button held',
    seq[0] === 'down' && seq.at(-1) === 'up' && seq.includes('drag') && !seq.includes('click') && up.x > dn.x,
    seq.join(','));

  // zoom button
  await page.tap('#btn-zoom');
  await sleep(350);
  check('zoom button returns to the whole screen', (await view()).zoom === 1);
  await page.tap('#btn-zoom');
  await sleep(350);
  check('zoom button restores the previous zoom', near((await view()).zoom, z.zoom, 0.01));

  // ------------------------------------------------------------- keyboard
  await clearInputs();
  await page.tap('#btn-kbd');
  check('keyboard button opens the extra keys', await page.evaluate(() => !document.getElementById('keys').hidden));
  await page.keyboard.type('Привет, Mac!');
  await until(async () => (await inputs()).filter((i) => i.t === 'text').map((i) => i.s).join('') === 'Привет, Mac!');
  check('typed text reaches the Mac, including Cyrillic',
    (await inputs()).filter((i) => i.t === 'text').map((i) => i.s).join('') === 'Привет, Mac!');
  await clearInputs();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await until(async () => (await inputs()).length >= 2);
  check('Backspace and Enter are sent as keys',
    JSON.stringify((await inputs()).map((i) => i.k)) === '["Backspace","Enter"]', JSON.stringify(await inputs()));
  await clearInputs();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Backspace');
  await until(async () => (await inputs()).length >= 12);
  check('Backspace keeps working past the start of the typed text', (await inputs()).length === 12);
  await clearInputs();
  await page.tap('#keys [data-mod="cmd"]');
  await page.keyboard.type('c');
  got = await lastInput('key');
  check('modifier + letter is sent as a shortcut', got.k === 'c' && got.m?.join() === 'cmd', JSON.stringify(got));
  await page.keyboard.type('x');
  got = await lastInput('text');
  check('modifier releases after one key', got.s === 'x', JSON.stringify(got));
  await clearInputs();
  await page.tap('#keys [data-key="Escape"]');
  got = await lastInput('key');
  check('extra key row works', got.k === 'Escape');
  check('keyboard stays open after using the extra keys',
    await page.evaluate(() => document.activeElement?.id === 'kbd'));
  if (shots) await page.screenshot({ path: path.join(shots, '3-keys.png') });
  await page.tap('#btn-kbd');

  // --------------------------------------------------- signaling security
  if (!realSignal) {
  const sessionsBefore = (await hostEvents('session:state')).length;
  const attacker = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/?ch=macbridge-${hostId}`);
  await new Promise((r) => attacker.on('open', r));
  attacker.send(JSON.stringify(helloEnvelope)); // replay of a genuine request
  attacker.send(JSON.stringify(pairEnvelope)); // replay of the pairing request
  attacker.send(JSON.stringify({ ...helloEnvelope, ct: helloEnvelope.ct.slice(0, -4) + 'AAAA' })); // tampered
  attacker.send(JSON.stringify({ t: 'c2h', d: 'unknown-device', iv: helloEnvelope.iv, ct: helloEnvelope.ct }));
  await sleep(1200);
  check('replayed, tampered and forged requests do not disturb the session',
    (await hostEvents('session:state')).length === sessionsBefore &&
      (await hostEvents('pair:done')).length === 1 &&
      (await page.evaluate(() => !document.getElementById('view').hidden)));
  attacker.close();
  }

  // ------------------------------------------------------------ lifecycle
  await page.reload();
  const again = await until(() => page.evaluate(() => !document.getElementById('view').hidden), 15000);
  check('reopening the page reconnects without pairing again', !!again);
  await until(() => page.evaluate(() => document.getElementById('video').videoWidth), 10000);

  // rotate to landscape
  await page.setViewportSize({ width: 844, height: 390 });
  await sleep(300);
  v = await view();
  check('landscape layout fits the screen by height', near(v.fitH, v.stageH, 0.5) && v.fitW < v.stageW, JSON.stringify(v));
  if (shots) await page.screenshot({ path: path.join(shots, '4-landscape.png') });
  await page.setViewportSize({ width: 390, height: 844 });

  await hostPage.evaluate(() => window.emit('session:kick'));
  const kicked = await until(() => page.evaluate(() => !document.getElementById('connect').hidden));
  check('disconnecting from the Mac returns the phone to the start screen', !!kicked);
  if (shots) await page.screenshot({ path: path.join(shots, '6-start.png') });

  const deviceId = paired[0].id;
  await hostPage.evaluate((id) => window.emit('devices:removed', id), deviceId);
  const before2 = (await hostEvents('session:state')).length;
  await page.tap('#connect-go');
  await sleep(2500);
  check('a removed device can no longer connect',
    (await hostEvents('session:state')).length === before2 &&
      (await page.evaluate(() => document.getElementById('view').hidden)));

  if (shots) {
    const fresh = await (await browser.newContext(phone)).newPage();
    await fresh.goto(clientBase);
    await sleep(500);
    await fresh.screenshot({ path: path.join(shots, '7-setup.png') });
  }
  sniffer?.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  server.close();
  relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
