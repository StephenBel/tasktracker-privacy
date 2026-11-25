// Bundles the host engine and the phone web client. The configuration
// (signaling server, STUN/TURN servers, video limits) is baked into both.
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(
  fs.readFileSync(process.env.MB_CONFIG || path.join(root, 'config.json'), 'utf8'),
);
const hostDist = process.env.MB_HOST_DIST || path.join(root, 'host', 'dist');
const webDist = process.env.MB_WEB_DIST || path.join(root, 'web', 'dist');

// Only what the page needs to know. Nothing in here is secret: the Supabase
// "publishable" key is designed to be public.
const publicConfig = {
  signal: cfg.signal,
  iceServers: cfg.iceServers,
  video: cfg.video,
};

// The pages may open network connections to the signaling server only.
function connectSrc() {
  const u = new URL(cfg.signal.url);
  if (cfg.signal.type === 'supabase') return `wss://${u.host} https://${u.host}`;
  return `${u.protocol}//${u.host}`;
}

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari15', 'chrome110'],
  minify: !process.env.MB_NO_MINIFY,
  define: { __MB_CONFIG__: JSON.stringify(publicConfig) },
  logLevel: 'warning',
};

function page(from, to) {
  fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace('__CONNECT_SRC__', connectSrc()));
}

fs.rmSync(hostDist, { recursive: true, force: true });
fs.mkdirSync(hostDist, { recursive: true });
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'host', 'engine.js')],
  outfile: path.join(hostDist, 'engine.js'),
});
page(path.join(root, 'host', 'engine.html'), path.join(hostDist, 'engine.html'));

fs.rmSync(webDist, { recursive: true, force: true });
fs.mkdirSync(webDist, { recursive: true });
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'web', 'src', 'app.js')],
  outfile: path.join(webDist, 'app.js'),
});
page(path.join(root, 'web', 'index.html'), path.join(webDist, 'index.html'));
for (const file of ['style.css', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png']) {
  fs.copyFileSync(path.join(root, 'web', file), path.join(webDist, file));
}
console.log(`[macbridge] built ${path.relative(root, hostDist)} and ${path.relative(root, webDist)}`);
