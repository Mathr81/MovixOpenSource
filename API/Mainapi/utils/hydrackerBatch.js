/**
 * Hydracker batch decoding orchestrator (predecode-on-page-load).
 *
 * /decode/:id at click = cache hit OR direct POST single (cache miss fallback).
 * /download/:type/:id triggers predecodePage(entries) in setImmediate after
 * res.json — that batches all uncached IDs of a download page into one upstream
 * POST. Result: most user clicks land on cache hits; the upstream quota is
 * burned ~once per page open instead of once per click.
 *
 * Cache lives ONLY on disk (DOWNLOAD_CACHE_DIR). Redis carries:
 *   - hydracker:lock:{id}              (string, 60s TTL) — single-flight per ID
 *   - hydracker:predecode_lock:{tid}:{S}:{E} (string, 30s TTL) — one worker per page
 *   - hydracker:rate_limited_until     (string, EXPIREAT) — kill-switch quota
 *
 * Pivoted on 2026-05-02 from the queue-based design (cf. spec
 * docs/superpowers/specs/2026-05-01-hydracker-queue-decoding-design.md, now
 * superseded). Kept the pure helpers and Redis primitives from that work; the
 * orchestrators (decodeRequest, drainQueueOnce) were replaced by decodeSingle
 * and predecodePage.
 */

const fsp = require('fs').promises;
const path = require('path');

// Redis keys
const LOCK_KEY = (id) => `hydracker:lock:${id}`;
const PREDECODE_LOCK_KEY = (titleId, season, episode) =>
  `hydracker:predecode_lock:${titleId}:${season || 0}:${episode || 0}`;
const RATE_LIMIT_KEY = 'hydracker:rate_limited_until';

// Tunables
const BATCH_CHUNK_SIZE = 50;            // hydracker accepts up to 50 IDs per POST
const LOCK_TTL_SEC = 60;                // per-ID single-flight lock TTL
const PREDECODE_LOCK_TTL_SEC = 30;      // page-level predecode lock TTL
const FAILED_MARKER_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const STALE_REVALIDATE_MS = 48 * 60 * 60 * 1000; // 48h

// ---------------------------------------------------------------------------
// Pure helpers (no Redis, no fs side-effects)
// ---------------------------------------------------------------------------

function chunk(arr, size) {
  if (!Array.isArray(arr) || size <= 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPayload(id, linkInfo) {
  const rawLien = typeof linkInfo?.lien === 'string' ? linkInfo.lien : '';
  const provider = /darkibox\.com/i.test(rawLien) ? 'darkibox' : 'direct';

  let resolvedUrl;
  if (provider === 'darkibox') {
    const m = rawLien.match(/darkibox\.com\/(?:embed-)?([a-z0-9]{12,})(?:\.html)?/i);
    const code = m ? m[1] : null;
    resolvedUrl = code
      ? `https://darkibox.com/embed-${code}.html`
      : (rawLien || `https://darkibox.com/embed-${id}.html`);
  } else {
    resolvedUrl = rawLien || `https://darkibox.com/embed-${id}.html`;
  }

  // Sparse linkInfo (empty lien AND no taille) → fallback URL is /embed-{id}.html
  // which matches the invalid embed pattern. Return null to signal upstream-failure
  // path to callers — distinguishes truly sparse linkInfo from a real file with
  // empty lien that carries metadata.
  const isInvalidEmbed = /\/embed-\d+\.html$/i.test(resolvedUrl);
  if (isInvalidEmbed && !rawLien && linkInfo?.taille === undefined) {
    return null;
  }

  const embedUrlPayload = linkInfo
    ? { ...linkInfo, lien: resolvedUrl }
    : resolvedUrl;

  return {
    success: true,
    id: String(id),
    provider,
    embed_url: embedUrlPayload,
    metadata: linkInfo ? {
      language: undefined,
      quality: undefined,
      sub: undefined,
      size: linkInfo?.taille,
      upload_date: linkInfo?.created_at
    } : null
  };
}

function buildFailedMarker(id, errorMsg, debugMsg) {
  return {
    failed: true,
    failedAt: Date.now(),
    id: String(id),
    error: errorMsg || 'Lien non trouvé ou inaccessible',
    debug: debugMsg || ''
  };
}

function parseRateLimitError(error) {
  const data = error?.response?.data;
  if (!data || data.error !== 'daily_api_limit_exceeded') {
    return { isRateLimit: false, resetsAt: null };
  }
  const resetsAtIso = data.resets_at;
  const resetsAt = resetsAtIso ? Date.parse(resetsAtIso) : null;
  return { isRateLimit: true, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

function isFailedMarkerActive(payload) {
  return Boolean(
    payload?.failed === true &&
    typeof payload.failedAt === 'number' &&
    (Date.now() - payload.failedAt < FAILED_MARKER_TTL_MS)
  );
}

// ---------------------------------------------------------------------------
// Redis primitives — coordination only, NEVER cache data here.
// All functions tolerate Redis errors silently so the system degrades
// gracefully when Redis is unavailable.
// ---------------------------------------------------------------------------

async function acquireLock(redis, key, ttlSec) {
  if (!redis) return false;
  try {
    const result = await redis.set(key, String(process.pid), 'NX', 'EX', ttlSec);
    return result === 'OK';
  } catch (e) { return false; }
}

async function releaseLock(redis, key) {
  if (!redis) return;
  try { await redis.del(key); }
  catch (e) { /* silent */ }
}

async function isRateLimited(redis) {
  if (!redis) return false;
  try { return Boolean(await redis.exists(RATE_LIMIT_KEY)); }
  catch (e) { return false; }
}

async function getRateLimitedUntil(redis) {
  if (!redis) return null;
  try {
    const v = await redis.get(RATE_LIMIT_KEY);
    return v ? Number(v) : null;
  } catch (e) { return null; }
}

async function armRateLimit(redis, resetsAtMs) {
  if (!redis || !resetsAtMs) return;
  try {
    const ttlSec = Math.max(1, Math.ceil((resetsAtMs - Date.now()) / 1000));
    await redis.set(RATE_LIMIT_KEY, String(resetsAtMs), 'EX', ttlSec);
    console.warn(`[hydracker] daily quota exhausted, kill-switch armed until ${new Date(resetsAtMs).toISOString()}`);
  } catch (e) { /* silent */ }
}

async function readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration }) {
  const cacheKey = generateCacheKey(`darkiworld_decode_v2_${id}`);
  try {
    const payload = await getFromCacheNoExpiration(cacheDir, cacheKey);
    if (!payload) return null;
    const filePath = path.join(cacheDir, `${cacheKey}.json`);
    const stats = await fsp.stat(filePath);
    return { payload, mtimeMs: stats.mtime.getTime(), cacheKey };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// decodeSingle — handles a single /decode/:id click. Cache hit returns 200;
// cache miss does a single POST upstream (small fallback for IDs that the
// predecode missed or that are stale). Returns:
//   { payload }                          — 200 OK
//   { failed: <marker> }                 — 404
//   { rateLimited: true, retryAt }       — 503 rate_limited
// ---------------------------------------------------------------------------

async function decodeSingle(id, deps) {
  const {
    redis,
    cacheDir,
    generateCacheKey,
    getFromCacheNoExpiration,
    shouldUpdateCache48h
  } = deps;

  // 1. Read disk cache
  const cached = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
  if (cached) {
    if (isFailedMarkerActive(cached.payload)) {
      return { failed: cached.payload };
    }
    if (cached.payload.success === true) {
      const stale = await shouldUpdateCache48h(cacheDir, cached.cacheKey);
      if (stale) {
        // Background refresh — gate behind per-id lock so concurrent stale reads
        // from N workers fire only 1 upstream POST instead of N.
        setImmediate(async () => {
          const lockKey = LOCK_KEY(id);
          const gotLock = await acquireLock(redis, lockKey, LOCK_TTL_SEC);
          if (!gotLock) return;
          try {
            await postSingleAndPersist(id, deps);
          } finally {
            await releaseLock(redis, lockKey);
          }
        });
      }
      return { payload: cached.payload };
    }
    // Malformed cache — fall through to refetch
  }

  // 2. Kill-switch
  if (await isRateLimited(redis)) {
    const retryAt = await getRateLimitedUntil(redis);
    if (retryAt) return { rateLimited: true, retryAt };
    // retryAt unavailable — fall through to attempt POST
  }

  // 3. Acquire single-flight lock; if taken, poll cache for the holder's result
  const lockKey = LOCK_KEY(id);
  const gotLock = await acquireLock(redis, lockKey, LOCK_TTL_SEC);
  if (!gotLock) {
    // Another worker (or the predecode batch) is decoding this ID. Poll the
    // disk cache for up to 30s; the holding worker will write the result.
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const recheck = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
      if (recheck) {
        if (isFailedMarkerActive(recheck.payload)) return { failed: recheck.payload };
        if (recheck.payload.success === true) return { payload: recheck.payload };
      }
    }
    // Timeout — fallthrough; lock should have expired by now (60s TTL).
  }

  // 4. POST single upstream
  try {
    return await postSingleAndPersist(id, deps);
  } finally {
    if (gotLock) await releaseLock(redis, lockKey);
  }
}

/**
 * Internal helper — POSTs a single ID upstream, persists the result to disk,
 * returns the decodeSingle result shape. Used by decodeSingle (path 4) and by
 * the SWR background refresh (caller already holds the lock there).
 */
async function postSingleAndPersist(id, deps) {
  const {
    redis,
    cacheDir,
    generateCacheKey,
    getFromCacheNoExpiration,
    saveToCache,
    axiosDarkinoRequest,
    refreshDarkinoSessionIfNeeded
  } = deps;

  const cacheKey = generateCacheKey(`darkiworld_decode_v2_${id}`);

  try {
    await refreshDarkinoSessionIfNeeded();
    const resp = await axiosDarkinoRequest({
      method: 'post',
      url: `/api/v1/download-premium/${id}`
    });

    const linkInfo = resp.data?.liens?.[0] || null;
    const payload = buildPayload(id, linkInfo);

    if (!payload) {
      const marker = buildFailedMarker(id, "Lien d'embed invalide", 'embed-NN.html shape detected');
      const existing = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
      if (!existing) {
        await saveToCache(cacheDir, cacheKey, marker).catch((cacheErr) => {
          console.warn(`[hydracker] failure marker write failed for ${id}:`, cacheErr?.message);
        });
      }
      return { failed: marker };
    }

    await saveToCache(cacheDir, cacheKey, payload).catch((cacheErr) => {
      console.warn(`[hydracker] payload write failed for ${id}:`, cacheErr?.message);
    });
    return { payload };

  } catch (err) {
    const rl = parseRateLimitError(err);
    if (rl.isRateLimit) {
      await armRateLimit(redis, rl.resetsAt);
      return { rateLimited: true, retryAt: rl.resetsAt };
    }
    const marker = buildFailedMarker(id, 'Lien non trouvé ou inaccessible', err?.message || '');
    const existing = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
    if (!existing) {
      await saveToCache(cacheDir, cacheKey, marker).catch((cacheErr) => {
        console.warn(`[hydracker] failure marker write failed for ${id}:`, cacheErr?.message);
      });
    }
    return { failed: marker };
  }
}

// ---------------------------------------------------------------------------
// predecodePage — fire-and-forget batch decoding for a download page.
//
// Called from /download/:type/:id route AFTER res.json() has been sent.
// Errors are logged but never propagate. Designed to be wrapped in
// setImmediate(...) so it never blocks the response.
//
// Skips IDs already in disk cache (success or active failed marker), already
// in-flight (per-id lock taken), or upstream-rate-limited. Reserves the
// remaining IDs via per-id locks, batches them in chunks of 50, POSTs to
// hydracker, distributes results to disk, releases locks.
// ---------------------------------------------------------------------------

async function predecodePage({ entries, titleId, season, episode }, deps) {
  const {
    redis,
    cacheDir,
    generateCacheKey,
    getFromCacheNoExpiration,
    saveToCache,
    shouldUpdateCache48h,
    axiosDarkinoRequest,
    refreshDarkinoSessionIfNeeded
  } = deps;

  if (!Array.isArray(entries) || entries.length === 0) return;
  if (!titleId) return;

  // 1. Page-level lock — prevents 2 workers from pre-decoding the same page
  const pageLockKey = PREDECODE_LOCK_KEY(titleId, season, episode);
  const gotPageLock = await acquireLock(redis, pageLockKey, PREDECODE_LOCK_TTL_SEC);
  if (!gotPageLock) return;

  try {
    // 2. Kill-switch — skip if upstream is rate-limited
    if (await isRateLimited(redis)) return;

    // 3. Filter IDs needing decode + reserve them via per-id locks
    const idsToBatch = [];
    for (const entry of entries) {
      if (!entry || entry.id == null) continue;
      // Skip if entry already has a direct lien (resolved by /content/liens)
      if (typeof entry.lien === 'string' && entry.lien.length > 0) continue;
      // Skip if cache hit AND fresh AND not a failed marker
      const cached = await readDiskCache(entry.id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
      if (cached) {
        if (isFailedMarkerActive(cached.payload)) continue;
        if (cached.payload.success === true) {
          const stale = await shouldUpdateCache48h(cacheDir, cached.cacheKey);
          if (!stale) continue;
          // Stale, include in batch to refresh
        }
      }
      // Reserve via per-id lock
      const got = await acquireLock(redis, LOCK_KEY(entry.id), LOCK_TTL_SEC);
      if (!got) continue; // another worker holds this id
      idsToBatch.push(String(entry.id));
    }

    if (idsToBatch.length === 0) return;

    // 4. Chunked batch POST (50 IDs per POST per upstream limit)
    const chunks = chunk(idsToBatch, BATCH_CHUNK_SIZE);
    for (const ids of chunks) {
      try {
        await refreshDarkinoSessionIfNeeded();
        const resp = await axiosDarkinoRequest({
          method: 'post',
          url: `/api/v1/download-premium/${ids.join(',')}`
        });

        const liens = Array.isArray(resp.data?.liens) ? resp.data.liens : [];
        const byId = new Map();
        for (const li of liens) {
          if (li && li.id != null) byId.set(String(li.id), li);
        }

        for (const id of ids) {
          const linkInfo = byId.get(String(id)) || null;
          const cacheKey = generateCacheKey(`darkiworld_decode_v2_${id}`);

          if (!linkInfo) {
            const marker = buildFailedMarker(id, 'Absent de la réponse batch hydracker', '');
            await saveToCache(cacheDir, cacheKey, marker).catch((cacheErr) => {
              console.warn(`[hydracker] failure marker write failed for ${id}:`, cacheErr?.message);
            });
          } else {
            const payload = buildPayload(id, linkInfo);
            if (!payload) {
              const marker = buildFailedMarker(id, "Lien d'embed invalide", 'embed-NN.html shape detected');
              const existing = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
              if (!existing) {
                await saveToCache(cacheDir, cacheKey, marker).catch((cacheErr) => {
                  console.warn(`[hydracker] failure marker write failed for ${id}:`, cacheErr?.message);
                });
              }
            } else {
              await saveToCache(cacheDir, cacheKey, payload).catch((cacheErr) => {
                console.warn(`[hydracker] payload write failed for ${id}:`, cacheErr?.message);
              });
            }
          }
          await releaseLock(redis, LOCK_KEY(id));
        }
      } catch (err) {
        const rl = parseRateLimitError(err);
        if (rl.isRateLimit) {
          await armRateLimit(redis, rl.resetsAt);
          for (const id of ids) await releaseLock(redis, LOCK_KEY(id));
          return; // skip remaining chunks
        }
        console.warn(`[hydracker] predecode chunk failed (${ids.length} ids):`, err?.message || err);
        for (const id of ids) await releaseLock(redis, LOCK_KEY(id));
        // continue with next chunk
      }
    }
  } finally {
    await releaseLock(redis, pageLockKey);
  }
}

module.exports = {
  // pure helpers
  chunk,
  buildPayload,
  buildFailedMarker,
  parseRateLimitError,
  isFailedMarkerActive,
  // Redis primitives
  acquireLock,
  releaseLock,
  isRateLimited,
  getRateLimitedUntil,
  armRateLimit,
  // disk cache
  readDiskCache,
  // orchestrators
  decodeSingle,
  predecodePage,
  postSingleAndPersist,
  // constants
  LOCK_KEY,
  PREDECODE_LOCK_KEY,
  RATE_LIMIT_KEY,
  BATCH_CHUNK_SIZE,
  LOCK_TTL_SEC,
  PREDECODE_LOCK_TTL_SEC,
  FAILED_MARKER_TTL_MS,
  STALE_REVALIDATE_MS
};
