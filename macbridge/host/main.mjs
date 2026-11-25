// MacBridge host: menu bar app. Owns the tray menu, the pairing window, the
// stored keys and the native input helper. Screen capture and WebRTC run in a
// hidden window (engine.js).
import {
  app, BrowserWindow, Menu, Notification, Tray, clipboard, desktopCapturer, dialog,
  ipcMain, nativeImage, powerSaveBlocker, safeStorage, screen, session, shell,
  systemPreferences,
} from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { InputInjector } from './input.mjs';
import { PAIR_TTL_MS, makePairLink } from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const isMac = process.platform === 'darwin';

const cfg = JSON.parse(
  fs.readFileSync(process.env.MB_CONFIG || path.join(root, 'config.json'), 'utf8'),
);
const distDir = process.env.MB_HOST_DIST || path.join(here, 'dist');
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

if (process.env.MB_USER_DATA) app.setPath('userData', process.env.MB_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let state = { hostKey: null, devices: [], displayId: null, keepAwake: true };
let engine = null;
let pairWindow = null;
let tray = null;
let hostInfo = null; // { hostId, hostPub } once the engine is ready
let pairingTimer = null;
let signalState = 'closed';
let activeDevice = null;
let awakeBlocker = null;
let engineError = null;
const input = new InputInjector({
  helperPath: process.env.MB_INPUT_HELPER || path.join(here, 'bin', 'mb-input'),
  onStatus: () => refreshMenu(),
});

// ------------------------------------------------------------------ storage
// Secrets are encrypted with a key kept in the macOS Keychain (safeStorage).

function protect(text) {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(text).toString('base64');
  }
  if (isMac) throw new Error('Keychain encryption is unavailable');
  return 'raw:' + text; // development on other platforms only
}

function unprotect(value) {
  if (value.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  }
  if (value.startsWith('raw:') && !isMac) return value.slice(4);
  throw new Error('Unreadable stored secret');
}

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) };
  } catch {
    // first run
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile());
}

// ------------------------------------------------------------------ windows

const webPreferences = {
  preload: path.join(here, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false,
};

function lockDown(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createEngine() {
  engine = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences });
  lockDown(engine);
  engine.loadFile(path.join(distDir, 'engine.html'));
  engine.webContents.on('render-process-gone', () => {
    activeDevice = null;
    hostInfo = null;
    refreshMenu();
    setTimeout(() => {
      engine?.destroy();
      createEngine();
    }, 1000);
  });
  if (process.env.MB_DEBUG) {
    engine.webContents.on('console-message', (event, _level, message) =>
      console.log(message ?? event.message),
    );
  }
}

const fromEngine = (event) => engine && event.sender === engine.webContents;
const fromPair = (event) => pairWindow && event.sender === pairWindow.webContents;

async function openPairWindow() {
  if (!hostInfo) return;
  if (pairWindow) {
    pairWindow.show();
    pairWindow.focus();
    return;
  }
  pairWindow = new BrowserWindow({
    width: 380,
    height: 560,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    title: 'Подключить телефон',
    webPreferences,
  });
  lockDown(pairWindow);
  pairWindow.on('closed', () => {
    pairWindow = null;
    closePairing();
  });
  await pairWindow.loadFile(path.join(here, 'pair.html'));
  await startPairing();
}

async function startPairing() {
  if (!pairWindow || !hostInfo) return;
  clearTimeout(pairingTimer);
  const secret = crypto.randomBytes(16).toString('base64url');
  const expires = Date.now() + PAIR_TTL_MS;
  const link = makePairLink(cfg.clientUrl, hostInfo.hostPub, secret);
  const qr = await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 640 });
  engine.webContents.send('pair:open', { secret, expires });
  pairWindow.webContents.send('pair:data', { qr, link, expires });
  pairingTimer = setTimeout(closePairing, PAIR_TTL_MS);
}

function closePairing() {
  clearTimeout(pairingTimer);
  engine?.webContents.send('pair:close');
}

// --------------------------------------------------------------------- tray

function trayIcon() {
  const file = path.join(here, 'assets', isMac ? 'trayTemplate.png' : 'tray.png');
  const image = nativeImage.createFromPath(file);
  if (isMac) image.setTemplateImage(true);
  return image;
}

function permissionItems() {
  if (!isMac) return [];
  const screenOk = systemPreferences.getMediaAccessStatus('screen') === 'granted';
  const open = (pane) => () =>
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  const inputLabel = !input.status.available
    ? 'Управление: помощник не собран (npm run build:helper)'
    : input.status.trusted
      ? 'Универсальный доступ: разрешён'
      : 'Универсальный доступ: нужно разрешить…';
  return [
    {
      label: screenOk ? 'Запись экрана: разрешена' : 'Запись экрана: нужно разрешить…',
      click: open('Privacy_ScreenCapture'),
    },
    { label: inputLabel, click: open('Privacy_Accessibility') },
    { label: 'Проверить разрешения снова', click: () => { input.restart(); refreshMenu(); } },
  ];
}

function refreshMenu() {
  if (!tray) return;
  const online = signalState === 'open';
  const displays = screen.getAllDisplays();
  const status = engineError
    ? `Ошибка: ${engineError}`
    : !hostInfo
      ? 'Запуск…'
      : online
        ? 'В сети, готов к подключению'
        : 'Нет связи с сервером, переподключаюсь…';

  const template = [
    { label: status, enabled: false },
    {
      label: activeDevice ? `Сейчас подключён: ${activeDevice.name}` : 'Никто не подключён',
      enabled: false,
    },
    ...(activeDevice
      ? [{ label: 'Отключить сейчас', click: () => engine?.webContents.send('session:kick') }]
      : []),
    { type: 'separator' },
    { label: 'Подключить телефон…', enabled: !!hostInfo, click: openPairWindow },
    {
      label: 'Доверенные устройства',
      enabled: state.devices.length > 0,
      submenu: state.devices.map((d) => ({
        label: d.name,
        submenu: [
          { label: `Добавлено ${new Date(d.addedAt).toLocaleDateString()}`, enabled: false },
          { label: 'Удалить доступ', click: () => removeDevice(d.id) },
        ],
      })),
    },
    ...(displays.length > 1
      ? [
          {
            label: 'Какой экран показывать',
            submenu: displays.map((d, i) => ({
              label: describeDisplay(d, i).label,
              type: 'radio',
              checked: String(d.id) === String(state.displayId ?? screen.getPrimaryDisplay().id),
              click: () => {
                state.displayId = String(d.id);
                saveState();
                engine?.webContents.send('display:set', state.displayId);
              },
            })),
          },
        ]
      : []),
    { type: 'separator' },
    ...permissionItems(),
    { type: 'separator' },
    {
      label: 'Не давать Маку засыпать',
      type: 'checkbox',
      checked: state.keepAwake,
      click: (item) => {
        state.keepAwake = item.checked;
        saveState();
        applyKeepAwake();
      },
    },
    ...(app.isPackaged
      ? [
          {
            label: 'Запускать при входе в систему',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
          },
        ]
      : []),
    { type: 'separator' },
    { label: 'Выйти из MacBridge', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`MacBridge: ${status}`);
  if (isMac) tray.setTitle(activeDevice ? ' ●' : '');
}

function removeDevice(id) {
  state.devices = state.devices.filter((d) => d.id !== id);
  saveState();
  engine?.webContents.send('devices:removed', id);
  refreshMenu();
}

function applyKeepAwake() {
  if (state.keepAwake && awakeBlocker === null) {
    awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!state.keepAwake && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}

// ---------------------------------------------------------------- displays

function describeDisplay(d, index) {
  return {
    id: String(d.id),
    label: d.label || (d.internal ? 'Встроенный экран' : `Экран ${index + 1}`),
    w: d.bounds.width,
    h: d.bounds.height,
    pw: Math.round(d.bounds.width * d.scaleFactor),
    ph: Math.round(d.bounds.height * d.scaleFactor),
  };
}

function findDisplay(id) {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

// ---------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('state:load', (event) => {
    if (!fromEngine(event)) throw new Error('forbidden');
    return {
      hostName: os.hostname().replace(/\.local$/, ''),
      displayId: state.displayId,
      hostKey: state.hostKey ? JSON.parse(unprotect(state.hostKey)) : null,
      devices: state.devices.map((d) => ({ id: d.id, name: d.name, key: unprotect(d.key) })),
    };
  });

  ipcMain.handle('state:saveHostKey', (event, key) => {
    if (!fromEngine(event)) throw new Error('forbidden');
    state.hostKey = protect(JSON.stringify(key));
    saveState();
  });

  ipcMain.handle('state:addDevice', (event, dev) => {
    if (!fromEngine(event)) throw new Error('forbidden');
    state.devices = state.devices.filter((d) => d.id !== dev.id);
    state.devices.push({ id: dev.id, name: dev.name, key: protect(dev.key), addedAt: Date.now() });
    saveState();
    refreshMenu();
  });

  ipcMain.handle('capture:source', async (event, id) => {
    if (!fromEngine(event)) throw new Error('forbidden');
    const all = screen.getAllDisplays();
    const target = findDisplay(id);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const source =
      sources.find((s) => s.display_id === String(target.id)) ||
      sources[all.indexOf(target)] ||
      sources[0];
    if (!source) throw new Error('no screen source (screen recording permission?)');
    return {
      sourceId: source.id,
      display: describeDisplay(target, all.indexOf(target)),
      displays: all.map(describeDisplay),
    };
  });

  ipcMain.handle('pair:copy', (event, text) => {
    if (!fromPair(event)) throw new Error('forbidden');
    clipboard.writeText(String(text));
  });

  ipcMain.on('pair:refresh', (event) => {
    if (fromPair(event)) startPairing();
  });

  ipcMain.on('engine:ready', (event, info) => {
    if (!fromEngine(event)) return;
    hostInfo = info;
    engineError = null;
    refreshMenu();
    if (pairWindow) startPairing();
    else if (state.devices.length === 0) openPairWindow();
  });

  ipcMain.on('engine:error', (event, message) => {
    if (!fromEngine(event)) return;
    engineError = message;
    refreshMenu();
  });

  ipcMain.on('signal:state', (event, s) => {
    if (!fromEngine(event)) return;
    signalState = s;
    refreshMenu();
  });

  ipcMain.on('session:state', (event, s) => {
    if (!fromEngine(event)) return;
    const was = activeDevice;
    activeDevice = s.connected ? s.device : null;
    if (activeDevice && activeDevice.id !== was?.id) {
      // Make sure the display is on and tell whoever sits at the Mac.
      if (isMac) spawn('caffeinate', ['-u', '-t', '3'], { stdio: 'ignore' }).on('error', () => {});
      if (Notification.isSupported()) {
        new Notification({
          title: 'MacBridge',
          body: `Экран смотрит и управляет: ${activeDevice.name}`,
          silent: true,
        }).show();
      }
    }
    refreshMenu();
  });

  ipcMain.on('pair:done', (event, dev) => {
    if (!fromEngine(event)) return;
    clearTimeout(pairingTimer);
    pairWindow?.webContents.send('pair:success', dev);
    refreshMenu();
  });

  ipcMain.on('capture:failed', (event) => {
    if (!fromEngine(event)) return;
    refreshMenu();
    if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      new Notification({
        title: 'MacBridge: нет доступа к экрану',
        body: 'Разрешите «Запись экрана» в настройках и перезапустите приложение.',
      }).show();
    }
  });

  ipcMain.on('input', (event, msg) => {
    if (!fromEngine(event) || !activeDevice) return;
    const b = findDisplay(msg.display).bounds;
    const cmd = { ...msg, x: b.x + msg.x * b.width, y: b.y + msg.y * b.height };
    delete cmd.display;
    if (msg.t === 'scroll') {
      cmd.dx = msg.dx * b.width;
      cmd.dy = msg.dy * b.height;
    }
    input.send(cmd);
  });
}

// ---------------------------------------------------------------------- app

app.on('window-all-closed', () => {
  // Menu bar app: keep running without windows.
});
app.on('second-instance', () => openPairWindow());
app.on('before-quit', () => input.stop());

app.whenReady().then(() => {
  if (isMac) app.dock?.hide();
  loadState();

  // The only web permission ever granted is screen capture, and only to the engine.
  const ses = session.defaultSession;
  const allowed = (wc, permission) =>
    !!engine && wc === engine.webContents && (permission === 'display-capture' || permission === 'media');
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(allowed(wc, permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));

  registerIpc();
  tray = new Tray(trayIcon());
  refreshMenu();
  screen.on('display-added', refreshMenu);
  screen.on('display-removed', refreshMenu);
  applyKeepAwake();
  input.start();

  if (!/^https?:\/\//.test(cfg.clientUrl || '') || /YOUR-/.test(JSON.stringify(cfg))) {
    dialog.showErrorBox(
      'MacBridge не настроен',
      'Заполните macbridge/config.json (адрес страницы для телефона и сервер сигналинга) и перезапустите.',
    );
    engineError = 'не заполнен config.json';
    refreshMenu();
    return;
  }
  createEngine();
});
