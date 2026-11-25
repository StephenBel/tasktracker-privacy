// Signaling transports. A transport only relays small JSON envelopes between
// the phone and the Mac so they can set up a direct WebRTC connection.
// It is untrusted: every envelope is encrypted and authenticated end to end
// (see crypto.js), so the relay can neither read nor forge anything useful.
//
// Interface: { send(obj), close(), onmessage, onstate }  state: 'open' | 'closed'

import { RealtimeClient } from '@supabase/realtime-js';

export function createTransport(signal, channelName) {
  if (signal.type === 'supabase') return supabaseTransport(signal, channelName);
  if (signal.type === 'relay') return relayTransport(signal, channelName);
  throw new Error(`Unknown signaling type: ${signal.type}`);
}

// Supabase Realtime "broadcast": a hosted pub/sub channel, nothing is stored.
function supabaseTransport({ url, key }, channelName) {
  const t = { onmessage: null, onstate: null, state: 'closed' };
  const endpoint = url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/realtime/v1';
  const client = new RealtimeClient(endpoint, { params: { apikey: key } });
  const channel = client.channel(channelName, {
    config: { broadcast: { self: false, ack: false } },
  });
  const setState = (s) => {
    if (t.state === s) return;
    t.state = s;
    t.onstate?.(s);
  };
  channel.on('broadcast', { event: 'm' }, (msg) => t.onmessage?.(msg.payload));
  // realtime-js reconnects and rejoins on its own; we only mirror the status.
  channel.subscribe((status) => setState(status === 'SUBSCRIBED' ? 'open' : 'closed'));

  t.send = (payload) => {
    if (t.state !== 'open') return false;
    channel.send({ type: 'broadcast', event: 'm', payload });
    return true;
  };
  t.close = () => {
    t.onmessage = null;
    t.onstate = null;
    client.removeChannel(channel);
    client.disconnect();
    t.state = 'closed';
  };
  return t;
}

// Minimal self-hosted relay (dev/relay.mjs): used by the automated tests and
// usable on a home network without any cloud service.
function relayTransport({ url }, channelName) {
  const t = { onmessage: null, onstate: null, state: 'closed' };
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  const setState = (s) => {
    if (t.state === s) return;
    t.state = s;
    t.onstate?.(s);
  };
  const connect = () => {
    ws = new WebSocket(`${url.replace(/\/+$/, '')}/?ch=${encodeURIComponent(channelName)}`);
    ws.onopen = () => {
      retry = 0;
      setState('open');
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      t.onmessage?.(msg);
    };
    ws.onclose = () => {
      setState('closed');
      if (closed) return;
      timer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
    };
    ws.onerror = () => ws.close();
  };
  connect();

  t.send = (payload) => {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(payload));
    return true;
  };
  t.close = () => {
    closed = true;
    clearTimeout(timer);
    t.onmessage = null;
    t.onstate = null;
    ws?.close();
    t.state = 'closed';
  };
  return t;
}

export function channelFor(hostId) {
  return `macbridge-${hostId}`;
}
