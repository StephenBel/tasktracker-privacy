// MacBridge phone client: pairing, connection management and UI wiring.

import * as C from '../../shared/crypto.js';
import { createTransport, channelFor } from '../../shared/signal.js';
import { aad, parsePairLink } from '../../shared/protocol.js';
import { store } from './store.js';
import { createViewer } from './viewer.js';
import { createKeyboard } from './keyboard.js';

const cfg = __MB_CONFIG__;
const { b64u } = C;
const $ = (id) => document.getElementById(id);

const app = $('app');
const video = $('video');
const screens = { setup: $('setup'), connect: $('connect'), view: $('view') };

let pairing = null; // { hostId, hostName, deviceId, key }
let transport = null;
let sess = null; // { sid, pc, dc, pendingIce, live }
let want = false; // the user wants to be connected
let resumeOnVisible = false;
let attempt = 0;
let retryTimer = null;
let lostTimer = null;
let pingTimer = null;
let pingSent = 0;
let rtt = null;
let wakeLock = null;
let info = null; // last `info` message from the Mac

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

function setConnectStatus(text) {
  $('connect-status').textContent = text;
}

function banner(text) {
  $('banner').hidden = !text;
  $('banner').textContent = text || '';
  $('dot').className = text ? 'warn' : sess?.live ? 'ok' : '';
}

// ------------------------------------------------------------------ input

function sendInput(msg) {
  if (sess?.live && sess.dc.readyState === 'open') sess.dc.send(JSON.stringify(msg));
}

const viewer = createViewer({
  stage: $('stage'),
  canvas: $('canvas'),
  video,
  fx: $('fx'),
  minimap: $('minimap'),
  send: sendInput,
});

const keyboard = createKeyboard({
  field: $('kbd'),
  keys: $('keys'),
  root: app,
  send: sendInput,
  onToggle: (open) => $('btn-kbd').setAttribute('aria-pressed', String(open)),
});

// ---------------------------------------------------------------- pairing

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'Браузер';
}

function waitOpen(t, ms) {
  return new Promise((resolve, reject) => {
    if (t.state === 'open') return resolve();
    const timer = setTimeout(() => reject(new Error('signal timeout')), ms);
    t.onstate = (s) => {
      if (s !== 'open') return;
      clearTimeout(timer);
      resolve();
    };
  });
}

async function pair(link) {
  const hostPubRaw = b64u.dec(link.hostPub);
  const hostId = await C.keyId(hostPubRaw);
  const keyPair = await C.generateKeyPair();
  const pubRaw = await C.exportPublicKey(keyPair.publicKey);
  const pub = b64u.enc(pubRaw);
  const deviceId = await C.keyId(pubRaw);
  const { pairKey, sessionRaw } = await C.deriveKeys(
    keyPair.privateKey,
    await C.importPublicKey(hostPubRaw),
    b64u.dec(link.secret),
  );
  const key = await C.importAesKey(sessionRaw);
  const request = { t: 'pair', pub, ...(await C.seal(pairKey, { name: deviceName() }, aad.pair(pub))) };

  const t = createTransport(cfg.signal, channelFor(hostId));
  try {
    await waitOpen(t, 12000);
    const hostName = await new Promise((resolve, reject) => {
      let tries = 0;
      const tick = () => {
        if (tries++ >= 5) return reject(new Error('no answer'));
        t.send(request);
        timer = setTimeout(tick, 2000);
      };
      let timer = null;
      t.onmessage = async (msg) => {
        if (msg?.t !== 'paired' || msg.d !== deviceId) return;
        try {
          const body = await C.open(key, msg, aad.paired(deviceId));
          clearTimeout(timer);
          resolve(String(body.host || 'Mac'));
        } catch {
          // not from our Mac
        }
      };
      tick();
    });
    pairing = { hostId, hostName, deviceId, key };
    await store.set('pairing', pairing);
  } finally {
    t.close();
  }
}

async function pairFromLink(link) {
  show('connect');
  $('host-name').textContent = 'Сопряжение…';
  $('connect-go').hidden = true;
  $('forget').hidden = true;
  setConnectStatus('Связываюсь с Маком');
  try {
    await pair(link);
  } catch (e) {
    console.warn('pairing failed', e);
    showSetup('Не получилось подключиться: код истёк или уже использован. Создайте новый код на Маке и попробуйте снова.');
    return;
  }
  showConnect('');
  connect();
}

function showSetup(error) {
  show('setup');
  $('setup-error').hidden = !error;
  $('setup-error').textContent = error || '';
}

function showConnect(status) {
  show('connect');
  $('host-name').textContent = pairing.hostName;
  $('connect-go').hidden = false;
  $('forget').hidden = false;
  setConnectStatus(status);
}

// -------------------------------------------------------------- connection

async function sendSignal(body) {
  if (!transport || transport.state !== 'open') return false;
  const box = await C.seal(pairing.key, body, aad.c2h(pairing.deviceId));
  return transport.send({ t: 'c2h', d: pairing.deviceId, ...box });
}

function ensureTransport() {
  if (transport) return;
  transport = createTransport(cfg.signal, channelFor(pairing.hostId));
  transport.onmessage = (msg) => onSignal(msg).catch((e) => console.warn('signal error', e));
  transport.onstate = (s) => {
    if (s === 'open' && want && !sess?.pc) hello();
  };
}

function connect() {
  want = true;
  attempt = 0;
  if (!screens.view.hidden) banner('Подключение…');
  else setConnectStatus('Подключение…');
  $('connect-go').disabled = true;
  ensureTransport();
  hello();
}

// Ask the Mac to start a session. Repeated until it answers.
async function hello() {
  if (!want) return;
  clearTimeout(retryTimer);
  closePeer();
  const sid = b64u.enc(C.randomBytes(16));
  sess = { sid, pc: null, dc: null, pendingIce: [], live: false };
  await sendSignal({ k: 'hello', sid, ts: Date.now() });
  attempt++;
  retryTimer = setTimeout(hello, Math.min(15000, 3500 + attempt * 1500));
  if (attempt === 3) {
    const text = 'Мак не отвечает. Проверьте, что он включён и MacBridge запущен.';
    if (screens.view.hidden) setConnectStatus(text);
    else banner('Мак не отвечает, пробую ещё…');
  }
}

async function onSignal(msg) {
  if (msg?.t !== 'h2c' || !pairing || msg.d !== pairing.deviceId) return;
  let body;
  try {
    body = await C.open(pairing.key, msg, aad.h2c(pairing.deviceId));
  } catch {
    return;
  }
  if (!sess || body.sid !== sess.sid) return;
  switch (body.k) {
    case 'offer':
      if (!sess.pc) await onOffer(sess, body.sdp);
      return;
    case 'ice':
      if (sess.pc?.remoteDescription) await addIce(sess, body.c);
      else sess.pendingIce.push(body.c);
      return;
    case 'bye':
      return stop(
        body.reason === 'replaced'
          ? 'К Маку подключилось другое ваше устройство.'
          : 'Соединение закрыто на Маке.',
      );
    case 'error':
      return stop(
        body.code === 'clock'
          ? 'Часы телефона и Мака расходятся больше чем на две минуты. Проверьте дату и время.'
          : 'Мак не смог показать экран. Проверьте на нём разрешение «Запись экрана» для MacBridge.',
      );
  }
}

async function addIce(s, candidate) {
  try {
    await s.pc.addIceCandidate(candidate);
  } catch (e) {
    console.warn('bad ICE candidate', e);
  }
}

async function onOffer(s, sdp) {
  // The Mac answered: give the direct connection time to come up.
  clearTimeout(retryTimer);
  retryTimer = setTimeout(hello, 15000);

  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
  s.pc = pc;
  pc.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    // Show frames as soon as they arrive instead of buffering for smoothness.
    try {
      e.receiver.jitterBufferTarget = 0;
    } catch {}
    try {
      e.receiver.playoutDelayHint = 0;
    } catch {}
    video.play().catch(() => {});
  };
  pc.ondatachannel = (e) => {
    s.dc = e.channel;
    s.dc.onmessage = (ev) => onData(s, ev.data);
    s.dc.onclose = () => {
      if (sess === s && s.live) lost();
    };
    if (s.dc.readyState === 'open') onLive(s);
    else s.dc.onopen = () => onLive(s);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ k: 'ice', sid: s.sid, c: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (sess !== s) return;
    clearTimeout(lostTimer);
    if (pc.connectionState === 'failed') lost();
    else if (pc.connectionState === 'disconnected') {
      banner('Связь прервалась…');
      lostTimer = setTimeout(() => {
        if (sess === s && pc.connectionState !== 'connected') lost();
      }, 6000);
    } else if (pc.connectionState === 'connected' && s.live) banner('');
  };

  await pc.setRemoteDescription({ type: 'offer', sdp });
  for (const c of s.pendingIce.splice(0)) await addIce(s, c);
  await pc.setLocalDescription(await pc.createAnswer());
  if (sess !== s) return;
  await sendSignal({ k: 'answer', sid: s.sid, sdp: pc.localDescription.sdp });
}

function onLive(s) {
  if (sess !== s || s.live) return;
  s.live = true;
  attempt = 0;
  clearTimeout(retryTimer);
  show('view');
  banner('');
  $('connect-go').disabled = false;
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    pingSent = performance.now();
    sendInput({ t: 'ping', id: 1 });
  }, 3000);
  navigator.wakeLock?.request('screen').then((lock) => (wakeLock = lock)).catch(() => {});
}

function onData(s, data) {
  if (sess !== s) return;
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.t === 'pong') rtt = Math.round(performance.now() - pingSent);
  if (msg.t === 'focus') {
    // A text field got the focus on the Mac: frame it. Without a rectangle the
    // focus has left the field.
    const ok = [msg.x, msg.y, msg.w, msg.h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
    viewer.focusField(ok && msg.w > 0 && msg.h > 0 ? { x: msg.x, y: msg.y, w: msg.w, h: msg.h } : null);
  }
  if (msg.t === 'info') {
    info = msg;
    const d = msg.displays.find((x) => x.id === msg.display);
    if (d) viewer.setDisplay(d.w, d.h);
    $('btn-display').hidden = msg.displays.length < 2;
    if (msg.name && msg.name !== pairing.hostName) {
      pairing.hostName = msg.name;
      store.set('pairing', pairing).catch(() => {});
    }
  }
}

function closePeer() {
  const s = sess;
  sess = null;
  clearTimeout(lostTimer);
  clearInterval(pingTimer);
  if (!s) return;
  try {
    s.dc?.close();
  } catch {}
  s.pc?.close();
}

// The link dropped although the user still wants it: reconnect quietly.
function lost() {
  if (!want) return;
  banner('Переподключение…');
  attempt = 0;
  // The channel closes a moment before the Mac's explanation ("bye") arrives
  // through signaling. Wait for it, so that a deliberate disconnect on the
  // Mac is not immediately undone by an automatic reconnect.
  clearTimeout(lostTimer);
  lostTimer = setTimeout(hello, 1200);
}

// End the session and return to the start screen.
function stop(message = '') {
  const s = sess;
  if (s && want) sendSignal({ k: 'bye', sid: s.sid }).catch(() => {});
  want = false;
  clearTimeout(retryTimer);
  closePeer();
  video.srcObject = null;
  keyboard.hide();
  $('sheet').hidden = true;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  $('connect-go').disabled = false;
  if (pairing) showConnect(message);
}

function dropTransport() {
  transport?.close();
  transport = null;
}

// ----------------------------------------------------------------- wiring

$('connect-go').addEventListener('click', connect);
$('btn-kbd').addEventListener('click', () => keyboard.toggle());
$('btn-zoom').addEventListener('click', () => viewer.toggleZoom());
$('btn-display').addEventListener('click', () => {
  if (!info || info.displays.length < 2) return;
  const i = info.displays.findIndex((d) => d.id === info.display);
  sendInput({ t: 'display', id: info.displays[(i + 1) % info.displays.length].id });
});
// Keep the keyboard open when the bar is tapped.
$('bar').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

$('btn-more').addEventListener('click', () => {
  $('sheet-title').textContent = pairing.hostName;
  const size = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '';
  $('sheet-info').textContent = [rtt !== null ? `Задержка ${rtt} мс` : '', size].filter(Boolean).join(' · ');
  keyboard.hide();
  $('sheet').hidden = false;
});
$('sheet-close').addEventListener('click', () => ($('sheet').hidden = true));
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) $('sheet').hidden = true;
});
$('sheet-disconnect').addEventListener('click', () => stop());

async function forget() {
  if (!confirm('Забыть этот Мак? Чтобы подключиться снова, понадобится новый QR-код.')) return;
  stop();
  dropTransport();
  await store.delete('pairing');
  pairing = null;
  showSetup('');
}
$('forget').addEventListener('click', forget);
$('sheet-forget').addEventListener('click', forget);

$('link-go').addEventListener('click', () => {
  const link = parsePairLink($('link-input').value.trim());
  if (!link) return showSetup('Это не похоже на ссылку MacBridge. Скопируйте её целиком из окна на Маке.');
  $('link-input').value = '';
  pairFromLink(link);
});

// Leaving the page (switching apps, locking the phone) ends the session so
// the Mac stops streaming; coming back reconnects automatically.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (!want) return;
    resumeOnVisible = true;
    const s = sess;
    if (s) sendSignal({ k: 'bye', sid: s.sid }).catch(() => {});
    want = false;
    clearTimeout(retryTimer);
    closePeer();
    dropTransport();
  } else if (resumeOnVisible && pairing) {
    resumeOnVisible = false;
    connect();
  }
});

// Follow the visual viewport so the layout sits above the on-screen keyboard.
const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  app.style.height = `${vv.height}px`;
  app.style.transform = `translateY(${vv.offsetTop}px)`;
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
fitViewport();

async function boot() {
  if (!window.isSecureContext || !window.RTCPeerConnection) {
    return showSetup('Этот браузер не подходит: нужен Safari или Chrome и открытие страницы по https.');
  }
  try {
    pairing = (await store.get('pairing')) || null;
  } catch {
    pairing = null;
  }
  const link = parsePairLink(location.hash);
  if (link) {
    // Remove the one-time secret from the address bar and history.
    history.replaceState(null, '', location.pathname + location.search);
    return pairFromLink(link);
  }
  if (!pairing) return showSetup('');
  showConnect('');
  connect(); // one tap on the home-screen icon is enough
}

// For tests and diagnostics: the viewer, and a way to feed a message as if it
// came from the Mac.
window.__macbridge = { viewer, onData: (msg) => sess && onData(sess, JSON.stringify(msg)) };
boot();
