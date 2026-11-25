// Narrow bridge between the sandboxed windows and the main process.
// Only the channels listed here can cross; the main process additionally
// checks which window a message came from.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['state:load', 'state:saveHostKey', 'state:addDevice', 'capture:source', 'pair:copy'];
const SEND = [
  'engine:ready', 'engine:error', 'signal:state', 'session:state',
  'pair:done', 'capture:failed', 'input', 'pair:refresh',
];
const ON = [
  'pair:open', 'pair:close', 'devices:removed', 'session:kick', 'display:set',
  'pair:data', 'pair:success',
];

contextBridge.exposeInMainWorld('mb', {
  invoke: (channel, ...args) => {
    if (!INVOKE.includes(channel)) throw new Error(`blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    if (!SEND.includes(channel)) throw new Error(`blocked channel ${channel}`);
    ipcRenderer.send(channel, ...args);
  },
  on: (channel, handler) => {
    if (!ON.includes(channel)) throw new Error(`blocked channel ${channel}`);
    ipcRenderer.on(channel, (_event, ...args) => handler(...args));
  },
});
