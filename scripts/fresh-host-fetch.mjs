// fetch for a host that provisioning made minutes ago. The operator's
// resolver can hold a "not found" answer for it from before the record
// existed: macOS keeps it for the zone's negative TTL, 30 minutes on
// the workspace domain. On ENOTFOUND this asks a public resolver instead. TLS still
// checks the certificate against the host name.
import { Resolver, lookup as systemLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

/** dns.lookup that falls back to a public resolver on ENOTFOUND. */
export function freshHostLookup(host, options, callback) {
  systemLookup(host, options, (error, address, family) => {
    if (error?.code !== 'ENOTFOUND') return callback(error, address, family);
    const resolver = new Resolver();
    resolver.setServers(PUBLIC_RESOLVERS);
    resolver.resolve4(host, (publicError, addresses) => {
      if (publicError || addresses.length === 0) return callback(error);
      if (options?.all) return callback(null, addresses.map((item) => ({ address: item, family: 4 })));
      callback(null, addresses[0], 4);
    });
  });
}

/**
 * The subset of fetch that the provisioning scripts use: https only, a string
 * body, no redirects followed (a 3xx is an error, as `redirect: 'error'`).
 */
export function freshHostFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') return Promise.reject(new Error('freshHostFetch is https only'));
  return new Promise((resolve, reject) => {
    const req = httpsRequest(target, { method, headers, signal, lookup: freshHostLookup }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new Error(`redirect refused (${res.statusCode})`));
      }
      const empty = [204, 205, 304].includes(res.statusCode) || method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), {
        status: res.statusCode,
        headers: Object.entries(res.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((item) => [name, item]) : value === undefined ? [] : [[name, value]])),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
