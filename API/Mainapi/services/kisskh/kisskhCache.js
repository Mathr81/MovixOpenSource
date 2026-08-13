const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const writeFileAtomic = require('write-file-atomic');
const { KisskhError } = require('./errors');

const MATCH_TTL_SECONDS = 86_400;
const EPISODES_TTL_SECONDS = 21_600;
const SENSITIVE_TTL_SECONDS = 600;
const SENSITIVE_MAX_ENTRIES = 256;
const NOT_FOUND_TTL_SECONDS = 900;
const RESOLVE_LOCK_MS = 30_000;
const FALLBACK_TOKEN_TTL_SECONDS = 120;
const CATALOG_TTL_SECONDS = 43_200;
const RESOLUTION_REFRESH_SECONDS = 43_200;
const CATALOG_MAX_ENTRIES = 20_000;
const CATALOG_PROGRESS_TTL_SECONDS = 900;
const CATALOG_PROGRESS_KEY = 'kisskh:catalog:progress:v1';
const RELEASE_LOCK_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('DEL', KEYS[1])",
  'end',
  'return 0',
].join('\n');
const RENEW_LOCK_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('PEXPIRE', KEYS[1], ARGV[2])",
  'end',
  'return 0',
].join('\n');
const GETDEL_SCRIPT = [
  "local value = redis.call('GET', KEYS[1])",
  'if value then',
  "  redis.call('DEL', KEYS[1])",
  'end',
  'return value',
].join('\n');

function unavailable() {
  return new KisskhError('proxy_unavailable', 'Service de lecture indisponible');
}

function securityError() {
  return new KisskhError('provider_security', 'Donnees KissKH non autorisees');
}

function lockContentionError() {
  return new KisskhError('provider_unavailable', 'Resolution KissKH deja en cours', {
    details: { reason: 'lock_contended' },
  });
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} invalide`);
}

function assertMediaType(value) {
  if (!['tv', 'movie'].includes(value)) throw new TypeError('type media KissKH invalide');
  return value;
}

function boundedPositiveInteger(value, fallback, maximum, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${label} invalide`);
  }
  return resolved;
}

function sanitizeMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw securityError();
  assertPositiveInteger(value.tmdbId, 'tmdbId');
  assertPositiveInteger(value.kisskhDramaId, 'kisskhDramaId');
  if (!Number.isSafeInteger(value.season) || value.season < 0) throw securityError();
  const evidence = value.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || !Number.isFinite(evidence.score) || evidence.score < 0 || evidence.score > 1_000
      || typeof evidence.titleSource !== 'string' || !['localized', 'original', 'alternative'].includes(evidence.titleSource)) {
    throw securityError();
  }
  return {
    tmdbId: value.tmdbId,
    kisskhDramaId: value.kisskhDramaId,
    season: value.season,
    episodeOffset: Number.isSafeInteger(value.episodeOffset) ? value.episodeOffset : 0,
    evidence: { score: evidence.score, titleSource: evidence.titleSource },
  };
}

function sanitizeEpisodes(value) {
  if (!Array.isArray(value) || value.length > 1_000) throw securityError();
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw securityError();
    assertPositiveInteger(entry.id, 'episodeId');
    assertPositiveInteger(entry.number, 'episodeNumber');
    if (seen.has(entry.id)) throw securityError();
    seen.add(entry.id);
    return { id: entry.id, number: entry.number };
  });
}

function optionalCatalogString(value, maximum, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000]/.test(value)) {
    throw new KisskhError('provider_security', `Catalogue KissKH ${label} invalide`);
  }
  return value;
}

function sanitizeCatalogItems(value) {
  if (!Array.isArray(value) || !value.length || value.length > CATALOG_MAX_ENTRIES) throw securityError();
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw securityError();
    assertPositiveInteger(entry.id, 'dramaId');
    if (seen.has(entry.id) || typeof entry.title !== 'string'
        || !entry.title.trim() || entry.title.length > 500 || /[\u0000]/.test(entry.title)) throw securityError();
    seen.add(entry.id);
    const item = { id: entry.id, title: entry.title };
    if (Number.isSafeInteger(entry.episodesCount) && entry.episodesCount >= 0) {
      item.episodesCount = entry.episodesCount;
    }
    const label = optionalCatalogString(entry.label, 200, 'label');
    const thumbnail = optionalCatalogString(entry.thumbnail, 2_048, 'thumbnail');
    if (label !== undefined) item.label = label;
    if (thumbnail !== undefined) item.thumbnail = thumbnail;
    return item;
  });
}

function sanitizeCatalogProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'completed,percent,phase,total'
      || !['starting', 'catalog', 'finalizing'].includes(value.phase)
      || !Number.isSafeInteger(value.completed) || value.completed < 0
      || (value.total !== null && (!Number.isSafeInteger(value.total) || value.total <= 0))
      || (value.percent !== null && (!Number.isSafeInteger(value.percent)
        || value.percent < 0 || value.percent > 100))) throw securityError();
  if (value.total === null) {
    if (value.percent !== null || value.completed !== 0) throw securityError();
  } else if (value.completed > value.total
      || value.percent !== Math.floor((value.completed / value.total) * 100)) throw securityError();
  return {
    phase: value.phase,
    completed: value.completed,
    total: value.total,
    percent: value.percent,
  };
}

function sanitizeBundleMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.algorithmVersion !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.algorithmVersion)
      || typeof value.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.bundleSha256)
      || typeof value.moduleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.moduleSha256)) throw securityError();
  return {
    algorithmVersion: value.algorithmVersion,
    bundleSha256: value.bundleSha256,
    moduleSha256: value.moduleSha256,
  };
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createKisskhCache(deps = {}) {
  const redis = deps.redis;
  const now = deps.now || Date.now;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const scheduleInterval = deps.setInterval || setInterval;
  const cancelInterval = deps.clearInterval || clearInterval;
  const matchTtlSeconds = boundedPositiveInteger(
    deps.matchTtlSeconds, MATCH_TTL_SECONDS, MATCH_TTL_SECONDS, 'match TTL KissKH',
  );
  const episodesTtlSeconds = boundedPositiveInteger(
    deps.episodesTtlSeconds, EPISODES_TTL_SECONDS, EPISODES_TTL_SECONDS, 'episodes TTL KissKH',
  );
  const sensitiveTtlSeconds = boundedPositiveInteger(
    deps.sensitiveTtlSeconds, SENSITIVE_TTL_SECONDS, SENSITIVE_TTL_SECONDS, 'episode/sub TTL KissKH',
  );
  const notFoundTtlSeconds = boundedPositiveInteger(
    deps.notFoundTtlSeconds, NOT_FOUND_TTL_SECONDS, NOT_FOUND_TTL_SECONDS, 'not-found TTL KissKH',
  );
  const resolveLockMs = boundedPositiveInteger(
    deps.resolveLockMs, RESOLVE_LOCK_MS, RESOLVE_LOCK_MS, 'lock TTL KissKH',
  );
  const bundleCheckTtlSeconds = boundedPositiveInteger(
    deps.bundleCheckTtlSeconds, 900, 900, 'bundle check TTL KissKH',
  );
  const bundleStaleMaxSeconds = boundedPositiveInteger(
    deps.bundleStaleMaxSeconds, 86_400, 86_400, 'bundle stale TTL KissKH',
  );
  const diskCacheDir = deps.cacheDir;
  if (diskCacheDir !== undefined && (
    typeof diskCacheDir !== 'string' || !path.isAbsolute(diskCacheDir)
  )) throw new TypeError('dossier cache KissKH invalide');
  if (typeof now !== 'function' || typeof randomBytes !== 'function'
      || typeof scheduleInterval !== 'function' || typeof cancelInterval !== 'function') {
    throw new TypeError('cache KissKH invalide');
  }
  const sensitive = new Map();
  const resolutions = new Map();
  const inFlight = new Map();
  let catalogSnapshot = null;
  let catalogProgress = null;
  let catalogProgressLocalOnly = false;

  function sensitiveKey(kind, episodeId) {
    return `${kind}:${episodeId}`;
  }

  function sensitiveFile(kind, episodeId) {
    return diskCacheDir ? path.join(diskCacheDir, `${kind}-${episodeId}.json`) : null;
  }

  function resolutionKey(mediaType, tmdbId, season, episode) {
    assertMediaType(mediaType);
    assertPositiveInteger(tmdbId, 'tmdbId');
    if (!Number.isSafeInteger(season) || season < 0) throw new TypeError('season invalide');
    assertPositiveInteger(episode, 'episode');
    return `${mediaType}:${tmdbId}:${season}:${episode}`;
  }

  function resolutionFile(mediaType, tmdbId, season, episode) {
    return diskCacheDir ? path.join(diskCacheDir, `${mediaType}-${tmdbId}-${season}-${episode}.json`) : null;
  }

  function rememberSensitive(key, value, expiresAt) {
    sensitive.delete(key);
    sensitive.set(key, { value, expiresAt });
    while (sensitive.size > SENSITIVE_MAX_ENTRIES) sensitive.delete(sensitive.keys().next().value);
  }

  function rememberResolution(key, value, expiresAt) {
    resolutions.delete(key);
    resolutions.set(key, { value, expiresAt });
    while (resolutions.size > SENSITIVE_MAX_ENTRIES) resolutions.delete(resolutions.keys().next().value);
  }

  async function readJson(key) {
    if (typeof redis?.get !== 'function') return null;
    try {
      return parseJson(await redis.get(key));
    } catch {
      return null;
    }
  }

  async function writeJson(key, value, ttlSeconds) {
    if (typeof redis?.set !== 'function') return false;
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    } catch {
      // Provider resolution may continue with process-local single-flight.
      return false;
    }
  }

  async function withDistributedLock(key, operation, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((name) => !['lockMs', 'renewEveryMs'].includes(name))) {
      throw new TypeError('options lock KissKH invalides');
    }
    const lockMs = boundedPositiveInteger(
      options.lockMs, resolveLockMs, 1_800_000, 'lock TTL KissKH',
    );
    const renewEveryMs = boundedPositiveInteger(
      options.renewEveryMs, Math.max(1, Math.floor(lockMs / 3)), lockMs, 'lock renewal KissKH',
    );
    const noLockLease = Object.freeze({ async assertOwned() {} });
    if (typeof redis?.set !== 'function') return operation(noLockLease);
    const token = randomBytes(32).toString('base64url');
    let acquired;
    try {
      acquired = await redis.set(key, token, 'PX', lockMs, 'NX');
    } catch {
      return operation(noLockLease);
    }
    if (acquired !== 'OK') {
      throw lockContentionError();
    }
    const evaluateRedisScript = redis?.['eval']?.bind(redis);
    let renewal = Promise.resolve();
    const renewLease = async () => {
      if (typeof evaluateRedisScript !== 'function') return true;
      try {
        return await evaluateRedisScript(RENEW_LOCK_SCRIPT, 1, key, token, lockMs) === 1;
      } catch {
        return false;
      }
    };
    const lease = Object.freeze({
      async assertOwned() {
        if (!await renewLease()) throw lockContentionError();
      },
    });
    const heartbeat = typeof evaluateRedisScript === 'function'
      ? scheduleInterval(() => {
        renewal = renewal.then(renewLease, renewLease);
        return renewal;
      }, renewEveryMs)
      : null;
    heartbeat?.unref?.();
    try {
      return await operation(lease);
    } finally {
      if (heartbeat !== null) cancelInterval(heartbeat);
      await renewal.catch(() => {});
      if (typeof evaluateRedisScript === 'function') {
        try {
          await evaluateRedisScript(RELEASE_LOCK_SCRIPT, 1, key, token);
        } catch {
          // Expiry remains the only safe fallback; never delete another owner's lock.
        }
      }
    }
  }

  return Object.freeze({
    async getResolution(mediaType, tmdbId, season, episode, options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)
          || Object.keys(options).some((name) => name !== 'allowStale')
          || (options.allowStale !== undefined && typeof options.allowStale !== 'boolean')) {
        throw new TypeError('options resolution KissKH invalides');
      }
      const allowStale = options.allowStale === true;
      const key = resolutionKey(mediaType, tmdbId, season, episode);
      const entry = resolutions.get(key);
      if (entry && (now() < entry.expiresAt || allowStale)) {
        rememberResolution(key, entry.value, entry.expiresAt);
        return entry.value;
      }
      resolutions.delete(key);
      const file = resolutionFile(mediaType, tmdbId, season, episode);
      if (!file) return null;
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!parsed || !Number.isSafeInteger(parsed.expiresAt) || !Object.hasOwn(parsed, 'value')) {
          await fsp.unlink(file).catch(() => {});
          return null;
        }
        if (now() >= parsed.expiresAt && !allowStale) return null;
        rememberResolution(key, parsed.value, parsed.expiresAt);
        return parsed.value;
      } catch (error) {
        if (error?.code !== 'ENOENT') await fsp.unlink(file).catch(() => {});
        return null;
      }
    },
    async setResolution(mediaType, tmdbId, season, episode, value) {
      const key = resolutionKey(mediaType, tmdbId, season, episode);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw securityError();
      const expiresAt = now() + (RESOLUTION_REFRESH_SECONDS * 1000);
      rememberResolution(key, value, expiresAt);
      const file = resolutionFile(mediaType, tmdbId, season, episode);
      if (!file) return;
      try {
        await fsp.mkdir(diskCacheDir, { recursive: true });
        await writeFileAtomic(file, JSON.stringify({ expiresAt, value }), { encoding: 'utf8', fsync: false });
      } catch {
        // Le cache disque est une optimisation et ne bloque jamais la resolution.
      }
    },
    async getMatch(mediaType, tmdbId, season) {
      assertMediaType(mediaType);
      assertPositiveInteger(tmdbId, 'tmdbId');
      if (!Number.isSafeInteger(season) || season < 0) throw new TypeError('season invalide');
      const value = await readJson(`kisskh:match:v2:${mediaType}:${tmdbId}:${season}`)
        || await readJson(`kisskh:match:v1:${mediaType}:${tmdbId}`);
      try {
        const sanitized = value ? sanitizeMatch(value) : null;
        return sanitized?.season === season ? sanitized : null;
      } catch { return null; }
    },
    async setMatch(mediaType, tmdbId, season, value) {
      assertMediaType(mediaType);
      assertPositiveInteger(tmdbId, 'tmdbId');
      const sanitized = sanitizeMatch(value);
      if (sanitized.tmdbId !== tmdbId || sanitized.season !== season) throw securityError();
      await Promise.all([
        writeJson(`kisskh:match:v2:${mediaType}:${tmdbId}:${season}`, sanitized, matchTtlSeconds),
        writeJson(`kisskh:match:v1:${mediaType}:${tmdbId}`, sanitized, matchTtlSeconds),
      ]);
      return sanitized;
    },
    async getCatalogSnapshot(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)
          || Object.keys(options).some((key) => key !== 'allowStale')
          || (options.allowStale !== undefined && typeof options.allowStale !== 'boolean')) {
        throw new TypeError('options catalogue KissKH invalides');
      }
      const allowStale = options.allowStale === true;
      let snapshot = catalogSnapshot;
      const file = diskCacheDir ? path.join(diskCacheDir, 'catalog-v1.json') : null;
      if (!snapshot && file) {
        try {
          const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
          snapshot = {
            version: parsed?.version,
            refreshedAt: parsed?.refreshedAt,
            items: sanitizeCatalogItems(parsed?.items),
          };
          if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.refreshedAt)
              || snapshot.refreshedAt < 0 || snapshot.refreshedAt > now()) throw securityError();
          catalogSnapshot = snapshot;
        } catch (error) {
          if (error?.code !== 'ENOENT') await fsp.unlink(file).catch(() => {});
          return null;
        }
      }
      if (!snapshot) return null;
      if (!allowStale && now() - snapshot.refreshedAt >= CATALOG_TTL_SECONDS * 1000) return null;
      return { refreshedAt: snapshot.refreshedAt, items: snapshot.items.map((item) => ({ ...item })) };
    },
    async setCatalogSnapshot(items) {
      const sanitized = sanitizeCatalogItems(items);
      const snapshot = { version: 1, refreshedAt: now(), items: sanitized };
      const file = diskCacheDir ? path.join(diskCacheDir, 'catalog-v1.json') : null;
      if (file) {
        await fsp.mkdir(diskCacheDir, { recursive: true });
        await writeFileAtomic(file, JSON.stringify(snapshot), { encoding: 'utf8', fsync: false });
      }
      catalogSnapshot = snapshot;
      return { refreshedAt: snapshot.refreshedAt, items: sanitized.map((item) => ({ ...item })) };
    },
    async getCatalogProgress() {
      if (typeof redis?.get === 'function') {
        try {
          const value = parseJson(await redis.get(CATALOG_PROGRESS_KEY));
          if (!value) {
            return catalogProgressLocalOnly && catalogProgress ? { ...catalogProgress } : null;
          }
          catalogProgress = sanitizeCatalogProgress(value);
          catalogProgressLocalOnly = false;
          return { ...catalogProgress };
        } catch {
          return catalogProgress ? { ...catalogProgress } : null;
        }
      }
      return catalogProgress ? { ...catalogProgress } : null;
    },
    async setCatalogProgress(value) {
      const sanitized = sanitizeCatalogProgress(value);
      catalogProgress = sanitized;
      catalogProgressLocalOnly = !await writeJson(
        CATALOG_PROGRESS_KEY,
        sanitized,
        CATALOG_PROGRESS_TTL_SECONDS,
      );
      return { ...sanitized };
    },
    async clearCatalogProgress() {
      catalogProgress = null;
      catalogProgressLocalOnly = false;
      if (typeof redis?.del === 'function') {
        try { await redis.del(CATALOG_PROGRESS_KEY); } catch {
          // La progression expire rapidement si Redis est momentanement indisponible.
        }
      }
    },
    async getEpisodes(dramaId) {
      assertPositiveInteger(dramaId, 'dramaId');
      const value = await readJson(`kisskh:episodes:v2:${dramaId}`);
      try { return value ? sanitizeEpisodes(value) : null; } catch { return null; }
    },
    async setEpisodes(dramaId, value) {
      assertPositiveInteger(dramaId, 'dramaId');
      const sanitized = sanitizeEpisodes(value);
      await writeJson(`kisskh:episodes:v2:${dramaId}`, sanitized, episodesTtlSeconds);
      return sanitized;
    },
    async getCurrentBundleMetadata() {
      const value = await readJson('kisskh:bundle:current');
      if (!value || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0) return null;
      const checkedAt = now();
      if (value.checkedAt > checkedAt
          || checkedAt - value.checkedAt >= bundleCheckTtlSeconds * 1000) return null;
      try {
        return { ...sanitizeBundleMetadata(value), checkedAt: value.checkedAt };
      } catch {
        return null;
      }
    },
    async recordBundleMetadata(value) {
      const sanitized = sanitizeBundleMetadata(value);
      const record = { ...sanitized, checkedAt: now() };
      if (typeof redis?.set !== 'function') return record;
      const serialized = JSON.stringify(record);
      try {
        await redis.set('kisskh:bundle:current', serialized, 'EX', bundleCheckTtlSeconds);
        const existing = parseJson(await redis.get?.('kisskh:bundle:last-known'));
        const same = existing && existing.algorithmVersion === sanitized.algorithmVersion
          && existing.bundleSha256 === sanitized.bundleSha256
          && existing.moduleSha256 === sanitized.moduleSha256;
        if (!same) await redis.set('kisskh:bundle:last-known', serialized, 'EX', bundleStaleMaxSeconds);
      } catch {
        // Bundle trust remains enforced by the in-process approved registry.
      }
      return record;
    },
    async getSensitive(kind, episodeId) {
      if (!['episode', 'sub'].includes(kind)) throw new TypeError('cache sensible KissKH invalide');
      assertPositiveInteger(episodeId, 'episodeId');
      const key = sensitiveKey(kind, episodeId);
      const entry = sensitive.get(key);
      if (entry) {
        if (now() >= entry.expiresAt) {
          sensitive.delete(key);
        } else {
          rememberSensitive(key, entry.value, entry.expiresAt);
          return entry.value;
        }
      }

      const file = sensitiveFile(kind, episodeId);
      if (!file) return null;
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || !Number.isSafeInteger(parsed.expiresAt) || now() >= parsed.expiresAt
            || !Object.hasOwn(parsed, 'value')) {
          await fsp.unlink(file).catch(() => {});
          return null;
        }
        rememberSensitive(key, parsed.value, parsed.expiresAt);
        return parsed.value;
      } catch (error) {
        if (error?.code !== 'ENOENT') await fsp.unlink(file).catch(() => {});
        return null;
      }
    },
    async setSensitive(kind, episodeId, value) {
      if (!['episode', 'sub'].includes(kind)) throw new TypeError('cache sensible KissKH invalide');
      assertPositiveInteger(episodeId, 'episodeId');
      const key = sensitiveKey(kind, episodeId);
      const expiresAt = now() + (sensitiveTtlSeconds * 1000);
      rememberSensitive(key, value, expiresAt);

      const file = sensitiveFile(kind, episodeId);
      if (!file) return;
      try {
        await fsp.mkdir(diskCacheDir, { recursive: true });
        await writeFileAtomic(file, JSON.stringify({ expiresAt, value }), {
          encoding: 'utf8',
          fsync: false,
        });
      } catch {
        // Le cache disque accélère les requêtes suivantes mais ne bloque jamais la résolution.
      }
    },
    async getNotFound(mediaType, tmdbId, season, episode) {
      const key = `kisskh:not-found:v4:${assertMediaType(mediaType)}:${tmdbId}:${season}:${episode}`;
      if (typeof redis?.get !== 'function') return null;
      try {
        const code = await redis.get(key);
        return ['not_found', 'episode_missing'].includes(code) ? code : null;
      } catch {
        return null;
      }
    },
    async setNotFound(mediaType, tmdbId, season, episode, code) {
      assertMediaType(mediaType);
      if (!['not_found', 'episode_missing'].includes(code)) throw new TypeError('code not-found KissKH invalide');
      if (typeof redis?.set === 'function') {
        try {
          await redis.set(`kisskh:not-found:v4:${mediaType}:${tmdbId}:${season}:${episode}`, code, 'EX', notFoundTtlSeconds);
        } catch {
          // Negative caching is optional when Redis is unavailable.
        }
      }
    },
    singleFlight(key, operation, options = {}) {
      if (typeof key !== 'string' || !key || typeof operation !== 'function') {
        return Promise.reject(new TypeError('single-flight KissKH invalide'));
      }
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise = withDistributedLock(key, operation, options);
      inFlight.set(key, promise);
      promise.finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      }).catch(() => {});
      return promise;
    },
  });
}

function validateProviderOrigin(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new TypeError('origine provider KissKH invalide');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('origine provider KissKH invalide'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') throw new TypeError('origine provider KissKH invalide');
  return url.origin;
}

function validateMediaCapabilityUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8_192 || /[\r\n]/.test(value)) throw securityError();
  let url;
  try { url = new URL(value); } catch { throw securityError(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw securityError();
  }
  return url.href;
}

function validateRequiredHeaders(value, providerOrigin) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw securityError();
  const entries = Object.entries(value);
  if (entries.length > 2) throw securityError();
  const normalized = {};
  for (const [name, headerValue] of entries) {
    if (!['Referer', 'Origin'].includes(name) || typeof headerValue !== 'string'
        || !headerValue || headerValue.length > 2_048 || /[\r\n\0]/.test(headerValue)) throw securityError();
    if (name === 'Origin' && headerValue !== providerOrigin) throw securityError();
    if (name === 'Referer') {
      let referer;
      try { referer = new URL(headerValue); } catch { throw securityError(); }
      if (referer.origin !== providerOrigin || referer.protocol !== 'https:'
          || (referer.port && referer.port !== '443') || referer.username || referer.password || referer.hash) {
        throw securityError();
      }
    }
    normalized[name] = headerValue;
  }
  return normalized;
}

function createFallbackCapabilityStore(deps = {}) {
  const redis = deps.redis;
  const now = deps.now || Date.now;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const providerOrigin = validateProviderOrigin(deps.providerBaseUrl || 'https://kisskh.nl');
  const fallbackTokenTtlSeconds = boundedPositiveInteger(
    deps.fallbackTokenTtlSeconds,
    FALLBACK_TOKEN_TTL_SECONDS,
    FALLBACK_TOKEN_TTL_SECONDS,
    'fallback token TTL KissKH',
  );
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('capability store KissKH invalide');

  async function atomicConsume(key) {
    if (typeof redis?.getdel === 'function') return redis.getdel(key);
    const evaluateRedisScript = redis?.['eval']?.bind(redis);
    if (typeof evaluateRedisScript === 'function') return evaluateRedisScript(GETDEL_SCRIPT, 1, key);
    throw unavailable();
  }

  return Object.freeze({
    async create({ url, requiredHeaders }) {
      const normalizedUrl = validateMediaCapabilityUrl(url);
      const normalizedHeaders = validateRequiredHeaders(requiredHeaders || {}, providerOrigin);
      if (typeof redis?.set !== 'function') throw unavailable();
      const expiresAt = now() + (fallbackTokenTtlSeconds * 1000);
      const record = JSON.stringify({ url: normalizedUrl, expiresAt, requiredHeaders: normalizedHeaders });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const bytes = randomBytes(32);
        if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw unavailable();
        const token = bytes.toString('base64url');
        const digest = crypto.createHash('sha256').update(token).digest('hex');
        let result;
        try {
          result = await redis.set(`kisskh:fallback:v1:${digest}`, record, 'EX', fallbackTokenTtlSeconds, 'NX');
        } catch {
          throw unavailable();
        }
        if (result === 'OK') return token;
      }
      throw unavailable();
    },
    async consume(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(token)) return null;
      const digest = crypto.createHash('sha256').update(token).digest('hex');
      let serialized;
      try {
        serialized = await atomicConsume(`kisskh:fallback:v1:${digest}`);
      } catch (error) {
        if (error instanceof KisskhError) throw error;
        throw unavailable();
      }
      const parsed = parseJson(serialized);
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'expiresAt,requiredHeaders,url'
          || !Number.isSafeInteger(parsed.expiresAt) || now() >= parsed.expiresAt) return null;
      try {
        return {
          url: validateMediaCapabilityUrl(parsed.url),
          expiresAt: parsed.expiresAt,
          requiredHeaders: validateRequiredHeaders(parsed.requiredHeaders, providerOrigin),
        };
      } catch {
        return null;
      }
    },
  });
}

function createFallbackDescriptorValidator(deps = {}) {
  const providerOrigin = validateProviderOrigin(deps.providerBaseUrl || 'https://kisskh.nl');
  const now = deps.now || Date.now;
  if (typeof now !== 'function') throw new TypeError('horloge capability KissKH invalide');
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'expiresAt,requiredHeaders,url'
        || !Number.isSafeInteger(value.expiresAt) || now() >= value.expiresAt) throw securityError();
    return {
      url: validateMediaCapabilityUrl(value.url),
      expiresAt: value.expiresAt,
      requiredHeaders: validateRequiredHeaders(value.requiredHeaders, providerOrigin),
    };
  };
}

module.exports = {
  assertMediaType,
  createFallbackDescriptorValidator,
  createFallbackCapabilityStore,
  createKisskhCache,
};
