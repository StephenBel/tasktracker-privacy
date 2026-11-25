// Wire protocol shared by host and client.
//
// Signaling envelopes (travel through the untrusted relay):
//   { t: 'pair',   pub, iv, ct }   phone -> Mac, once, during pairing
//   { t: 'paired', d,   iv, ct }   Mac -> phone, pairing confirmation
//   { t: 'c2h',    d,   iv, ct }   phone -> Mac, session setup
//   { t: 'h2c',    d,   iv, ct }   Mac -> phone, session setup
// `d` is the device id. The decrypted body of c2h/h2c is { k, sid, ... } with
// k one of: hello, offer, answer, ice, bye, busy.
//
// Input messages (travel inside the encrypted WebRTC data channel), phone -> Mac.
// Coordinates are fractions of the screen (0..1), so they do not depend on the
// video resolution or on the zoom level of the phone.
//   { t: 'click', x, y, b: 0|1, n: 1|2 }      b: 0 left, 1 right; n: click count
//   { t: 'down' | 'drag' | 'up', x, y }       left-button drag
//   { t: 'scroll', x, y, dx, dy }             dx/dy as fractions of the screen
//   { t: 'text', s }                          literal text, any language
//   { t: 'key', k, m: ['cmd','shift',...] }   named key or single character
//   { t: 'display', id }                      switch captured display
//   { t: 'ping', id }
// Mac -> phone:
//   { t: 'info', name, display, displays: [{ id, label, w, h }] }
//   { t: 'pong', id }
//   { t: 'focus', x, y, w, h }                a text field got the focus (fractions
//                                             of the screen); no x: focus left it

export const PAIR_TTL_MS = 5 * 60 * 1000;
export const HELLO_MAX_SKEW_MS = 2 * 60 * 1000;

export const aad = {
  pair: (pub) => `pair|${pub}`,
  paired: (d) => `paired|${d}`,
  c2h: (d) => `c2h|${d}`,
  h2c: (d) => `h2c|${d}`,
};

// Pairing link: <clientUrl>#p=<host public key>.<one-time secret>
// It lives in the URL fragment, which browsers never send to the web server.
export function makePairLink(clientUrl, hostPub, secret) {
  return `${clientUrl.replace(/#.*$/, '')}#p=${hostPub}.${secret}`;
}

export function parsePairLink(text) {
  const m = /[#&?]p=([A-Za-z0-9_-]{80,100})\.([A-Za-z0-9_-]{20,64})/.exec(text || '');
  return m ? { hostPub: m[1], secret: m[2] } : null;
}

export const NAMED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
];
export const MODIFIERS = ['cmd', 'alt', 'ctrl', 'shift'];

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

// Validates and normalizes an input message received from the phone. Returns
// null for anything malformed, so the host never forwards unexpected data to
// the process that injects mouse and keyboard events.
export function sanitizeInput(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const point = () => {
    const x = clamp01(msg.x);
    const y = clamp01(msg.y);
    return x === null || y === null ? null : { x, y };
  };
  switch (msg.t) {
    case 'click': {
      const p = point();
      if (!p) return null;
      return { t: 'click', ...p, b: msg.b === 1 ? 1 : 0, n: msg.n === 2 ? 2 : 1 };
    }
    case 'down':
    case 'drag':
    case 'up': {
      const p = point();
      return p ? { t: msg.t, ...p } : null;
    }
    case 'scroll': {
      const p = point();
      if (!p || !Number.isFinite(msg.dx) || !Number.isFinite(msg.dy)) return null;
      const lim = (v) => Math.min(2, Math.max(-2, v));
      return { t: 'scroll', ...p, dx: lim(msg.dx), dy: lim(msg.dy) };
    }
    case 'text':
      if (typeof msg.s !== 'string' || !msg.s.length || msg.s.length > 4000) return null;
      return { t: 'text', s: msg.s };
    case 'key': {
      if (typeof msg.k !== 'string') return null;
      const named = NAMED_KEYS.includes(msg.k);
      if (!named && [...msg.k].length !== 1) return null;
      const m = Array.isArray(msg.m) ? MODIFIERS.filter((x) => msg.m.includes(x)) : [];
      return { t: 'key', k: msg.k, m };
    }
    default:
      return null;
  }
}
