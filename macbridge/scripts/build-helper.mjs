// Compiles the native input helper (host/helper.swift) with the Swift compiler
// that ships with Xcode Command Line Tools. Runs automatically after
// `npm install`; with --optional it never fails the install.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const optional = process.argv.includes('--optional');
const src = path.join(root, 'host', 'helper.swift');
const out = path.join(root, 'host', 'bin', 'mb-input');

function bail(message) {
  console[optional ? 'warn' : 'error'](`[macbridge] ${message}`);
  process.exit(optional ? 0 : 1);
}

if (process.platform !== 'darwin') bail('input helper is macOS-only, skipping build.');

const probe = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
if (probe.status !== 0) {
  bail(
    'Swift compiler not found. Install Xcode Command Line Tools with ' +
      '`xcode-select --install`, then run `npm run build:helper`.',
  );
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const build = spawnSync('xcrun', ['swiftc', '-O', src, '-o', out], { stdio: 'inherit' });
if (build.status !== 0) bail('failed to compile host/helper.swift (see errors above).');
console.log(`[macbridge] built ${path.relative(root, out)}`);
