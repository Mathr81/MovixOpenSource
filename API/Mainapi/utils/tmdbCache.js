/**
 * Cache Redis centralisé pour les appels TMDB API.
 * Partagé entre tous les workers du cluster — évite les appels TMDB redondants.
 *
 * Pattern identique à wrappedRoutes.js : redisReady() + get/set avec TTL.
 * Préfixe Redis : "tmdb:"
 */

const axios = require('axios');
const { redis } = require('../config/redis');

// TTL par type de requête
const TTL_DETAILS = 24 * 60 * 60;  // 24h — les détails d'un film/série changent rarement
const TTL_SEARCH  = 12 * 60 * 60;  // 12h — les résultats de recherche peuvent évoluer

function redisReady() {
  return redis && redis.status === 'ready';
}

async function redisGet(key) {
  if (!redisReady()) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

async function redisSet(key, value, ttl) {
  if (!redisReady()) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
  } catch { /* ignore */ }
}

/**
 * Récupère les détails TMDB pour un ID donné, avec cache Redis.
 * Clé : tmdb:details:{type}:{id}
 *
 * @param {string} tmdbApiUrl - Ex: "https://api.themoviedb.org/3"
 * @param {string} tmdbApiKey - Clé API TMDB
 * @param {string|number} id  - ID TMDB
 * @param {string} type       - "movie" ou "tv"
 * @param {string} [language] - Langue (défaut: "fr-FR")
 * @returns {object|null}
 */
async function fetchTmdbDetails(tmdbApiUrl, tmdbApiKey, id, type, language = 'fr-FR') {
  const redisKey = `tmdb:details:${type}:${id}:${language}`;

  // 1. Cache Redis
  const cached = await redisGet(redisKey);
  if (cached) return cached;

  // 2. Appel API TMDB
  try {
    const response = await axios.get(`${tmdbApiUrl}/${type}/${id}`, {
      params: { api_key: tmdbApiKey, language },
      timeout: 10000
    });

    if (!response.data) return null;

    // 3. Sauvegarder dans Redis
    await redisSet(redisKey, response.data, TTL_DETAILS);
    return response.data;
  } catch (error) {
    // Ne pas cacher les erreurs
    return null;
  }
}

/**
 * Recherche TMDB avec cache Redis.
 * Clé : tmdb:search:{type}:{query}:{year}:{language}
 *
 * @param {string} tmdbApiUrl
 * @param {string} tmdbApiKey
 * @param {string} type       - "movie" ou "tv"
 * @param {string} query      - Terme de recherche
 * @param {object} [extraParams] - Params additionnels (first_air_date_year, year, etc.)
 * @param {string} [language]
 * @returns {object|null} - response.data complet (avec .results)
 */
async function searchTmdb(tmdbApiUrl, tmdbApiKey, type, query, extraParams = {}, language = 'fr-FR') {
  const paramsSuffix = Object.entries(extraParams).sort().map(([k, v]) => `${k}=${v}`).join('&');
  const redisKey = `tmdb:search:${type}:${query}:${paramsSuffix}:${language}`;

  const cached = await redisGet(redisKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${tmdbApiUrl}/search/${type}`, {
      params: { api_key: tmdbApiKey, query, language, ...extraParams },
      timeout: 10000
    });

    if (response.data) {
      await redisSet(redisKey, response.data, TTL_SEARCH);
    }
    return response.data;
  } catch (error) {
    return null;
  }
}

/**
 * Récupère les détails d'une saison TMDB avec cache Redis.
 * Clé : tmdb:season:{tvId}:{seasonNumber}:{language}
 */
async function fetchTmdbSeason(tmdbApiUrl, tmdbApiKey, tvId, seasonNumber, language = 'fr-FR') {
  const redisKey = `tmdb:season:${tvId}:${seasonNumber}:${language}`;

  const cached = await redisGet(redisKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${tmdbApiUrl}/tv/${tvId}/season/${seasonNumber}`, {
      params: { api_key: tmdbApiKey, language },
      timeout: 10000
    });

    if (response.data) {
      await redisSet(redisKey, response.data, TTL_DETAILS);
    }
    return response.data;
  } catch (error) {
    return null;
  }
}

/**
 * Recupere les titres alternatifs d'un media TMDB avec le TTL des details.
 * Cle : tmdb:alternative_titles:{mediaType}:{id}
 */
async function fetchTmdbAlternativeTitles(tmdbApiUrl, tmdbApiKey, id, mediaType = 'tv') {
  if (!['tv', 'movie'].includes(mediaType)) throw new TypeError('type media TMDB invalide');
  const redisKey = `tmdb:alternative_titles:${mediaType}:${id}`;
  const cached = await redisGet(redisKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${tmdbApiUrl}/${mediaType}/${id}/alternative_titles`, {
      params: { api_key: tmdbApiKey },
      timeout: 10000
    });
    if (response.data) {
      await redisSet(redisKey, response.data, TTL_DETAILS);
    }
    return response.data;
  } catch {
    return null;
  }
}

/**
 * Récupère l'année de sortie française d'un film via /movie/{id}/release_dates.
 * Clé : tmdb:release_dates:movie:{id}
 */
async function fetchTmdbFrenchReleaseYear(tmdbApiUrl, tmdbApiKey, id) {
  const redisKey = `tmdb:release_dates:movie:${id}`;

  const cached = await redisGet(redisKey);
  if (cached) {
    const frRelease = cached.results ? cached.results.find(r => r.iso_3166_1 === 'FR') : null;
    if (frRelease && frRelease.release_dates && frRelease.release_dates.length > 0) {
      const date = frRelease.release_dates[0].release_date;
      if (date) return new Date(date).getFullYear();
    }
    return null;
  }

  try {
    const response = await axios.get(`${tmdbApiUrl}/movie/${id}/release_dates`, {
      params: { api_key: tmdbApiKey },
      timeout: 10000
    });

    if (response.data) {
      await redisSet(redisKey, response.data, TTL_DETAILS);
    }

    const frRelease = response.data?.results?.find(r => r.iso_3166_1 === 'FR');
    if (frRelease && frRelease.release_dates && frRelease.release_dates.length > 0) {
      const date = frRelease.release_dates[0].release_date;
      if (date) return new Date(date).getFullYear();
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Récupère toutes les images TMDB (posters + backdrops, toutes langues).
 * Clé : tmdb:images:{type}:{id}
 */
async function fetchTmdbImages(tmdbApiUrl, tmdbApiKey, id, type) {
  const redisKey = `tmdb:images:${type}:${id}`;

  const cached = await redisGet(redisKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${tmdbApiUrl}/${type}/${id}/images`, {
      params: { api_key: tmdbApiKey },
      timeout: 10000
    });

    if (response.data) {
      await redisSet(redisKey, response.data, TTL_DETAILS);
    }
    return response.data;
  } catch (error) {
    return null;
  }
}

module.exports = {
  fetchTmdbDetails,
  searchTmdb,
  fetchTmdbSeason,
  fetchTmdbAlternativeTitles,
  fetchTmdbFrenchReleaseYear,
  fetchTmdbImages,
  TTL_DETAILS,
  TTL_SEARCH
};
