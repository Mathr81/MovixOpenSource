/**
 * Movix Top 10 - Public endpoint
 * Returns the top 10 most watched movies and series by logged-in users
 * Based on aggregated data from wrapped_viewing_data table
 * Uses Redis for caching
 */

const express = require("express");
const router = express.Router();
const { fetchTmdbDetails } = require("./utils/tmdbCache");

const TMDB_API_URL = "https://api.themoviedb.org/3";

let pool = null;
let redis = null;

const CACHE_REFRESH = 1800; // 30 min before background refresh
const CACHE_TTL = 86400; // 24h Redis TTL
const CACHE_PREFIX = "top10:";
const LOCK_PREFIX = `${CACHE_PREFIX}lock:`;
const LOCK_TTL = 120; // seconds
// Anti-stampede : un build lourd peut prendre plusieurs secondes a froid.
// Les requetes concurrentes attendent le resultat du detenteur du lock au lieu
// de relancer le meme agregat SQL en parallele.
const LOCK_WAIT_MS = 15000;
const LOCK_POLL_MS = 250;

// In-memory locks to avoid duplicate background refreshes.
const refreshLocks = new Set();

const TOP10_TYPE_CONFIG = {
  movies: {
    contentType: "movie",
    minDuration: 1200,
    tmdbType: "movie",
    emptyLabel: "Film",
    withEpisodes: false,
  },
  tv: {
    contentType: "tv",
    minDuration: 300,
    tmdbType: "tv",
    emptyLabel: "Serie",
    withEpisodes: true,
  },
  anime: {
    contentType: "anime",
    minDuration: 300,
    tmdbType: "anime",
    emptyLabel: "Anime",
    withEpisodes: true,
  },
};

// Period filter: number of days to look back (null = all time).
const PERIODS = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
  all: null,
};
const DEFAULT_PERIOD = "all";

// Ranking algorithms: whitelisted ORDER BY clauses (never user input directly).
const ALGORITHMS = {
  viewers: "unique_viewers DESC, total_hours DESC",
  hours: "total_hours DESC, unique_viewers DESC",
  sessions: "total_sessions DESC, unique_viewers DESC",
};
const DEFAULT_ALGO = "viewers";

// Returns validated value or null (invalid input).
function parsePeriod(raw) {
  if (raw === undefined) return DEFAULT_PERIOD;
  const period = typeof raw === "string" ? raw.toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(PERIODS, period) ? period : null;
}

function parseAlgo(raw) {
  if (raw === undefined) return DEFAULT_ALGO;
  const algo = typeof raw === "string" ? raw.toLowerCase() : "";
  return ALGORITHMS[algo] ? algo : null;
}

/**
 * Initialize with MySQL pool and Redis instance
 */
function initTop10Routes(mysqlPool, redisInstance) {
  pool = mysqlPool;
  redis = redisInstance || null;
}

/**
 * Redis cache helpers - stale-while-revalidate.
 * Stored shape: { data, updatedAt }
 */
async function cacheGet(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(`${CACHE_PREFIX}${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("[Top10] Redis GET error:", err.message);
    return null;
  }
}

async function cacheSet(key, value) {
  if (!redis) return;
  try {
    const wrapper = { data: value, updatedAt: Date.now() };
    await redis.set(
      `${CACHE_PREFIX}${key}`,
      JSON.stringify(wrapper),
      "EX",
      CACHE_TTL,
    );
  } catch (err) {
    console.warn("[Top10] Redis SET error:", err.message);
  }
}

function isStale(wrapper) {
  if (!wrapper || !wrapper.updatedAt) return true;
  return Date.now() - wrapper.updatedAt > CACHE_REFRESH * 1000;
}

function getTop10TypeConfig(type) {
  return type ? TOP10_TYPE_CONFIG[type] || null : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockStorageKey(key) {
  return `${LOCK_PREFIX}${key}`;
}

function acquireLocalLock(lockKey) {
  if (refreshLocks.has(lockKey)) {
    return null;
  }

  refreshLocks.add(lockKey);
  return { key: lockKey, local: true };
}

async function acquireDistributedLock(key) {
  const lockKey = getLockStorageKey(key);

  if (!redis) {
    return acquireLocalLock(lockKey);
  }

  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  try {
    const result = await redis.set(lockKey, owner, "EX", LOCK_TTL, "NX");
    if (result === "OK") {
      return { key: lockKey, owner, local: false };
    }
    return null;
  } catch (err) {
    console.warn("[Top10] Redis LOCK error:", err.message);
    return acquireLocalLock(lockKey);
  }
}

async function releaseDistributedLock(lock) {
  if (!lock) return;

  if (lock.local) {
    refreshLocks.delete(lock.key);
    return;
  }

  if (!redis) return;

  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lock.key,
      lock.owner,
    );
  } catch (err) {
    console.warn("[Top10] Redis UNLOCK error:", err.message);
  }
}

async function waitForCachedPayload(key, timeoutMs = LOCK_WAIT_MS) {
  if (!redis) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_MS);
    const wrapper = await cacheGet(key);
    if (wrapper && wrapper.data) {
      return wrapper.data;
    }
  }

  return null;
}

async function buildWithCacheLock(key, builder) {
  const lock = await acquireDistributedLock(key);

  if (!lock) {
    const cachedPayload = await waitForCachedPayload(key);
    if (cachedPayload) {
      return cachedPayload;
    }
  }

  try {
    const result = await builder();
    await cacheSet(key, result);
    return result;
  } finally {
    if (lock) {
      await releaseDistributedLock(lock);
    }
  }
}

function scheduleBackgroundRefresh(key, refreshTask) {
  void (async () => {
    const lock = await acquireDistributedLock(key);
    if (!lock) return;

    try {
      await refreshTask();
    } finally {
      await releaseDistributedLock(lock);
    }
  })();
}

/**
 * Fetch TMDB details for enrichment via shared Redis cache.
 */
async function fetchTMDBDetails(contentId, contentType) {
  if (contentType === "live-tv") return null;
  const mediaType = contentType === "anime" ? "tv" : contentType;

  const data = await fetchTmdbDetails(
    TMDB_API_URL,
    process.env.TMDB_API_KEY,
    contentId,
    mediaType,
    "fr-FR",
  );
  if (!data) return null;

  return {
    title: data.title || data.name,
    poster_path: data.poster_path,
    backdrop_path: data.backdrop_path,
    overview: data.overview,
    vote_average: data.vote_average || null,
    genres: (data.genres || []).map((genre) =>
      typeof genre === "string" ? genre : genre.name,
    ),
    release_date: data.release_date || data.first_air_date || null,
    runtime: data.runtime || data.episode_run_time?.[0] || null,
  };
}

async function getTop10Response(
  category,
  period = DEFAULT_PERIOD,
  algo = DEFAULT_ALGO,
) {
  const cacheKey = `${category}:${period}:${algo}`;
  const wrapper = await cacheGet(cacheKey);
  if (wrapper && wrapper.data) {
    if (isStale(wrapper)) {
      scheduleBackgroundRefresh(cacheKey, () =>
        refreshTop10(category, period, algo),
      );
    }
    return wrapper.data;
  }

  return buildWithCacheLock(cacheKey, () =>
    buildTop10ByCategory(category, period, algo),
  );
}

async function buildStatsResult(requestedType, typeConfig, period = DEFAULT_PERIOD) {
  const conditions = ["watch_duration >= ?"];
  const statsParams = [typeConfig ? typeConfig.minDuration : 300];

  if (typeConfig) {
    conditions.unshift("content_type = ?");
    statsParams.unshift(typeConfig.contentType);
  }

  const periodDays = PERIODS[period];
  if (periodDays) {
    conditions.push("created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)");
    statsParams.push(periodDays);
  }

  const statsQuery = `
    SELECT
      COUNT(DISTINCT user_id) AS total_active_users,
      COUNT(DISTINCT content_id) AS total_unique_content,
      ROUND(SUM(watch_duration) / 3600, 0) AS total_hours_watched,
      COUNT(*) AS total_sessions,
      ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
      MIN(created_at) AS data_from,
      MAX(created_at) AS data_to
    FROM wrapped_viewing_data
    WHERE ${conditions.join("\n      AND ")}
  `;

  const [stats] = await pool.execute(statsQuery, statsParams);
  const row = stats[0] || {};

  return {
    success: true,
    type: requestedType || "global",
    period,
    stats: {
      totalActiveUsers: parseInt(row.total_active_users) || 0,
      totalUniqueContent: parseInt(row.total_unique_content) || 0,
      totalHoursWatched: parseInt(row.total_hours_watched) || 0,
      totalSessions: parseInt(row.total_sessions) || 0,
      avgSessionMinutes: parseInt(row.avg_session_minutes) || 0,
      dataFrom: row.data_from ? new Date(row.data_from).toISOString() : null,
      dataTo: row.data_to ? new Date(row.data_to).toISOString() : null,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function getStatsResponse(requestedType, typeConfig, period = DEFAULT_PERIOD) {
  const cacheKey = `stats:${requestedType || "global"}:${period}`;
  const wrapper = await cacheGet(cacheKey);
  if (wrapper && wrapper.data) {
    if (isStale(wrapper)) {
      scheduleBackgroundRefresh(cacheKey, () =>
        refreshStats(requestedType, typeConfig, period),
      );
    }
    return wrapper.data;
  }

  return buildWithCacheLock(cacheKey, () =>
    buildStatsResult(requestedType, typeConfig, period),
  );
}

/**
 * GET /api/top10/movies|tv|anime
 * Public - no auth required
 * Optional query params:
 *   period=day|week|month|year|all (default: all)
 *   algo=viewers|hours|sessions (default: viewers)
 */
for (const category of Object.keys(TOP10_TYPE_CONFIG)) {
  router.get(`/${category}`, async (req, res) => {
    try {
      if (!pool) {
        return res
          .status(503)
          .json({ success: false, error: "Database not available" });
      }

      const period = parsePeriod(req.query.period);
      const algo = parseAlgo(req.query.algo);

      if (!period || !algo) {
        return res.status(400).json({
          success: false,
          error: `Invalid filter. Allowed periods: ${Object.keys(PERIODS).join(", ")}. Allowed algos: ${Object.keys(ALGORITHMS).join(", ")}`,
        });
      }

      const result = await getTop10Response(category, period, algo);
      res.json(result);
    } catch (error) {
      console.error(`[Top10] Error fetching ${category}:`, error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });
}

/**
 * GET /api/top10/overview?type=movies|tv|anime&period=all&algo=viewers
 * Public - returns ranking + stats for one category
 */
router.get("/overview", async (req, res) => {
  try {
    if (!pool) {
      return res
        .status(503)
        .json({ success: false, error: "Database not available" });
    }

    const requestedType =
      typeof req.query.type === "string"
        ? req.query.type.toLowerCase()
        : "movies";
    const typeConfig = getTop10TypeConfig(requestedType);

    if (!typeConfig) {
      return res.status(400).json({
        success: false,
        error: "Invalid type. Allowed values: movies, tv, anime",
      });
    }

    const period = parsePeriod(req.query.period);
    const algo = parseAlgo(req.query.algo);

    if (!period || !algo) {
      return res.status(400).json({
        success: false,
        error: `Invalid filter. Allowed periods: ${Object.keys(PERIODS).join(", ")}. Allowed algos: ${Object.keys(ALGORITHMS).join(", ")}`,
      });
    }

    const [top10Result, statsResult] = await Promise.allSettled([
      getTop10Response(requestedType, period, algo),
      getStatsResponse(requestedType, typeConfig, period),
    ]);

    if (top10Result.status !== "fulfilled") {
      throw top10Result.reason;
    }

    const top10Payload = top10Result.value;
    const statsPayload =
      statsResult.status === "fulfilled" ? statsResult.value : null;

    res.json({
      success: true,
      type: requestedType,
      period,
      algorithm: algo,
      top10: top10Payload.top10,
      stats: statsPayload?.stats || null,
      updatedAt: top10Payload.updatedAt,
      statsUpdatedAt: statsPayload?.updatedAt || null,
    });
  } catch (error) {
    console.error("[Top10] Error fetching overview:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * GET /api/top10/stats
 * Public - global platform stats
 * Optional query params: type=movies|tv|anime, period=day|week|month|year|all
 */
router.get("/stats", async (req, res) => {
  try {
    if (!pool) {
      return res
        .status(503)
        .json({ success: false, error: "Database not available" });
    }

    const requestedType =
      typeof req.query.type === "string" ? req.query.type.toLowerCase() : null;
    const typeConfig = getTop10TypeConfig(requestedType);

    if (requestedType && !typeConfig) {
      return res.status(400).json({
        success: false,
        error: "Invalid type. Allowed values: movies, tv, anime",
      });
    }

    const period = parsePeriod(req.query.period);
    if (!period) {
      return res.status(400).json({
        success: false,
        error: `Invalid period. Allowed values: ${Object.keys(PERIODS).join(", ")}`,
      });
    }

    const result = await getStatsResponse(requestedType, typeConfig, period);
    res.json(result);
  } catch (error) {
    console.error("[Top10] Error fetching stats:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Top 10 builders
// ---------------------------------------------------------------------------

/**
 * Recupere titre + nombre d'episodes vus pour les 10 ids retenus.
 * Requete legere (IN sur 10 ids via idx_content) — permet de garder la requete
 * lourde d'agregation sans content_title, donc couverte par idx_top10.
 */
async function loadContentDetailsMap(config, contentIds, periodDays) {
  if (contentIds.length === 0) {
    return new Map();
  }

  const periodClause = periodDays
    ? " AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)"
    : "";
  const params = [config.contentType, config.minDuration];
  if (periodDays) params.push(periodDays);

  const episodesSelect = config.withEpisodes
    ? "COUNT(DISTINCT CONCAT(IFNULL(season_number, ''), '-', IFNULL(episode_number, ''))) AS episodes_watched"
    : "0 AS episodes_watched";

  const placeholders = contentIds.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `
      SELECT
        content_id,
        MAX(content_title) AS content_title,
        ${episodesSelect}
      FROM wrapped_viewing_data
      WHERE content_type = ?
        AND watch_duration >= ?${periodClause}
        AND content_id IN (${placeholders})
      GROUP BY content_id
    `,
    [...params, ...contentIds],
  );

  return new Map(
    rows.map((row) => [
      String(row.content_id),
      {
        title: row.content_title || null,
        episodesWatched: parseInt(row.episodes_watched) || 0,
      },
    ]),
  );
}

async function buildTop10ByCategory(
  category,
  period = DEFAULT_PERIOD,
  algo = DEFAULT_ALGO,
) {
  const config = getTop10TypeConfig(category);
  if (!config) {
    throw new Error(`Unknown Top10 category: ${category}`);
  }

  const orderBy = ALGORITHMS[algo] || ALGORITHMS[DEFAULT_ALGO];
  const periodDays = PERIODS[period] || null;
  const periodClause = periodDays
    ? " AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)"
    : "";
  const params = [config.contentType, config.minDuration];
  if (periodDays) params.push(periodDays);

  // Volontairement sans content_title : toutes les colonnes referencees sont
  // dans idx_top10 (voir exportscripts/add_top10_index.sql) => scan index-only,
  // pas de lecture de lignes. Titres recuperes ensuite sur les 10 ids retenus.
  const [rows] = await pool.execute(
    `
      SELECT
        content_id,
        COUNT(DISTINCT user_id) AS unique_viewers,
        ROUND(SUM(watch_duration) / 3600, 1) AS total_hours,
        COUNT(*) AS total_sessions,
        ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes
      FROM wrapped_viewing_data
      WHERE content_type = ?
        AND watch_duration >= ?${periodClause}
      GROUP BY content_id
      ORDER BY ${orderBy}
      LIMIT 10
    `,
    params,
  );

  const detailsByContentId = await loadContentDetailsMap(
    config,
    rows.map((row) => row.content_id),
    periodDays,
  );

  const enriched = await Promise.all(
    rows.map(async (row, index) => {
      const tmdb = await fetchTMDBDetails(row.content_id, config.tmdbType);
      const details = detailsByContentId.get(String(row.content_id));
      return {
        rank: index + 1,
        contentId: row.content_id,
        title:
          tmdb?.title ||
          details?.title ||
          `${config.emptyLabel} #${row.content_id}`,
        posterPath: tmdb?.poster_path || null,
        backdropPath: tmdb?.backdrop_path || null,
        overview: tmdb?.overview || null,
        voteAverage: tmdb?.vote_average || null,
        genres: tmdb?.genres || [],
        releaseDate: tmdb?.release_date || null,
        uniqueViewers: parseInt(row.unique_viewers) || 0,
        totalHours: parseFloat(row.total_hours) || 0,
        totalSessions: parseInt(row.total_sessions) || 0,
        avgSessionMinutes: parseInt(row.avg_session_minutes) || 0,
        episodesWatched: config.withEpisodes
          ? details?.episodesWatched || 0
          : undefined,
      };
    }),
  );

  return {
    success: true,
    type: category,
    period,
    algorithm: algo,
    top10: enriched,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Background refresh (stale-while-revalidate)
// ---------------------------------------------------------------------------

async function refreshTop10(category, period = DEFAULT_PERIOD, algo = DEFAULT_ALGO) {
  try {
    const cacheKey = `${category}:${period}:${algo}`;
    const result = await buildTop10ByCategory(category, period, algo);
    await cacheSet(cacheKey, result);
    console.log(`[Top10] Cache ${cacheKey} refreshed in background`);
  } catch (err) {
    console.error(`[Top10] Refresh error for ${category}:`, err.message);
  }
}

async function refreshStats(requestedType, typeConfig, period = DEFAULT_PERIOD) {
  try {
    const cacheKey = `stats:${requestedType || "global"}:${period}`;
    const result = await buildStatsResult(requestedType, typeConfig, period);
    await cacheSet(cacheKey, result);
    console.log(`[Top10] Cache stats ${cacheKey} refreshed in background`);
  } catch (err) {
    console.error("[Top10] Refresh error for stats:", err.message);
  }
}

module.exports = { router, initTop10Routes };
