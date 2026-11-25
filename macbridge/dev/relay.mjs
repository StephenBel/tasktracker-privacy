// Tiny signaling relay: forwards each message to the other members of the
// same channel and stores nothing. Used by the automated test, and usable
// instead of Supabase (set "signal": {"type":"relay","url":"wss://..."}).
import { WebSocketServer } from 'ws';

export function startRelay(port = Number(process.env.PORT) || 8787) {
  const channels = new Map(); // name -> Set<WebSocket>
  const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 });
  wss.on('connection', (ws, req) => {
    const name = new URL(req.url, 'http://x').searchParams.get('ch');
    if (!name || name.length > 100) return ws.close();
    if (!channels.has(name)) channels.set(name, new Set());
    const peers = channels.get(name);
    if (peers.size >= 8) return ws.close();
    peers.add(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      for (const peer of peers) if (peer !== ws && peer.readyState === 1) peer.send(data.toString());
    });
    ws.on('close', () => {
      peers.delete(ws);
      if (!peers.size) channels.delete(name);
    });
    ws.on('error', () => {});
  });
  return wss;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wss = startRelay();
  console.log(`relay listening on ws://0.0.0.0:${wss.options.port}`);
}
