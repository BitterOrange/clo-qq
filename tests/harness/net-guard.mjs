// Preloaded into the Gateway under test with --import. It records and refuses, in this process and
// in worker threads, any connection or DNS lookup that is not loopback. It does not touch OpenClaw.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import net, { isIP } from 'node:net';

const LOG = process.env.CLO_NET_GUARD_LOG;

const isLoopback = (host) => {
  if (!host) return true;
  const h = String(host).replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h === '0:0:0:0:0:0:0:1' || h.startsWith('::ffff:127.');
};

function record(kind, host, port) {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error().stack.split('\n').slice(3).map((s) => s.trim());
  Error.stackTraceLimit = limit;
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), kind, host: String(host), port: port ?? null, stack })}\n`);
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (!opts.path && !isLoopback(opts.host)) {
    record('connect', opts.host, opts.port);
    const err = Object.assign(new Error(`net-guard: refused ${opts.host}`), { code: 'ECONNREFUSED' });
    queueMicrotask(() => this.destroy(err));
    return this;
  }
  return Reflect.apply(origConnect, this, args);
};

const origLookup = dns.lookup;
dns.lookup = function guardedLookup(host, ...rest) {
  if (!isLoopback(host) && !isIP(String(host))) {
    record('dns', host);
    const cb = rest[rest.length - 1];
    const err = Object.assign(new Error(`net-guard: refused lookup ${host}`), { code: 'ENOTFOUND', hostname: host });
    if (typeof cb === 'function') queueMicrotask(() => cb(err));
    return {};
  }
  return Reflect.apply(origLookup, this, [host, ...rest]);
};

const origPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedPromiseLookup(host, ...rest) {
  if (!isLoopback(host) && !isIP(String(host))) {
    record('dns', host);
    throw Object.assign(new Error(`net-guard: refused lookup ${host}`), { code: 'ENOTFOUND', hostname: host });
  }
  return Reflect.apply(origPromiseLookup, this, [host, ...rest]);
};
