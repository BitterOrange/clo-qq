// Preloaded into the Q5 Gateway with --import and through NODE_OPTIONS, so a Node child that keeps the environment
// loads it too. Loopback is allowed, plus the one model host the probe names in CLO_Q5_ALLOWED_HOST. Every other
// connection or lookup is recorded and refused, in this process and in worker threads. QQ and Tencent names are
// refused even if they were named, so a mistake in the probe cannot open a route.
//
// It also holds the per-turn request limit. The host retries and compacts on its own, up to 10 requests in one turn
// as observed on mocks, some of them 20 ms apart, so watching from outside cannot be exact. The request is counted
// here when it is created, before any byte leaves, and the one over the limit ends the process.
//
// What it cannot see: a non-Node child, a child given a replaced environment, and native code doing its own I/O.
import { appendFileSync, readFileSync } from 'node:fs';
import { subscribe } from 'node:diagnostics_channel';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net, { isIP } from 'node:net';

const LOG = process.env.CLO_NET_GUARD_LOG;
const ALLOWED = String(process.env.CLO_Q5_ALLOWED_HOST ?? '').toLowerCase();
const QQ_HOST = /(^|\.)(qq\.com|tencent\.com)$/i;

// By form, not by prefix: 127.evil.invalid is a name, and only a real IP literal counts.
const isLoopback = (h) => h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1'
  || (isIP(h) === 4 && h.startsWith('127.'))
  || (isIP(h) === 6 && h.startsWith('::ffff:127.'));

function permitted(host) {
  if (!host) return true;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (QQ_HOST.test(h)) return false;
  return isLoopback(h) || h === ALLOWED;
}

function record(kind, host, port) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), kind, host: String(host), port: port ?? null })}\n`);
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (!opts.path && !permitted(opts.host)) {
    record('connect', opts.host, opts.port);
    const err = Object.assign(new Error('q5-net-guard: refused'), { code: 'ECONNREFUSED' });
    queueMicrotask(() => this.destroy(err));
    return this;
  }
  return Reflect.apply(origConnect, this, args);
};

function guardCallback(owner, name) {
  const orig = owner[name];
  if (typeof orig !== 'function') return;
  owner[name] = function guarded(host, ...rest) {
    if (permitted(host)) return Reflect.apply(orig, this, [host, ...rest]);
    record('dns', host);
    const cb = rest[rest.length - 1];
    const err = Object.assign(new Error('q5-net-guard: refused lookup'), { code: 'ENOTFOUND', hostname: host });
    if (typeof cb === 'function') queueMicrotask(() => cb(err));
    return {};
  };
}

function guardPromise(owner, name) {
  const orig = owner[name];
  if (typeof orig !== 'function') return;
  owner[name] = async function guarded(host, ...rest) {
    if (permitted(host)) return Reflect.apply(orig, this, [host, ...rest]);
    record('dns', host);
    throw Object.assign(new Error('q5-net-guard: refused lookup'), { code: 'ENOTFOUND', hostname: host });
  };
}

// lookup goes through the OS. These go straight to a DNS server, so they need the same refusal.
const RESOLVERS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];

guardCallback(dns, 'lookup');
guardPromise(dns.promises, 'lookup');
for (const name of RESOLVERS) {
  guardCallback(dns, name);
  guardCallback(dns.Resolver.prototype, name);
  guardPromise(dns.promises, name);
  guardPromise(dns.promises.Resolver.prototype, name);
}
// Named imports of node:dns, as the host's bundles use, see the patched functions only after this.
syncBuiltinESMExports();

// --- the per-turn request limit ---

const MODEL_ORIGIN = process.env.CLO_Q5_MODEL_ORIGIN;
const CALL_LOG = process.env.CLO_Q5_CALL_LOG;
const TURN_FILE = process.env.CLO_Q5_TURN_FILE;
const TURN_LIMIT = Number(process.env.CLO_Q5_TURN_CALL_LIMIT);

const originOf = (value) => {
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
};

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// Files, not memory: worker threads and Node children each load their own copy of this module.
function countModelRequest() {
  const turn = readText(TURN_FILE).trim() || 'none';
  const used = readText(CALL_LOG).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.turn === turn && !l.refused).length;
  // Outside a planned turn nothing is allowed, so a model call at start-up ends the run as well.
  const allowed = turn !== 'none' && used < TURN_LIMIT;
  appendFileSync(CALL_LOG, `${JSON.stringify({ t: Date.now(), turn, refused: !allowed })}\n`);
  if (allowed) return;
  // Unconditional and immediate on Windows, from any thread. The request object exists, and nothing has been sent.
  process.kill(process.pid, 'SIGKILL');
  process.exit(97);
}

if (MODEL_ORIGIN && CALL_LOG && TURN_FILE && Number.isInteger(TURN_LIMIT)) {
  const expected = originOf(MODEL_ORIGIN);
  // undici publishes this from the request constructor, for the built-in fetch and for the host's own copy alike.
  subscribe('undici:request:create', ({ request }) => {
    if (String(request.method).toUpperCase() === 'POST' && originOf(request.origin) === expected) countModelRequest();
  });
  // In case a route uses node:http instead. Published when the request is created, before its socket can write.
  subscribe('http.client.request.created', ({ request }) => {
    const origin = originOf(`${request.protocol}//${request.getHeader('host')}`);
    if (String(request.method).toUpperCase() === 'POST' && origin === expected) countModelRequest();
  });
}
