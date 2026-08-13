/**
 * Download routes module.
 * Extracted from server.js -- handles film/series download link retrieval,
 * m3u8 extraction, Darkibox premium, cache deletion, and anime cache.
 *
 * Mounted at /api  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const { generateCacheKey, ANIME_SAMA_CACHE_DIR, getCacheRefreshInfo } = require('../utils/cacheManager');

// TTL for empty download results ({"sources":[]}) to avoid repeated ~20s m3u8 re-extractions
const EMPTY_RESULT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let DARKINO_MAINTENANCE;
let DARKINOS_CACHE_DIR;
let getFromCacheNoExpiration;
let saveToCache;

/**
 * Inject runtime dependencies that still live in app.js.
 */
function configure(deps) {
  if (deps.DARKINO_MAINTENANCE !== undefined) DARKINO_MAINTENANCE = deps.DARKINO_MAINTENANCE;
  if (deps.DARKINOS_CACHE_DIR) DARKINOS_CACHE_DIR = deps.DARKINOS_CACHE_DIR;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
}

// ---------------------------------------------------------------------------
// Utility functions (were inline in server.js)
// ---------------------------------------------------------------------------

const truncateForLog = (value, maxLength = 240) => {
  if (typeof value !== 'string') return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
};

const buildLogContext = (context = {}) => {
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(' ') : 'no-context';
};

const summarizeErrorForLog = (error) => {
  const responseBody = error?.response?.data;
  return {
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    responseSnippet: typeof responseBody === 'string'
      ? truncateForLog(responseBody, 500)
      : responseBody && typeof responseBody === 'object'
        ? truncateForLog(JSON.stringify(responseBody), 500)
        : undefined
  };
};

const summarizeSourceForLog = (source) => {
  if (!source) return null;
  return {
    src: truncateForLog(source.src),
    language: source.language,
    quality: source.quality,
    sub: source.sub,
    hasM3u8: !!source.m3u8
  };
};

const summarizeSourcesForLog = (sources = [], limit = 5) =>
  sources.slice(0, limit).map(summarizeSourceForLog);

const validateM3u8Url = async (m3u8Url, _useProxy = false, logContext = {}) => {
  if (!m3u8Url) return { isValid: false, quality: null };
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 2000,
      validateStatus: (status) => status === 200,
      decompress: true
    });
    const contentType = response.headers['content-type'];
    const isValidContent = contentType && (
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      contentType.includes('audio/mpegurl') ||
      contentType.includes('text/plain')
    );
    const isValidM3u8 = response.data && typeof response.data === 'string' &&
      (response.data.includes('#EXTM3U') || response.data.includes('#EXT-X-VERSION'));
    const isValid = isValidContent || isValidM3u8;
    let quality = null;
    if (isValid && response.data && typeof response.data === 'string') {
      const content = response.data;
      const resolutionMatch = content.match(/RESOLUTION=(\d+x\d+)/i);
      if (resolutionMatch) {
        const [width, height] = resolutionMatch[1].split('x').map(Number);
        if (width >= 3840 || height >= 2160) quality = '4K';
        else if (width >= 1920 || height >= 1080) quality = '1080p';
        else if (width >= 1280 || height >= 720) quality = '720p';
        else if (width >= 854 || height >= 480) quality = '480p';
        else if (width >= 640 || height >= 360) quality = '360p';
        else quality = `${height}p`;
      } else {
        const qualityMatch = content.match(/(\d+p|4k|hd|sd)/gi);
        if (qualityMatch) {
          const qs = qualityMatch[0].toLowerCase();
          if (qs.includes('4k')) quality = '4K';
          else if (qs.includes('1080p') || qs.includes('hd')) quality = '1080p';
          else if (qs.includes('720p')) quality = '720p';
          else if (qs.includes('480p')) quality = '480p';
          else if (qs.includes('360p')) quality = '360p';
          else quality = qs.toUpperCase();
        }
      }
    }
    return { isValid, quality };
  } catch (_error) {
    return { isValid: false, quality: null };
  }
};

const extractM3u8Url = async (darkiboxUrl, logContext = {}) => {
  let timeoutId;
  try {
    const axiosPromise = axios.get(darkiboxUrl);
    const timeoutPromise = new Promise((_, reject) =>
      { timeoutId = setTimeout(() => reject(new Error('Request timed out (manual)')), 4500); }
    );
    const response = await Promise.race([axiosPromise, timeoutPromise]);
    const htmlContent = response.data;
    const playerConfigMatch = htmlContent.match(/sources:\s*\[\s*{\s*src:\s*"([^"]+)"/);
    if (playerConfigMatch && playerConfigMatch[1]) {
      const m3u8Url = playerConfigMatch[1];
      const validation = await validateM3u8Url(m3u8Url, false, {
        ...logContext,
        sourceUrl: truncateForLog(darkiboxUrl, 160)
      });
      if (validation.isValid) {
        return { url: m3u8Url, quality: validation.quality };
      }
      return null;
    }
    return null;
  } catch (_error) {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const deduplicateSourcesWithPreference = (sources = []) => {
  const normalizeLang = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
  const mergeMissingFields = (main, other) => {
    const merged = { ...main };
    for (const field of ['language', 'quality', 'sub', 'provider', 'm3u8', 'src']) {
      if ((merged[field] === undefined || merged[field] === null || merged[field] === '') && other[field]) {
        merged[field] = other[field];
      }
    }
    return merged;
  };
  const choosePreferred = (current, candidate) => {
    if (!current) return { ...candidate };
    if (!candidate) return { ...current };
    const currentLang = normalizeLang(current.language);
    const candidateLang = normalizeLang(candidate.language);
    let winner = current, loser = candidate;
    if (!current.m3u8 && candidate.m3u8) { winner = candidate; loser = current; }
    else if (current.m3u8 && !candidate.m3u8) { winner = current; loser = candidate; }
    else if (candidateLang === 'multi' && currentLang !== 'multi') { winner = candidate; loser = current; }
    else if (currentLang === 'multi' && candidateLang !== 'multi') { winner = current; loser = candidate; }
    else if (!current.language && candidate.language) { winner = candidate; loser = current; }
    return mergeMissingFields(winner, loser);
  };
  const byKey = new Map();
  for (const source of sources) {
    if (!source) continue;
    const key = source.m3u8 || source.src;
    if (!key) continue;
    byKey.set(key, choosePreferred(byKey.get(key), source));
  }
  return [...byKey.values()];
};

// ===========================================================================
// ROUTES  (mounted at /api, so paths are relative)
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /films/download/:id  -- retrieve download links for a film
// ---------------------------------------------------------------------------
router.get('/films/download/:id', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  try {
    const { id } = req.params;
    const cacheKey = generateCacheKey(`films_download_${id}`);
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

    if (cachedData && cachedData.sources !== undefined) {
      const now = Date.now();
      // Short-circuit: empty result cached recently -- skip ~20s re-extraction
      if (cachedData.emptyResultTimestamp && (now - cachedData.emptyResultTimestamp < EMPTY_RESULT_CACHE_TTL_MS)) {
        return res.status(200).json({ sources: [] });
      }
      const needM3u8Refresh = !cachedData.m3u8Timestamp || (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);
      let sourcesWithM3u8;
      if (!needM3u8Refresh && cachedData.sourcesWithM3u8) {
        sourcesWithM3u8 = cachedData.sourcesWithM3u8;
        const validSources = sourcesWithM3u8.filter(source => source.m3u8);
        if (validSources.length === 0) {
          // Aucun m3u8 valide dans le cache, on force la re-extraction
          sourcesWithM3u8 = await Promise.all(
            cachedData.sources.map(async (source, idx) => {
              const m3u8Result = await extractM3u8Url(source.src);
              if (m3u8Result) {
                return {
                  ...source,
                  m3u8: m3u8Result.url,
                  quality: m3u8Result.quality || source.quality
                };
              }
              return { ...source, m3u8: null };
            })
          );
          const newCacheData = {
            ...cachedData,
            sourcesWithM3u8: sourcesWithM3u8,
            m3u8Timestamp: Date.now()
          };
          if (sourcesWithM3u8.filter(s => s.m3u8).length === 0) {
            newCacheData.emptyResultTimestamp = Date.now();
          } else {
            delete newCacheData.emptyResultTimestamp;
          }
          await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
        }
      } else {
        sourcesWithM3u8 = await Promise.all(
          cachedData.sources.map(async (source, idx) => {
            const m3u8Result = await extractM3u8Url(source.src);
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          })
        );
        const newCacheData = {
          ...cachedData,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: Date.now()
        };
        if (sourcesWithM3u8.filter(s => s.m3u8).length === 0) {
          newCacheData.emptyResultTimestamp = Date.now();
        } else {
          delete newCacheData.emptyResultTimestamp;
        }
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
      }
      const dedupedSources = deduplicateSourcesWithPreference(sourcesWithM3u8);
      // Filtrer les sources avec m3u8: null avant de retourner
      const filteredSources = dedupedSources.filter(source => source.m3u8);
      // Retourner les sources dedupliquees et filtrees
      res.status(200).json({ sources: filteredSources });
      return;
    }
    // Hydracker freeze: no upstream fallback. Cache-only.
    const sources = [];
    const basicSources = sources.map(source => ({
      src: source.src,
      language: source.language,
      quality: source.quality,
      sub: source.sub
    }));

    // Extract and cache m3u8 URLs
    let sourcesWithM3u8 = await Promise.all(
      basicSources.map(async (source, idx) => {
        if (source.m3u8) {
          const validation = await validateM3u8Url(source.m3u8, false);
          if (validation.isValid) {
            return {
              ...source,
              m3u8: source.m3u8,
              quality: validation.quality || source.quality
            };
          } else {
            return { ...source, m3u8: null };
          }
        } else {
          const m3u8Result = await extractM3u8Url(source.src);
          if (m3u8Result) {
            return {
              ...source,
              m3u8: m3u8Result.url,
              quality: m3u8Result.quality || source.quality
            };
          }
          return { ...source, m3u8: null };
        }
      })
    );
    // Retry extraction if no valid sources (up to 2 more times)
    let validSources = sourcesWithM3u8.filter(source => source.m3u8);
    let m3u8RetryCount = 0;
    while (validSources.length === 0 && m3u8RetryCount < 2) {
      m3u8RetryCount++;
      await new Promise(r => setTimeout(r, 500));
      sourcesWithM3u8 = await Promise.all(
        basicSources.map(async (source, idx) => {
          if (source.m3u8) {
            const validation = await validateM3u8Url(source.m3u8, false);
            if (validation.isValid) {
              return {
                ...source,
                m3u8: source.m3u8,
                quality: validation.quality || source.quality
              };
            } else {
              return { ...source, m3u8: null };
            }
          } else {
            const m3u8Result = await extractM3u8Url(source.src);
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          }
        })
      );
      validSources = sourcesWithM3u8.filter(source => source.m3u8);
    }
    const dedupedSources = deduplicateSourcesWithPreference(sourcesWithM3u8);
    // Filtrer les sources avec m3u8: null avant de retourner
    const filteredSources = dedupedSources.filter(source => source.m3u8);
    // Save both the basic sources and the sources with m3u8
    const cacheDataToSave = {
      sources: basicSources,
      sourcesWithM3u8: sourcesWithM3u8,
      m3u8Timestamp: Date.now()
    };
    if (filteredSources.length === 0) {
      cacheDataToSave.emptyResultTimestamp = Date.now();
    }
    await saveToCache(DARKINOS_CACHE_DIR, cacheKey, cacheDataToSave);
    res.status(200).json({ sources: filteredSources });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la recuperation des liens de telechargement' });
  }
});

// ---------------------------------------------------------------------------
// GET /series/download/:titleId/season/:seasonId/episode/:episodeId
// ---------------------------------------------------------------------------
router.get('/series/download/:titleId/season/:seasonId/episode/:episodeId', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  const { titleId, seasonId, episodeId } = req.params;
  const cacheKey = generateCacheKey(`series_download_${titleId}_${seasonId}_${episodeId}`);
  const requestContext = {
    route: 'series_download',
    titleId,
    seasonId,
    episodeId,
    cacheKey
  };
  try {
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000;

    if (cachedData && cachedData.sources !== undefined) {
      const now = Date.now();
      // Short-circuit: empty result cached recently -- skip ~20s re-extraction
      if (cachedData.emptyResultTimestamp && (now - cachedData.emptyResultTimestamp < EMPTY_RESULT_CACHE_TTL_MS)) {
        return res.status(200).json({ sources: [] });
      }
      const needM3u8Refresh = !cachedData.m3u8Timestamp ||
        (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);

      let sourcesWithM3u8;
      let validSources = [];

      if (!needM3u8Refresh && cachedData.sourcesWithM3u8) {
        sourcesWithM3u8 = cachedData.sourcesWithM3u8;
        validSources = sourcesWithM3u8.filter(source => source.m3u8);
      }

      if (needM3u8Refresh || validSources.length === 0) {
        sourcesWithM3u8 = await Promise.all(
          cachedData.sources.map(async (source, sourceIndex) => {
            const m3u8Result = await extractM3u8Url(source.src, {
              ...requestContext,
              phase: 'cache_reextract',
              sourceIndex
            });
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          })
        );

        const newCacheData = {
          ...cachedData,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: Date.now()
        };
        validSources = sourcesWithM3u8.filter(source => source.m3u8);
        if (validSources.length === 0) {
          newCacheData.emptyResultTimestamp = Date.now();
        } else {
          delete newCacheData.emptyResultTimestamp;
        }
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
      }

      const dedupedSources = deduplicateSourcesWithPreference(validSources);
      const filteredSources = dedupedSources.filter(source => source.m3u8);
      const cachedSourceCount = Array.isArray(cachedData.sources) ? cachedData.sources.length : 0;
      const cachedSourcesWithM3u8Count = Array.isArray(cachedData.sourcesWithM3u8) ? cachedData.sourcesWithM3u8.length : 0;
      const cacheRefreshInfo = await getCacheRefreshInfo(DARKINOS_CACHE_DIR, cacheKey);
      const shouldRefreshCacheNow = cacheRefreshInfo.shouldRefreshNow;
      const refreshSummary = shouldRefreshCacheNow
        ? 'refresh possible immediatement'
        : `refresh possible dans ${cacheRefreshInfo.refreshInMinutes} min (${cacheRefreshInfo.refreshAvailableAt})`;
      // If result is empty, we've just saved emptyResultTimestamp above -- return empty and let TTL block retries
      const shouldForceLiveRefetch = false;
      if (!shouldForceLiveRefetch) {
        res.status(200).json({ sources: filteredSources });
        return;
      }
    }
    // Hydracker freeze: no upstream fallback. Cache-only.
    const sources = [];
    const basicSources = sources.map(source => ({
      src: source.src,
      language: source.language,
      quality: source.quality,
      sub: source.sub
    }));
    // Extract and cache m3u8 URLs
    let sourcesWithM3u8 = await Promise.all(
      basicSources.map(async (source, sourceIndex) => {
        if (source.m3u8) {
          const validation = await validateM3u8Url(source.m3u8, false, {
            ...requestContext,
            phase: 'initial_validation',
            sourceIndex
          });
          if (validation.isValid) {
            return {
              ...source,
              m3u8: source.m3u8,
              quality: validation.quality || source.quality
            };
          } else {
            return { ...source, m3u8: null };
          }
        } else {
          const m3u8Result = await extractM3u8Url(source.src, {
            ...requestContext,
            phase: 'initial_extract',
            sourceIndex
          });
          if (m3u8Result) {
            return {
              ...source,
              m3u8: m3u8Result.url,
              quality: m3u8Result.quality || source.quality
            };
          }
          return { ...source, m3u8: null };
        }
      })
    );
    // Retry extraction if no valid sources (up to 2 more times)
    let validSources = sourcesWithM3u8.filter(source => source.m3u8);
    let m3u8RetryCount = 0;
    while (validSources.length === 0 && m3u8RetryCount < 2) {
      m3u8RetryCount++;
      await new Promise(r => setTimeout(r, 500));
      sourcesWithM3u8 = await Promise.all(
        basicSources.map(async (source, sourceIndex) => {
          if (source.m3u8) {
            const validation = await validateM3u8Url(source.m3u8, false, {
              ...requestContext,
              phase: `retry_validation_${m3u8RetryCount}`,
              sourceIndex
            });
            if (validation.isValid) {
              return {
                ...source,
                m3u8: source.m3u8,
                quality: validation.quality || source.quality
              };
            } else {
              return { ...source, m3u8: null };
            }
          } else {
            const m3u8Result = await extractM3u8Url(source.src, {
              ...requestContext,
              phase: `retry_extract_${m3u8RetryCount}`,
              sourceIndex
            });
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          }
        })
      );
      validSources = sourcesWithM3u8.filter(source => source.m3u8);
    }
    // Deduplication des sources par m3u8 (prioritaire) puis src
    const seenM3u8 = new Set();
    const seenSrc = new Set();
    const dedupedSources = [];
    for (const source of sourcesWithM3u8) {
      const key = source.m3u8 || source.src;
      if (!key) continue;
      if (!seenM3u8.has(key)) {
        seenM3u8.add(key);
        dedupedSources.push(source);
      }
    }
    // Deduplication supplementaire sur src
    const finalSources = [];
    for (const source of dedupedSources) {
      if (!seenSrc.has(source.src)) {
        seenSrc.add(source.src);
        finalSources.push(source);
      }
    }
    // Filtrer les sources avec m3u8: null avant de retourner
    const filteredSources = finalSources.filter(source => source.m3u8 !== null);
    // Save both the basic sources and the sources with m3u8
    const cacheDataToSave = {
      sources: basicSources,
      sourcesWithM3u8: sourcesWithM3u8,
      m3u8Timestamp: Date.now()
    };
    if (filteredSources.length === 0) {
      cacheDataToSave.emptyResultTimestamp = Date.now();
    }
    await saveToCache(DARKINOS_CACHE_DIR, cacheKey, cacheDataToSave);
    res.status(200).json({ sources: filteredSources });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la recuperation des liens de telechargement' });
  }
});

// ---------------------------------------------------------------------------
// GET /darkino/download-premium/:id
// ---------------------------------------------------------------------------
router.get('/darkino/download-premium/:id', async (_req, res) => {
  // Hydracker freeze (2026-05-15): upstream decode is disabled.
  res.status(410).json({
    success: false,
    error: 'gone',
    message: 'Decode upstream désactivé. Utilise /api/darkiworld/decode/:id.'
  });
});

// ---------------------------------------------------------------------------
// GET /titles/:id/download  -- FROZEN: returns 410 Gone
// ---------------------------------------------------------------------------
router.get('/titles/:id/download', async (_req, res) => {
  res.status(410).json({
    success: false,
    error: 'gone',
    message: 'Hydracker /titles/{id}/download désactivé. Utilise /api/darkiworld/download/:type/:id.'
  });
});

// ---------------------------------------------------------------------------
// DELETE /films/download/:id/cache  -- delete film download cache
// ---------------------------------------------------------------------------
router.delete('/films/download/:id/cache', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = generateCacheKey(`films_download_${id}`);
    const cacheFile = path.join(DARKINOS_CACHE_DIR, `${cacheKey}.json`);
    await fsp.unlink(cacheFile);
    return res.status(200).json({ success: true, message: `Cache film ${id} supprime.` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Cache introuvable.' });
    }
    console.error('Erreur suppression cache film :', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /series/download/:titleId/season/:seasonId/episode/:episodeId/cache
// ---------------------------------------------------------------------------
router.delete('/series/download/:titleId/season/:seasonId/episode/:episodeId/cache', async (req, res) => {
  try {
    const { titleId, seasonId, episodeId } = req.params;
    const cacheKey = generateCacheKey(`series_download_${titleId}_${seasonId}_${episodeId}`);
    const cacheFile = path.join(DARKINOS_CACHE_DIR, `${cacheKey}.json`);
    await fsp.unlink(cacheFile);
    return res.status(200).json({ success: true, message: `Cache episode ${titleId}/${seasonId}/${episodeId} supprime.` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Cache introuvable.' });
    }
    console.error('Erreur suppression cache episode :', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = router;
module.exports.configure = configure;
