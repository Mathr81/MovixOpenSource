/**
 * 1jour1film (1J1F) source — Dooplay/WordPress scraper.
 * Mount point: app.use('/api/j1f', require('./routes/j1f'))
 *
 * Endpoints (TMDB id in, players out — same contract as fstream/wiflix):
 *   GET /movie/:id
 *   GET /tv/:id/season/:season   (optional ?episode=N)
 *
 * Flow
 * ----
 * 0. Domain rotates. Resolve the live base from the stable /go/ entry
 *    (TARGET_URL = "..."), cached + env-overridable (J1F_BASE_URL).
 * 1. Search via the nonce-free WP listing {base}/?s={query} -> /films/ +
 *    /tvshows/ links (slug carries the year). Matched against TMDB title+year.
 * 2. The real source list is NOT in the plain HTML — it ships base64-encoded
 *    inside <script defer src="data:text/javascript;base64,...">. Decode those:
 *      - Movies: `var J1F_SRV = [{label,url,type,source}, ...]`
 *      - Series: `var j1fEpsData = [{num,label,servers:[{label,url,type}], ...}]`
 *    (the season's /saisons/{slug}/ page; pick the link whose slug carries the
 *    season number).
 * 3. Each source has a `source` tag:
 *      - "manual"  -> 1J1F's own players (totocoutouno, bysezoxexe, ...) — UNIQUE.
 *      - "frembed"/"vidsrc"/"videasy" -> generic TMDB-id aggregators that Movix
 *        already exposes as their own sources. We DROP these (J1F_DROP_SOURCES)
 *        so 1J1F doesn't just duplicate frembed; only the unique players remain.
 *    Kept players are split VF/VOSTFR by label.
 *
 * When a title yields no unique (manual) player, we still cache the negative
 * result (sentinel) so the frontend marks 1J1F "checked, nothing extra" and we
 * don't re-scrape on every hit.
 *
 * All fetches go through make1j1fRequest (CycleTLS JA3-Chrome + ProxyScrape
 * rotation) which clears the Cloudflare shield. Works from datacenter IPs —
 * verified: the J1F_SRV/j1fEpsData blobs are in the page for any client, just
 * base64-wrapped.
 */

const express = require('express');
const router = express.Router();
const cheerio = require('cheerio');

const { fetchTmdbDetails } = require('../utils/tmdbCache');
const { make1j1fRequest } = require('../utils/proxyManager');
const {
  CACHE_DIR,
  generateCacheKey,
  getFromCacheNoExpiration,
  saveToCache,
} = require('../utils/cacheManager');
const { calculateTitleSimilarity } = require('./coflix'); // pure fn, no configure() needed

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_API_URL = 'https://api.themoviedb.org/3';

// --- Env-overridable knobs (domain rotates; markup may drift) ---
const GO_URL = process.env.J1F_GO_URL || 'https://1jour1film2026.site/go/';
const BASE_OVERRIDE = (process.env.J1F_BASE_URL || '').trim().replace(/\/+$/, '');
// Source tags to DROP — generic aggregators Movix already has as separate
// sources. Anything not listed (e.g. "manual") is kept as a unique 1J1F player.
const DROP_SOURCES = new Set(
  (process.env.J1F_DROP_SOURCES || 'frembed,vidsrc,videasy')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
// Series episode servers carry no `source` tag, so generic aggregators are
// dropped by host here too (vsembed=vidsrc, videasy, frembed).
const DROP_HOST_RE = new RegExp(process.env.J1F_DROP_HOSTS || 'vsembed|videasy|frembed|vidsrc', 'i');
const SRV_VAR = process.env.J1F_SRV_VAR || 'J1F_SRV'; // movie source array
const EPS_VAR = process.env.J1F_EPS_VAR || 'j1fEpsData'; // series episodes array
const SIMILARITY_THRESHOLD = parseFloat(process.env.J1F_SIMILARITY || '0.7');
const BASE_TTL_MS = 6 * 60 * 60 * 1000; // re-resolve domain every 6h
const REFRESH_MS = 40 * 60 * 1000; // serve cache fresh within this window

const hostOf = (u) => {
  const m = (u || '').match(/^https?:\/\/(?:www\.)?([^/]+)/);
  return m ? m[1] : u || 'embed';
};
const toBody = (r) => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
// VOSTFR only when the label is VOSTFR-only; "VF + VOSTFR" (dual) stays VF.
const langOf = (label) =>
  /vostfr/i.test(label || '') && !/\bvf\b/i.test(label || '') ? 'VOSTFR' : 'VF';
const yearFromSlug = (slug) => {
  const m = slug.match(/-(\d{4})(?:[-/]|$)/);
  return m ? parseInt(m[1], 10) : null;
};

// === Domain resolution (cached) ===
let cachedBase = null;
let cachedBaseAt = 0;
async function resolveBase() {
  if (BASE_OVERRIDE) return BASE_OVERRIDE;
  if (cachedBase && Date.now() - cachedBaseAt < BASE_TTL_MS) return cachedBase;
  const res = await make1j1fRequest(GO_URL, { timeout: 20 });
  const m = toBody(res).match(/TARGET_URL\s*=\s*"([^"]+)"/);
  if (!m) {
    if (cachedBase) return cachedBase; // keep last good on a bad /go/ fetch
    throw new Error('[1J1F] TARGET_URL introuvable sur /go/');
  }
  cachedBase = m[1].replace(/\\\//g, '/').replace(/\/+$/, '');
  cachedBaseAt = Date.now();
  return cachedBase;
}

// In-flight scrapes keyed by cache key, so concurrent cold requests for the same
// title kick off only ONE background scrape.
const inFlight = new Map();

// Non-blocking cache — never make the user wait on the slow CycleTLS+proxy scrape:
//  - fresh cache      -> return it
//  - stale cache      -> return stale now, refresh in background (stale-while-revalidate)
//  - cold (no cache)  -> return { pending:true } immediately, scrape in background
// The background job caches the real result; the client gets it on a subsequent
// request (the frontend retries shortly after a `pending` response). Negative
// results are cached too (sentinel) so frembed-only titles don't re-scrape.
function startBackgroundScrape(key, fetcher) {
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    try {
      const fresh = await fetcher();
      fresh._ts = Date.now();
      await saveToCache(CACHE_DIR.J1F, key, fresh);
      return fresh;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  job.catch(() => {}); // next request retries; avoid unhandled rejection
  return job;
}

async function withCache(key, fetcher) {
  const cached = await getFromCacheNoExpiration(CACHE_DIR.J1F, key);
  if (cached && cached._ts && Date.now() - cached._ts < REFRESH_MS) return cached;

  // Stale or cold: trigger a background refresh/scrape (deduped), don't await it.
  startBackgroundScrape(key, fetcher);

  if (cached) return cached; // stale-while-revalidate: serve stale immediately
  return { success: false, pending: true, tmdb_id: undefined }; // cold: tell client to retry shortly
}

// Decode every <script ... src="data:text/javascript;base64,...">. The real
// player data (J1F_SRV / j1fEpsData) lives base64-wrapped in these.
function decodeDataScripts(html) {
  const out = [];
  const re = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(Buffer.from(m[1], 'base64').toString('utf-8'));
    } catch {
      /* skip undecodable */
    }
  }
  return out;
}

// Pull `var <name> = [ ... ];` (a JSON array) out of the decoded data: scripts.
function extractJsArray(html, varName) {
  const re = new RegExp(`(?:var|let|const)\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`);
  for (const js of decodeDataScripts(html)) {
    const m = js.match(re);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* malformed — try the next script */
      }
    }
  }
  return null;
}

// Keep only unique (non-generic) servers, split VF/VOSTFR by label.
function splitUniqueServers(servers) {
  const vf = [];
  const vostfr = [];
  for (const s of servers || []) {
    if (!s || !s.url) continue;
    if (DROP_SOURCES.has(String(s.source || '').toLowerCase())) continue; // drop by `source` tag (movies)
    if (DROP_HOST_RE.test(s.url)) continue; // drop by host (series servers have no `source` tag)
    const entry = {
      name: hostOf(s.url),
      url: s.url,
      type: s.type === 'mp4' ? 'mp4' : 'iframe',
      label: s.label || '',
      source: s.source || 'manual',
    };
    (langOf(s.label) === 'VOSTFR' ? vostfr : vf).push(entry);
  }
  return { vf, vostfr };
}

// === Search: {base}/?s={query} -> [{url, slug, type, year}] ===
async function searchJ1F(base, query) {
  const url = `${base}/?s=${encodeURIComponent(query)}`;
  const res = await make1j1fRequest(url, { timeout: 15 });
  const $ = cheerio.load(toBody(res));
  const seen = new Set();
  const out = [];
  $('a[href*="/films/"], a[href*="/tvshows/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/(films|tvshows)\/([^/"?#]+)\/?/);
    if (!m) return;
    const slug = m[2];
    if (seen.has(slug)) return;
    seen.add(slug);
    out.push({
      url: href.split('#')[0],
      slug,
      type: m[1] === 'films' ? 'movie' : 'tv',
      year: yearFromSlug(slug),
    });
  });
  return out;
}

// Best search hit for a TMDB title/year. Title is reconstructed from the slug.
function pickBest(results, mediaType, titles, year) {
  let best = null;
  let bestScore = 0;
  for (const r of results.filter((x) => x.type === mediaType)) {
    const slugTitle = r.slug
      .replace(/-(streaming|vf|vostfr|hd|fhd|complete?|netflix|serie|saison|film|episode|\d{4}|[a-z]\d+)\b/gi, ' ')
      .replace(/-/g, ' ')
      .trim();
    let score = 0;
    for (const t of titles) score = Math.max(score, calculateTitleSimilarity(t, slugTitle));
    if (year && r.year === year) score += 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= SIMILARITY_THRESHOLD ? best : null;
}

async function findOnJ1F(base, mediaType, tmdb) {
  const titles = [
    mediaType === 'movie' ? tmdb.title : tmdb.name,
    mediaType === 'movie' ? tmdb.original_title : tmdb.original_name,
  ].filter((t, i, a) => t && a.indexOf(t) === i);
  const dateStr = mediaType === 'movie' ? tmdb.release_date : tmdb.first_air_date;
  const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;

  for (const t of titles) {
    let results = [];
    try {
      results = await searchJ1F(base, t);
    } catch (e) {
      console.log(`[1J1F SEARCH] "${t}": ${e.message}`);
      continue;
    }
    const hit = pickBest(results, mediaType, titles, year);
    if (hit) return hit;
  }
  return null;
}

// === Movie ===
async function fetchMovie(base, tmdbId) {
  const tmdb = await fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, 'movie', 'fr-FR');
  if (!tmdb) return { success: false, error: 'Film non trouve sur TMDB', tmdb_id: tmdbId };

  const hit = await findOnJ1F(base, 'movie', tmdb);
  if (!hit) return { success: false, error: 'Film non trouve sur 1jour1film', tmdb_id: tmdbId };

  const res = await make1j1fRequest(hit.url, { timeout: 15 });
  const srv = extractJsArray(toBody(res), SRV_VAR);
  if (!srv) {
    console.warn(`[1J1F MOVIE] ${tmdbId}: ${SRV_VAR} introuvable sur ${hit.url}`);
    return { success: false, error: 'Sources introuvables', tmdb_id: tmdbId, j1f_url: hit.url };
  }

  const { vf, vostfr } = splitUniqueServers(srv);
  if (vf.length === 0 && vostfr.length === 0) {
    // Only generic aggregators (frembed/vidsrc/videasy) — nothing 1J1F adds.
    return { success: false, error: 'Aucune source unique (generiques uniquement)', tmdb_id: tmdbId, j1f_url: hit.url };
  }
  return {
    success: true,
    tmdb_id: tmdbId,
    title: tmdb.title,
    original_title: tmdb.original_title,
    source: '1jour1film',
    j1f_url: hit.url,
    players: { vf, vostfr },
    cache_timestamp: new Date().toISOString(),
  };
}

// === Series ===
async function fetchSeason(base, tmdbId, seasonNum, episodeNum) {
  const tmdb = await fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, 'tv', 'fr-FR');
  if (!tmdb) return { success: false, error: 'Serie non trouvee sur TMDB', tmdb_id: tmdbId };

  const hit = await findOnJ1F(base, 'tv', tmdb);
  if (!hit) return { success: false, error: 'Serie non trouvee sur 1jour1film', tmdb_id: tmdbId };

  // tvshow page -> the /saisons/ link whose slug carries this season number.
  const showRes = await make1j1fRequest(hit.url, { timeout: 15 });
  const $show = cheerio.load(toBody(showRes));
  let seasonUrl = null;
  $show('a[href*="/saisons/"]').each((_, a) => {
    const href = $show(a).attr('href') || '';
    const m = href.match(/saison-(\d+)/i);
    if (m && parseInt(m[1], 10) === Number(seasonNum)) seasonUrl = href.split('#')[0];
  });
  if (!seasonUrl) {
    return { success: false, error: `Saison ${seasonNum} introuvable`, tmdb_id: tmdbId, j1f_url: hit.url };
  }

  const seasonRes = await make1j1fRequest(seasonUrl, { timeout: 15 });
  const eps = extractJsArray(toBody(seasonRes), EPS_VAR);
  if (!eps || !Array.isArray(eps)) {
    console.warn(`[1J1F TV] ${tmdbId} S${seasonNum}: ${EPS_VAR} introuvable sur ${seasonUrl}`);
    return { success: false, error: 'Episodes introuvables', tmdb_id: tmdbId, j1f_url: seasonUrl };
  }

  // Shape matches wiflix's TV response: `episodes` keyed by episode number,
  // each { vf:[{name,url,...}], vostfr:[...] } — the whole season is returned
  // and the frontend slices the current episode. `?episode=` still narrows it.
  const wanted = episodeNum ? eps.filter((e) => Number(e.num) === Number(episodeNum)) : eps;
  const episodes = {};
  for (const e of wanted) {
    const { vf, vostfr } = splitUniqueServers(e.servers);
    if (!vf.length && !vostfr.length) continue; // drop generic-only episodes
    episodes[String(e.num)] = { vf, vostfr, label: e.label || '' };
  }

  if (Object.keys(episodes).length === 0) {
    return { success: false, error: 'Aucune source unique (generiques uniquement)', tmdb_id: tmdbId, j1f_url: seasonUrl };
  }
  return {
    success: true,
    tmdb_id: tmdbId,
    title: tmdb.name,
    source: '1jour1film',
    j1f_url: seasonUrl,
    season: Number(seasonNum),
    episodes,
    cache_timestamp: new Date().toISOString(),
  };
}

// === Routes ===
router.get('/movie/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const base = await resolveBase();
    const data = await withCache(generateCacheKey({ src: 'j1f', t: 'movie', id }), () =>
      fetchMovie(base, id),
    );
    res.json(data);
  } catch (err) {
    console.error(`[1J1F MOVIE] ${id}: ${err.message}`);
    res.status(200).json({ success: false, error: 'Erreur 1jour1film', tmdb_id: id });
  }
});

router.get('/tv/:id/season/:season', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query;
  try {
    const base = await resolveBase();
    const key = generateCacheKey({ src: 'j1f', t: 'tv', id, season, episode: episode || '' });
    const data = await withCache(key, () => fetchSeason(base, id, season, episode));
    res.json(data);
  } catch (err) {
    console.error(`[1J1F TV] ${id} S${season}: ${err.message}`);
    res.status(200).json({ success: false, error: 'Erreur 1jour1film', tmdb_id: id });
  }
});

module.exports = router;
