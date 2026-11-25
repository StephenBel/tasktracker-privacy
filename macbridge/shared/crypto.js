// Cryptographic primitives shared by the Mac host and the phone client.
// Everything is WebCrypto, so the same file runs in Safari, Chromium and Electron.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export const b64u = {
  enc(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  },
};

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export function generateKeyPair() {
  return subtle.generateKey(ECDH, true, ['deriveBits']);
}

export async function exportPublicKey(key) {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

export function importPublicKey(raw) {
  return subtle.importKey('raw', raw, ECDH, true, []);
}

export function exportPrivateKey(key) {
  return subtle.exportKey('jwk', key);
}

export function importPrivateKey(jwk) {
  return subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);
}

// Short stable identifier of a public key (used as host id / device id).
export async function keyId(rawPublicKey) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', rawPublicKey));
  return b64u.enc(digest.slice(0, 12));
}

// ECDH + HKDF. The one-time pairing secret is the HKDF salt, so only a party
// that both owns the private key and saw the QR code can derive these keys.
//   pairKey    - protects the pairing handshake itself
//   sessionRaw - long-term key that authenticates all later signaling
export async function deriveKeys(privateKey, publicKey, pairSecret) {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const derive = async (info) =>
    new Uint8Array(
      await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: pairSecret, info: te.encode(info) },
        hk,
        256,
      ),
    );
  const pairKey = await importAesKey(await derive('macbridge/v1/pair'));
  const sessionRaw = await derive('macbridge/v1/session');
  return { pairKey, sessionRaw };
}

export function importAesKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Authenticated encryption of a JSON value. `aad` binds the ciphertext to its
// direction and device so a message cannot be replayed in another role.
export async function seal(key, value, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) },
    key,
    te.encode(JSON.stringify(value)),
  );
  return { iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

// Throws if the message was not produced with the same key and aad.
export async function open(key, box, aad) {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64u.dec(box.iv), additionalData: te.encode(aad) },
    key,
    b64u.dec(box.ct),
  );
  return JSON.parse(td.decode(pt));
}
