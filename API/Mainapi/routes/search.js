/**
 * Search routes module.
 * Handles Darkino search with caching.
 *
 * Mounted at /  (paths below include their full prefix).
 */

const express = require('express');
const router = express.Router();
const { generateCacheKey } = require('../utils/cacheManager');

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let DARKINO_MAINTENANCE;
let DARKINOS_CACHE_DIR;
let axiosDarkinoRequest;
let getFromCacheNoExpiration;
let saveToCache;
let touchCacheEntry;
let shouldUpdateCache;

function isEmptySearchResponse(data) {
  return !Array.isArray(data?.results) || data.results.length === 0;
}

function ensureValidSearchPayload(data) {
  if (typeof data === 'string' && data.includes('Maintenance en cours')) {
    throw new Error('Maintenance en cours - donnees invalides');
  }

  if (typeof data === 'string' || data === null || data === undefined) {
    throw new Error('Reponse invalide - donnees non-JSON');
  }

  return data;
}

function getTitlesResults(data) {
  return Array.isArray(data?.pagination?.data) ? data.pagination.data : [];
}

function getAddableContentResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.pagination?.data)) return data.pagination.data;
  return [];
}

function getResultMergeKey(item, index) {
  if (item?.model_type && item?.id !== undefined && item?.id !== null) {
    return `${item.model_type}:${item.id}`;
  }

  if (item?.type && item?.tmdb_id !== undefined && item?.tmdb_id !== null) {
    return `${item.type}:tmdb:${item.tmdb_id}`;
  }

  if (item?.imdb_id) {
    return `imdb:${item.imdb_id}`;
  }

  if (item?.name) {
    return `name:${String(item.name).trim().toLowerCase()}`;
  }

  return `index:${index}`;
}

function mergeResults(...resultLists) {
  const merged = [];
  const seen = new Set();

  for (const list of resultLists) {
    const results = Array.isArray(list) ? list : [];

    results.forEach((item, index) => {
      const key = getResultMergeKey(item, merged.length + index);
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      merged.push(item);
    });
  }

  return merged;
}

function buildMergedSearchResponse(title, searchData, titlesData, addableCategory15Results, addableCategory2Results) {
  return {
    results: mergeResults(
      searchData?.results,
      getTitlesResults(titlesData),
      addableCategory15Results,
      addableCategory2Results
    ),
    query: searchData?.query || title,
    loader: searchData?.loader || 'searchPage',
    seo: searchData?.seo ?? titlesData?.seo ?? null
  };
}

async function fetchAddableContent(title, category) {
  try {
    const response = await axiosDarkinoRequest({
      method: 'get',
      url: '/api/v1/channel/search-for-addable-content',
      params: { query: title, category }
    });

    return getAddableContentResults(ensureValidSearchPayload(response.data));
  } catch (_) {
    return null;
  }
}

// Garde-fou : si TOUTES les requêtes upstream traînent, on coupe pour éviter
// que /api/search reste pending côté frontend. Chaque axios a son propre
// timeout 5s, mais si plusieurs proxies retry-loop, l'agrégat peut dépasser.
const SEARCH_UPSTREAM_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms))
  ]);
}

async function fetchMergedSearchData(title) {
  let searchData = null;
  let titlesData = null;
  let addableCategory15Results = null;
  let addableCategory2Results = null;
  let searchError = null;
  let titlesError = null;

  const [searchResult, titlesResult, addable15Result, addable2Result] = await Promise.allSettled([
    withTimeout(axiosDarkinoRequest({
      method: 'get',
      url: `/api/v1/search/${encodeURIComponent(title)}`,
      params: { loader: 'searchPage' }
    }), SEARCH_UPSTREAM_TIMEOUT_MS, 'search'),
    withTimeout(axiosDarkinoRequest({
      method: 'get',
      url: '/api/v1/titles',
      params: { perPage: 15, query: title }
    }), SEARCH_UPSTREAM_TIMEOUT_MS, 'titles'),
    withTimeout(fetchAddableContent(title, 15), SEARCH_UPSTREAM_TIMEOUT_MS, 'addable15'),
    withTimeout(fetchAddableContent(title, 2), SEARCH_UPSTREAM_TIMEOUT_MS, 'addable2')
  ]);

  if (searchResult.status === 'fulfilled') {
    try {
      searchData = ensureValidSearchPayload(searchResult.value.data);
    } catch (error) {
      searchError = error;
    }
  } else {
    searchError = searchResult.reason;
  }

  if (titlesResult.status === 'fulfilled') {
    try {
      titlesData = ensureValidSearchPayload(titlesResult.value.data);
    } catch (error) {
      titlesError = error;
    }
  } else {
    titlesError = titlesResult.reason;
  }

  if (addable15Result.status === 'fulfilled') {
    addableCategory15Results = addable15Result.value;
  }

  if (addable2Result.status === 'fulfilled') {
    addableCategory2Results = addable2Result.value;
  }

  if (!searchData && !titlesData && !addableCategory15Results && !addableCategory2Results) {
    throw searchError || titlesError || new Error('Erreur lors de la recherche');
  }

  return buildMergedSearchResponse(title, searchData, titlesData, addableCategory15Results, addableCategory2Results);
}

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.DARKINO_MAINTENANCE !== undefined) DARKINO_MAINTENANCE = deps.DARKINO_MAINTENANCE;
  if (deps.DARKINOS_CACHE_DIR) DARKINOS_CACHE_DIR = deps.DARKINOS_CACHE_DIR;
  if (deps.axiosDarkinoRequest) axiosDarkinoRequest = deps.axiosDarkinoRequest;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
  if (deps.touchCacheEntry) touchCacheEntry = deps.touchCacheEntry;
  if (deps.shouldUpdateCache) shouldUpdateCache = deps.shouldUpdateCache;
}

// ---------------------------------------------------------------------------
// GET /api/search  -- search Darkino with caching
// ---------------------------------------------------------------------------
router.get('/api/search', async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'Le parametre title est requis' });
    const sanitizedTitle = String(title).replace(/\//g, '').trim();
    if (!sanitizedTitle) return res.status(400).json({ error: 'Le parametre title est invalide' });

    // Generate cache key
    const cacheKey = generateCacheKey(`api_search_${sanitizedTitle}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    let dataReturned = false;

    if (cachedData && !isEmptySearchResponse(cachedData)) {
      res.status(200).json(cachedData);
      dataReturned = true;

      // Update cache in background only if no error occurs
      (async () => {
        try {
          const shouldUpdate_ = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate_) {
            return;
          }

          const freshData = await fetchMergedSearchData(sanitizedTitle);

          if (Array.isArray(cachedData?.results) && cachedData.results.length > 0 && isEmptySearchResponse(freshData)) {
            await touchCacheEntry(DARKINOS_CACHE_DIR, cacheKey);
            return;
          }

          if (freshData) {
            await saveToCache(DARKINOS_CACHE_DIR, cacheKey, freshData);
          }
        } catch (error) {
          // Silent fail on background update
        }
      })();
    } else {
      // Si en maintenance et pas de cache, erreur
      if (DARKINO_MAINTENANCE) {
        return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
      }
      // No cache, get data synchronously
      try {
        const data = await fetchMergedSearchData(sanitizedTitle);

        if (data) {
          await saveToCache(DARKINOS_CACHE_DIR, cacheKey, data);
          res.status(200).json(data);
        } else {
          res.status(404).json({ error: 'Aucun resultat trouve' });
        }
      } catch (error) {
        if (error.response && error.response.status >= 500) {
          if (dataReturned) return;

          try {
            const fallbackCache = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
            if (fallbackCache && !isEmptySearchResponse(fallbackCache)) {
              return res.status(200).json(fallbackCache);
            }
          } catch (_) { }
        }
        res.status(500).json({ error: 'Erreur lors de la recherche' });
      }
    }
  } catch (error) {
    console.error(`Erreur API Darkino Search: ${error.response?.status || 'Erreur reseau'}`);
    if (!res.headersSent) {
      try {
        const { title } = req.query;
        const sanitizedTitle = String(title || '').replace(/\//g, '').trim();
        const cacheKey = generateCacheKey(`api_search_${sanitizedTitle}`);
        const fallbackCache = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
        if (error.response && error.response.status >= 500 && fallbackCache && !isEmptySearchResponse(fallbackCache)) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
      res.status(500).json({ error: 'Erreur lors de la recherche' });
    }
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = router;
module.exports.configure = configure;
