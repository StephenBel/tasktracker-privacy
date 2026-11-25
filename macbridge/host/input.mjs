// Runs the native helper that injects mouse and keyboard events (helper.swift)
// and feeds it one JSON command per line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

export class InputInjector {
  constructor({ helperPath, onStatus }) {
    this.helperPath = helperPath;
    this.onStatus = onStatus;
    this.child = null;
    this.status = { available: false, trusted: false };
    this.stopped = false;
    this.prompted = false;
    this.restartTimer = null;
  }

  start() {
    if (!fs.existsSync(this.helperPath)) {
      this.setStatus({ available: false, trusted: false });
      return;
    }
    // Ask macOS for the permission prompt only on the first launch.
    const args = this.prompted ? [] : ['--prompt'];
    this.prompted = true;
    const child = spawn(this.helperPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (typeof msg.trusted === 'boolean') this.setStatus({ available: true, trusted: msg.trusted });
      } catch {
        // ignore anything that is not a status line
      }
    });
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.setStatus({ available: true, trusted: false });
      this.restartTimer = setTimeout(() => this.start(), 3000);
    });
  }

  // Called after the user may have granted the permission in System Settings:
  // a fresh process is the reliable way to pick the new status up.
  restart() {
    clearTimeout(this.restartTimer);
    const old = this.child;
    this.child = null;
    old?.removeAllListeners('exit');
    old?.kill();
    this.start();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
  }

  setStatus(s) {
    if (s.available === this.status.available && s.trusted === this.status.trusted) return;
    this.status = s;
    this.onStatus?.(s);
  }

  send(cmd) {
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(cmd) + '\n');
    return true;
  }
}
