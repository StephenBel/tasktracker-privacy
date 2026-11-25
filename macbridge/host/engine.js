// Host engine. Runs in a hidden Electron window (it needs WebRTC and screen
// capture, which live in the renderer). Responsibilities:
//   - keep a signaling connection open and answer only to paired devices
//   - pair a new device while a pairing window is open on the Mac
//   - on a valid request, capture the screen and stream it over WebRTC
//   - validate input messages and hand them to the main process for injection
//
// The surrounding process is reached through `window.mb` (see preload.cjs).
// The automated test substitutes that object, which is why nothing here
// imports Electron directly.

import * as C from '../shared/crypto.js';
import { createTransport, channelFor } from '../shared/signal.js';
import { aad, HELLO_MAX_SKEW_MS, sanitizeInput } from '../shared/protocol.js';

const cfg = __MB_CONFIG__;
const mb = window.mb;
const { b64u } = C;

let hostPrivate = null;
let hostName = 'Mac';
let transport = null;
const devices = new Map(); // id -> { id, name, key }
let pairing = null; // { secret: Uint8Array, expires }
let lastPaired = null; // { pub, reply, until }: lets a phone that missed the reply ask again
let session = null;
let displayId = null; // preferred display, null = primary
const seenSids = new Map(); // sid -> timestamp, replay protection for `hello`

const log = (...a) => console.log('[engine]', ...a);

async function init() {
  const state = await mb.invoke('state:load');
  hostName = state.hostName || hostName;
  displayId = state.displayId ?? null;

  let hostPubRaw;
  if (state.hostKey) {
    hostPrivate = await C.importPrivateKey(state.hostKey.private);
    hostPubRaw = b64u.dec(state.hostKey.public);
  } else {
    const pair = await C.generateKeyPair();
    hostPubRaw = await C.exportPublicKey(pair.publicKey);
    const jwk = await C.exportPrivateKey(pair.privateKey);
    await mb.invoke('state:saveHostKey', { private: jwk, public: b64u.enc(hostPubRaw) });
    hostPrivate = await C.importPrivateKey(jwk);
  }
  for (const d of state.devices) {
    devices.set(d.id, { id: d.id, name: d.name, key: await C.importAesKey(b64u.dec(d.key)) });
  }

  const hostId = await C.keyId(hostPubRaw);
  transport = createTransport(cfg.signal, channelFor(hostId));
  transport.onstate = (s) => mb.send('signal:state', s);
  transport.onmessage = (msg) => onSignal(msg).catch((e) => log('signal error', e));

  mb.on('pair:open', (p) => {
    pairing = { secret: b64u.dec(p.secret), expires: p.expires };
  });
  mb.on('pair:close', () => {
    pairing = null;
  });
  mb.on('devices:removed', (id) => {
    devices.delete(id);
    if (session?.dev.id === id) endSession('removed');
  });
  mb.on('session:kick', () => endSession('kicked', true));
  mb.on('display:set', (id) => {
    displayId = id;
    if (session) switchDisplay(session, id).catch((e) => log('display switch failed', e));
  });

  mb.send('engine:ready', { hostId, hostPub: b64u.enc(hostPubRaw) });
}

// ---------------------------------------------------------------- signaling

async function onSignal(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'pair') return onPair(msg);
  if (msg.t !== 'c2h') return;
  const dev = devices.get(msg.d);
  if (!dev) return; // unknown device: stay silent
  let body;
  try {
    body = await C.open(dev.key, msg, aad.c2h(dev.id));
  } catch {
    return; // not authentic
  }
  switch (body.k) {
    case 'hello':
      return onHello(dev, body);
    case 'answer':
      if (session?.sid === body.sid && !session.answered) {
        session.answered = true;
        await session.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
        for (const c of session.pendingIce.splice(0)) await addIce(session, c);
      }
      return;
    case 'ice':
      if (session?.sid === body.sid) {
        if (session.pc.remoteDescription) await addIce(session, body.c);
        else session.pendingIce.push(body.c);
      }
      return;
    case 'bye':
      if (session?.sid === body.sid) endSession('bye');
      return;
  }
}

async function addIce(s, candidate) {
  try {
    await s.pc.addIceCandidate(candidate);
  } catch (e) {
    log('bad ICE candidate', e.message);
  }
}

async function sendTo(dev, body) {
  const box = await C.seal(dev.key, body, aad.h2c(dev.id));
  transport.send({ t: 'h2c', d: dev.id, ...box });
}

async function onPair(msg) {
  if (typeof msg.pub !== 'string') return;
  if (lastPaired && lastPaired.pub === msg.pub && Date.now() < lastPaired.until) {
    transport.send(lastPaired.reply);
    return;
  }
  const p = pairing;
  if (!p || Date.now() > p.expires) return;
  let pubRaw, keys, body;
  try {
    pubRaw = b64u.dec(msg.pub);
    if (pubRaw.length !== 65) return;
    keys = await C.deriveKeys(hostPrivate, await C.importPublicKey(pubRaw), p.secret);
    body = await C.open(keys.pairKey, msg, aad.pair(msg.pub));
  } catch {
    return; // the sender does not know the one-time secret from the QR code
  }
  if (pairing !== p) return; // another request won the race
  pairing = null; // the secret is single-use

  const id = await C.keyId(pubRaw);
  const name = String(body.name || 'Телефон').slice(0, 60);
  const key = await C.importAesKey(keys.sessionRaw);
  devices.set(id, { id, name, key });
  await mb.invoke('state:addDevice', { id, name, key: b64u.enc(keys.sessionRaw) });
  const reply = { t: 'paired', d: id, ...(await C.seal(key, { host: hostName }, aad.paired(id))) };
  lastPaired = { pub: msg.pub, reply, until: Date.now() + 60000 };
  transport.send(reply);
  mb.send('pair:done', { id, name });
}

async function onHello(dev, body) {
  const now = Date.now();
  for (const [sid, t] of seenSids) if (now - t > 2 * HELLO_MAX_SKEW_MS) seenSids.delete(sid);
  if (typeof body.sid !== 'string' || body.sid.length < 16 || seenSids.has(body.sid)) return;
  if (typeof body.ts !== 'number' || Math.abs(now - body.ts) > HELLO_MAX_SKEW_MS) {
    // Old or replayed request. Tell the phone, its clock may simply be wrong.
    return sendTo(dev, { k: 'error', sid: body.sid, code: 'clock' });
  }
  seenSids.set(body.sid, now);
  await startSession(dev, body.sid);
}

// ------------------------------------------------------------------ session

async function capture(id) {
  if (mb.testCapture) return mb.testCapture(id);
  const src = await mb.invoke('capture:source', id);
  const scale = Math.min(1, cfg.video.maxWidth / src.display.pw);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: src.sourceId,
        maxWidth: Math.round(src.display.pw * scale),
        maxHeight: Math.round(src.display.ph * scale),
        maxFrameRate: cfg.video.maxFps,
      },
    },
  });
  return { stream, display: src.display, displays: src.displays };
}

function prepareTrack(stream) {
  const track = stream.getVideoTracks()[0];
  // Screen content: keep text sharp and drop frames instead of resolution.
  track.contentHint = 'detail';
  return track;
}

// H.264 is hardware accelerated on both the Mac and the iPhone.
function preferH264(transceiver) {
  for (const caps of [RTCRtpSender.getCapabilities('video'), RTCRtpReceiver.getCapabilities('video')]) {
    const codecs = caps?.codecs || [];
    const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    if (!h264.length) continue;
    const rest = codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
    try {
      transceiver.setCodecPreferences([...h264, ...rest]);
      return;
    } catch {
      // try the other capability list, otherwise keep the browser default
    }
  }
}

async function startSession(dev, sid) {
  endSession('replaced', true);
  const s = {
    sid,
    dev,
    pc: new RTCPeerConnection({ iceServers: cfg.iceServers }),
    dc: null,
    stream: null,
    sender: null,
    display: null,
    displays: [],
    pendingIce: [],
    answered: false,
    live: false,
    timer: null,
  };
  session = s;
  const send = (body) => sendTo(dev, { ...body, sid });

  let cap;
  try {
    cap = await capture(displayId);
  } catch (e) {
    log('capture failed:', e?.name, e?.message);
    if (session === s) {
      session = null;
      s.pc.close();
    }
    await send({ k: 'error', code: 'capture' });
    mb.send('capture:failed', String(e?.message || e));
    return;
  }
  if (session !== s) {
    cap.stream.getTracks().forEach((t) => t.stop());
    return;
  }
  s.stream = cap.stream;
  s.display = cap.display;
  s.displays = cap.displays;

  const transceiver = s.pc.addTransceiver(prepareTrack(cap.stream), {
    direction: 'sendonly',
    streams: [cap.stream],
    sendEncodings: [{ maxBitrate: cfg.video.maxBitrate, maxFramerate: cfg.video.maxFps }],
  });
  s.sender = transceiver.sender;
  preferH264(transceiver);

  s.dc = s.pc.createDataChannel('input', { ordered: true });
  s.dc.onopen = () => {
    s.live = true;
    clearTimeout(s.timer);
    sendInfo(s);
    mb.send('session:state', { connected: true, device: { id: dev.id, name: dev.name } });
  };
  s.dc.onmessage = (e) => onData(s, e.data);
  s.dc.onclose = () => {
    if (session === s) endSession('channel closed');
  };

  s.pc.onicecandidate = (e) => {
    if (e.candidate) send({ k: 'ice', c: e.candidate.toJSON() });
  };
  s.pc.onconnectionstatechange = () => {
    const st = s.pc.connectionState;
    if (session !== s) return;
    if (st === 'failed' || st === 'closed') endSession(st);
    if (st === 'disconnected') {
      // Give a flaky mobile link a few seconds to come back.
      clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        if (session === s && s.pc.connectionState !== 'connected') endSession('lost');
      }, 8000);
    }
  };
  // Nobody completed the handshake: stop capturing.
  s.timer = setTimeout(() => {
    if (session === s && !s.live) endSession('handshake timeout');
  }, 30000);

  await s.pc.setLocalDescription(await s.pc.createOffer());
  if (session !== s) return;
  try {
    const params = s.sender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    await s.sender.setParameters(params);
  } catch {
    // optional tuning
  }
  await send({ k: 'offer', sdp: s.pc.localDescription.sdp });
}

function endSession(reason, notifyPeer = false) {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(s.timer);
  log('session ended:', reason);
  if (notifyPeer) sendTo(s.dev, { k: 'bye', sid: s.sid, reason }).catch(() => {});
  try {
    s.dc?.close();
  } catch {}
  s.stream?.getTracks().forEach((t) => t.stop());
  s.pc.close();
  mb.send('session:state', { connected: false });
}

function sendInfo(s) {
  if (s.dc?.readyState !== 'open') return;
  s.dc.send(
    JSON.stringify({
      t: 'info',
      name: hostName,
      display: s.display.id,
      displays: s.displays.map((d) => ({ id: d.id, label: d.label, w: d.w, h: d.h })),
    }),
  );
}

async function switchDisplay(s, id) {
  if (s.display?.id === id) return;
  const cap = await capture(id);
  if (session !== s) {
    cap.stream.getTracks().forEach((t) => t.stop());
    return;
  }
  await s.sender.replaceTrack(prepareTrack(cap.stream));
  s.stream.getTracks().forEach((t) => t.stop());
  s.stream = cap.stream;
  s.display = cap.display;
  s.displays = cap.displays;
  sendInfo(s);
}

function onData(s, data) {
  if (session !== s || typeof data !== 'string' || data.length > 20000) return;
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg?.t === 'ping') {
    s.dc.send(JSON.stringify({ t: 'pong', id: msg.id }));
    return;
  }
  if (msg?.t === 'display') {
    if (s.displays.some((d) => d.id === msg.id)) {
      displayId = msg.id;
      switchDisplay(s, msg.id).catch((e) => log('display switch failed', e));
    }
    return;
  }
  const input = sanitizeInput(msg);
  if (input) mb.send('input', { ...input, display: s.display.id });
}

init().catch((e) => {
  log('init failed', e);
  mb.send('engine:error', String(e?.message || e));
});
