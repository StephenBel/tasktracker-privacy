// Сводит реплики в одну дорожку по таймкодам шотов и собирает MP4 из frames/: node mix.mjs
// Озвучка ожидается в ../audio/<ключ>.mp3 (ключи - поле audio в shots.js).
import { shots } from './shots.js';
import { execFileSync } from 'node:child_process';

const fps = 24; let t = 0; const inputs = [], filters = [];
for (const s of shots) {
  for (const l of s.lines || []) {
    const ms = Math.round((t + l.at) * 1000);
    inputs.push('-i', `../audio/${l.audio}.mp3`);
    filters.push(`[${inputs.length / 2}:a]adelay=${ms}|${ms},aformat=channel_layouts=stereo[a${filters.length}]`);
  }
  t += Math.round(s.dur * fps) / fps; // та же длина шота в кадрах, что и в movie.mjs
}
const mixIn = filters.map((_, i) => `[a${i}]`).join('');
const fc = filters.join(';') + `;${mixIn}amix=inputs=${filters.length}:normalize=0,volume=1.6,apad[aout]`;
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-i', 'frames/%05d.jpg', ...inputs,
  '-filter_complex', fc, '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
  '-c:a', 'aac', '-b:a', '160k', '-shortest', 'drema_animatic_sc1-3.mp4'], { stdio: 'inherit' });
console.log('total', t.toFixed(2), 's, lines', filters.length);
