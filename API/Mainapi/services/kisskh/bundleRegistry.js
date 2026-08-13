const crypto = require('node:crypto');
const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { APPROVED_ALGORITHMS } = require('./approvedAlgorithms');
const { KisskhError } = require('./errors');

const BUNDLE_URL = 'https://kisskh.nl/502.33bac7b53e9897b8.js';
const MODULE_URL = 'https://kisskh.nl/common.js?v=9082123';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CHECK_TTL_SECONDS = 900;
const STALE_MAX_SECONDS = 86_400;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundedTtlSeconds(value, fallback, maximum, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${label} invalide`);
  }
  return resolved;
}

function validateKisskhUrl(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new KisskhError('provider_security', 'URL KissKH non autorisee');
  }
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new KisskhError('provider_security', 'URL KissKH non autorisee', { cause });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'kisskh.nl'
      || (url.port && url.port !== '443') || url.username || url.password || url.hash) {
    throw new KisskhError('provider_security', 'URL KissKH non autorisee');
  }
  return url;
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6(address) {
  let input = address.toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = input.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) return null;
    const octets = ipv4.split('.').map(Number);
    input = `${input.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 0 || (halves.length === 2 && zeros < 1)) return null;
  const words = [...left, ...Array(zeros).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function isPublicIpv6(address) {
  const words = expandIpv6(address);
  if (!words) return false;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (allZero || loopback) return false;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return isPublicIpv4(ipv4);
  }
  return (words[0] & 0xe000) === 0x2000;
}

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function validatePublicDns(hostname, resolveDns) {
  let answers;
  try {
    answers = await resolveDns(hostname);
  } catch (cause) {
    throw new KisskhError('provider_unavailable', 'Verification KissKH indisponible', { cause });
  }
  const normalized = (Array.isArray(answers) ? answers : [answers])
    .map((answer) => typeof answer === 'string' ? answer : answer?.address)
    .filter(Boolean);
  if (!normalized.length || normalized.some((address) => !isPublicIp(address))) {
    throw new KisskhError('provider_security', 'Adresse KissKH non publique');
  }
  return normalized;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function assertDeclaredSizes(response) {
  for (const size of [response.compressedBytes, response.decompressedBytes]) {
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_BYTES)) {
      throw new KisskhError('provider_security', 'Bundle KissKH trop volumineux');
    }
  }
  const contentLength = getHeader(response.headers, 'content-length');
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^\d+$/.test(String(contentLength))) {
      throw new KisskhError('provider_security', 'Taille bundle KissKH invalide');
    }
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_SOURCE_BYTES) {
      throw new KisskhError('provider_security', 'Bundle KissKH trop volumineux');
    }
  }
}

function appendChunk(chunks, chunk, total) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const nextTotal = total + buffer.length;
  if (nextTotal > MAX_SOURCE_BYTES) {
    throw new KisskhError('provider_security', 'Bundle KissKH trop volumineux');
  }
  chunks.push(buffer);
  return nextTotal;
}

async function readBodyLimited(response) {
  assertDeclaredSizes(response);
  const body = response.body;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buffer.length > MAX_SOURCE_BYTES) throw new KisskhError('provider_security', 'Bundle KissKH trop volumineux');
    return buffer.toString('utf8');
  }
  const chunks = [];
  let total = 0;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total = appendChunk(chunks, value, total);
      }
    } catch (error) {
      if (error instanceof KisskhError) await reader.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) total = appendChunk(chunks, chunk, total);
    return Buffer.concat(chunks, total).toString('utf8');
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
      throw new KisskhError('provider_security', 'Bundle KissKH trop volumineux');
    }
    return text;
  }
  throw new KisskhError('provider_unavailable', 'Verification KissKH indisponible');
}

async function defaultResolveDns(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

function createPinnedLookup(addresses) {
  const pinned = addresses.map((address) => ({ address, family: net.isIP(address) }));
  if (!pinned.length || pinned.some((entry) => !entry.family || !isPublicIp(entry.address))) {
    throw new KisskhError('provider_security', 'Adresse KissKH non publique');
  }
  return (_hostname, options, callback) => {
    const settings = typeof options === 'object' && options !== null ? options : { family: options };
    const family = Number(settings.family) || 0;
    const candidates = family ? pinned.filter((entry) => entry.family === family) : pinned;
    if (!candidates.length) {
      const error = new Error('Aucune adresse KissKH approuvee pour cette famille');
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    if (settings.all) {
      callback(null, candidates.map((entry) => ({ ...entry })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

function createPinnedHttpsFetcher({ request = https.request, timeoutMs = 10_000 } = {}) {
  if (typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('transport HTTPS KissKH invalide');
  }
  return (urlValue, options = {}) => {
    const url = validateKisskhUrl(urlValue);
    const maxBytes = options.maxBytes === undefined ? MAX_SOURCE_BYTES : options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES) {
      return Promise.reject(new KisskhError('provider_security', 'Limite bundle KissKH invalide'));
    }
    let lookup;
    try {
      lookup = createPinnedLookup(Array.isArray(options.addresses) ? options.addresses : []);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let req;
      let res;
      let settled = false;
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
      };
      const destroy = () => {
        if (res && !res.destroyed) res.destroy();
        if (req && !req.destroyed) req.destroy();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        destroy();
        reject(error);
      };
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const resolveAndDestroy = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        destroy();
        resolve(value);
      };
      const unavailable = (cause) => new KisskhError('provider_unavailable', 'Verification KissKH indisponible', { cause });
      const requestOptions = {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        lookup,
        headers: {
          Host: url.hostname,
          Accept: 'application/javascript,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Movix-KissKH-Bundle-Guard/1.0',
        },
      };
      try {
        req = request(requestOptions, (response) => {
          res = response;
          const status = Number(response.statusCode);
          const headers = response.headers || {};
          if (status < 200 || status >= 300) {
            resolveAndDestroy({ status, headers, body: Buffer.alloc(0), compressedBytes: 0, decompressedBytes: 0 });
            return;
          }
          const contentEncoding = String(getHeader(headers, 'content-encoding') || '').trim().toLowerCase();
          if (contentEncoding && contentEncoding !== 'identity') {
            rejectOnce(new KisskhError('provider_security', 'Encodage bundle KissKH non autorise'));
            return;
          }
          const contentLength = getHeader(headers, 'content-length');
          if (contentLength !== null && contentLength !== undefined) {
            if (!/^\d+$/.test(String(contentLength)) || Number(contentLength) > maxBytes) {
              rejectOnce(new KisskhError('provider_security', 'Bundle KissKH trop volumineux'));
              return;
            }
          }
          const chunks = [];
          let wireBytes = 0;
          let decodedBytes = 0;
          response.on('data', (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            wireBytes += buffer.length;
            decodedBytes += buffer.length;
            if (wireBytes > maxBytes || decodedBytes > maxBytes) {
              rejectOnce(new KisskhError('provider_security', 'Bundle KissKH trop volumineux'));
              return;
            }
            chunks.push(buffer);
          });
          response.once('aborted', () => rejectOnce(unavailable(new Error('reponse interrompue'))));
          response.once('error', (cause) => rejectOnce(unavailable(cause)));
          response.once('end', () => {
            resolveOnce({
              status,
              headers,
              body: Buffer.concat(chunks, decodedBytes),
              compressedBytes: wireBytes,
              decompressedBytes: decodedBytes,
            });
          });
        });
      } catch (cause) {
        rejectOnce(unavailable(cause));
        return;
      }
      try {
        req.once('error', (cause) => rejectOnce(unavailable(cause)));
        req.setTimeout(timeoutMs, () => rejectOnce(unavailable(new Error('delai HTTPS depasse'))));
        timer = setTimeout(() => rejectOnce(unavailable(new Error('delai HTTPS depasse'))), timeoutMs);
        timer.unref?.();
        req.end();
      } catch (cause) {
        rejectOnce(unavailable(cause));
      }
    });
  };
}

async function fetchBoundedText(initialUrl, fetchText, resolveDns) {
  let current = validateKisskhUrl(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const addresses = await validatePublicDns(current.hostname, resolveDns);
    let response;
    try {
      response = await fetchText(current.href, { redirect: 'manual', addresses, maxBytes: MAX_SOURCE_BYTES });
    } catch (cause) {
      if (cause instanceof KisskhError) throw cause;
      throw new KisskhError('provider_unavailable', 'Verification KissKH indisponible', { cause });
    }
    if (typeof response === 'string') {
      if (Buffer.byteLength(response, 'utf8') > MAX_SOURCE_BYTES) {
        throw new KisskhError('provider_security', 'Bundle KissKH trop volumineux');
      }
      return response;
    }
    const status = Number(response?.status);
    if (status >= 300 && status < 400) {
      if (redirects === MAX_REDIRECTS) throw new KisskhError('provider_security', 'Trop de redirections KissKH');
      const location = getHeader(response.headers, 'location');
      if (!location || /[\r\n]/.test(location)) throw new KisskhError('provider_security', 'Redirection KissKH invalide');
      current = validateKisskhUrl(new URL(location, current).href);
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new KisskhError('provider_unavailable', 'Verification KissKH indisponible');
    }
    return readBodyLimited(response);
  }
  throw new KisskhError('provider_security', 'Trop de redirections KissKH');
}

function createBundleRegistry(deps = {}) {
  const checkTtlMs = boundedTtlSeconds(
    deps.checkTtlSeconds, CHECK_TTL_SECONDS, CHECK_TTL_SECONDS, 'bundle check TTL KissKH',
  ) * 1000;
  const staleMaxMs = boundedTtlSeconds(
    deps.staleMaxSeconds, STALE_MAX_SECONDS, STALE_MAX_SECONDS, 'bundle stale TTL KissKH',
  ) * 1000;
  const fetchText = deps.fetchText || createPinnedHttpsFetcher();
  const resolveDns = deps.resolveDns || defaultResolveDns;
  const hashText = deps.hashText || sha256;
  const approved = deps.approved || APPROVED_ALGORITHMS;
  const compiledFallback = deps.approved === undefined && approved.size === 1
    ? approved.values().next().value
    : null;
  const now = deps.now || Date.now;
  const loadCurrentMetadata = deps.loadCurrentMetadata;
  if (loadCurrentMetadata !== undefined && typeof loadCurrentMetadata !== 'function') {
    throw new TypeError('cache bundle KissKH invalide');
  }
  const bundleUrl = deps.bundleUrl || BUNDLE_URL;
  const moduleUrl = deps.moduleUrl || MODULE_URL;
  let current = null;
  let lastKnown = null;
  let cacheLoaded = false;
  let pendingResolution = null;

  async function loadCachedCurrent() {
    if (cacheLoaded || !loadCurrentMetadata) return;
    cacheLoaded = true;
    let metadata;
    try {
      metadata = await loadCurrentMetadata();
    } catch {
      return;
    }
    if (!metadata || !Number.isSafeInteger(metadata.checkedAt)) return;
    const checkedAt = now();
    if (metadata.checkedAt < 0 || metadata.checkedAt > checkedAt
        || checkedAt - metadata.checkedAt >= checkTtlMs) return;
    const algorithm = approved.get(metadata.bundleSha256);
    if (!algorithm || algorithm.algorithmVersion !== metadata.algorithmVersion
        || algorithm.moduleSha256 !== metadata.moduleSha256) return;
    current = { algorithm, checkedAt: metadata.checkedAt };
    lastKnown = current;
  }

  async function checkCurrent() {
    const bundleText = await fetchBoundedText(bundleUrl, fetchText, resolveDns);
    const bundleSha256 = hashText(bundleText);
    const algorithm = approved.get(bundleSha256);
    if (!algorithm) throw new KisskhError('provider_changed', 'Version KissKH non approuvee');
    if (typeof algorithm.moduleSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(algorithm.moduleSha256)) {
      throw new KisskhError('provider_changed', 'Module KissKH non approuve');
    }
    const moduleText = await fetchBoundedText(moduleUrl, fetchText, resolveDns);
    const moduleSha256 = hashText(moduleText);
    if (moduleSha256 !== algorithm.moduleSha256) {
      throw new KisskhError('provider_changed', 'Module KissKH non approuve');
    }
    return algorithm;
  }

  return {
    async resolveApprovedAlgorithm() {
      const checkedAt = now();
      if (current && checkedAt - current.checkedAt < checkTtlMs) return current.algorithm;
      if (pendingResolution) return pendingResolution;
      pendingResolution = (async () => {
        await loadCachedCurrent();
        const refreshedAt = now();
        if (current && refreshedAt - current.checkedAt < checkTtlMs) return current.algorithm;
        try {
          const algorithm = await checkCurrent();
          current = { algorithm, checkedAt: refreshedAt };
          lastKnown = current;
          return algorithm;
        } catch (cause) {
          if (cause instanceof KisskhError && ['provider_changed', 'provider_security'].includes(cause.code)) throw cause;
          if (lastKnown && refreshedAt - lastKnown.checkedAt <= staleMaxMs) return lastKnown.algorithm;
          if (compiledFallback) {
            current = { algorithm: compiledFallback, checkedAt: refreshedAt };
            lastKnown = current;
            return compiledFallback;
          }
          if (cause instanceof KisskhError) throw cause;
          throw new KisskhError('provider_unavailable', 'Verification KissKH indisponible', { cause });
        }
      })();
      try {
        return await pendingResolution;
      } finally {
        pendingResolution = null;
      }
    },
  };
}

module.exports = { createBundleRegistry, createPinnedHttpsFetcher };
