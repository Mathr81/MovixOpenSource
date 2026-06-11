/**
 * Hydracker queue-based decoding orchestrator.
 *
 * /decode/:id at click = cache hit OR SADD queue + 202 (frontend retry).
 * Drain worker in worker process: when queue size >= 50, SPOP 50 atomically,
 * batch POST hydracker, persist results to disk cache, release lock.
 *
 * Cache lives ONLY on disk (DOWNLOAD_CACHE_DIR). Redis carries:
 *   - hydracker:queue:pending  (SET, dedup-safe)
 *   - hydracker:worker_lock    (string, 60s TTL)
 *   - hydracker:rate_limited_until (string, EXPIREAT)
 *
 * See: docs/superpowers/specs/2026-05-01-hydracker-queue-decoding-design.md
 */

const fsp = require('fs').promises;
const path = require('path');

// Redis keys
const QUEUE_KEY = 'hydracker:queue:pending';
const WORKER_LOCK_KEY = 'hydracker:worker_lock';
const RATE_LIMIT_KEY = 'hydracker:rate_limited_until';

// Tunables
// HYDRACKER_BATCHING_ENABLED=false → bypass complet : la route /decode/:id
// utilise decodeRequestSync (POST direct, pas de Redis, pas de queue) et
// le drain timer dans app.js est skip. Comportement identique à l'ancien
// code synchrone, avant l'introduction de la queue.
const BATCHING_ENABLED = process.env.HYDRACKER_BATCHING_ENABLED !== 'false';
const BATCH_SIZE = 50;
const WORKER_LOCK_TTL_SEC = 60;
const FAILED_MARKER_TTL_MS = 2 * 60 * 60 * 1000; // 2h
// Bumped 48h → 7d : un lien déjà en cache reste servi sans refetch pendant
// 7 jours, ce qui réduit la pression sur hydracker pour des contenus stables.
const STALE_REVALIDATE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

async function enqueueId(redis, id) {
  if (!redis) return false;
  const idStr = id == null ? '' : String(id);
  if (!idStr) return false;
  try {
    await redis.sadd(QUEUE_KEY, idStr);
    return true;
  } catch (e) { return false; }
}

async function getQueueSize(redis) {
  if (!redis) return 0;
  try { return await redis.scard(QUEUE_KEY); }
  catch (e) { return 0; }
}

async function popBatch(redis, size) {
  if (!redis) return [];
  try {
    const ids = await redis.spop(QUEUE_KEY, size);
    return Array.isArray(ids) ? ids : [];
  } catch (e) { return []; }
}

async function requeueIds(redis, ids) {
  if (!redis || !Array.isArray(ids) || ids.length === 0) return;
  try { await redis.sadd(QUEUE_KEY, ...ids.map(String)); }
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

async function acquireWorkerLock(redis) {
  if (!redis) return false;
  try {
    const result = await redis.set(WORKER_LOCK_KEY, String(process.pid), 'NX', 'EX', WORKER_LOCK_TTL_SEC);
    return result === 'OK';
  } catch (e) { return false; }
}

async function releaseWorkerLock(redis) {
  if (!redis) return;
  try { await redis.del(WORKER_LOCK_KEY); }
  catch (e) { /* silent */ }
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
// decodeRequest — handles a single /decode/:id click from the route handler.
// Never POSTs upstream; just reads cache or enqueues. Returns:
//   { payload }                          — 200 OK
//   { failed: <marker> }                 — 404
//   { queued: true, queue_size: N }      — 202 (frontend retries)
//   { rateLimited: true, retryAt }       — 503 rate_limited
//   { unavailable: true }               — 503 queue_unavailable (Redis down at enqueue)
// ---------------------------------------------------------------------------

async function decodeRequest(id, deps) {
  const {
    redis,
    cacheDir,
    generateCacheKey,
    getFromCacheNoExpiration
  } = deps;

  // 1. Read disk cache
  const cached = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
  if (cached) {
    if (isFailedMarkerActive(cached.payload)) {
      return { failed: cached.payload };
    }
    if (cached.payload.success === true) {
      // Stale check (STALE_REVALIDATE_MS = 7d) — return immediately, optionally
      // enqueue for refresh. mtimeMs vient de readDiskCache, pas de re-stat.
      const stale = (Date.now() - cached.mtimeMs) >= STALE_REVALIDATE_MS;
      if (stale) {
        // Refresh asynchronously by adding to the queue.
        // No await — fire-and-forget, this is best-effort.
        enqueueId(redis, id).catch(() => {});
      }
      return { payload: cached.payload };
    }
    // Malformed cache — fall through to enqueue
  }

  // 2. Kill-switch check
  if (await isRateLimited(redis)) {
    const retryAt = await getRateLimitedUntil(redis);
    if (retryAt) {
      return { rateLimited: true, retryAt };
    }
    // retryAt unavailable (Redis flake, key just expired) — fall through to enqueue
    // rather than serving an undefined retry hint to the user.
  }

  // 3. Enqueue (or fail fast if Redis is unavailable)
  const enqueued = await enqueueId(redis, id);
  if (!enqueued) {
    // Redis unreachable — caller can't queue, so polling would never succeed.
    // Surface as a 503 with a distinct error code so the frontend can show a
    // clear "infra issue, retry later" message rather than spinning 5 min.
    return { unavailable: true };
  }
  const queue_size = await getQueueSize(redis);
  return { queued: true, queue_size };
}

// ---------------------------------------------------------------------------
// decodeRequestSync — bypass mode (HYDRACKER_BATCHING_ENABLED=false).
// POST hydracker directement pour un ID, pas de Redis, pas de queue.
// Comportement identique à l'ancien code synchrone d'avant la queue.
// Returns:
//   { payload }                          — 200 OK
//   { failed: <marker> }                 — 404
// ---------------------------------------------------------------------------

async function decodeRequestSync(id, deps) {
  const {
    cacheDir,
    generateCacheKey,
    getFromCacheNoExpiration,
    saveToCache,
    axiosDarkinoRequest,
    refreshDarkinoSessionIfNeeded
  } = deps;

  // 1. Read disk cache
  const cached = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
  if (cached) {
    if (isFailedMarkerActive(cached.payload)) {
      return { failed: cached.payload };
    }
    if (cached.payload.success === true) {
      return { payload: cached.payload };
    }
    // Malformed cache — fall through to refetch
  }

  const cacheKey = generateCacheKey(`darkiworld_decode_v2_${id}`);

  try {
    await refreshDarkinoSessionIfNeeded();
    const resp = await axiosDarkinoRequest({
      method: 'post',
      url: `/api/v1/download-premium/${id}`
    });

    const linkInfo = resp.data?.liens?.[0] || null;
    if (!linkInfo) {
      const marker = buildFailedMarker(id, 'Lien non trouvé', 'download-premium response empty');
      await saveToCache(cacheDir, cacheKey, marker).catch(() => {});
      return { failed: marker };
    }

    const payload = buildPayload(id, linkInfo);
    if (!payload) {
      const marker = buildFailedMarker(id, 'Lien d\'embed invalide', 'embed-NN.html shape detected');
      await saveToCache(cacheDir, cacheKey, marker).catch(() => {});
      return { failed: marker };
    }

    await saveToCache(cacheDir, cacheKey, payload).catch(() => {});
    return { payload };

  } catch (err) {
    const marker = buildFailedMarker(id, 'Erreur upstream hydracker', err?.message || String(err));
    // Ne pas écrire de marker si un cache existe déjà — évite de l'empoisonner.
    if (!cached) {
      await saveToCache(cacheDir, cacheKey, marker).catch(() => {});
    }
    return { failed: marker };
  }
}

// ---------------------------------------------------------------------------
// drainQueueOnce — one tick of the drain loop. Returns:
//   { drained: false, reason: 'rate_limited' | 'queue_too_small' | 'lock_taken' }
//   { drained: true,  batchSize: N }
//   { drained: false, error: <msg> }
//
// Caller (timer in every HTTP worker process) invokes this every ~5s; only one worker drains per tick via Redis lock.
// ---------------------------------------------------------------------------

async function drainQueueOnce(deps) {
  const {
    redis,
    cacheDir,
    generateCacheKey,
    getFromCacheNoExpiration,
    saveToCache,
    axiosDarkinoRequest,
    refreshDarkinoSessionIfNeeded
  } = deps;

  // 1. Skip if rate-limited
  if (await isRateLimited(redis)) {
    return { drained: false, reason: 'rate_limited' };
  }

  // 2. Skip if queue too small
  const sizeBefore = await getQueueSize(redis);
  if (sizeBefore < BATCH_SIZE) {
    return { drained: false, reason: 'queue_too_small', queueSize: sizeBefore };
  }

  // 3. Try to acquire worker lock
  const gotLock = await acquireWorkerLock(redis);
  if (!gotLock) return { drained: false, reason: 'lock_taken' };

  let popped = [];
  try {
    // 4. Re-check size after lock (anti-race)
    const sizeAfter = await getQueueSize(redis);
    if (sizeAfter < BATCH_SIZE) {
      return { drained: false, reason: 'queue_too_small', queueSize: sizeAfter };
    }

    // 5. SPOP 50 atomically
    popped = await popBatch(redis, BATCH_SIZE);
    if (popped.length === 0) {
      return { drained: false, reason: 'queue_empty_after_pop' };
    }

    // 6. POST hydracker
    await refreshDarkinoSessionIfNeeded();
    const resp = await axiosDarkinoRequest({
      method: 'post',
      url: `/api/v1/download-premium/${popped.join(',')}`
    });

    // 7. Distribute results to disk cache
    const liens = Array.isArray(resp.data?.liens) ? resp.data.liens : [];
    const byId = new Map();
    for (const li of liens) {
      if (li && li.id != null) byId.set(String(li.id), li);
    }

    for (const id of popped) {
      const cacheKey = generateCacheKey(`darkiworld_decode_v2_${id}`);
      const linkInfo = byId.get(String(id)) || null;

      if (!linkInfo) {
        // Absent from response → write failure marker
        const marker = buildFailedMarker(id, 'Absent de la réponse batch hydracker', '');
        await saveToCache(cacheDir, cacheKey, marker).catch((cacheErr) => {
          console.warn(`[hydracker] failure marker write failed for ${id}:`, cacheErr?.message);
        });
      } else {
        const payload = buildPayload(id, linkInfo);
        if (!payload) {
          // Invalid embed shape → write failure marker (only if no prior cache)
          const existing = await readDiskCache(id, { cacheDir, generateCacheKey, getFromCacheNoExpiration });
          if (!existing) {
            const marker = buildFailedMarker(id, 'Lien d\'embed invalide', 'embed-NN.html shape detected');
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
    }

    return { drained: true, batchSize: popped.length };

  } catch (err) {
    console.warn(`[hydracker] drain failed (popped=${popped.length}):`, err?.message || err);
    // 8. Error handling — requeue popped IDs so nothing is lost
    const rl = parseRateLimitError(err);
    if (rl.isRateLimit) {
      await armRateLimit(redis, rl.resetsAt);
      await requeueIds(redis, popped);
      return { drained: false, reason: 'rate_limited', requeued: popped.length };
    }
    // Other error
    await requeueIds(redis, popped);
    return { drained: false, error: err?.message || String(err), requeued: popped.length };
  } finally {
    await releaseWorkerLock(redis);
  }
}

// ---------------------------------------------------------------------------
// prewarmDecodeCache — call the new hydracker /download endpoint and seed the
// disk decode cache for every entry that carries a direct `lien`. Best-effort:
// silent on failure, never writes a failed marker. Triggered in parallel with
// the existing /content/liens fetch in routes/darkiworld.js (cache miss path).
// ---------------------------------------------------------------------------

async function prewarmDecodeCache({ type, id, season, episode, deps }) {
  const {
    axiosDarkinoRequest,
    refreshDarkinoSessionIfNeeded,
    cacheDir,
    generateCacheKey,
    saveToCache,
    blockedUsers
  } = deps;
  const blocked = blockedUsers instanceof Set ? blockedUsers : new Set();

  try { await refreshDarkinoSessionIfNeeded(); } catch (_) { /* non-fatal */ }

  const url = type === 'movie'
    ? `/api/v1/titles/${id}/download`
    : `/api/v1/titles/${id}/season/${season}/episode/${episode}/download`;

  let resp;
  try {
    resp = await axiosDarkinoRequest({ method: 'get', url });
  } catch (e) {
    console.warn(`[hydracker] prewarm upstream fail ${type}/${id}: ${e?.message || e}`);
    return { warmed: 0, warmedIds: new Set() };
  }

  const entries = [
    resp.data?.video,
    ...(resp.data?.alternative_videos || [])
  ].filter(Boolean);

  const warmedIds = new Set();
  const seen = new Set();
  for (const entry of entries) {
    if (entry.id == null) continue;
    const idKey = String(entry.id);
    if (seen.has(idKey)) continue;
    if (typeof entry.lien !== 'string' || entry.lien.trim() === '') continue;
    if (entry.id_user && blocked.has(entry.id_user)) continue;
    seen.add(idKey);
    const payload = buildPayload(entry.id, entry);
    if (!payload) continue;
    const cacheKey = generateCacheKey(`darkiworld_decode_v2_${entry.id}`);
    await saveToCache(cacheDir, cacheKey, payload).catch(() => {});
    warmedIds.add(idKey);
  }
  return { warmed: warmedIds.size, warmedIds };
}

module.exports = {
  // helpers
  chunk,
  buildPayload,
  buildFailedMarker,
  parseRateLimitError,
  isFailedMarkerActive,
  // Redis primitives
  enqueueId,
  getQueueSize,
  popBatch,
  requeueIds,
  isRateLimited,
  getRateLimitedUntil,
  armRateLimit,
  acquireWorkerLock,
  releaseWorkerLock,
  // orchestrators
  decodeRequest,
  decodeRequestSync,
  drainQueueOnce,
  prewarmDecodeCache,
  // disk cache
  readDiskCache,
  // constants
  QUEUE_KEY,
  WORKER_LOCK_KEY,
  RATE_LIMIT_KEY,
  BATCH_SIZE,
  BATCHING_ENABLED,
  WORKER_LOCK_TTL_SEC,
  FAILED_MARKER_TTL_MS,
  STALE_REVALIDATE_MS
};
