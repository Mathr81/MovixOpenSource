const fs = require('node:fs');

const POLICY_KEYS = ['version', 'subtitleHosts', 'maxSubtitleBytes'];
const CANONICAL_SUBTITLE_BYTES = 2 * 1024 * 1024;
const RUNTIME_POLICY = Object.freeze({
  version: 1,
  subtitleHosts: Object.freeze(['auto.cdnvideo11.shop', 'sub.cdnvideo11.shop']),
  maxSubtitleBytes: CANONICAL_SUBTITLE_BYTES,
});
const PLACEHOLDER_LABELS = new Set(['example', 'invalid', 'localhost', 'placeholder', 'test']);

function invalidPolicy() {
  return new TypeError('policy KissKH invalide');
}

function isValidHostname(hostname) {
  if (typeof hostname !== 'string' || hostname !== hostname.toLowerCase() || hostname.length > 253) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) return false;
  return !hostname.split('.').some((label) => PLACEHOLDER_LABELS.has(label));
}

function validateFallbackPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPolicy();
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(POLICY_KEYS)) throw invalidPolicy();
  if (value.version !== 1 || value.maxSubtitleBytes !== CANONICAL_SUBTITLE_BYTES) throw invalidPolicy();
  if (!Array.isArray(value.subtitleHosts) || !value.subtitleHosts.length) throw invalidPolicy();
  if (value.subtitleHosts.some((host) => !isValidHostname(host))) throw invalidPolicy();
  const canonical = [...new Set(value.subtitleHosts)].sort();
  if (canonical.length !== value.subtitleHosts.length
      || JSON.stringify(canonical) !== JSON.stringify(value.subtitleHosts)) throw invalidPolicy();
  return Object.freeze({
    version: 1,
    subtitleHosts: Object.freeze([...value.subtitleHosts]),
    maxSubtitleBytes: CANONICAL_SUBTITLE_BYTES,
  });
}

function loadFallbackPolicy(policyPath) {
  if (policyPath === undefined) return RUNTIME_POLICY;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (cause) {
    const error = invalidPolicy();
    error.cause = cause;
    throw error;
  }
  return validateFallbackPolicy(parsed);
}

function parseBoolean(environ, name, fallback = false) {
  const raw = environ[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TypeError(`${name} doit valoir true ou false`);
}

function parsePositiveInteger(environ, name, fallback) {
  const raw = environ[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) throw new TypeError(`${name} invalide`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} invalide`);
  return value;
}

function parseHostList(raw) {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string') throw new TypeError('KISSKH_SUBTITLE_ALLOWED_HOSTS invalide');
  const hosts = raw.split(',');
  if (!hosts.length || hosts.some((host) => host !== host.trim() || !isValidHostname(host))) {
    throw new TypeError('KISSKH_SUBTITLE_ALLOWED_HOSTS invalide');
  }
  const unique = [...new Set(hosts)].sort();
  if (unique.length !== hosts.length) throw new TypeError('KISSKH_SUBTITLE_ALLOWED_HOSTS invalide');
  return unique;
}

function fromEnv(environ) {
  if (!environ || typeof environ !== 'object') throw new TypeError('environnement KissKH invalide');
  const policy = loadFallbackPolicy();
  const enabled = parseBoolean(environ, 'KISSKH_ENABLED');
  const subtitleAllowedHosts = parseHostList(environ.KISSKH_SUBTITLE_ALLOWED_HOSTS);
  const bundleCheckTtlSeconds = parsePositiveInteger(environ, 'KISSKH_BUNDLE_CHECK_TTL_SECONDS', 900);
  const bundleStaleMaxSeconds = parsePositiveInteger(environ, 'KISSKH_BUNDLE_STALE_MAX_SECONDS', 86_400);
  return Object.freeze({
    enabled,
    browserFallbackEnabled: false,
    subtitleAllowedHosts: Object.freeze(subtitleAllowedHosts),
    subtitleMaxBytes: policy.maxSubtitleBytes,
    bundleCheckTtlSeconds,
    bundleStaleMaxSeconds,
  });
}

module.exports = { fromEnv, loadFallbackPolicy, validateFallbackPolicy };
