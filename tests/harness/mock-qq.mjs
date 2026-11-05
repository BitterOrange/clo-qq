// Local stand-in for the QQ open platform. It binds to loopback only, and it records every HTTP
// request and every message so tests can assert exactly what would have reached QQ.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const isMessagePost = (method, url) => method === 'POST' && /^\/v2\/(groups|users)\/[^/]+\/messages$/.test(url);

export async function startMockQq({ token = 'mock-access-token', ready = true } = {}) {
  const requests = [];
  const identifies = [];
  const resumes = [];
  const sockets = new Set();
  let seq = 0;
  let opened = 0;
  let peak = 0;
  let refused = 0;
  let refuseLeft = 0;
  let tokenFailures = 0;
  let readyEnabled = ready;
  let sendScript = null;
  let refCounter = 0;
  let botUsername = 'mock-bot';

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const rec = { method: req.method, path: req.url, body };
      requests.push(rec);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/app/getAppAccessToken') {
        if (tokenFailures > 0) {
          tokenFailures -= 1;
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'mock: token unavailable' }));
          return;
        }
        res.end(JSON.stringify({ access_token: token, expires_in: '7200' }));
      } else if (req.method === 'GET' && req.url === '/gateway') {
        res.end(JSON.stringify({ url: `ws://127.0.0.1:${server.address().port}/ws` }));
      } else if (sendScript && isMessagePost(req.method, req.url)) {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* left null */ }
        const out = (await sendScript({ path: req.url, body: parsed, nth: requests.filter((r) => isMessagePost(r.method, r.path)).length })) ?? {};
        rec.scripted = out;
        if (out.hang) return;
        res.statusCode = out.status ?? 200;
        const reply = out.body !== undefined ? out.body : { id: `sent-${requests.length}`, timestamp: new Date().toISOString() };
        res.end(JSON.stringify(reply));
      } else {
        res.end(JSON.stringify({ id: `sent-${requests.length}`, timestamp: new Date().toISOString() }));
      }
    });
  });
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (_info, cb) => {
      if (refuseLeft > 0) {
        refuseLeft -= 1;
        refused += 1;
        cb(false, 503, 'mock: refused');
      } else {
        cb(true);
      }
    },
  });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    opened += 1;
    peak = Math.max(peak, sockets.size);
    ws.on('close', () => sockets.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 2) {
        identifies.push(m.d);
        if (readyEnabled) ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'READY', d: { session_id: 'mock-session', version: 1, user: { id: 'bot', bot: true, username: botUsername } } }));
      } else if (m.op === 6) {
        resumes.push(m.d);
        ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'RESUMED', d: {} }));
      } else if (m.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    requests,
    identifies,
    resumes,
    /** Pushes a gateway event to every connected client. */
    push(type, data) {
      for (const ws of sockets) ws.send(JSON.stringify({ op: 0, s: ++seq, t: type, d: data }));
    },
    /** Closes every connection with the given WebSocket close code. */
    closeAll(code) {
      for (const ws of sockets) ws.close(code);
    },
    /** Cuts every socket with no close frame, which the client reads as 1006. */
    terminateAll() {
      for (const ws of sockets) ws.terminate();
    },
    connected: () => sockets.size,
    /** Total connections ever accepted, and the most that were ever open at once. */
    opened: () => opened,
    peak: () => peak,
    /** `fn({ path, body, nth })` returns `{ status, body }` or `{ hang: true }`. Message routes only. */
    setSendScript(fn) { sendScript = fn; },
    /** The next n WebSocket handshakes are refused. */
    refuseConnections(n) { refuseLeft = n; },
    refused: () => refused,
    /** The next n token requests fail. */
    failToken(n) { tokenFailures = n; },
    /** Withhold or restore READY for later identifies. */
    setReady(on) { readyEnabled = on; },
    /** Sends READY now on every open socket. */
    sendReady() {
      for (const ws of sockets) ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'READY', d: { session_id: 'mock-session', version: 1, user: { id: 'bot', bot: true, username: botUsername } } }));
    },
    setUsername(name) { botUsername = name; },
    /** A ref_idx value a scripted send response can carry. */
    nextRefIdx() {
      refCounter += 1;
      return `REFIDX${refCounter}`;
    },
    /** Message POSTs only. */
    messagePosts() {
      return requests.filter((r) => isMessagePost(r.method, r.path));
    },
    async stop() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
