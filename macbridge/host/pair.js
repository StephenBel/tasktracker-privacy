// Pairing window: shows the one-time QR code produced by the main process.
const $ = (id) => document.getElementById(id);
let current = null;
let ticker = null;

function tick() {
  if (!current) return;
  const left = Math.max(0, current.expires - Date.now());
  const expired = left === 0;
  $('qr').parentElement.classList.toggle('expired', expired);
  $('copy').disabled = expired;
  if (expired) {
    $('timer').textContent = 'Код истёк. Нажмите «Новый код».';
    clearInterval(ticker);
    return;
  }
  const s = Math.ceil(left / 1000);
  $('timer').textContent = `Код действует ещё ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

window.mb.on('pair:data', (data) => {
  current = data;
  $('qr').src = data.qr;
  $('pairing').hidden = false;
  $('done').hidden = true;
  clearInterval(ticker);
  ticker = setInterval(tick, 500);
  tick();
});

window.mb.on('pair:success', (dev) => {
  clearInterval(ticker);
  $('device').textContent = dev.name;
  $('pairing').hidden = true;
  $('done').hidden = false;
  setTimeout(() => window.close(), 6000);
});

$('copy').addEventListener('click', async () => {
  if (!current) return;
  await window.mb.invoke('pair:copy', current.link);
  $('copy').textContent = 'Скопировано';
  setTimeout(() => ($('copy').textContent = 'Скопировать ссылку'), 1500);
});

$('refresh').addEventListener('click', () => window.mb.send('pair:refresh'));
