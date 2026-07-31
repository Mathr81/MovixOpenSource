// API/Mainapi/utils/hydrackerLive.js
//
// Live raw-URL resolution path used by darkiworldSqlite.decodeLink when both
// the disk cache and the two sqlite snapshots miss. See:
//   docs/superpowers/plans/2026-05-16-hydracker-live-raw-resolution.md

'use strict';

const { randomUUID } = require('node:crypto');

const LOCK_RELEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

function createLimit(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job.fn)
      .then(
        (v) => { active--; job.resolve(v); pump(); },
        (e) => { active--; job.reject(e); pump(); },
      );
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRedisLock(redis, key, ttlSec, work, opts = {}) {
  const waitMs = opts.waitMs ?? 65000;
  const pollMs = opts.pollMs ?? 500;
  const onWaitCheck = opts.onWaitCheck || (async () => null);
  const token = randomUUID();

  let acquired = null;
  try {
    acquired = await redis.set(key, token, 'NX', 'EX', ttlSec);
  } catch (_) {
    // Redis unreachable — fail closed so we don't bypass single-flight and
    // overload upstream during a Redis outage.
    return { owned: false, value: null, redisDown: true };
  }

  if (acquired === 'OK') {
    try {
      const value = await work();
      return { owned: true, value };
    } finally {
      try {
        await redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token);
      } catch (_) { /* swallow */ }
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let cached = null;
    try { cached = await onWaitCheck(); } catch (_) { cached = null; }
    if (cached) return { owned: false, value: cached };
  }
  return { owned: false, value: null, timedOut: true };
}

async function fetchHydrackerLien(lienId, deps) {
  const { axios, limit, cookies, xsrf, timeoutMs } = deps;
  return limit(async () => {
    try {
      const resp = await axios.get(
        `https://hydracker.com/api/v1/content/liens/${lienId}`,
        {
          timeout: timeoutMs,
          headers: {
            accept: 'application/json',
            cookie: cookies || '',
            'x-xsrf-token': xsrf || '',
            'user-agent': 'Mozilla/5.0 (Movix HydrackerLive)',
          },
          validateStatus: (s) => s >= 200 && s < 300,
        },
      );
      const body = resp.data || {};
      const directDL = body.directDL;
      if (!directDL || typeof directDL !== 'string') {
        return { ok: false, code: 'live_no_directdl' };
      }
      return {
        ok: true,
        directDL,
        rawUrl: typeof body.raw_url === 'string' && body.raw_url ? body.raw_url : null,
        taille: body.lien?.taille ?? null,
        created_at: body.lien?.created_at ?? null,
      };
    } catch (e) {
      return {
        ok: false,
        code: 'live_hydracker_error',
        status: e?.response?.status || 0,
      };
    }
  });
}

async function fetchHydrackerTitleLiens(titleId, deps) {
  const { axios, limit, cookies, xsrf, timeoutMs } = deps;
  return limit(async () => {
    try {
      const resp = await axios.get(
        `https://hydracker.com/api/v1/titles/${titleId}/content/liens`,
        {
          params: {
            perPage: 100,
            loader: 'linksdl',
            filters: '',
            paginate: 'preferLengthAware',
          },
          timeout: timeoutMs,
          headers: {
            accept: 'application/json',
            cookie: cookies || '',
            'x-xsrf-token': xsrf || '',
            'user-agent': 'Mozilla/5.0 (Movix HydrackerLive)',
          },
          validateStatus: (s) => s >= 200 && s < 300,
        },
      );
      const rows = Array.isArray(resp.data?.pagination?.data) ? resp.data.pagination.data : [];
      return { ok: true, rows };
    } catch (e) {
      return {
        ok: false,
        code: 'live_hydracker_list_error',
        status: e?.response?.status || 0,
      };
    }
  });
}

function normalizeHydrackerLien(row) {
  if (!row || typeof row.id !== 'number') return null;
  const langs = Array.isArray(row.langues_compact)
    ? row.langues_compact.map((l) => l.name).filter(Boolean).join('/')
    : '';
  const subs = Array.isArray(row.subs_compact)
    ? row.subs_compact.map((s) => s.name).filter(Boolean).join('/')
    : '';
  const hostName = row.host?.name || undefined;
  return {
    id: row.id,
    language: langs || undefined,
    quality: row.qual?.qual || undefined,
    sub: subs || undefined,
    // Frontend uses `provider` as the visible host label, so surface the
    // real host name (1Fichier, Send, ...) instead of a generic tag.
    provider: hostName || 'darkiworld',
    host_id: row.id_host != null ? row.id_host : undefined,
    host_name: hostName,
    host_icon: row.host?.icon || undefined,
    size: row.taille || undefined,
    upload_date: row.created_at || undefined,
    saison: row.saison != null ? row.saison : undefined,
    episode: row.episode != null ? row.episode : undefined,
    full_saison: row.full_saison ? 1 : undefined,
    source: 'hydracker-live',
  };
}

const FAILED_MARKER_TTL_MS = 2 * 60 * 60 * 1000; // 2h — match darkiworldSqlite

function buildFailedMarker(lienId, code, status) {
  return {
    failed: true,
    failedAt: Date.now(),
    id: String(lienId),
    error: 'Lien indisponible',
    debug: code,
    status: status ?? null,
  };
}

function buildSuccessPayload(lienId, raw, hydracker) {
  return {
    success: true,
    id: String(lienId),
    provider: 'hydracker-live',
    embed_url: {
      lien: raw.link,
      taille: raw.size ?? hydracker.taille ?? 0,
      created_at: hydracker.created_at ?? null,
    },
    metadata: {
      language: undefined,
      quality: undefined,
      sub: undefined,
      size: raw.size ?? hydracker.taille ?? undefined,
      upload_date: hydracker.created_at ?? undefined,
      host: raw.host ?? undefined,
      filename: raw.filename ?? undefined,
    },
    source: 'live',
  };
}

function createHydrackerLive(deps) {
  const {
    redis, axios, cookies, xsrf,
    concurrency = 6, timeoutMs = 20000,
    cacheGet, cacheSet, cacheKeyFor, cacheDir,
    hydrackerLienCacheTtl = 60,
    titleListCacheTtl = 300,
    lockTtlSec = 60, lockWaitMs = 65000, lockPollMs = 500,
    upstreamCooldownMs = 5 * 60 * 1000,
  } = deps;

  const limit = createLimit(concurrency);

  // Cluster-wide hydracker upstream cooldown — stored in Redis so a 5xx
  // observed by any worker stops ALL workers from hammering a sick server.
  // Key carries a TTL = upstreamCooldownMs, so it self-expires.
  // Fail-open on Redis errors: a Redis outage must not block live fetches.
  const HYDRACKER_COOLDOWN_KEY = 'hydracker:cooldown:5xx';
  const cooldownTtlSec = Math.max(1, Math.ceil(upstreamCooldownMs / 1000));
  async function isHydrackerInCooldown() {
    try {
      const exists = await redis.exists(HYDRACKER_COOLDOWN_KEY);
      return exists === 1;
    } catch (_) {
      return false;
    }
  }
  async function armHydrackerCooldownIfServerError(status) {
    if (typeof status !== 'number' || status < 500 || status >= 600) {
      return false;
    }
    try {
      // NX so concurrent 5xx responses don't keep resetting the TTL window —
      // first writer wins, the rest are no-ops.
      const armed = await redis.set(
        HYDRACKER_COOLDOWN_KEY,
        String(Date.now()),
        'EX',
        cooldownTtlSec,
        'NX',
      );
      if (armed === 'OK') {
        console.warn(
          `[hydrackerLive] upstream ${status} — cooldown ${Math.round(upstreamCooldownMs / 60000)}min (cluster-wide)`,
        );
      }
    } catch (_) {
      // Redis down — cooldown not armed, but per-worker retry pressure stays
      // low because hydracker itself is still returning 5xx quickly.
    }
    return true;
  }

  async function getCachedHydracker(lienId) {
    try {
      const raw = await redis.get(`hydracker:lien:${lienId}`);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* swallow */ }
    return null;
  }

  async function cacheHydracker(lienId, hyd) {
    try {
      await redis.set(
        `hydracker:lien:${lienId}`,
        JSON.stringify(hyd),
        'EX',
        hydrackerLienCacheTtl,
      );
    } catch (_) { /* swallow */ }
  }

  async function resolveLien(lienId) {
    const key = cacheKeyFor(lienId);
    const lockKey = `lock:hydracker:lien:${lienId}`;
    const enterTime = Date.now();

    const lockResult = await withRedisLock(redis, lockKey, lockTtlSec, async () => {
      // Winner path. Re-check cache in case a previous holder finished
      // between our miss check and lock acquisition.
      // IMPORTANT: only short-circuit on success payloads. Failed markers
      // (especially the legacy `sqlite_miss` one) are precisely why the
      // caller's decodeLink self-heal decided to invoke us; honouring them
      // here would loop the retry back into the same marker and the live
      // fetch would never run.
      const pre = await cacheGet(cacheDir, key);
      if (pre && pre.success === true) return pre;

      // Reuse a recent hydracker response (Redis, hydrackerLienCacheTtl) so
      // we don't re-hit upstream while waiting for AllDebrid history to
      // pick up a freshly-debrided link. Saves rate-limit budget.
      let hyd = await getCachedHydracker(lienId);
      if (!hyd) {
        if (await isHydrackerInCooldown()) {
          // Don't persist marker — cooldown is transient; retry cheap after
          // window ends instead of locking a 2h disk marker.
          return buildFailedMarker(lienId, 'live_hydracker_cooldown', 0);
        }
        hyd = await fetchHydrackerLien(lienId, {
          axios, limit, cookies, xsrf, timeoutMs,
        });
        if (hyd.ok) {
          await cacheHydracker(lienId, hyd);
        } else {
          await armHydrackerCooldownIfServerError(hyd.status);
        }
      }
      if (!hyd.ok) {
        const marker = buildFailedMarker(lienId, hyd.code, hyd.status);
        try { await cacheSet(cacheDir, key, marker); } catch (_) {}
        return marker;
      }

      // hydracker returns the raw host link (1fichier, ...) directly in
      // raw_url/directDL now — no debrid unlock step. directDL is the
      // fallback when raw_url is absent.
      const match = {
        link: hyd.rawUrl || hyd.directDL,
        size: hyd.taille ?? undefined,
        host: undefined,
        filename: undefined,
      };

      const payload = buildSuccessPayload(lienId, match, hyd);
      try { await cacheSet(cacheDir, key, payload); } catch (_) {}
      return payload;
    }, {
      waitMs: lockWaitMs,
      pollMs: lockPollMs,
      onWaitCheck: async () => {
        const c = await cacheGet(cacheDir, key);
        if (!c) return null;
        if (c.success === true) return c;
        // Only honour a failed marker if it was written AFTER we started
        // waiting — otherwise it's a stale pre-existing marker that has
        // nothing to do with the current holder's in-flight work.
        if (c.failed === true && typeof c.failedAt === 'number' && c.failedAt >= enterTime) {
          return c;
        }
        return null;
      },
    });

    if (lockResult.redisDown) {
      return { failed: buildFailedMarker(lienId, 'live_redis_down') };
    }
    if (lockResult.timedOut || !lockResult.value) {
      return { failed: buildFailedMarker(lienId, 'live_lock_timeout') };
    }
    const result = lockResult.value;
    return result.success === true ? { payload: result } : { failed: result };
  }

  async function listLiensForTitle(titleId, opts = {}) {
    const { type, season, episode } = opts;
    const titleNum = Number(titleId);
    if (!Number.isFinite(titleNum) || !Number.isInteger(titleNum) || titleNum <= 0) {
      return [];
    }
    const cacheKey = `hydracker:title:${titleNum}`;

    let rows = null;
    try {
      const raw = await redis.get(cacheKey);
      if (raw) {
        try { rows = JSON.parse(raw); } catch (_) { rows = null; }
      }
    } catch (_) { /* redis down — refetch */ }

    if (!rows) {
      if (await isHydrackerInCooldown()) {
        console.warn(`[hydrackerLive] title list skipped (cooldown active) title=${titleNum}`);
        return [];
      }
      const res = await fetchHydrackerTitleLiens(titleNum, {
        axios, limit, cookies, xsrf, timeoutMs,
      });
      if (!res.ok) {
        await armHydrackerCooldownIfServerError(res.status);
        console.warn(`[hydrackerLive] title list fetch failed title=${titleNum} code=${res.code} status=${res.status ?? '-'}`);
        return [];
      }
      rows = res.rows;
      try {
        await redis.set(cacheKey, JSON.stringify(rows), 'EX', titleListCacheTtl);
      } catch (_) { /* swallow */ }
    }

    let filtered = rows;
    if (type === 'tv') {
      const sNum = Number(season);
      const eNum = Number(episode);
      if (Number.isFinite(sNum) && Number.isFinite(eNum)) {
        filtered = rows.filter((r) =>
          Number(r.saison) === sNum && (Number(r.episode) === eNum || r.full_saison === 1 || r.full_saison === true),
        );
      }
    }
    // For 'movie' (or unspecified) return everything — hydracker stores movies
    // as saison=0/episode=null and the caller already implies that by passing
    // type='movie'.

    return filtered.map(normalizeHydrackerLien).filter(Boolean);
  }

  return { resolveLien, listLiensForTitle };
}

module.exports = {
  createHydrackerLive,
  _createLimit: createLimit,
  _withRedisLock: withRedisLock,
  _fetchHydrackerLien: fetchHydrackerLien,
  _fetchHydrackerTitleLiens: fetchHydrackerTitleLiens,
  _normalizeHydrackerLien: normalizeHydrackerLien,
  _buildSuccessPayload: buildSuccessPayload,
  _buildFailedMarker: buildFailedMarker,
};
