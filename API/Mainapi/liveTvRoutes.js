/**
 * Live TV Routes - Backend API pour TV en Direct
 *
 * Ce module gère les requêtes vers l'API Stremio TV Direct
 * avec mise en cache et résolution des URLs de streaming.
 */

const express = require("express");
const axios = require("axios");
const path = require("path");
const fsp = require("fs").promises;
const crypto = require("crypto");
const cheerio = require("cheerio");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { verifyAccessKey, requireVip } = require("./checkVip");
const {
  DADDYLIVE_BASE_URL,
  DADDYLIVE_REFERER,
  DADDYLIVE_ORIGIN,
  DADDYLIVE_CHANNELS_PATH,
  DADDYLIVE_PLACEHOLDER_POSTER,
  DADDYLIVE_COUNTRIES,
  parseChannelsHtml: parseDaddyliveChannelsHtml,
  parsePlayersHtml: parseDaddylivePlayersHtml,
  buildDeterministicPlayers: buildDaddyliveDeterministicPlayers,
  extractM3u8FromPlayerHtml: extractDaddyliveM3u8,
  extractIframeSrc: extractDaddyliveIframeSrc,
} = require("./utils/daddylive");

// SOCKS5H Proxy configuration pour WITV
const WITV_PROXY_URL = process.env.WITV_SOCKS5_PROXY_URL || "";
const WITV_PROXY_AGENT = WITV_PROXY_URL
  ? new SocksProxyAgent(WITV_PROXY_URL)
  : null;

const router = express.Router();

// === CONFIGURATION ===
const TVDIRECT_BASE_URL = "https://tvdirect.ddns.net";
// URL du serveur proxy local (proxiesembed)
const PROXY_SERVER_URL = process.env.PROXY_SERVER_URL;
/*

  "https://tvmio.gleeze.com/eyJjb3VudHJpZXMiOlsiRlIiXSwiY2F0ZWdvcmllcyI6eyJGUiI6WyJHZW5lcmFsIPCfk7oiLCJTcG9ydHMg4pq9IiwiRG9jdW1lbnRhaXJlcyDwn4yNIiwiRmlsbXMg8J+OrCIsIkluZm9ybWF0aW9ucyDwn5OwIiwiRW5mYW50cyDwn5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0";

  tvmio_general: {
    genre: "FR | General",
    remoteGenre: "General 📺",
    name: "Généraliste 📺",
    emoji: "📺",
  },
  tvmio_sports: {
    genre: "FR | Sports",
    remoteGenre: "Sports ⚽",
    name: "Sports ⚽",
    emoji: "⚽",
  },
  tvmio_documentaires: {
    genre: "FR | Documentaires",
    remoteGenre: "Documentaires 🌍",
    name: "Documentaires 🌍",
    emoji: "🌍",
  },
  tvmio_films: {
    genre: "FR | Films",
    remoteGenre: "Films 🎬",
    name: "Films 🎬",
    emoji: "🎬",
  },
  tvmio_informations: {
    genre: "FR | Informations",
    remoteGenre: "Informations 📰",
    name: "Informations 📰",
    emoji: "📰",
  },
  tvmio_enfants: {
    genre: "FR | Enfants",
    remoteGenre: "Enfants 👶",
    name: "Enfants 👶",
    emoji: "👶",
  },
  tvmio_music: {
    genre: "FR | Musique",
    remoteGenre: "Music 🎵",
    name: "Musique 🎵",
    emoji: "🎵",
  },
};

*/
const TVMIO_CATEGORIES = {};

// URL de base pour Wiflix (Witv)
const WITV_BASE_URL = "https://witv.football";
// Cloudflare proxy for 403 bypass (livehdtv)
const CF_PROXY_403 = process.env.CF_PROXY_403_URL;

const WITV_CATEGORIES = {
  wiflix_generaliste: "/chaines-live/generaliste/",
  wiflix_cinema: "/chaines-live/cinema/",
  wiflix_sport: "/chaines-live/sport/",
  wiflix_documentaire: "/chaines-live/documentaire/",
  wiflix_enfants: "/chaines-live/enfants/",
  wiflix_info: "/chaines-live/info/",
  wiflix_musique: "/chaines-live/musique/",
};

// URL de base pour Sosplay
const SOSPLAY_BASE_URL = "https://streamonsport.art";

// Source Bolaloca/Elitegol (remplace l'ancien catalogue Sosplay pour les chaines)
const BOLALOCA_BASE_URL = "https://bolaloca.my";
const BOLALOCA_PLAYER_VARIANTS = [2, 4, 3, 1];
const BOLALOCA_CHANNELS = [
  {
    id: "20",
    name: "Ligue 1+",
    poster: "https://www.lensois.com/wp-content/uploads/2025/07/ligue-1-1.jpg",
  },
  {
    id: "21",
    name: "Ligue 1+ CH2",
    poster:
      "https://www.monpetitforfait.com/comparateur-box-internet/wp-content/uploads/2025/07/ligue-1-plus-2.png",
  },
  {
    id: "22",
    name: "Ligue 1+ CH3",
    poster:
      "https://www.monpetitforfait.com/comparateur-box-internet/wp-content/uploads/2025/07/ligue-1plus-3-box-internet-300x95.png",
  },
  {
    id: "39",
    name: "Ligue 1+ CH4",
    poster:
      "https://www.monpetitforfait.com/comparateur-box-internet/wp-content/uploads/2025/07/ligue-1plus-4-box-internet-300x106.png",
  },
  {
    id: "40",
    name: "Ligue 1+ CH5",
    poster:
      "https://www.monpetitforfait.com/comparateur-box-internet/wp-content/uploads/2025/07/ligue-1-plus-5.png",
  },
  {
    id: "11",
    name: "Canal+",
    poster:
      "https://thumb.canalplus.pro/http/unsafe/epg.canal-plus.com/mycanal/img/CHN43FN/PNG/213X160/CHN43FB_301.PNG",
  },
  {
    id: "12",
    name: "Canal+ Foot",
    poster: "https://upload.wikimedia.org/wikipedia/fr/3/3b/C%2B_Foot.png",
  },
  {
    id: "13",
    name: "Canal+ Sport",
    poster:
      "https://upload.wikimedia.org/wikipedia/fr/2/2c/C%2B_Sport_%282023%29.png",
  },
  {
    id: "14",
    name: "Canal+ Sport 360",
    poster: "https://upload.wikimedia.org/wikipedia/fr/1/11/C%2B_Sport_360.png",
  },
  {
    id: "17",
    name: "RMC Sport 1",
    poster:
      "https://i0.wp.com/www.planetecsat.com/wp-content/uploads/2018/07/RMC_SPORT1_PNG_500x500px.png?w=500&ssl=1",
  },
  {
    id: "18",
    name: "RMC Sport 2",
    poster:
      "https://i0.wp.com/www.planetecsat.com/wp-content/uploads/2018/07/RMC_SPORT2_PNG_500x500px.png?fit=500%2C500&ssl=1",
  },
  {
    id: "15",
    name: "Eurosport 1",
    poster:
      "https://2.bp.blogspot.com/-qEkUoydNN-E/WvMoKma36fI/AAAAAAAAG_0/ov-d571uhZ443Nai7gdU9sSIV2IBOkquQCLcBGAs/s1600/europsort-1-HD.jpg",
  },
  {
    id: "16",
    name: "Eurosport 2",
    poster:
      "https://4.bp.blogspot.com/-1bHZ8b5ZnW0/VzDh6KfzayI/AAAAAAAABsI/lKDWcPmyBSk7etoAj2DVr7nvQ5SsMPwzgCLcB/s1600/fhuxmcp92wg1w4y9pd2v4zjz3xs1vmjm.jpg",
  },
  {
    id: "19",
    name: "L'Equipe",
    poster:
      "https://www.cse.fr/wp-content/uploads/2016/02/LEquipe_logo-300x200-300x150.png",
  },
  {
    id: "23",
    name: "Automoto",
    poster:
      "https://moto-station.com/wp-content/uploads/2021/05/05/Automoto-La-Chaine-logo_0.png.jpg",
  },
  {
    id: "31",
    name: "Canal+ Live 1",
    poster: "https://www.lyngsat.com/logo/tv/cc/canal-plus-live-1-fr.png",
  },
  {
    id: "32",
    name: "Canal+ Live 2",
    poster: "https://www.lyngsat.com/logo/tv/cc/canal-plus-live-2-fr.png",
  },
  {
    id: "33",
    name: "Canal+ Live 3",
    poster: "https://www.lyngsat.com/logo/tv/cc/canal-plus-live-3-fr.png",
  },
  {
    id: "1",
    name: "beIN Sports 1",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_1_Australia.png",
  },
  {
    id: "2",
    name: "beIN Sports 2",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_2_Australia.png",
  },
  {
    id: "3",
    name: "beIN Sports 3",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_3_Australia.png",
  },
  {
    id: "4",
    name: "beIN Sports MAX 4",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_4.png",
  },
  {
    id: "5",
    name: "beIN Sports MAX 5",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_5.png",
  },
  {
    id: "6",
    name: "beIN Sports MAX 6",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_6.png",
  },
  {
    id: "7",
    name: "beIN Sports MAX 7",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_7.png",
  },
  {
    id: "8",
    name: "beIN Sports MAX 8",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_8.png",
  },
  {
    id: "9",
    name: "beIN Sports MAX 9",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_9.png",
  },
  {
    id: "10",
    name: "beIN Sports MAX 10",
    poster:
      "https://r2.thesportsdb.com/images/media/channel/logo/BeIn_Sports_Max_10.png",
  },
];

const LIVETV_BASE_URL = "https://livetv901.me";
const LIVETV_EMBED_REFERER = `${LIVETV_BASE_URL}/`;
const LIVETV_ALLUPCOMING_PATHS = ["/frx/allupcoming/", "/frx/ads/"];
const LIVETV_CATEGORIES = {
  livetv_all: { name: "Tous les sports", emoji: "📅", sportKey: "all" },
  livetv_live: { name: "En direct", emoji: "🔴", sportKey: "live" },
  livetv_football: { name: "Football", emoji: "⚽", sportKey: "football" },
  livetv_hockey: { name: "Hockey", emoji: "🏒", sportKey: "hockey" },
  livetv_basketball: {
    name: "Basketball",
    emoji: "🏀",
    sportKey: "basketball",
  },
  livetv_tennis: { name: "Tennis", emoji: "🎾", sportKey: "tennis" },
  livetv_volleyball: {
    name: "Volley-ball",
    emoji: "🏐",
    sportKey: "volleyball",
  },
  livetv_handball: { name: "Handball", emoji: "🤾", sportKey: "handball" },
  livetv_rugby: { name: "Rugby", emoji: "🏉", sportKey: "rugby" },
  livetv_combat: { name: "Sports de combat", emoji: "🥊", sportKey: "combat" },
  livetv_motorsport: {
    name: "Sports mecaniques",
    emoji: "🏎️",
    sportKey: "motorsport",
  },
  livetv_winter: { name: "Sports d'hiver", emoji: "🎿", sportKey: "winter" },
  livetv_athletics: { name: "Athletisme", emoji: "🏃", sportKey: "athletics" },
  livetv_other: { name: "Autres sports", emoji: "🏟️", sportKey: "other" },
};
const LIVETV_SPORT_ALIASES = {
  football: ["football", "soccer", "futsal"],
  hockey: ["hockey sur glace", "ice hockey", "hockey"],
  basketball: ["basketball", "basket"],
  tennis: ["tennis"],
  volleyball: ["volley-ball", "volleyball", "volley ball", "volley"],
  handball: ["handball"],
  rugby: ["rugby"],
  combat: [
    "boxe",
    "boxing",
    "mma",
    "ufc",
    "kickboxing",
    "muay thai",
    "wrestling",
    "lutte",
    "combat",
  ],
  motorsport: [
    "courses",
    "motogp",
    "formula 1",
    "formule 1",
    "rally",
    "rallye",
    "nascar",
    "indycar",
    "motorsport",
    "auto racing",
  ],
  winter: [
    "sport d'hiver",
    "sports d'hiver",
    "winter sports",
    "ski",
    "biathlon",
    "snowboard",
    "curling",
    "patinage",
  ],
  athletics: [
    "course a pied",
    "course a pied",
    "course à pied",
    "athletisme",
    "athletism",
    "athletisme...",
    "athletisme…",
    "marathon",
    "trail",
    "running",
  ],
};
const LIVETV_SPORT_EMOJIS = Object.fromEntries(
  Object.values(LIVETV_CATEGORIES)
    .filter(
      (config) =>
        config.sportKey &&
        config.sportKey !== "all" &&
        config.sportKey !== "live",
    )
    .map((config) => [config.sportKey, config.emoji || "🏟️"]),
);

// Sosplay categories
const SOSPLAY_CATEGORIES = {
  sosplay_chaines: "/livetv-sport-france-streaming-gratuit",
};

// Sosplay Matches categories (for live sports events)
const SOSPLAY_MATCHES_CATEGORIES = {
  matches_football: {
    path: "/type.php?type=Football",
    name: "Football",
    emoji: "⚽",
  },
};

// FCTV33 / RBTV-style API used for the matches catalog.
// EU endpoint (defra) is used by default for European users.
// Fallback API base — normally auto-resolved at runtime (getFctvApiBase); this
// hardcoded value is used only when the cache is empty / auto-resolve fails.
const FCTV_API_BASE_URL = "https://apis-data-defra10.tcore131ybdf.ru";
// Fallback embed player origin — normally auto-resolved (getFctvPlayerBaseUrl).
// Used for the iframe player + referer when the lookup is unavailable.
const FCTV_PLAYER_BASE_URL = "https://zac07eo.mpipzni2naturally32kistomach.ru";

// --- Native (HLSPlayer) stream tokenisation -------------------------------
// /api/stream/detail (unsigned, with continent/country/digit) returns an
// `rb-session` header + a masked URL that decodes to the proxy m3u8 path.
// The CDN gate is `/token-<T>/` where T = base64( rbSession XOR keystream ) + "a"
// (a fixed RC4-style keystream; recovered from a known token↔rb-session pair).
// The proxy m3u8 + its TS segments are Referer-gated to the player origin, so
// the native stream must be fetched through PROXY_SERVER_URL with that Referer.
const FCTV_STREAM_DIGIT = "seth";
const FCTV_GEO_CONTINENT = "EU";
const FCTV_GEO_COUNTRY = "FR";
// Keystream (hex). Edit this value when upstream rotates its key (native breaks
// with 403/404 → re-capture one token↔rb-session pair and XOR them,
// scripts/fctv_token_crack.cjs).
const FCTV_TOKEN_KEYSTREAM = Buffer.from(
  "15764bab80a419c6abdd5518f3db0ea95bb3b9a2e2b519ce5c159af6917e2000c2d680ae30706a3aba1c9c25786c7c28774eecf20450a3cf414ca17f6472798cfa557c7a8705b7861f06e84f827f8a24676eeab77ce504bfc335b79609b9",
  "hex",
);
const FCTV_LANGUAGE_FR = 6;
const FCTV_DEFAULT_SITE_TYPE = 2001;

// Image proxy for FCTV logos: derived from the shared bypass403 proxy
// (${BYPASS403_SERVER_URL}/proxy), with a hardcoded fallback.
const FCTV_IMAGE_PROXY = process.env.BYPASS403_SERVER_URL
  ? `${process.env.BYPASS403_SERVER_URL.replace(/\/+$/, "")}/proxy`
  : "https://proxy.movix.date/proxy";

function proxifyFctvImage(url) {
  if (!url) return "";
  
  // Replace dead domains with the working one
  let fixedUrl = url;
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.startsWith("logos1.")) {
      urlObj.hostname = "logos1.tcore131ybdf.ru";
    }
    fixedUrl = urlObj.toString();
  } catch (e) {
    // fallback if it's not a full URL
    fixedUrl = url.replace(/logos1\.[a-z0-9]+\.(cfd|ru|com)/g, "logos1.tcore131ybdf.ru");
  }

  const proxy = FCTV_IMAGE_PROXY.endsWith("/") ? FCTV_IMAGE_PROXY : FCTV_IMAGE_PROXY + "/";
  return `${proxy}${fixedUrl}`;
}

const FCTV_MATCHES_CATEGORIES = {
  matches_all: {
    name: "All Sports",
    emoji: "🏅",
    sportKey: "all",
    sportType: 0,
  },
  matches_football: {
    name: "Football",
    emoji: "\u26bd",
    sportKey: "football",
    sportType: 1,
  },
};
const FCTV_API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/x-protobuf,application/json,*/*",
  Origin: FCTV_PLAYER_BASE_URL,
  Referer: `${FCTV_PLAYER_BASE_URL}/`,
};

// V mapping: API endpoint paths -> bs code numbers (from upstream client JS)
const FCTV_BS_CODE_MAP = {
  "/api/match/live": 100,
  "/api/match/schedule": 101,
  "/api/match/detail": 102,
  "/api/match/event": 103,
  "/api/match/statistic": 104,
  "/api/match/trend": 105,
  "/api/match/lineup": 106,
  "/api/match/analysis": 107,
  "/api/match/count": 190,
  "/api/league/detail": 200,
  "/api/league/season/list": 210,
  "/api/league/match/list": 220,
  "/api/league/team/total/list": 230,
  "/api/league/player/total/list": 231,
  "/api/league/team/standing/list": 240,
  "/api/odds/list": 300,
};

// In-memory cache for bs keys (from /api/common/bs)
let fctvBsKeysCache = null;
let fctvBsKeysCacheTime = 0;
const FCTV_BS_KEYS_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch body-signature keys from /api/common/bs.
 * These keys are used to build the sfver path prefix required by the upstream API.
 */
async function fetchFctvBsKeys(sportType = 0) {
  // Return cached keys if fresh
  if (fctvBsKeysCache && Date.now() - fctvBsKeysCacheTime < FCTV_BS_KEYS_TTL) {
    return fctvBsKeysCache;
  }

  try {
    const codes = [100, 101, 102, 103, 104, 105, 106, 107];
    const params = new URLSearchParams();
    params.set("stream", "true");
    params.set("sportType", String(sportType));
    codes.forEach((c) => params.append("code", String(c)));

    const apiBase = await getFctvApiBase();
    const response = await axios.get(`${apiBase}/api/common/bs`, {
      params,
      responseType: "arraybuffer",
      headers: FCTV_API_HEADERS,
      timeout: 10000,
    });

    const { body } = parseFctvBody(response.data);
    const kvEntries = fctvAll(body, 1);
    const keys = {};

    for (const entry of kvEntries) {
      const entryFields = fctvFields(entry);
      const code = fctvValue(entryFields, 1);
      const key = fctvString(fctvValue(entryFields, 2));
      if (code != null && key) {
        keys[Number(code)] = key;
      }
    }

    console.log(`[FCTV-BS] Fetched ${Object.keys(keys).length} bs keys`);
    fctvBsKeysCache = keys;
    fctvBsKeysCacheTime = Date.now();
    return keys;
  } catch (error) {
    console.warn(`[FCTV-BS] Error fetching bs keys: ${error.message}`);
    return fctvBsKeysCache || {};
  }
}

/**
 * Build the sfver path prefix for a given API endpoint and params.
 * Format: sfver + MD5(JSON.stringify(sortedParams)).slice(0,6) + bsKey
 */
function buildFctvSfverPrefix(pathname, params, bsKeys) {
  const au = { ...params };
  delete au.usls;
  delete au.cBsDataTep;

  const ap = ['matchId', 'leagueId', 'seasonId', 'sportType', 'language', 'stream'];
  
  const sortedKeys = Object.keys(au).sort((a, b) => ap.indexOf(a) - ap.indexOf(b));
  
  const sortedObj = {};
  for (const key of sortedKeys) {
    sortedObj[key] = au[key];
  }
  
  const jsonStr = JSON.stringify(sortedObj);
  const md5Hash = crypto.createHash("md5").update(jsonStr).digest("hex").slice(0, 6);
  
  // Try to find the bsCode mapping, but for /api/stream/detail it's missing in some clients so default to bsKeys[102]
  const bsCode = FCTV_BS_CODE_MAP[pathname];
  const bsKey = (bsCode && bsKeys[bsCode]) || bsKeys[102] || bsKeys[100] || "";
  
  return `sfver${md5Hash}${bsKey}`;
}

// Linkzy configuration (FREE source - no extension/VIP required)
const LINKZY_CATEGORIES = {
  general: { id: "linkzy_generaliste", name: "Généraliste", emoji: "📺" },
  sports: { id: "linkzy_sport", name: "Sport", emoji: "⚽" },
  movies: { id: "linkzy_cinema", name: "Cinéma", emoji: "🎬" },
  chaines_info: { id: "linkzy_info", name: "Informations", emoji: "📰" },
  chaines_jeunesse: { id: "linkzy_jeunesse", name: "Jeunesse", emoji: "👶" },
};

// HTTPS Agent for Sosplay — DNS Cloudflare (1.1.1.1) pour contourner le blocage FAI
const https = require("https");
const dns = require("dns");
const cloudflareDns = new dns.Resolver();
cloudflareDns.setServers(["1.1.1.1", "1.0.0.1"]);

const cloudflareLookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  cloudflareDns.resolve4(hostname, (err, addresses) => {
    if (err) return callback(err);
    if (options.all) {
      callback(
        null,
        addresses.map((addr) => ({ address: addr, family: 4 })),
      );
    } else {
      callback(null, addresses[0], 4);
    }
  });
};

const SOSPLAY_HTTPS_AGENT = new https.Agent({
  rejectUnauthorized: false,
  lookup: cloudflareLookup,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const STREAM_PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LIVE_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const CACHE_DIR = path.join(__dirname, "cache", "tvdirect");
const CACHE_EXPIRATION_HOURS = 24; // Cache expire après 24h

// Headers Stremio pour les requêtes (principalement TV Direct)
const STREMIO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Stremio/4.4.162 Chrome/114.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Origin: "https://app.strem.io",
  Referer: "https://app.strem.io/",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
};

// In-memory M3U cache to avoid re-reading/re-parsing on every request
let m3uCache = null;
let m3uCacheTime = 0;
const M3U_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Parse local M3U file (cached)
 */
async function parseM3u() {
  return [];
  // Return cached data if still fresh
  if (m3uCache && Date.now() - m3uCacheTime < M3U_CACHE_TTL) {
    return m3uCache;
  }
  try {
    const content = await fsp.readFile(M3U_PATH, "utf8");
    const lines = content.split(/\r?\n/);
    const channels = [];
    let currentChannel = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("#EXTINF:")) {
        currentChannel = {};
        // Parse attributes
        const attrs = trimmed.match(/([a-zA-Z0-9-]+)="([^"]*)"/g);
        if (attrs) {
          for (const attr of attrs) {
            const [key, val] = attr.split("=");
            const value = val.replace(/"/g, "");
            if (key === "tvg-id") currentChannel.id = value;
            if (key === "tvg-name") currentChannel.name = value;
            if (key === "tvg-logo") currentChannel.logo = value;
            if (key === "tvg-poster") currentChannel.poster = value;
            if (key === "group-title") currentChannel.group = value;
            if (key === "tvg-back") currentChannel.background = value;
          }
        }

        // Name after comma
        const commaIndex = trimmed.lastIndexOf(",");
        if (commaIndex !== -1) {
          currentChannel.title = trimmed.substring(commaIndex + 1).trim();
        } else {
          currentChannel.title = currentChannel.name || "Unknown";
        }
      } else if (!trimmed.startsWith("#") && currentChannel) {
        currentChannel.stream = trimmed;
        // If no ID, generate one from title
        if (!currentChannel.id) {
          currentChannel.id = currentChannel.title.replace(/[^a-zA-Z0-9]/g, "");
        }
        channels.push(currentChannel);
        currentChannel = null; // Reset for next channel
      }
    }
    // Cache the parsed result
    m3uCache = channels;
    m3uCacheTime = Date.now();
    return channels;
  } catch (error) {
    console.error("[M3U] Error parsing france.m3u:", error.message);
    return [];
  }
}

function normalizeTvmioImageKey(value) {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.(fr|be|ch|ca|uk|us)$/g, " ")
    .replace(/\b(fr|fhd|uhd|hd|sd|4k)\b/g, " ")
    .replace(/[|_\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTvmioCatalogMetas(catalogId) {
  const cacheKey = generateCacheKey(`tvmio_remote_catalog_v2_${catalogId}`);
  const cached = await getFromCache(cacheKey, 24);
  if (cached) return cached;

  try {
    const categoryConfig = TVMIO_CATEGORIES[catalogId];
    if (!categoryConfig?.remoteGenre) {
      return [];
    }

    const encodedGenre = encodeURIComponent(categoryConfig.remoteGenre);
    const url = `${TVMIO_BASE_URL}/catalog/tv/tvmio-fr/genre=${encodedGenre}.json`;
    const response = await axios.get(url, {
      headers: STREMIO_HEADERS,
      timeout: 12000,
    });

    const metas = Array.isArray(response.data?.metas)
      ? response.data.metas
      : [];
    await saveToCache(cacheKey, metas);
    return metas;
  } catch (error) {
    console.warn(
      `[TVMIO] Unable to fetch remote catalog images for ${catalogId}: ${error.message}`,
    );
    return [];
  }
}

function buildTvmioImagesMap(remoteMetas) {
  const imageMap = new Map();

  for (const meta of remoteMetas) {
    const imageData = {
      poster: meta?.poster || null,
      logo: meta?.logo || null,
      background: meta?.background || null,
    };

    const normalizedId = normalizeTvmioImageKey(meta?.id);
    const normalizedName = normalizeTvmioImageKey(meta?.name);

    if (normalizedId) imageMap.set(`id:${normalizedId}`, imageData);
    if (normalizedName) imageMap.set(`name:${normalizedName}`, imageData);
  }

  return imageMap;
}

function getTvmioRemoteImages(channel, imageMap) {
  const idRaw = channel?.id || "";
  const titleRaw = channel?.title || channel?.name || "";

  const idNormalized = normalizeTvmioImageKey(idRaw);
  const idBaseNormalized = normalizeTvmioImageKey(idRaw.split(".")[0]);
  const titleNormalized = normalizeTvmioImageKey(titleRaw);

  return (
    imageMap.get(`id:${idNormalized}`) ||
    imageMap.get(`id:${idBaseNormalized}`) ||
    imageMap.get(`name:${titleNormalized}`) || {
      poster: null,
      logo: null,
      background: null,
    }
  );
}

// === UTILITAIRES DE CACHE ===

// Créer le dossier de cache s'il n'existe pas
(async () => {
  try {
    await fsp.access(CACHE_DIR);
  } catch {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    console.log("✅ Live TV cache directory created");
  }
})();

/**
 * Génère une clé de cache MD5 basée sur les paramètres
 */
function generateCacheKey(params) {
  const stringParams =
    typeof params === "string" ? params : JSON.stringify(params);
  return crypto.createHash("md5").update(stringParams).digest("hex");
}

/**
 * Récupère des données du cache avec vérification d'expiration
 */
async function getFromCache(key, expirationHours = CACHE_EXPIRATION_HOURS) {
  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileTime = stats.mtime.getTime();
    const expirationTime = expirationHours * 60 * 60 * 1000;

    if (now - fileTime > expirationTime) {
      return null; // Cache expiré
    }

    const cacheData = JSON.parse(await fsp.readFile(cacheFilePath, "utf8"));
    return cacheData;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    console.error(`[LIVETV CACHE] Erreur lecture cache ${key}:`, error.message);
    return null;
  }
}

/**
 * Récupère des données du cache avec expiration en millisecondes
 */
async function getFromCacheMs(key, expirationMs = 30000) {
  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileTime = stats.mtime.getTime();

    if (now - fileTime > expirationMs) {
      return null; // Cache expiré
    }

    const cacheData = JSON.parse(await fsp.readFile(cacheFilePath, "utf8"));
    return cacheData;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    console.error(`[LIVETV CACHE] Erreur lecture cache ${key}:`, error.message);
    return null;
  }
}

/**
 * Sauvegarde des données en cache
 */
async function saveToCache(key, data) {
  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    await fsp.writeFile(cacheFilePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error(
      `[LIVETV CACHE] Erreur sauvegarde cache ${key}:`,
      error.message,
    );
    return false;
  }
}

/**
 * Résout l'URL de lecture pour obtenir le lien m3u8 final
 * Suit les redirections et récupère le header Location
 */
async function resolvePlayUrl(playUrl) {
  try {
    const response = await axios.get(playUrl, {
      headers: STREMIO_HEADERS,
      timeout: 10000,
      maxRedirects: 0, // Ne pas suivre les redirections automatiquement
      validateStatus: (status) => status >= 200 && status < 400, // Accepter 2xx et 3xx
    });

    // Si c'est une redirection (302, 301), récupérer le header Location
    if (response.status === 302 || response.status === 301) {
      return response.headers.location || null;
    }

    // Sinon retourner l'URL originale (peut-être déjà un m3u8)
    return playUrl;
  } catch (error) {
    // Si erreur avec response (ex: 302), essayer de récupérer Location
    if (
      error.response &&
      (error.response.status === 302 || error.response.status === 301)
    ) {
      return error.response.headers.location || null;
    }
    console.error(`[LIVETV] Erreur résolution URL ${playUrl}:`, error.message);
    return null;
  }
}

// === WITV (WIFLIX) SCRAPING FUNCTIONS ===

/**
 * Scrape les chaînes disponibles depuis une catégorie Witv
 */
async function scrapeWitvChannels(categoryKey) {
  try {
    const pathUrl = WITV_CATEGORIES[categoryKey];
    if (!pathUrl) {
      console.log(`[WITV] Unknown category: ${categoryKey}`);
      return [];
    }

    const fullUrl = `${WITV_BASE_URL}${pathUrl}`;
    console.log(`[WITV] Scraping category ${categoryKey} from ${fullUrl}`);

    const response = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 15000,
      httpAgent: WITV_PROXY_AGENT,
      httpsAgent: WITV_PROXY_AGENT,
    });

    const $ = cheerio.load(response.data);
    const channels = [];

    console.log(`[WITV] Page loaded, length: ${response.data.length} bytes`);

    // Pattern 1: .holographic-card with .ann-short_price for name
    $(".holographic-card").each((index, element) => {
      const $el = $(element);

      // Name: .ann-short_price
      const name = $el.find(".ann-short_price").text().trim();

      // Link: a href
      const link = $el.find("a").attr("href");

      if (name && link) {
        // Extract ID from link (e.g. .../40-mtv.html -> 40)
        const idMatch = link.match(/\/(\d+)-/);
        if (idMatch) {
          const id = idMatch[1];
          // Also extract the slug for the channel page URL
          const slugMatch = link.match(/\/(\d+-[^\/]+\.html)$/);
          const pageSlug = slugMatch ? slugMatch[1] : null;
          channels.push({
            id: `wiflix_${id}`,
            type: "tv",
            name: name,
            poster: null,
            genres: [categoryKey.replace("wiflix_", "")],
            _pageSlug: pageSlug, // Store for stream resolution
          });
        }
      }
    });

    console.log(
      `[WITV] Pattern 1 (.holographic-card): found ${channels.length} channels`,
    );

    // Pattern 2 fallback: Look for .e-grid-cat or similar grid structures
    if (channels.length === 0) {
      console.log("[WITV] Trying Pattern 2 (.e-grid-cat)...");
      $(".e-grid-cat a, .grid-item a, .channel-item a").each(
        (index, element) => {
          const $el = $(element);
          const link = $el.attr("href");
          const name =
            $el.find(".ann-short_price, .channel-name, .title").text().trim() ||
            $el.text().trim();

          if (name && link) {
            const idMatch = link.match(/\/(\d+)-/);
            if (idMatch) {
              const id = idMatch[1];
              if (!channels.find((c) => c.id === `wiflix_${id}`)) {
                const slugMatch = link.match(/\/(\d+-[^\/]+\.html)$/);
                const pageSlug = slugMatch ? slugMatch[1] : null;
                channels.push({
                  id: `wiflix_${id}`,
                  type: "tv",
                  name: name,
                  poster: null,
                  genres: [categoryKey.replace("wiflix_", "")],
                  _pageSlug: pageSlug,
                });
              }
            }
          }
        },
      );
      console.log(`[WITV] Pattern 2: found ${channels.length} channels`);
    }

    // Pattern 3: Ultra-simple - find all links with /ID-slug pattern
    if (channels.length === 0) {
      console.log("[WITV] Trying Pattern 3 (regex on all links)...");
      const html = response.data;
      const linkRegex = /href="[^"]*\/(\d+)-([^"\.]+)/gi;
      let match;
      const seenIds = new Set();

      while ((match = linkRegex.exec(html)) !== null) {
        const id = match[1];
        const slug = match[2];

        // Convert slug to readable name
        const name = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());

        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          channels.push({
            id: `wiflix_${id}`,
            type: "tv",
            name: name,
            poster: null,
            genres: [categoryKey.replace("wiflix_", "")],
            _pageSlug: `${id}-${slug}.html`,
          });
        }
      }
      console.log(`[WITV] Pattern 3: found ${channels.length} channels`);
    }

    // Debug: Log HTML preview if no channels found
    if (channels.length === 0) {
      console.log("[WITV] No channels found! HTML preview:");
      console.log(response.data.substring(0, 2000));
    }

    console.log(
      `[WITV] Total scraped ${channels.length} channels for ${categoryKey}`,
    );
    return channels;
  } catch (error) {
    console.error(`[WITV] Error scraping ${categoryKey}:`, error.message);
    return [];
  }
}

/**
 * Trouve l'URL de la page d'une chaîne Witv à partir de son ID
 */
async function findWitvChannelPageUrl(channelId) {
  // channelId format: wiflix_XX (ex: wiflix_23)
  const id = channelId.replace("wiflix_", "");

  // Chercher dans le cache des catalogues
  for (const categoryKey of Object.keys(WITV_CATEGORIES)) {
    const catalogCacheKey = generateCacheKey(`catalog_tv_${categoryKey}`);
    const catalogCache = await getFromCache(catalogCacheKey, 24);

    if (catalogCache && catalogCache.metas) {
      const channel = catalogCache.metas.find((m) => m.id === channelId);
      if (channel && channel._pageSlug) {
        // Déterminer la catégorie pour construire l'URL complète
        const categoryPath = WITV_CATEGORIES[categoryKey];
        return `${WITV_BASE_URL}${categoryPath}${channel._pageSlug}`;
      }
    }
  }

  // Fallback: Si pas trouvé dans le cache, chercher dynamiquement
  console.log(`[WITV] Channel ${channelId} not found in cache, searching...`);

  for (const [categoryKey, pathUrl] of Object.entries(WITV_CATEGORIES)) {
    try {
      const fullUrl = `${WITV_BASE_URL}${pathUrl}`;
      const response = await axios.get(fullUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        timeout: 10000,
        httpAgent: WITV_PROXY_AGENT,
        httpsAgent: WITV_PROXY_AGENT,
      });

      // Chercher le lien de la chaîne avec l'ID correspondant
      const regex = new RegExp(`href="([^"]*/${id}-[^"\.]+\.html)"`, "i");
      const match = response.data.match(regex);

      if (match) {
        const channelPath = match[1];
        return channelPath.startsWith("http")
          ? channelPath
          : `${WITV_BASE_URL}${channelPath}`;
      }
    } catch (e) {
      console.warn(`[WITV] Error searching in ${categoryKey}: ${e.message}`);
    }
  }

  return null;
}

/**
 * Résout le lien m3u8 pour une chaîne Witv
 * Gère 2 types d'embeds: witv-player.php et livehdtv.com
 */
async function resolveWitvStream(channelId) {
  try {
    console.log(`[WITV] Resolving stream for channel ${channelId}`);

    // Étape 1: Trouver l'URL de la page de la chaîne
    const channelPageUrl = await findWitvChannelPageUrl(channelId);

    if (!channelPageUrl) {
      console.warn(`[WITV] Could not find page URL for ${channelId}`);
      return null;
    }

    console.log(`[WITV] Channel page URL: ${channelPageUrl}`);

    // Étape 2: Récupérer la page de la chaîne
    const pageResponse = await axios.get(channelPageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: WITV_BASE_URL,
      },
      timeout: 15000,
      httpAgent: WITV_PROXY_AGENT,
      httpsAgent: WITV_PROXY_AGENT,
    });

    const $ = cheerio.load(pageResponse.data);

    // Étape 3: Trouver l'iframe embed
    const iframe = $("iframe").first();
    let embedSrc = iframe.attr("src");

    if (!embedSrc) {
      console.warn(`[WITV] No iframe found on page ${channelPageUrl}`);
      return null;
    }

    console.log(`[WITV] Found embed iframe: ${embedSrc}`);

    // Étape 4: Gérer les différents types d'embeds

    // Type 1: witv-player.php (ex: /player/playerjs/witv-player.php?id=20)
    if (embedSrc.includes("witv-player.php")) {
      const playerUrl = embedSrc.startsWith("http")
        ? embedSrc
        : `${WITV_BASE_URL}${embedSrc}`;
      console.log(`[WITV] Type 1: witv-player detected, fetching ${playerUrl}`);

      const playerResponse = await axios.get(playerUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: channelPageUrl,
        },
        timeout: 15000,
        httpAgent: WITV_PROXY_AGENT,
        httpsAgent: WITV_PROXY_AGENT,
      });

      const html = playerResponse.data;

      // Chercher: var streamUrl = "..."
      const streamMatch = html.match(/var\s+streamUrl\s*=\s*["']([^"']+)["']/);
      if (streamMatch && streamMatch[1]) {
        console.log(`[WITV] Found streamUrl: ${streamMatch[1]}`);
        return streamMatch[1];
      }

      // Alternative: chercher file: "..." (JWPlayer setup)
      const fileMatch = html.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/);
      if (fileMatch && fileMatch[1]) {
        console.log(`[WITV] Found JWPlayer file: ${fileMatch[1]}`);
        return fileMatch[1];
      }

      console.warn(`[WITV] No stream URL found in witv-player`);
      return null;
    }

    // Type 2: livehdtv.com (ex: https://www.livehdtv.com/yayin/?kanal=182)
    if (embedSrc.includes("livehdtv.com")) {
      console.log(`[WITV] Type 2: livehdtv detected, following embed chain...`);

      // Use Cloudflare proxy to bypass 403
      const proxiedLivehdtvUrl = `${CF_PROXY_403}${encodeURIComponent(embedSrc)}`;

      // Étape 4a: Récupérer la page livehdtv/yayin
      const livehdtvResponse = await axios.get(proxiedLivehdtvUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://www.livehdtv.com/",
        },
        timeout: 15000,
      });

      const $livehdtv = cheerio.load(livehdtvResponse.data);
      const innerIframe = $livehdtv("iframe").first();
      let tokenPhpUrl = innerIframe.attr("src");

      if (!tokenPhpUrl) {
        console.warn(`[WITV] No inner iframe found in livehdtv page`);
        return null;
      }

      console.log(`[WITV] Found token.php iframe: ${tokenPhpUrl}`);

      // Étape 4b: Récupérer la page token.php (contient le JWPlayer avec le m3u8)
      if (!tokenPhpUrl.startsWith("http")) {
        tokenPhpUrl = `https://www.livehdtv.com${tokenPhpUrl}`;
      }

      // Use got-scraping to bypass Cloudflare protection for token.php
      const { gotScraping } = await import("got-scraping");
      const tokenResponse = await gotScraping({
        url: tokenPhpUrl,
        headers: {
          Referer: embedSrc, // Critical for validation
        },
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 120 }],
          devices: ["desktop"],
          locales: ["fr-FR", "en-US"],
          operatingSystems: ["windows"],
        },
      });

      const tokenHtml = tokenResponse.body;

      // Extraire: file: "https://livetvde.net/gulli/index.m3u8?token=..."
      const fileMatch = tokenHtml.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/);
      if (fileMatch && fileMatch[1]) {
        console.log(`[WITV] Found m3u8 from token.php: ${fileMatch[1]}`);
        return fileMatch[1];
      }

      console.warn(
        `[WITV] No m3u8 URL found in token.php response. Response preview:`,
      );
      console.log(tokenHtml.substring(0, 500));
      return null;
    }

    // Type inconnu: tenter d'extraire directement un m3u8
    console.log(
      `[WITV] Unknown embed type, attempting direct extraction from: ${embedSrc}`,
    );

    const unknownUrl = embedSrc.startsWith("http")
      ? embedSrc
      : `${WITV_BASE_URL}${embedSrc}`;
    const unknownResponse = await axios.get(unknownUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: channelPageUrl,
      },
      timeout: 15000,
      httpAgent: WITV_PROXY_AGENT,
      httpsAgent: WITV_PROXY_AGENT,
    });

    const unknownHtml = unknownResponse.data;

    // Chercher n'importe quel m3u8
    const m3u8Match = unknownHtml.match(
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/,
    );
    if (m3u8Match && m3u8Match[1]) {
      console.log(`[WITV] Found m3u8 via generic extraction: ${m3u8Match[1]}`);
      return m3u8Match[1];
    }

    console.warn(`[WITV] Could not extract stream URL from ${channelId}`);
    return null;
  } catch (error) {
    console.error(
      `[WITV] Error resolving stream for ${channelId}:`,
      error.message,
    );
    return null;
  }
}

// === SOSPLAY SCRAPING FUNCTIONS ===

/**
 * Scrape les chaînes disponibles depuis Sosplay
 */
async function scrapeSosplayChannels(categoryKey) {
  try {
    if (categoryKey !== "sosplay_chaines") {
      console.log(`[BOLALOCA] Unknown category: ${categoryKey}`);
      return [];
    }

    const channels = BOLALOCA_CHANNELS.map((channel) => ({
      id: `sosplay_${channel.id}`,
      type: "tv",
      name: channel.name,
      poster: channel.poster || null,
      genres: ["chaines"],
      _channelId: channel.id,
    }));

    console.log(
      `[BOLALOCA] Returning ${channels.length} static channels for ${categoryKey}`,
    );
    return channels;
  } catch (error) {
    console.error(`[BOLALOCA] Error building ${categoryKey}:`, error.message);
    return [];
  }
}

/**
 * Scrape les matchs disponibles depuis Sosplay (Football, etc.)
 */
function readFctvVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset: cursor };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error("Invalid protobuf varint");
    }
  }

  throw new Error("Unexpected protobuf EOF");
}

function fctvNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return value;
}

function fctvLooksText(value) {
  if (!value) return false;
  let printable = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 32 && code <= 126) || code >= 160) printable++;
  }
  return printable / value.length > 0.7;
}

function decodeFctvProtoMessage(input, depth = 0) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const tag = readFctvVarint(buffer, offset);
    offset = tag.offset;

    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    const entry = { field, wireType };

    if (wireType === 0) {
      const parsed = readFctvVarint(buffer, offset);
      offset = parsed.offset;
      entry.value = fctvNumber(parsed.value);
    } else if (wireType === 1) {
      entry.value = buffer.subarray(offset, offset + 8).toString("hex");
      offset += 8;
    } else if (wireType === 2) {
      const parsedLength = readFctvVarint(buffer, offset);
      offset = parsedLength.offset;
      const length = Number(parsedLength.value);
      const bytes = buffer.subarray(offset, offset + length);
      offset += length;

      const text = bytes.toString("utf8");
      if (fctvLooksText(text)) entry.value = text;

      if (depth < 6 && bytes.length > 0) {
        try {
          const children = decodeFctvProtoMessage(bytes, depth + 1);
          if (children.length > 0) entry.children = children;
        } catch {
          // Plain strings are also length-delimited; ignore decode failures.
        }
      }
    } else if (wireType === 5) {
      entry.value = buffer.subarray(offset, offset + 4).toString("hex");
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }

    fields.push(entry);
  }

  return fields;
}

function fctvFields(input) {
  return Array.isArray(input) ? input : input?.children || [];
}

function fctvFirst(input, field) {
  return fctvFields(input).find((entry) => entry.field === field);
}

function fctvAll(input, field) {
  return fctvFields(input).filter((entry) => entry.field === field);
}

function fctvValue(input, field) {
  return fctvFirst(input, field)?.value;
}

function fctvChildren(input, field) {
  return fctvFirst(input, field)?.children || [];
}

function fctvString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseFctvBody(data) {
  const root = decodeFctvProtoMessage(Buffer.from(data || []));
  return {
    status: fctvString(fctvValue(root, 3)),
    body: fctvChildren(root, 10),
  };
}

async function fetchFctvApi(pathname, params, options = {}) {
  // Build sfver prefix if bs keys are available
  const apiBase = await getFctvApiBase();
  let url = `${apiBase}${pathname}`;
  if (!options.skipSfver) {
    try {
      const bsKeys = await fetchFctvBsKeys(params?.sportType || 0);
      const sfver = buildFctvSfverPrefix(pathname, params, bsKeys);
      if (sfver) {
        url = `${apiBase}/${sfver}${pathname}`;
      }
    } catch (err) {
      console.warn(`[FCTV] sfver prefix failed, using direct path: ${err.message}`);
    }
  }

  return axios.get(url, {
    params,
    responseType: "arraybuffer",
    headers: FCTV_API_HEADERS,
    timeout: 15000,
  });
}

function parseFctvLocalizedName(fields) {
  const localizedName = fctvString(fctvValue(fctvChildren(fields, 3), 2));
  if (localizedName) return localizedName;
  return fctvString(fctvValue(fields, 2));
}

function parseFctvTeam(teamField) {
  const team = fctvChildren(teamField, 10);
  if (team.length === 0) return null;

  return {
    id: fctvNumber(fctvValue(team, 1)),
    name: parseFctvLocalizedName(team),
    logo: proxifyFctvImage(fctvString(fctvValue(team, 4))),
  };
}

function slugifyFctv(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatFctvTime(timestamp) {
  if (!timestamp) return "";
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function buildFctvMatchPageUrl(match) {
  const leagueSlug = match.leagueSlug || "football";
  const matchSlug = match.matchSlug || slugifyFctv(match.name);
  return `${FCTV_PLAYER_BASE_URL}/fr/${match.sportKey || "football"}/${leagueSlug}-${match.matchId}/${matchSlug}.html?icg=RlI&ilang=fr`;
}

// Embeddable upstream player. Loads the match's own server selector + handles
// the v3b tokenisation / service-worker / playback internally. This is the
// robust playback path (the masked stream URLs are token-gated and the token
// is computed client-side, so we cannot replay them server-side reliably).
// player.html expects: mdata = base64(`${matchId}_${sportType}`).
function buildFctvPlayerEmbedUrl(matchId, sportType, playerBase) {
  const base = playerBase || FCTV_PLAYER_BASE_URL;
  const mdata = Buffer.from(`${matchId}_${sportType}`, "utf8").toString("base64");
  return `${base}/fr/player.html?mdata=${encodeURIComponent(mdata)}&ilang=fr`;
}

// Auto-discover the current FCTV API base. The bio-link page hubu.ru/fctvlink
// points at the live front domain (rotates: .mom / .motorcycles / …), and that
// front's /fr page embeds the API base in its Nuxt SSR payload (unicode-escaped
// `apis-data-defra<N>.<host>`). Cached; on any failure falls back to the last
// good value / hardcoded default.
const FCTV_BIOLINK_URL =
  process.env.FCTV_BIOLINK_URL || "https://hubu.ru/fctvlink";
let fctvApiBaseCache = null;
let fctvApiBaseCacheTime = 0;
const FCTV_API_BASE_TTL = 30 * 60 * 1000; // 30 min
async function getFctvApiBase() {
  if (
    fctvApiBaseCache &&
    Date.now() - fctvApiBaseCacheTime < FCTV_API_BASE_TTL
  ) {
    return fctvApiBaseCache;
  }
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  try {
    // 1) bio-link page -> current front domain (the "FCTV33" button).
    const hub = await axios.get(FCTV_BIOLINK_URL, {
      headers: { "User-Agent": ua },
      timeout: 10000,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const front = [...String(hub.data).matchAll(/<a[^>]+href="([^"]+)"/gi)]
      .map((mm) => mm[1])
      .find((h) => /fctv33hd/i.test(h));
    if (!front) throw new Error("front domain not found on bio-link page");

    // 2) front /fr -> API base embedded (unicode-escaped) in the SSR payload.
    const idx = await axios.get(front.replace(/\/+$/, "") + "/fr", {
      headers: {
        "User-Agent": ua,
        Referer: new URL(FCTV_BIOLINK_URL).origin + "/",
      },
      timeout: 10000,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const html = String(idx.data).replace(/\\u002[fF]/g, "/");
    const m = html.match(/https?:\/\/apis-data-defra\d+\.[a-z0-9.-]+/i);
    if (!m) throw new Error("API base not found on front page");
    fctvApiBaseCache = m[0].replace(/\/+$/, "");
    fctvApiBaseCacheTime = Date.now();
    console.log(`[FCTV] Auto API base: ${fctvApiBaseCache} (via ${front})`);
    return fctvApiBaseCache;
  } catch (error) {
    console.warn(`[FCTV] API base auto-fetch failed: ${error.message}`);
    // Cache the fallback so we don't hammer hubu/front for the next TTL window.
    fctvApiBaseCache = fctvApiBaseCache || FCTV_API_BASE_URL;
    fctvApiBaseCacheTime = Date.now();
    return fctvApiBaseCache;
  }
}

// Auto-discover the current player origin (used for the embed iframe AND as the
// Referer for native streams) — same way the site does, from /api/common/params
// `iframePlayerDomains`. Cached; rotates upstream.
let fctvPlayerBaseCache = null;
let fctvPlayerBaseCacheTime = 0;
const FCTV_PLAYER_BASE_TTL = 30 * 60 * 1000; // 30 min
async function getFctvPlayerBaseUrl() {
  if (fctvPlayerBaseCache && Date.now() - fctvPlayerBaseCacheTime < FCTV_PLAYER_BASE_TTL) {
    return fctvPlayerBaseCache;
  }
  try {
    const apiBase = await getFctvApiBase();
    const response = await axios.get(`${apiBase}/api/common/params`, {
      responseType: "arraybuffer",
      headers: FCTV_API_HEADERS,
      timeout: 10000,
    });
    // params is rot47'd, and iframePlayerDomains sits inside a nested (escaped)
    // JSON string — strip backslashes so the list is matchable.
    const decoded = rot47(Buffer.from(response.data).toString("utf8")).replace(/\\/g, "");
    const domains = [];
    const re = /"iframePlayerDomains"\s*:\s*\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(decoded))) {
      for (const part of m[1].split(",")) {
        const host = part.replace(/[\\"\s]/g, "");
        if (host && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) domains.push(host);
      }
    }
    if (domains.length) {
      fctvPlayerBaseCache = `https://${domains[0]}`;
      fctvPlayerBaseCacheTime = Date.now();
      console.log(`[FCTV] Auto player origin: ${fctvPlayerBaseCache} (${domains.length} candidates)`);
      return fctvPlayerBaseCache;
    }
  } catch (error) {
    console.warn(`[FCTV] Player origin auto-fetch failed: ${error.message}`);
  }
  return fctvPlayerBaseCache || FCTV_PLAYER_BASE_URL;
}

function parseFctvMatch(matchField, categoryConfig, streamCountByMatchId, streamsByMatchId) {
  const fields = fctvFields(matchField);
  const matchId = fctvNumber(fctvValue(fields, 1));
  if (!matchId) return null;

  const sportType = fctvNumber(fctvValue(fields, 2)) || categoryConfig.sportType;
  const timestamp = fctvNumber(fctvValue(fields, 3)) || 0;
  const statusCode = fctvNumber(fctvValue(fields, 4));
  const league = fctvChildren(fields, 10);
  const country = fctvChildren(league, 80);
  const matchParts = fctvAll(fields, 30);
  const matchName =
    fctvString(fctvValue(fctvFields(matchParts[0]), 2)) ||
    matchParts.map(parseFctvTeam).filter(Boolean).map((team) => team.name).join(" vs ");
  const teams = matchParts.map(parseFctvTeam).filter(Boolean);
  const extra = fctvChildren(fields, 150);
  const matchSlug = fctvString(fctvValue(extra, 20)) || slugifyFctv(matchName);
  const leagueSlug = fctvString(fctvValue(extra, 21)) || slugifyFctv(parseFctvLocalizedName(league));
  const now = Date.now();
  const recentlyStarted =
    timestamp > 0 && timestamp <= now && now - timestamp < 4 * 60 * 60 * 1000;
  const isLive = Number(statusCode) >= 10000 || recentlyStarted;
  const serverCount = streamCountByMatchId.get(Number(matchId)) || 0;
  const matchStreams = streamsByMatchId.get(Number(matchId)) || [];
  const parsedMatch = {
    matchId,
    sportKey: categoryConfig.sportKey,
    name: matchName || `Match ${matchId}`,
    leagueSlug,
    matchSlug,
  };

  return {
    id: `match_fctv_${matchId}_sport_${sportType}`,
    type: "tv",
    name: parsedMatch.name,
    poster: teams[0]?.logo || teams[1]?.logo || proxifyFctvImage(fctvString(fctvValue(league, 4))) || "",
    genres: [categoryConfig.name.toLowerCase()],
    _pageUrl: buildFctvMatchPageUrl(parsedMatch),
    _timestamp: timestamp || undefined,
    _timeText: formatFctvTime(timestamp),
    _competition: parseFctvLocalizedName(league),
    _leagueLogo: proxifyFctvImage(fctvString(fctvValue(league, 4))),
    _country: parseFctvLocalizedName(country),
    _countryLogo: proxifyFctvImage(fctvString(fctvValue(country, 4))),
    _homeTeam: teams[0]?.name || "",
    _awayTeam: teams[1]?.name || "",
    _homeLogo: teams[0]?.logo || "",
    _awayLogo: teams[1]?.logo || "",
    _isLive: isLive,
    _status: isLive ? "live" : "upcoming",
    _serverCount: serverCount,
    _servers: matchStreams,
    _sport: categoryConfig.name,
    _sportKey: categoryConfig.sportKey,
    _sportType: sportType,
    _emoji: categoryConfig.emoji,
  };
}

function parseFctvStreamFields(fields) {
  return {
    id: fctvNumber(fctvValue(fields, 1)),
    sportType: fctvNumber(fctvValue(fields, 2)),
    name: fctvString(fctvValue(fields, 3)),
    rawUrl: fctvString(fctvValue(fields, 4)),
    status: fctvNumber(fctvValue(fields, 5)),
    order: fctvNumber(fctvValue(fields, 8)),
    siteType: fctvNumber(fctvValue(fields, 9)) || FCTV_DEFAULT_SITE_TYPE,
    streamStatus: fctvNumber(fctvValue(fields, 11)),
    flag: fctvNumber(fctvValue(fields, 30)),
    matchId: fctvNumber(fctvValue(fields, 50)),
  };
}

function parseFctvStream(streamField) {
  return parseFctvStreamFields(fctvFields(streamField));
}

async function scrapeFctvMatches(categoryKey) {
  try {
    const categoryConfig = FCTV_MATCHES_CATEGORIES[categoryKey];
    if (!categoryConfig) {
      console.log(`[FCTV-MATCHES] Unknown category: ${categoryKey}`);
      return [];
    }

    console.log(`[FCTV-MATCHES] Fetching live matches for ${categoryKey}`);
    const response = await fetchFctvApi("/api/match/live", {
      language: FCTV_LANGUAGE_FR,
      sportType: categoryConfig.sportType,
      stream: true,
    });
    const { body } = parseFctvBody(response.data);
    const streamCountByMatchId = new Map();
    const streamsByMatchId = new Map();

    for (const streamRef of fctvAll(body, 2)) {
      try {
        const streamObj = parseFctvStreamFields(fctvFields(streamRef));
        const matchId = Number(streamObj.matchId);
        if (matchId) {
          streamCountByMatchId.set(
            matchId,
            (streamCountByMatchId.get(matchId) || 0) + 1,
          );

          if (!streamsByMatchId.has(matchId)) {
            streamsByMatchId.set(matchId, []);
          }
          streamsByMatchId.get(matchId).push({
            id: streamObj.id || Math.floor(Math.random() * 100000),
            name: streamObj.name || `Serveur ${streamObj.id || "Auto"}`,
            siteType: streamObj.siteType,
            sportType: streamObj.sportType,
          });
        }
      } catch (err) {
        console.warn("[FCTV-MATCHES] Error parsing stream ref in list:", err.message);
      }
    }

    const matches = fctvAll(body, 1)
      .map((matchField) =>
        parseFctvMatch(matchField, categoryConfig, streamCountByMatchId, streamsByMatchId),
      )
      .filter(Boolean)
      .sort((a, b) => {
        if (a._isLive && !b._isLive) return -1;
        if (!a._isLive && b._isLive) return 1;
        return (a._timestamp || 0) - (b._timestamp || 0);
      });

    console.log(`[FCTV-MATCHES] Loaded ${matches.length} matches`);
    return matches;
  } catch (error) {
    console.error(`[FCTV-MATCHES] Error fetching ${categoryKey}:`, error.message);
    return [];
  }
}

async function fetchFctvMatchDetail(matchId, sportType = 1) {
  const response = await fetchFctvApi("/api/match/detail", {
    language: FCTV_LANGUAGE_FR,
    matchId,
    sportType,
    stream: true,
  });
  const { body } = parseFctvBody(response.data);

  return {
    match: fctvAll(body, 1)[0] || null,
    streams: fctvAll(body, 2)
      .map(parseFctvStream)
      .filter((stream) => stream.id && stream.name),
  };
}

function rot47(value) {
  return String(value || "")
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 33 || code > 126) return char;
      return String.fromCharCode(33 + ((code - 33 + 47) % 94));
    })
    .join("");
}

// Decode the masked stream URL from /api/stream/detail.
// Format: <8-char per-request nonce> + rot47(originUrl); slice(8) drops the nonce.
// The resulting origin URL is referer-ACL / token gated upstream (the token is
// computed client-side by the player's service-worker), so this is only a
// best-effort "native" source — the embed player is the reliable path.
function decodeFctvStreamUrl(maskedUrl) {
  if (!maskedUrl) return null;
  try {
    const decoded = rot47(maskedUrl).slice(8);
    new URL(decoded); // validate it parsed to a real URL
    return decoded;
  } catch {
    return null;
  }
}

// token = base64( rbSession XOR keystream ) + "a", URL-encoded.
function makeFctvToken(rbSession) {
  const pt = Buffer.from(String(rbSession || ""), "utf8");
  if (!pt.length) return null;
  const n = Math.min(pt.length, FCTV_TOKEN_KEYSTREAM.length);
  const ct = Buffer.alloc(n);
  for (let i = 0; i < n; i++) ct[i] = pt[i] ^ FCTV_TOKEN_KEYSTREAM[i];
  return encodeURIComponent(`${ct.toString("base64")}a`);
}

// Resolve the upstream tokenised playlist for a single server (fresh rb-session
// + token). Cached briefly so HLS live-edge re-fetches don't hammer the API.
const fctvUpstreamCache = new Map(); // `${matchId}_${streamId}_${siteType}` -> { data, time }
const FCTV_UPSTREAM_TTL = 20 * 1000;
async function resolveFctvUpstreamPlaylist(streamId, siteType, matchId, sportType, forceFresh = false) {
  const key = `${matchId}_${streamId}_${siteType}`;
  if (forceFresh) {
    fctvUpstreamCache.delete(key);
  } else {
    const cached = fctvUpstreamCache.get(key);
    if (cached && Date.now() - cached.time < FCTV_UPSTREAM_TTL) return cached.data;
  }

  // Unsigned call with continent/country/digit => returns the `rb-session`
  // header and a masked URL that decodes to the proxy m3u8 path. No
  // `usls`/`language` and no sfver prefix here.
  const response = await fetchFctvApi(
    "/api/stream/detail",
    {
      streamId,
      siteType: siteType || FCTV_DEFAULT_SITE_TYPE,
      continent: FCTV_GEO_CONTINENT,
      country: FCTV_GEO_COUNTRY,
      digit: FCTV_STREAM_DIGIT,
      matchId,
      sportType,
    },
    { skipSfver: true },
  );

  const { body } = parseFctvBody(response.data);
  const streamBody = fctvChildren(body, 2).length ? fctvChildren(body, 2) : body;
  const detail = parseFctvStreamFields(streamBody);
  const proxyUrl = decodeFctvStreamUrl(detail.rawUrl);
  const rbSession = response.headers["rb-session"];
  if (!proxyUrl || !rbSession) return null;

  const token = makeFctvToken(rbSession);
  const u = new URL(proxyUrl);
  const data = {
    origin: u.origin,
    token,
    playlistUrl: `${u.origin}/token-${token}${u.pathname}${u.search}`,
  };
  fctvUpstreamCache.set(key, { data, time: Date.now() });
  return data;
}

function extractFctvMatchAndStreamId(channelId) {
  const match = String(channelId || "").match(/^match_(?:fctv_)?(\d+)(?:_sport_(\d+))?(?:_stream_([a-zA-Z0-9_]+))?$/);
  if (!match) return { matchId: null, sportType: 1, streamId: null };
  return {
    matchId: Number(match[1]),
    sportType: match[2] ? Number(match[2]) : 1,
    streamId: match[3] || null,
  };
}

function extractFctvMatchId(channelId) {
  const { matchId } = extractFctvMatchAndStreamId(channelId);
  return matchId;
}

async function resolveFctvMatchStream(channelId) {
  const { matchId, sportType } = extractFctvMatchAndStreamId(channelId);
  if (!matchId) {
    console.warn(`[FCTV-MATCHES] Invalid match id: ${channelId}`);
    return [];
  }

  const playerBase = await getFctvPlayerBaseUrl();
  const streams = [];

  // 1. Native HLS servers (from match/detail). Each plays via the FCTV
  //    smart-playlist endpoint, which resolves a fresh token and proxies the
  //    Referer-gated segments. First in the picker => HLSPlayer is the default.
  try {
    const detail = await fetchFctvMatchDetail(matchId, sportType);
    const servers = detail.streams
      .filter((stream) => stream.id && stream.siteType)
      .sort((a, b) => {
        const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 9999;
        const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 9999;
        return orderA - orderB;
      });

    for (const server of servers) {
      streams.push({
        id: server.id,
        title: server.name || `Serveur ${server.id}`,
        _fctvNative: {
          matchId,
          streamId: server.id,
          siteType: server.siteType || FCTV_DEFAULT_SITE_TYPE,
          sportType: server.sportType || sportType,
        },
        behaviorHints: { notWebReady: false },
      });
    }
    console.log(`[FCTV-MATCHES] match ${matchId}: ${streams.length} native servers`);
  } catch (error) {
    console.warn(`[FCTV-MATCHES] match/detail failed for ${channelId}: ${error.message}`);
  }

  // 2. Embed player fallback — always works (its own server selector + SW).
  streams.push({
    id: "embed",
    title: "Lecteur intégré ⭐",
    url: buildFctvPlayerEmbedUrl(matchId, sportType, playerBase),
    _isEmbed: true,
    behaviorHints: { notWebReady: false },
  });

  return streams;
}

async function scrapeSosplayMatches(categoryKey) {
  try {
    const categoryConfig = SOSPLAY_MATCHES_CATEGORIES[categoryKey];
    if (!categoryConfig) {
      console.log(`[SOSPLAY-MATCHES] Unknown category: ${categoryKey}`);
      return [];
    }

    const fullUrl = `${SOSPLAY_BASE_URL}${categoryConfig.path}`;
    console.log(`[SOSPLAY-MATCHES] Scraping matches from ${fullUrl}`);

    const response = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 15000,
      httpsAgent: SOSPLAY_HTTPS_AGENT,
    });

    const $ = cheerio.load(response.data);
    const matches = [];
    const now = Date.now();

    console.log(
      `[SOSPLAY-MATCHES] Page loaded, length: ${response.data.length} bytes`,
    );

    // Parse each .row element containing a match
    $(".events .row").each((index, element) => {
      const $el = $(element);

      // Get match name (team1 - team2)
      const name = $el.find(".game-name span").text().trim();
      const link = $el.find(".game-name").attr("href");

      // Get timestamp from data-timestamp attribute
      const timeElement = $el.find("time.DISDATE");
      const timestamp = parseInt(timeElement.attr("data-timestamp")) || 0;
      const timeText = timeElement.text().trim();

      // Get competition/league name
      const houreText = $el.find(".houre").text().trim();
      const competitionMatch = houreText.match(/·\s*(.+)$/);
      const competition = competitionMatch ? competitionMatch[1].trim() : "";

      // Check if match is live (timestamp is in the past or has "Direct" link)
      const isLive =
        timestamp <= now || $el.find(".scdw a").text().includes("Direct");

      // Get countdown/status
      const countdownEl = $el.find(".scdw");
      const countdownText = countdownEl.text().trim();
      const status = countdownText.includes("Direct") ? "live" : "upcoming";

      // Get country flag from .map class
      const flagClass = $el.find(".map").attr("class") || "";
      const countryCode = flagClass.replace("map", "").trim();

      if (name && link) {
        // Create a unique ID from the link
        const slugMatch = link.match(/\/regarder-([^/]+)/);
        const slug = slugMatch
          ? slugMatch[1]
          : link.replace(/\//g, "-").replace(/^\//, "");

        matches.push({
          id: `match_${slug}`,
          type: "tv",
          name: name,
          poster: null,
          genres: [categoryConfig.name.toLowerCase()],
          _pageUrl: link.startsWith("http")
            ? link
            : `${SOSPLAY_BASE_URL}${link}`,
          _timestamp: timestamp,
          _timeText: timeText,
          _competition: competition,
          _isLive: isLive,
          _status: status,
          _countryCode: countryCode,
        });
      }
    });

    // Sort: Live matches first, then by timestamp (soonest first)
    matches.sort((a, b) => {
      if (a._isLive && !b._isLive) return -1;
      if (!a._isLive && b._isLive) return 1;
      return a._timestamp - b._timestamp;
    });

    console.log(
      `[SOSPLAY-MATCHES] Scraped ${matches.length} matches (${matches.filter((m) => m._isLive).length} live)`,
    );
    return matches;
  } catch (error) {
    console.error(
      `[SOSPLAY-MATCHES] Error scraping ${categoryKey}:`,
      error.message,
    );
    return [];
  }
}

/**
 * Récupère les serveurs disponibles pour un match Sosplay (French first, fallback to other languages)
 */
async function getSosplayMatchServers(matchPageUrl) {
  try {
    console.log(`[SOSPLAY-MATCHES] Getting servers from: ${matchPageUrl}`);

    const response = await axios.get(matchPageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: SOSPLAY_BASE_URL,
      },
      timeout: 15000,
      httpsAgent: SOSPLAY_HTTPS_AGENT,
    });

    const $ = cheerio.load(response.data);
    const frenchServers = [];
    const otherServers = [];

    // Language flag to emoji mapping
    const langEmojis = {
      fr: "🇫🇷",
      es: "🇪🇸",
      de: "🇩🇪",
      pt: "🇵🇹",
      it: "🇮🇹",
      gb: "🇬🇧",
      en: "🇬🇧",
    };

    // Parse .servideo div for server options
    $(".servideo .change-video").each((index, element) => {
      const $el = $(element);
      const name = $el.text().trim();
      const embedPath = $el.attr("data-embed");
      const imgAlt = $el.find("img").attr("alt") || "";

      if (embedPath) {
        // Extract channel and server IDs from path like "/part/Ll.php?id=1/46"
        const match = embedPath.match(/id=(\d+)\/(\d+)/);
        if (match) {
          const serverInfo = {
            name: name,
            channelNum: match[1],
            serverNum: match[2],
            embedPath: embedPath,
            language: imgAlt,
            langEmoji: langEmojis[imgAlt] || `[${imgAlt.toUpperCase()}]`,
          };

          // Separate French and other servers
          if (imgAlt === "fr") {
            frenchServers.push(serverInfo);
          } else {
            otherServers.push(serverInfo);
          }
        }
      }
    });

    console.log(
      `[SOSPLAY-MATCHES] Found ${frenchServers.length} French servers, ${otherServers.length} other servers`,
    );

    // If we have French servers, return them
    if (frenchServers.length > 0) {
      return frenchServers;
    }

    // Fallback: No French servers, get up to 3 servers from other languages
    // Prioritize by getting one of each type (Wigi, Hoca, Obcast) from same language if possible
    console.log(
      `[SOSPLAY-MATCHES] No French servers, falling back to other languages`,
    );

    // Group other servers by language
    const serversByLang = {};
    for (const server of otherServers) {
      if (!serversByLang[server.language]) {
        serversByLang[server.language] = [];
      }
      serversByLang[server.language].push(server);
    }

    // Find the language with most servers (likely the best coverage)
    let bestLang = null;
    let maxServers = 0;
    for (const [lang, servers] of Object.entries(serversByLang)) {
      if (servers.length > maxServers) {
        maxServers = servers.length;
        bestLang = lang;
      }
    }

    if (bestLang && serversByLang[bestLang]) {
      // Return up to 3 servers from the best language
      const fallbackServers = serversByLang[bestLang].slice(0, 3);
      console.log(
        `[SOSPLAY-MATCHES] Using ${fallbackServers.length} servers from language: ${bestLang}`,
      );
      return fallbackServers;
    }

    // Last resort: return first 3 servers from any language
    return otherServers.slice(0, 3);
  } catch (error) {
    console.error(`[SOSPLAY-MATCHES] Error getting servers:`, error.message);
    return [];
  }
}

/**
 * Résout le lien m3u8 pour un match Sosplay
 */
async function resolveSosplayMatchStream(matchId) {
  try {
    console.log(`[SOSPLAY-MATCHES] Resolving stream for match ${matchId}`);

    // Try to find the match page URL from cache first
    let matchPageUrl = null;

    // Check matches_football catalog cache
    for (const categoryKey of Object.keys(SOSPLAY_MATCHES_CATEGORIES)) {
      const catalogCacheKey = generateCacheKey(`catalog_tv_${categoryKey}`);
      const catalogCache = await getFromCache(catalogCacheKey, 1); // 1 hour cache

      if (catalogCache && catalogCache.metas) {
        const match = catalogCache.metas.find((m) => m.id === matchId);
        if (match && match._pageUrl) {
          matchPageUrl = match._pageUrl;
          break;
        }
      }
    }

    if (!matchPageUrl) {
      // Fallback: reconstruct URL from match ID
      const slug = matchId.replace("match_", "");
      matchPageUrl = `${SOSPLAY_BASE_URL}/regarder-${slug}`;
    }

    console.log(`[SOSPLAY-MATCHES] Match page URL: ${matchPageUrl}`);

    // Get available servers (French first, fallback to other languages)
    const servers = await getSosplayMatchServers(matchPageUrl);

    if (servers.length === 0) {
      console.warn(`[SOSPLAY-MATCHES] No servers found for ${matchId}`);
      return [];
    }

    // Collect streams from all servers
    const allStreams = [];

    for (const server of servers) {
      try {
        console.log(`[SOSPLAY-MATCHES] Trying server: ${server.name}`);

        // Fetch the intermediate embed page (e.g. /part/Ll.php?id=1/20)
        const embedUrl = `${SOSPLAY_BASE_URL}${server.embedPath}`;
        console.log(`[SOSPLAY-MATCHES] Fetching embed page: ${embedUrl}`);

        const embedPageResponse = await axios.get(embedUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Referer: matchPageUrl,
          },
          timeout: 15000,
          httpsAgent: SOSPLAY_HTTPS_AGENT,
        });

        const embedHtml = embedPageResponse.data;

        // Extract iframe src (e.g. /Zoz/1/20 or external URL)
        const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)/i);
        if (!iframeMatch) {
          console.warn(
            `[SOSPLAY-MATCHES] No iframe found in embed page response`,
          );
          continue;
        }

        let iframeSrc = iframeMatch[1];
        // Handle relative URLs
        if (iframeSrc.startsWith("/")) {
          iframeSrc = `${SOSPLAY_BASE_URL}${iframeSrc}`;
        }
        console.log(`[SOSPLAY-MATCHES] Found iframe: ${iframeSrc}`);

        // Résoudre les iframes imbriqués jusqu'au contenu final
        const resolved = await resolveNestedIframes(
          iframeSrc,
          embedUrl,
          3,
          "[SOSPLAY-MATCHES]",
        );
        if (!resolved) continue;

        const { html: finalHtml, finalUrl } = resolved;

        // Essayer les deux décodeurs
        let m3u8Url = null;
        if (
          server.name.toLowerCase().includes("hoca") ||
          finalUrl.includes("hoca")
        ) {
          console.log(`[SOSPLAY-MATCHES] Processing Hoca embed`);
          m3u8Url = decodeHocaStream(finalHtml);
        }
        if (!m3u8Url) {
          console.log(`[SOSPLAY-MATCHES] Processing Wigi/generic embed`);
          m3u8Url = decodeWigiStream(finalHtml);
        }

        if (m3u8Url) {
          console.log(`[SOSPLAY-MATCHES] Found stream: ${m3u8Url}`);
          allStreams.push({
            title: `${server.langEmoji || "🇫🇷"} ${server.name}`,
            url: m3u8Url,
            referer: finalUrl,
          });
        }
      } catch (serverError) {
        console.warn(
          `[SOSPLAY-MATCHES] Error with server ${server.name}:`,
          serverError.message,
        );
        continue;
      }
    }

    console.log(`[SOSPLAY-MATCHES] Total streams found: ${allStreams.length}`);
    return allStreams;
  } catch (error) {
    console.error(
      `[SOSPLAY-MATCHES] Error resolving stream for ${matchId}:`,
      error.message,
    );
    return [];
  }
}

/**
 * Récupère les serveurs disponibles pour une chaîne Sosplay
 */
async function getSosplayServers(channelPageUrl) {
  try {
    console.log(`[SOSPLAY] Getting servers from: ${channelPageUrl}`);

    const response = await axios.get(channelPageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: SOSPLAY_BASE_URL,
      },
      timeout: 15000,
      httpsAgent: SOSPLAY_HTTPS_AGENT,
    });

    const $ = cheerio.load(response.data);
    const servers = [];

    // Parse .servideo div for server options
    $(".servideo .change-video").each((index, element) => {
      const $el = $(element);
      const name = $el.text().trim();
      const embedPath = $el.attr("data-embed");

      if (embedPath) {
        // Extract channel and server IDs from path like "/part/Ll.php?id=1/20"
        const match = embedPath.match(/id=(\d+)\/(\d+)/);
        if (match) {
          servers.push({
            name: name,
            channelNum: match[1],
            serverNum: match[2],
            embedPath: embedPath,
          });
        }
      }
    });

    console.log(`[SOSPLAY] Found ${servers.length} servers`);
    return servers;
  } catch (error) {
    console.error(`[SOSPLAY] Error getting servers:`, error.message);
    return [];
  }
}

/**
 * Dean Edwards Packer unpacker
 * Decodes eval(function(p,a,c,k,e,d){...}) obfuscated JavaScript
 */
function unpackPacker(p, a, c, k, e, d) {
  e = function (c) {
    return (
      (c < a ? "" : e(parseInt(c / a))) +
      ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36))
    );
  };

  if (!"".replace(/^/, String)) {
    while (c--) {
      d[e(c)] = k[c] || e(c);
    }
    k = [
      function (e) {
        return d[e];
      },
    ];
    e = function () {
      return "\\w+";
    };
    c = 1;
  }

  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp("\\b" + e(c) + "\\b", "g"), k[c]);
    }
  }
  return p;
}

/**
 * Résout les iframes imbriqués jusqu'à trouver le contenu final (avec m3u8/player)
 * Chaîne: /part/Ll.php → /Zoz/1/20 → @sosplay_...html (contient le player)
 */
async function resolveNestedIframes(
  url,
  referer,
  maxDepth = 3,
  logPrefix = "[SOSPLAY]",
) {
  let currentUrl = url;
  let currentReferer = referer;

  for (let depth = 0; depth < maxDepth; depth++) {
    console.log(`${logPrefix} Resolving depth ${depth}: ${currentUrl}`);

    const response = await axios.get(currentUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Referer: currentReferer,
      },
      timeout: 15000,
      httpsAgent: SOSPLAY_HTTPS_AGENT,
    });

    const html = response.data;

    // Si on trouve un m3u8 ou un player, c'est la page finale
    if (
      html.includes(".m3u8") ||
      html.includes("Clappr") ||
      html.includes("eval(function(p,a,c,k,e,d)")
    ) {
      console.log(`${logPrefix} Found final content at depth ${depth}`);
      return { html, finalUrl: currentUrl, referer: currentReferer };
    }

    // Sinon chercher un iframe imbriqué
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)/i);
    if (!iframeMatch) {
      console.log(
        `${logPrefix} No more iframes at depth ${depth}, returning current content`,
      );
      return { html, finalUrl: currentUrl, referer: currentReferer };
    }

    let nextUrl = iframeMatch[1];
    if (nextUrl.startsWith("/")) {
      nextUrl = `${SOSPLAY_BASE_URL}${nextUrl}`;
    } else if (!nextUrl.startsWith("http")) {
      // URL relative au chemin courant
      const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf("/") + 1);
      nextUrl = `${baseUrl}${nextUrl}`;
    }

    console.log(`${logPrefix} Following nested iframe: ${nextUrl}`);
    currentReferer = currentUrl;
    currentUrl = nextUrl;
  }

  console.warn(`${logPrefix} Max depth reached without finding stream content`);
  return null;
}

function decodeWigiStream(html) {
  try {
    // Strategy 1: Look for ALL Dean Edwards Packer obfuscated code blocks
    const packerRegex =
      /eval\(function\(p,a,c,k,e,d\)\{.*?return p\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\),0,\{\}\)\)/gs;
    const packerMatches = [...html.matchAll(packerRegex)];

    for (let i = 0; i < packerMatches.length; i++) {
      const packerMatch = packerMatches[i];

      const payload = packerMatch[1];
      const radix = parseInt(packerMatch[2]);
      const count = parseInt(packerMatch[3]);
      const keywords = packerMatch[4].split("|");

      // Create empty dictionary object
      const d = {};

      // Unpack the code
      const decodedScript = unpackPacker(
        payload,
        radix,
        count,
        keywords,
        null,
        d,
      );

      // Check if this block contains Clappr/player or m3u8
      if (
        !decodedScript.includes("Clappr") &&
        !decodedScript.includes(".m3u8") &&
        !decodedScript.includes("hls")
      ) {
        continue;
      }

      // Extract m3u8 URLs from unpacked code
      const urlRegex = /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g;
      let urlMatch;
      const urls = [];

      while ((urlMatch = urlRegex.exec(decodedScript)) !== null) {
        let url = urlMatch[1];
        url = url.replace(/\\\//g, "/");
        urls.push(url);
      }

      if (urls.length > 0) {
        urls.forEach((url, idx) => console.log(`  ${idx + 1}. ${url}`));

        // Prefer vuunov/live URL (backup/direct) over shop/srvagu (P2P)
        const backupUrl = urls.find(
          (u) => u.includes("vuunov") || u.includes("live"),
        );
        const primaryUrl = urls.find(
          (u) => u.includes("shop") || u.includes("srvagu"),
        );

        // Return backup if available, otherwise primary
        return backupUrl || primaryUrl || urls[0];
      }
    }

    if (packerMatches.length === 0) {
    } else {
    }

    // Strategy 2: Direct src: pattern search
    const srcMatch = html.match(/src:\s*["']([^"']+\.m3u8[^"']*)/i);
    if (srcMatch) {
      let url = srcMatch[1];
      url = url.replace(/\\\//g, "/");
      return url;
    }

    // Strategy 3: Direct m3u8 URL search
    const streamMatch = html.match(/["'](https?:\/\/[^"']*\.m3u8[^"']*)/);
    if (streamMatch) {
      let url = streamMatch[1];
      url = url.replace(/\\\//g, "/");
      return url;
    }

    // Strategy 4: var src = "..." pattern
    const varSrcMatch = html.match(/var\s+src\s*=\s*["']([^"']+)/i);
    if (varSrcMatch && varSrcMatch[1].includes(".m3u8")) {
      let url = varSrcMatch[1];
      url = url.replace(/\\\//g, "/");
      return url;
    }

    return null;
  } catch (error) {
    return null;
  }
}

// Function to decode Hoca stream
function decodeHocaStream(html) {
  try {
    // Pattern from hoca.html: atob('...') contains the path
    const atobMatch = html.match(/atob\(['"]([^'"]+)['"]\)/);
    if (atobMatch) {
      const decoded = Buffer.from(atobMatch[1], "base64").toString("utf-8");
      console.log(`[SOSPLAY] Decoded atob: ${decoded}`);
    }

    // Look for telgHtrptU function which returns the full URL
    // Pattern: array of characters joined together
    const urlArrayMatch = html.match(/return\s*\(\[([^\]]+)\]\.join/);
    if (urlArrayMatch) {
      try {
        // Parse the array of characters
        const chars = urlArrayMatch[1].match(/"([^"]*)"/g);
        if (chars) {
          let url = chars.map((c) => c.replace(/"/g, "")).join("");
          // Fix escaped slashes (https:\/\/...)
          url = url.replace(/\\\//g, "/");

          if (url.includes(".m3u8")) {
            return url;
          }
        }
      } catch (e) {
        console.error("[SOSPLAY] Error parsing Hoca array:", e.message);
      }
    }

    // Direct m3u8 search
    const m3u8Match = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/);
    if (m3u8Match) {
      let url = m3u8Match[1];
      // Fix escaped slashes
      url = url.replace(/\\\//g, "/");
      return url;
    }

    return null;
  } catch (error) {
    console.error("[SOSPLAY] Error decoding Hoca stream:", error.message);
    return null;
  }
}

/**
 * Résout le lien m3u8 pour une chaîne Sosplay
 */
function buildLivePageHeaders(referer = null) {
  return {
    "User-Agent": LIVE_PAGE_USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    ...(referer ? { Referer: referer } : {}),
  };
}

function buildStreamProxyHeaders(
  referer,
  fallbackOrigin,
  userAgent = STREAM_PROXY_USER_AGENT,
) {
  const safeReferer = referer || fallbackOrigin;
  let origin = fallbackOrigin;

  try {
    origin = new URL(safeReferer).origin;
  } catch {
    origin = fallbackOrigin;
  }

  const headers = {
    "User-Agent": userAgent || STREAM_PROXY_USER_AGENT,
  };

  if (safeReferer) {
    headers.Referer = safeReferer;
  }

  if (origin) {
    headers.Origin = origin;
  }

  return headers;
}

function absolutizeLiveUrl(rawUrl, currentUrl = "", fallbackBase = "") {
  if (!rawUrl) return null;

  const normalized = String(rawUrl)
    .trim()
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\s+/g, "");

  if (!normalized) return null;

  if (normalized.startsWith("//")) {
    const protocol = currentUrl.startsWith("http://") ? "http:" : "https:";
    return `${protocol}${normalized}`;
  }

  try {
    return new URL(normalized, currentUrl || fallbackBase || undefined).href;
  } catch (error) {
    return null;
  }
}

function dedupeByKey(items, getKey) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function encodeUrlToken(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeUrlToken(value) {
  try {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4 || 4)) % 4;
    return Buffer.from(
      `${normalized}${"=".repeat(paddingLength)}`,
      "base64",
    ).toString("utf8");
  } catch (error) {
    return null;
  }
}

function revealPipeSplit(html) {
  const cleaned = String(html || "").replace(/\\/g, "");
  const results = [
    ...cleaned.matchAll(/return p\}\(([\s\S]*?),'([^']*)'\.split\('\|'\)/g),
  ];

  if (results.length === 0) {
    return "";
  }

  const numericMode = !/[a-j]\b/.test(cleaned);
  const tokenToInt = (token) => {
    if (numericMode) return Number(token);
    if (/^[a-z]$/.test(token)) return token.charCodeAt(0) - 87;
    if (/^[A-Z]$/.test(token)) return token.charCodeAt(0) - 29;
    if (/^\d$/.test(token)) return Number(token);
    return Number(token) + 52;
  };

  return results
    .map((match) => {
      const mask = match[1];
      const keywords = match[2].split("|");
      return mask.replace(/\b[0-9a-zA-Z]+\b/g, (token) => {
        const index = tokenToInt(token);
        return Number.isInteger(index) &&
          index < keywords.length &&
          keywords[index]
          ? keywords[index]
          : token;
      });
    })
    .join("\n");
}

function revealCharByCharUrl(html) {
  const cleaned = String(html || "").replace(/\\/g, "");
  const match = cleaned.match(/((?:".",)+".")\]\.join\(""\)/);
  if (!match) return "";

  return match[1]
    .split(",")
    .map((entry) => entry.replace(/"/g, ""))
    .join("");
}

function extractIframeUrlsFromHtml(html, currentUrl, fallbackBase = "") {
  const iframeUrls = [];
  const regex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(String(html || ""))) !== null) {
    const absoluteUrl = absolutizeLiveUrl(match[1], currentUrl, fallbackBase);
    if (absoluteUrl && !shouldIgnoreLiveTvIframeUrl(absoluteUrl)) {
      iframeUrls.push(absoluteUrl);
    }
  }

  return dedupeByKey(iframeUrls, (url) => url);
}

function shouldIgnoreLiveTvIframeUrl(rawUrl) {
  const normalizedUrl = String(rawUrl || "").trim();
  if (!normalizedUrl) {
    return true;
  }

  if (/^(?:about:blank|javascript:|data:)/i.test(normalizedUrl)) {
    return true;
  }

  try {
    const parsed = new URL(normalizedUrl, LIVETV_BASE_URL);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    const combined = `${hostname}${pathname}${search}`;

    if (
      hostname === "ads.livetv901.me" ||
      hostname.startsWith("ads.") ||
      hostname.startsWith("ad.")
    ) {
      return true;
    }

    if (pathname.includes("getbanner.php") || search.includes("zone_id=")) {
      return true;
    }

    if (
      /(?:^|[./_-])(banner|ads?|popunder|popup)(?:[./_-]|$)/i.test(combined)
    ) {
      return true;
    }
  } catch (error) {
    return false;
  }

  return false;
}

function shouldTreatLiveTvIframeAsTerminalEmbed(
  rawUrl,
  fallbackBase = LIVETV_BASE_URL,
) {
  const normalizedUrl = String(rawUrl || "").trim();
  if (!normalizedUrl) {
    return false;
  }

  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(normalizedUrl)) {
    return false;
  }

  try {
    const parsed = new URL(normalizedUrl, fallbackBase || LIVETV_BASE_URL);
    const fallbackHost = new URL(fallbackBase || LIVETV_BASE_URL).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
    const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();

    if (!hostname || !fallbackHost) {
      return false;
    }

    return hostname !== fallbackHost && !hostname.endsWith(`.${fallbackHost}`);
  } catch (error) {
    return false;
  }
}

function isLiveTvExportIframePage(rawUrl, fallbackBase = LIVETV_BASE_URL) {
  try {
    const parsed = new URL(rawUrl, fallbackBase || LIVETV_BASE_URL);
    return /\/export\/webplayer\.iframe\.php$/i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function shouldFollowLiveTvIframeForExtraction(
  iframeUrl,
  pageUrl,
  fallbackBase = LIVETV_BASE_URL,
) {
  try {
    const page = new URL(pageUrl, fallbackBase || LIVETV_BASE_URL);
    if (!isLiveTvExportIframePage(page.href, fallbackBase)) {
      return false;
    }

    if ((page.searchParams.get("t") || "").toLowerCase() !== "alieztv") {
      return false;
    }

    const iframe = new URL(iframeUrl, page.href);
    const hostname = iframe.hostname.replace(/^www\./i, "").toLowerCase();
    const pathname = iframe.pathname.toLowerCase();

    return hostname === "emb.apl395.me" && pathname === "/player/live.php";
  } catch (error) {
    return false;
  }
}

function extractDirectMediaCandidatesFromHtml(
  html,
  referer,
  fallbackBase = "",
) {
  const candidates = [];
  const htmlVariants = [String(html || "")];

  const addCandidate = (rawUrl, candidateReferer = referer) => {
    const absoluteUrl = absolutizeLiveUrl(
      rawUrl,
      candidateReferer,
      fallbackBase,
    );
    if (!absoluteUrl) return;
    if (!/\.(m3u8|mpd)(?:[?#]|$)/i.test(absoluteUrl)) return;

    candidates.push({
      url: absoluteUrl,
      referer: candidateReferer,
    });
  };

  const pipeDecoded = revealPipeSplit(htmlVariants[0]);
  if (pipeDecoded) htmlVariants.push(pipeDecoded);

  const charDecoded = revealCharByCharUrl(htmlVariants[0]);
  if (charDecoded) addCandidate(charDecoded, referer);

  const packedPattern =
    /eval\(function\(p,a,c,k,e,(?:d|r)\)\{[\s\S]*?return p\}\((['"])([\s\S]*?)\1,\s*(\d+),\s*(\d+),\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)\s*(?:,\s*0\s*,\s*\{\})?\s*\)\)/gs;
  for (const packedMatch of String(html || "").matchAll(packedPattern)) {
    try {
      const decoded = unpackPacker(
        packedMatch[2],
        parseInt(packedMatch[3], 10),
        parseInt(packedMatch[4], 10),
        packedMatch[6].split("|"),
        null,
        {},
      );
      if (decoded) htmlVariants.push(decoded);
    } catch (error) {
      console.warn("[LIVE-TV] Unable to decode packed block:", error.message);
    }
  }

  for (const fragment of htmlVariants) {
    const cleaned = String(fragment || "").replace(/\\\//g, "/");

    for (const atobMatch of cleaned.matchAll(/atob\(['"]([^'"]+)['"]\)/g)) {
      try {
        addCandidate(
          Buffer.from(atobMatch[1], "base64").toString("utf8"),
          referer,
        );
      } catch (error) {
        // Ignore invalid payloads
      }
    }

    const mimeTypeMatch = cleaned.match(
      /mimeType:\s*"application\/x-mpegURL"[\s\S]*?source:\s*'([^']+)'/i,
    );
    if (mimeTypeMatch) addCandidate(mimeTypeMatch[1], referer);

    for (const playerInitMatch of cleaned.matchAll(
      /pl\.init\(\s*['"]([^'"]+)['"]\s*\)/gi,
    )) {
      addCandidate(playerInitMatch[1], referer);
    }

    for (const manifestUrlMatch of cleaned.matchAll(
      /manifestUrl\s*:\s*['"]([^'"]+)['"]/gi,
    )) {
      addCandidate(manifestUrlMatch[1], referer);
    }

    const loadSourceMatch = cleaned.match(
      /player\.load\(\{source:\s*([A-Za-z0-9_$]+)\(/,
    );
    if (loadSourceMatch) {
      const functionPattern = new RegExp(
        `function ${loadSourceMatch[1]}\\(\\)\\s*\\{\\s*return\\(\\[([^\\]]+)`,
        "s",
      );
      const functionMatch = cleaned.match(functionPattern);
      if (functionMatch) {
        addCandidate(
          functionMatch[1]
            .replace(/"/g, "")
            .replace(/,/g, "")
            .replace(/\\/g, "")
            .replace(/\/\/\/\//g, "//"),
          referer,
        );
      }
    }

    const playerMatchA = cleaned.match(
      /new Player\("100%","100%","player","(.+?)",\{"(.+?)":/,
    );
    if (playerMatchA)
      addCandidate(
        `https://${playerMatchA[2]}/hls/${playerMatchA[1]}/live.m3u8`,
        referer,
      );

    const playerMatchB = cleaned.match(
      /new Player\("100%","100%","player","(.+?)".+?,"([^"]+)"/,
    );
    if (playerMatchB)
      addCandidate(
        `https://${playerMatchB[2]}/hls/${playerMatchB[1]}/live.m3u8`,
        referer,
      );

    for (const inlineMatch of cleaned.matchAll(
      /(?:file|source|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mpd)[^"']*)["']/gi,
    )) {
      addCandidate(inlineMatch[1], referer);
    }

    for (const quotedMatch of cleaned.matchAll(
      /["'](https?:\/\/[^"']+\.(?:m3u8|mpd)[^"']*)["']/gi,
    )) {
      addCandidate(quotedMatch[1], referer);
    }

    for (const varSrcMatch of cleaned.matchAll(
      /;var.+?src=["']([^"']+)["']/gi,
    )) {
      addCandidate(varSrcMatch[1], referer);
    }
  }

  return dedupeByKey(
    candidates,
    (item) => `${item.url}__${item.referer || ""}`,
  );
}

function buildLivetvIframeExportUrl(webplayerUrl, eventUrl = "") {
  try {
    const parsed = new URL(webplayerUrl, eventUrl || LIVETV_BASE_URL);

    if (/\/export\/webplayer\.iframe\.php$/i.test(parsed.pathname)) {
      return parsed.href;
    }

    if (!/\/webplayer(?:2)?\.php$/i.test(parsed.pathname)) {
      return parsed.href;
    }

    let cdnHost = parsed.hostname;
    if (!/^cdn\./i.test(cdnHost)) {
      const eventHost = new URL(eventUrl || LIVETV_BASE_URL).hostname.replace(
        /^www\./i,
        "",
      );
      cdnHost = `cdn.${eventHost}`;
    }

    parsed.protocol = "https:";
    parsed.hostname = cdnHost;
    parsed.pathname = "/export/webplayer.iframe.php";
    return parsed.href;
  } catch (error) {
    return webplayerUrl;
  }
}

function extractLivetvWebplayerEntries(html, eventUrl) {
  const rawHtml = String(html || "");
  const $ = cheerio.load(rawHtml);
  const entries = [];
  const cleanText = (value) =>
    cheerio
      .load(`<div>${String(value || "")}</div>`)
      .text()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const addEntry = (rawUrl, metadata = {}) => {
    const webplayerUrl = absolutizeLiveUrl(rawUrl, eventUrl, LIVETV_BASE_URL);
    if (!webplayerUrl) return;

    let streamType = "";
    try {
      streamType = new URL(webplayerUrl).searchParams.get("t") || "";
    } catch (error) {
      streamType = "";
    }

    if (streamType.toLowerCase() === "acestream") {
      return;
    }

    const exportUrl = buildLivetvIframeExportUrl(webplayerUrl, eventUrl);
    const language = String(metadata.language || "").trim();
    const bitrate = String(metadata.bitrate || "").trim();
    const hoster = String(metadata.hoster || "").trim();
    const sourceType = String(metadata.sourceType || streamType || "").trim();
    const title = String(
      metadata.title ||
        [language, hoster || sourceType, bitrate].filter(Boolean).join(" - ") ||
        sourceType ||
        "Stream",
    ).trim();

    entries.push({
      title,
      language,
      bitrate,
      hoster,
      sourceType,
      webplayerUrl,
      exportUrl,
    });
  };

  const rowPattern = /<table[^>]+class=["']lnktbj["'][\s\S]*?<\/table>/gi;
  for (const rowMatch of rawHtml.matchAll(rowPattern)) {
    const rowHtml = rowMatch[0];
    const hrefMatch = rowHtml.match(
      /href=["']([^"']*\/webplayer(?:2)?\.php[^"']*)["']/i,
    );
    if (!hrefMatch) continue;

    const language =
      cleanText(rowHtml.match(/<img[^>]+title=["']([^"']+)["']/i)?.[1] || "") ||
      "";
    const bitrate =
      cleanText(
        rowHtml.match(/class=["']bitrate["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] ||
          "",
      ) || "";
    const hoster =
      cleanText(
        rowHtml.match(/class=["']lnktyt["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || "",
      ) || "";
    const title = [language, hoster, bitrate].filter(Boolean).join(" - ");

    addEntry(hrefMatch[1], {
      title,
      language,
      bitrate,
      hoster,
    });
  }

  if (entries.length === 0) {
    $('#links_block a[href*="/webplayer"]').each((_, link) => {
      const href = $(link).attr("href");
      if (!href) return;

      const row = $(link).closest("table.lnktbj");
      const language = row.find("img[title]").first().attr("title") || "";
      const bitrate = row.find("td.bitrate").first().text().trim();
      const hoster = row
        .find("td.lnktyt")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const title = [language, hoster, bitrate].filter(Boolean).join(" - ");

      addEntry(href, {
        title,
        language,
        bitrate,
        hoster,
      });
    });
  }

  if (entries.length === 0) {
    for (const hrefMatch of rawHtml.matchAll(
      /href=["']([^"']*\/webplayer(?:2)?\.php[^"']*)["']/gi,
    )) {
      addEntry(hrefMatch[1], {
        title: "Stream",
      });
    }
  }

  if (entries.length === 0) {
    const onclickPattern =
      /show_webplayer\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*\)/gi;

    for (const match of rawHtml.matchAll(onclickPattern)) {
      const [, type, contentId, eventId, linkId, countryId, streamId, lang] =
        match;
      const fallbackUrl = `/webplayer2.php?t=${encodeURIComponent(type)}&c=${encodeURIComponent(contentId)}&lang=${encodeURIComponent(lang)}&eid=${eventId}&lid=${linkId}&ci=${countryId}&si=${streamId}`;
      addEntry(fallbackUrl, {
        title: type || "Stream",
        language: lang || "",
        sourceType: type || "",
      });
    }
  }

  console.log(
    `[LIVETV] Raw parser signals for ${eventUrl}: href=${(rawHtml.match(/\/webplayer(?:2)?\.php/gi) || []).length}, onclick=${(rawHtml.match(/show_webplayer\(/gi) || []).length}`,
  );

  return dedupeByKey(
    entries,
    (item) => `${item.exportUrl}__${item.webplayerUrl}`,
  );
}

function buildLivetvSourceOptions(entries) {
  return entries.map((entry, index) => ({
    index,
    title: entry.title || `Source ${index + 1}`,
    language: entry.language || "",
    bitrate: entry.bitrate || "",
    hoster: entry.hoster || "",
    sourceType: entry.sourceType || "",
  }));
}

async function fetchLivetvEventEntries(channelId) {
  const encodedPath = channelId.replace("livetv_", "");
  const decodedPath = decodeUrlToken(encodedPath);
  if (!decodedPath) {
    console.warn(`[LIVETV] Could not decode event id ${channelId}`);
    return { eventUrl: "", hosterLinks: [] };
  }

  const eventUrl = absolutizeLiveUrl(
    decodedPath,
    LIVETV_BASE_URL,
    LIVETV_BASE_URL,
  );
  if (!eventUrl) {
    return { eventUrl: "", hosterLinks: [] };
  }

  const eventResponse = await axios.get(eventUrl, {
    headers: buildLivePageHeaders(LIVETV_BASE_URL),
    timeout: 15000,
    httpsAgent: SOSPLAY_HTTPS_AGENT,
  });

  const eventHtml = String(eventResponse.data || "");
  const hosterLinks = extractLivetvWebplayerEntries(eventHtml, eventUrl);
  console.log(
    `[LIVETV] Extracted ${hosterLinks.length} webplayer links from ${channelId}`,
  );

  return { eventUrl, hosterLinks };
}

async function resolveRecursiveIframeStreams(startUrl, referer, options = {}) {
  const {
    maxDepth = 4,
    visited = new Set(),
    fallbackBase = "",
    logPrefix = "[LIVE-TV]",
    preferEmbedForExternalIframes = false,
    embedReferer = null,
  } = options;

  const absoluteStartUrl = absolutizeLiveUrl(startUrl, referer, fallbackBase);
  if (!absoluteStartUrl || visited.has(absoluteStartUrl)) {
    return { streams: [], embeds: [] };
  }

  visited.add(absoluteStartUrl);

  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(absoluteStartUrl)) {
    return {
      streams: [
        { url: absoluteStartUrl, referer: referer || absoluteStartUrl },
      ],
      embeds: [],
    };
  }

  try {
    const response = await axios.get(absoluteStartUrl, {
      headers: buildLivePageHeaders(referer),
      timeout: 15000,
      httpsAgent: SOSPLAY_HTTPS_AGENT,
      maxRedirects: 5,
      transformResponse: [(data) => data],
    });

    const finalUrl = response.request?.res?.responseUrl || absoluteStartUrl;
    const html =
      typeof response.data === "string"
        ? response.data
        : String(response.data ?? "");
    let streams = extractDirectMediaCandidatesFromHtml(
      html,
      finalUrl,
      fallbackBase,
    );
    let embeds = [];
    const iframeUrls = extractIframeUrlsFromHtml(html, finalUrl, fallbackBase);

    if (iframeUrls.length === 0) {
      return { streams, embeds };
    }

    if (maxDepth <= 0) {
      return {
        streams,
        embeds: iframeUrls.map((url) => ({
          url,
          referer: embedReferer || finalUrl,
        })),
      };
    }

    for (const iframeUrl of iframeUrls) {
      if (
        preferEmbedForExternalIframes &&
        !shouldFollowLiveTvIframeForExtraction(
          iframeUrl,
          finalUrl,
          fallbackBase,
        )
      ) {
        embeds.push({ url: iframeUrl, referer: embedReferer || finalUrl });
        continue;
      }

      console.log(`${logPrefix} Following iframe: ${iframeUrl}`);
      const nested = await resolveRecursiveIframeStreams(iframeUrl, finalUrl, {
        maxDepth: maxDepth - 1,
        visited,
        fallbackBase,
        logPrefix,
        preferEmbedForExternalIframes,
        embedReferer,
      });

      streams = streams.concat(nested.streams);
      embeds = embeds.concat(nested.embeds);

      if (nested.streams.length === 0 && nested.embeds.length === 0) {
        embeds.push({ url: iframeUrl, referer: embedReferer || finalUrl });
      }
    }

    return {
      streams: dedupeByKey(
        streams,
        (item) => `${item.url}__${item.referer || ""}`,
      ),
      embeds: dedupeByKey(
        embeds,
        (item) => `${item.url}__${item.referer || ""}`,
      ),
    };
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to resolve ${absoluteStartUrl}: ${error.message}`,
    );
    return { streams: [], embeds: [] };
  }
}

async function resolveSosplayStream(channelId) {
  try {
    const rawChannelId = channelId.replace("sosplay_", "");
    const channelConfig = BOLALOCA_CHANNELS.find(
      (channel) => channel.id === rawChannelId,
    );
    if (!channelConfig) {
      console.warn(`[BOLALOCA] Unknown channel ${channelId}`);
      return [];
    }

    const resolvedStreams = [];
    const resolvedEmbeds = [];

    for (const variant of BOLALOCA_PLAYER_VARIANTS) {
      const playerUrl = `${BOLALOCA_BASE_URL}/player/${variant}/${rawChannelId}`;
      const resolved = await resolveRecursiveIframeStreams(
        playerUrl,
        BOLALOCA_BASE_URL,
        {
          maxDepth: 5,
          visited: new Set(),
          fallbackBase: BOLALOCA_BASE_URL,
          logPrefix: "[BOLALOCA]",
        },
      );

      resolvedStreams.push(
        ...resolved.streams.map((stream, index) => ({
          title: `${channelConfig.name} - Lien ${variant}${resolved.streams.length > 1 ? `.${index + 1}` : ""}`,
          url: stream.url,
          referer: stream.referer || playerUrl,
        })),
      );

      resolvedEmbeds.push(
        ...resolved.embeds.map((embed, index) => ({
          title: `${channelConfig.name} - Embed ${variant}${resolved.embeds.length > 1 ? `.${index + 1}` : ""}`,
          url: embed.url,
          referer: embed.referer || playerUrl,
          _isEmbed: true,
        })),
      );
    }

    const uniqueStreams = dedupeByKey(
      resolvedStreams,
      (item) => `${item.url}__${item.referer || ""}`,
    );
    const uniqueEmbeds = dedupeByKey(
      resolvedEmbeds,
      (item) => `${item.url}__${item.referer || ""}`,
    );

    console.log(
      `[BOLALOCA] Resolved ${uniqueStreams.length} direct streams and ${uniqueEmbeds.length} embeds for ${channelId}`,
    );
    return uniqueStreams.length > 0 ? uniqueStreams : uniqueEmbeds;

    console.log(`[SOSPLAY] Resolving stream for channel ${channelId}`);

    // Find the channel page URL from cache
    const catalogCacheKey = generateCacheKey("catalog_tv_sosplay_chaines");
    const catalogCache = await getFromCache(catalogCacheKey, 24);

    let channelPageUrl = null;

    if (catalogCache && catalogCache.metas) {
      const channel = catalogCache.metas.find((m) => m.id === channelId);
      if (channel && channel._pageUrl) {
        channelPageUrl = channel._pageUrl;
      }
    }

    if (!channelPageUrl) {
      // Fallback: reconstruct URL from channel ID
      const slug = channelId.replace("sosplay_", "");
      channelPageUrl = `${SOSPLAY_BASE_URL}/regardertv-${slug}-streaming-direct`;
    }

    console.log(`[SOSPLAY] Channel page URL: ${channelPageUrl}`);

    // Get available servers
    const servers = await getSosplayServers(channelPageUrl);

    if (servers.length === 0) {
      console.warn(`[SOSPLAY] No servers found for ${channelId}`);
      return [];
    }

    // Collect streams from ALL servers
    const allStreams = [];

    for (const server of servers) {
      try {
        console.log(`[SOSPLAY] Trying server: ${server.name}`);

        // Fetch the intermediate embed page (e.g. /part/Ll.php?id=1/20)
        const embedUrl = `${SOSPLAY_BASE_URL}${server.embedPath}`;
        console.log(`[SOSPLAY] Fetching embed page: ${embedUrl}`);

        const embedPageResponse = await axios.get(embedUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Referer: channelPageUrl,
          },
          timeout: 15000,
          httpsAgent: SOSPLAY_HTTPS_AGENT,
        });

        const embedHtml = embedPageResponse.data;

        // Extract iframe src (e.g. /Zoz/1/20 or external URL)
        const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)/i);
        if (!iframeMatch) {
          console.warn(`[SOSPLAY] No iframe found in embed page response`);
          continue;
        }

        let iframeSrc = iframeMatch[1];
        // Handle relative URLs
        if (iframeSrc.startsWith("/")) {
          iframeSrc = `${SOSPLAY_BASE_URL}${iframeSrc}`;
        }
        console.log(`[SOSPLAY] Found iframe: ${iframeSrc}`);

        // Résoudre les iframes imbriqués jusqu'au contenu final
        const resolved = await resolveNestedIframes(
          iframeSrc,
          embedUrl,
          3,
          "[SOSPLAY]",
        );
        if (!resolved) continue;

        const { html: finalHtml, finalUrl } = resolved;

        // Essayer les deux décodeurs
        let m3u8Url = null;
        if (
          server.name.toLowerCase().includes("hoca") ||
          finalUrl.includes("hoca")
        ) {
          console.log(`[SOSPLAY] Processing Hoca embed`);
          m3u8Url = decodeHocaStream(finalHtml);
        }
        if (!m3u8Url) {
          console.log(`[SOSPLAY] Processing Wigi/generic embed`);
          m3u8Url = decodeWigiStream(finalHtml);
        }

        if (m3u8Url) {
          console.log(`[SOSPLAY] Found stream: ${m3u8Url}`);
          allStreams.push({
            title: server.name,
            url: m3u8Url,
            referer: finalUrl,
          });
        }
      } catch (serverError) {
        console.warn(
          `[SOSPLAY] Error with server ${server.name}:`,
          serverError.message,
        );
        continue;
      }
    }

    console.log(`[SOSPLAY] Total streams found: ${allStreams.length}`);

    if (allStreams.length === 0) {
      console.warn(
        `[SOSPLAY] Could not find any working stream for ${channelId}`,
      );
      return [];
    }

    return allStreams;
  } catch (error) {
    console.error(
      `[BOLALOCA] Error resolving stream for ${channelId}:`,
      error.message,
    );
    return [];
  }
}

function normalizeLiveTvCatalogText(value) {
  return cheerio
    .load(`<div>${String(value || "")}</div>`)
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLiveTvComparableText(value) {
  return normalizeLiveTvCatalogText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .toLowerCase();
}

function humanizeLiveTvSportKey(sportKey) {
  const category = Object.values(LIVETV_CATEGORIES).find(
    (entry) => entry.sportKey === sportKey,
  );
  return category?.name || "Sport";
}

function classifyLiveTvSportKey(...values) {
  const normalizedValues = values
    .map((value) => normalizeLiveTvComparableText(value))
    .filter(Boolean);

  for (const [sportKey, aliases] of Object.entries(LIVETV_SPORT_ALIASES)) {
    if (
      normalizedValues.some((value) =>
        aliases.some((alias) => value.includes(alias)),
      )
    ) {
      return sportKey;
    }
  }

  return "other";
}

function extractLiveTvSportInfo(rawSportHint, fallbackText) {
  const sportHint = normalizeLiveTvCatalogText(rawSportHint);
  const hintParts = sportHint
    .split(".")
    .map((part) => normalizeLiveTvCatalogText(part))
    .filter(Boolean);

  const sportKey = classifyLiveTvSportKey(sportHint, fallbackText);
  const sportLabel = hintParts[0] || humanizeLiveTvSportKey(sportKey);
  const competitionFromHint = hintParts.slice(1).join(". ").trim();

  return {
    sportKey,
    sportLabel,
    competitionFromHint,
  };
}

function extractLiveTvSectionSportLabel(contextHtml) {
  const rawContext = String(contextHtml || "");
  if (!rawContext) {
    return "";
  }

  let lastSectionLabel = "";
  const sectionHeaderPattern =
    /<a(?=[^>]*\bclass=["'][^"']*\bmain\b[^"']*["'])(?=[^>]*href=["'][^"']*\/frx\/allupcomingsports\/\d+\/?[^"']*["'])[^>]*>\s*(?:<b[^>]*>)?([\s\S]*?)(?:<\/b>)?\s*<\/a>/gi;

  for (const match of rawContext.matchAll(sectionHeaderPattern)) {
    const candidate = normalizeLiveTvCatalogText(match[1]);
    if (candidate) {
      lastSectionLabel = candidate;
    }
  }

  return lastSectionLabel;
}

function extractLiveTvSectionDateText(rawContext) {
  const contextText = normalizeLiveTvCatalogText(rawContext);
  if (!contextText) return "";

  let lastRelativeMatch = null;
  const relativePattern =
    /(Aujourd'hui|Aujourd’hui|Today|Demain|Tomorrow|Hier|Yesterday)\s*(?:\(([^)]+)\))?/gi;
  for (const match of contextText.matchAll(relativePattern)) {
    lastRelativeMatch = match;
  }

  if (lastRelativeMatch) {
    return [
      lastRelativeMatch[1],
      lastRelativeMatch[2] ? `(${lastRelativeMatch[2]})` : "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  let lastExplicitMatch = null;
  const explicitPattern =
    /(\d{1,2}\s+(?:janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december))/gi;
  for (const match of contextText.matchAll(explicitPattern)) {
    lastExplicitMatch = match;
  }

  return lastExplicitMatch
    ? normalizeLiveTvCatalogText(lastExplicitMatch[1])
    : "";
}

function buildLiveTvBaseDate(sectionDateText) {
  const normalized = normalizeLiveTvComparableText(sectionDateText);
  if (!normalized) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (
    normalized.includes("aujourd'hui") ||
    normalized.includes("aujourdhui") ||
    normalized.includes("today")
  ) {
    return today;
  }

  if (normalized.includes("demain") || normalized.includes("tomorrow")) {
    return new Date(today.getTime() + 24 * 60 * 60 * 1000);
  }

  if (normalized.includes("hier") || normalized.includes("yesterday")) {
    return new Date(today.getTime() - 24 * 60 * 60 * 1000);
  }

  const monthMap = {
    janvier: 0,
    fevrier: 1,
    mars: 2,
    avril: 3,
    mai: 4,
    juin: 5,
    juillet: 6,
    aout: 7,
    septembre: 8,
    octobre: 9,
    novembre: 10,
    decembre: 11,
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  const dateMatch = normalized.match(/(\d{1,2})\s+([a-z]+)/);
  if (!dateMatch) {
    return null;
  }

  const day = Number.parseInt(dateMatch[1], 10);
  const monthIndex = monthMap[dateMatch[2]];
  if (!Number.isFinite(day) || monthIndex === undefined) {
    return null;
  }

  let year = today.getFullYear();
  let candidate = new Date(year, monthIndex, day);

  if (candidate.getTime() < today.getTime() - 7 * 24 * 60 * 60 * 1000) {
    candidate = new Date(year + 1, monthIndex, day);
  }

  return candidate;
}

function buildLiveTvTimestamp(sectionDateText, scheduledTime, isLive = false) {
  const timeMatch = String(scheduledTime || "").match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) {
    return null;
  }

  const now = new Date();
  const baseDate =
    buildLiveTvBaseDate(sectionDateText) ||
    new Date(now.getFullYear(), now.getMonth(), now.getDate());
  baseDate.setHours(
    Number.parseInt(timeMatch[1], 10),
    Number.parseInt(timeMatch[2], 10),
    0,
    0,
  );

  if (
    !sectionDateText &&
    !isLive &&
    baseDate.getTime() < now.getTime() - 6 * 60 * 60 * 1000
  ) {
    baseDate.setDate(baseDate.getDate() + 1);
  }

  return baseDate.getTime();
}

function extractLiveTvTimingInfo(segmentText, anchorHtml, eventBodyHtml = "") {
  const timeMatches = Array.from(
    segmentText.matchAll(/\b(\d{1,2}:\d{2})\b/g),
  ).map((match) => match[1]);
  const uniqueTimes = [...new Set(timeMatches)];
  const timeLineMatches = Array.from(
    segmentText.matchAll(/(\d{1,2}:\d{2})\s*\(([^)]+)\)/g),
  );
  const lastTimeLine =
    timeLineMatches.length > 0
      ? timeLineMatches[timeLineMatches.length - 1]
      : null;
  const scheduledTime =
    lastTimeLine?.[1] || uniqueTimes[uniqueTimes.length - 1] || "";
  const competition = normalizeLiveTvCatalogText(lastTimeLine?.[2] || "");
  const liveMarkerHtml = `${eventBodyHtml || ""}${anchorHtml || ""}`;
  const rawIsLive =
    /<img[^>]+src=["'][^"']*\/img\/live\.gif(?:\?[^"']*)?["']/i.test(
      liveMarkerHtml,
    );
  const scoreCandidate = rawIsLive
    ? uniqueTimes.find((value) => value !== scheduledTime) || ""
    : "";

  return {
    scheduledTime,
    competition,
    score: scoreCandidate,
    isLive: rawIsLive,
  };
}

function extractLiveTvCatalogEvents(html) {
  const rawHtml = String(html || "");
  const linkPattern =
    /<a[^>]+href=["']([^"']*\/frx\/eventinfo\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const linkMatches = Array.from(rawHtml.matchAll(linkPattern));
  const events = [];

  for (let index = 0; index < linkMatches.length; index += 1) {
    const match = linkMatches[index];
    const rawHref = match[1];
    const rawName = match[2];
    const name = normalizeLiveTvCatalogText(rawName);

    if (!rawHref || !name || name.length < 3) {
      continue;
    }

    const pageUrl = absolutizeLiveUrl(
      rawHref,
      LIVETV_BASE_URL,
      LIVETV_BASE_URL,
    );
    if (!pageUrl) {
      continue;
    }

    let pagePath = rawHref;
    try {
      pagePath = new URL(pageUrl).pathname;
    } catch {
      pagePath = rawHref;
    }

    const matchIndex = match.index || 0;
    const nextIndex = linkMatches[index + 1]?.index ?? rawHtml.length;
    const segmentStart = Math.max(0, matchIndex - 1200);
    const segmentEnd = Math.min(rawHtml.length, nextIndex);
    const segmentHtml = rawHtml.slice(segmentStart, segmentEnd);
    const eventBodyHtml = rawHtml.slice(matchIndex, segmentEnd);
    const beforeHtml = rawHtml.slice(
      Math.max(0, matchIndex - 5000),
      matchIndex,
    );
    const anchorHtml = match[0] || "";
    const segmentText = normalizeLiveTvCatalogText(
      segmentHtml
        .replace(/<\/(tr|table|div|p|li|td|h\d)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n"),
    );

    const imgHintMatches = Array.from(
      beforeHtml.matchAll(
        /<(?:img|span)[^>]+(?:alt|title)=["']([^"']{3,180})["'][^>]*>/gi,
      ),
    );
    const inlineHint = normalizeLiveTvCatalogText(
      imgHintMatches.length > 0
        ? imgHintMatches[imgHintMatches.length - 1][1]
        : "",
    );
    const sectionSportLabel = extractLiveTvSectionSportLabel(beforeHtml);
    const sportHint = sectionSportLabel || inlineHint;
    const timingInfo = extractLiveTvTimingInfo(
      segmentText,
      anchorHtml,
      eventBodyHtml,
    );

    if (!timingInfo.scheduledTime && !sportHint) {
      continue;
    }

    const sectionDateText = extractLiveTvSectionDateText(beforeHtml);
    const timestamp = buildLiveTvTimestamp(
      sectionDateText,
      timingInfo.scheduledTime,
      timingInfo.isLive,
    );
    const sportInfo = extractLiveTvSportInfo(sportHint, segmentText);
    const competition =
      timingInfo.competition || sportInfo.competitionFromHint || "";
    const timeText = timingInfo.scheduledTime
      ? [timingInfo.scheduledTime, competition ? `(${competition})` : ""]
          .filter(Boolean)
          .join(" ")
      : sectionDateText;
    const descriptionParts = [
      sportInfo.sportLabel,
      competition,
      timingInfo.isLive ? "Live" : timeText,
    ].filter(Boolean);

    events.push({
      id: `livetv_${encodeUrlToken(pagePath)}`,
      type: "tv",
      name,
      poster: null,
      description: descriptionParts.join(" • "),
      genres: [sportInfo.sportKey === "other" ? "sport" : sportInfo.sportKey],
      _pagePath: pagePath,
      _timestamp: timestamp,
      _timeText: timeText,
      _competition: competition,
      _isLive: timingInfo.isLive,
      _status: timingInfo.isLive ? "live" : "upcoming",
      _sport: sportInfo.sportLabel,
      _sportKey: sportInfo.sportKey,
      _score: timingInfo.score,
      _emoji: LIVETV_SPORT_EMOJIS[sportInfo.sportKey] || "🏟️",
    });
  }

  return dedupeByKey(events, (item) => item.id).sort((a, b) => {
    if (a._isLive && !b._isLive) return -1;
    if (!a._isLive && b._isLive) return 1;
    if (a._timestamp && b._timestamp) return a._timestamp - b._timestamp;
    if (a._timestamp) return -1;
    if (b._timestamp) return 1;
    return String(a.name || "").localeCompare(String(b.name || ""), "fr", {
      sensitivity: "base",
    });
  });
}

async function fetchLiveTvAllUpcomingHtml() {
  let bestResponse = null;

  for (const pagePath of LIVETV_ALLUPCOMING_PATHS) {
    const pageUrl = `${LIVETV_BASE_URL}${pagePath}`;

    try {
      const response = await axios.get(pageUrl, {
        headers: buildLivePageHeaders(LIVETV_BASE_URL),
        timeout: 15000,
        httpsAgent: SOSPLAY_HTTPS_AGENT,
      });

      const html = String(response.data || "");
      const score = (html.match(/\/frx\/eventinfo\//g) || []).length;
      if (!bestResponse || score > bestResponse.score) {
        bestResponse = { html, pageUrl, score };
      }
    } catch (error) {
      console.warn(
        `[LIVETV] Failed allupcoming page ${pageUrl}:`,
        error.message,
      );
    }
  }

  if (!bestResponse) {
    throw new Error("No LiveTV allupcoming page could be fetched");
  }

  return bestResponse;
}

async function scrapeLivetvChannels(categoryKey) {
  try {
    const categoryConfig = LIVETV_CATEGORIES[categoryKey];
    if (!categoryConfig) {
      console.log(`[LIVETV] Unknown category: ${categoryKey}`);
      return [];
    }

    const { html, pageUrl, score } = await fetchLiveTvAllUpcomingHtml();
    const events = extractLiveTvCatalogEvents(html);
    const filteredEvents = events.filter((event) => {
      if (categoryConfig.sportKey === "all") {
        return true;
      }

      if (categoryConfig.sportKey === "live") {
        return Boolean(event._isLive);
      }

      if (categoryConfig.sportKey === "other") {
        return event._sportKey === "other";
      }

      return event._sportKey === categoryConfig.sportKey;
    });

    console.log(
      `[LIVETV] Scraped ${filteredEvents.length}/${events.length} events for ${categoryKey} ` +
        `from ${pageUrl} (${score} raw event links, ${filteredEvents.filter((item) => item._isLive).length} live)`,
    );

    return filteredEvents;
  } catch (error) {
    console.error(`[LIVETV] Error scraping ${categoryKey}:`, error.message);
    return [];
  }
}

async function resolveLivetvStream(channelId, options = {}) {
  try {
    const requestedSourceIndex =
      Number.isInteger(options.sourceIndex) && options.sourceIndex >= 0
        ? options.sourceIndex
        : null;
    const { eventUrl, hosterLinks } = await fetchLivetvEventEntries(channelId);
    if (!eventUrl || hosterLinks.length === 0) {
      return [];
    }

    const selectedHosterLinks = hosterLinks
      .map((hoster, index) => ({
        ...hoster,
        _sourceIndex: index + 1,
        _sourceOffset: index,
      }))
      .filter(
        (hoster) =>
          requestedSourceIndex === null ||
          hoster._sourceOffset === requestedSourceIndex,
      );

    const resolvedStreams = [];
    const resolvedEmbeds = [];

    for (const hoster of selectedHosterLinks) {
      const candidateUrls = dedupeByKey(
        [hoster.exportUrl, hoster.webplayerUrl].filter(Boolean),
        (url) => url,
      );

      let resolved = { streams: [], embeds: [] };

      for (const candidateUrl of candidateUrls) {
        resolved = await resolveRecursiveIframeStreams(candidateUrl, eventUrl, {
          maxDepth: 6,
          visited: new Set(),
          fallbackBase: LIVETV_BASE_URL,
          logPrefix: "[LIVETV]",
          preferEmbedForExternalIframes: true,
          embedReferer: LIVETV_EMBED_REFERER,
        });

        if (resolved.streams.length > 0 || resolved.embeds.length > 0) {
          break;
        }
      }

      resolvedStreams.push(
        ...resolved.streams.map((stream, streamIndex) => ({
          title: `${hoster.title}${resolved.streams.length > 1 ? ` ${streamIndex + 1}` : ""}`,
          url: stream.url,
          referer:
            stream.referer ||
            hoster.exportUrl ||
            hoster.webplayerUrl ||
            eventUrl,
          _sourceIndex: hoster._sourceIndex,
        })),
      );

      resolvedEmbeds.push(
        ...resolved.embeds.map((embed, embedIndex) => ({
          title: `${hoster.title} Embed${resolved.embeds.length > 1 ? ` ${embedIndex + 1}` : ""}`,
          url: embed.url,
          referer: embed.referer || LIVETV_EMBED_REFERER,
          _isEmbed: true,
          _sourceIndex: hoster._sourceIndex,
        })),
      );
    }

    const uniqueStreams = dedupeByKey(
      resolvedStreams,
      (item) => `${item.url}__${item.referer || ""}`,
    );
    const uniqueEmbeds = dedupeByKey(
      resolvedEmbeds,
      (item) => `${item.url}__${item.referer || ""}`,
    );

    console.log(
      `[LIVETV] Resolved ${uniqueStreams.length} direct streams and ${uniqueEmbeds.length} embeds for ${channelId}`,
    );
    return uniqueStreams.length > 0 ? uniqueStreams : uniqueEmbeds;
  } catch (error) {
    console.error(
      `[LIVETV] Error resolving stream for ${channelId}:`,
      error.message,
    );
    return [];
  }
}

async function getLivetvSources(channelId) {
  try {
    const { eventUrl, hosterLinks } = await fetchLivetvEventEntries(channelId);
    if (!eventUrl || hosterLinks.length === 0) {
      return [];
    }

    return buildLivetvSourceOptions(hosterLinks);
  } catch (error) {
    console.error(
      `[LIVETV] Error fetching source list for ${channelId}:`,
      error.message,
    );
    return [];
  }
}

// ===== DADDYLIVE (dlhd.pk) =====

// Fetch + parse the full 24/7 channel grid once; cache 24h. -> [{rawId,name,country}]
async function fetchDaddyliveAllChannels() {
  const cacheKey = generateCacheKey("daddylive_all_channels_v1");
  const cached = await getFromCache(cacheKey, 24); // 24h
  if (cached && Array.isArray(cached.rows)) return cached.rows;

  try {
    const url = `${DADDYLIVE_BASE_URL}${DADDYLIVE_CHANNELS_PATH}`;
    const resp = await axios.get(url, {
      headers: buildLivePageHeaders(DADDYLIVE_REFERER),
      timeout: 15000,
    });
    const rows = parseDaddyliveChannelsHtml(resp.data);
    if (rows.length > 0) {
      await saveToCache(cacheKey, { rows });
    }
    return rows;
  } catch (error) {
    console.error("[DADDYLIVE] Error fetching channel list:", error.message);
    return [];
  }
}

// Channels for one catalog id (daddylive_<code>). Unknown country -> bucketed into `other`.
async function scrapeDaddyliveChannels(catalogId) {
  const code = catalogId.replace("daddylive_", "");
  if (!DADDYLIVE_COUNTRIES[code]) return [];
  const rows = await fetchDaddyliveAllChannels();
  const countryName = DADDYLIVE_COUNTRIES[code].name;
  return rows
    .filter(
      (r) => (DADDYLIVE_COUNTRIES[r.country] ? r.country : "other") === code,
    )
    .map((r) => ({
      id: `daddylive_${r.rawId}`,
      type: "tv",
      name: r.name,
      poster: DADDYLIVE_PLACEHOLDER_POSTER,
      genres: [countryName],
    }));
}

// Fetch the ordered player list for a channel (cache 10min). Falls back to the
// 6 deterministic paths if watch.php cannot be parsed.
async function fetchDaddylivePlayers(rawId) {
  const cacheKey = generateCacheKey(`daddylive_players_${rawId}_v1`);
  const cached = await getFromCacheMs(cacheKey, 600000); // 10 min
  if (cached && Array.isArray(cached.players) && cached.players.length) {
    return cached.players;
  }
  let players = [];
  try {
    const url = `${DADDYLIVE_BASE_URL}/watch.php?id=${rawId}`;
    const resp = await axios.get(url, {
      headers: buildLivePageHeaders(DADDYLIVE_REFERER),
      timeout: 15000,
    });
    players = parseDaddylivePlayersHtml(resp.data);
  } catch (error) {
    console.error(
      `[DADDYLIVE] Error fetching players for ${rawId}:`,
      error.message,
    );
  }
  if (!players.length) players = buildDaddyliveDeterministicPlayers(rawId);
  await saveToCache(cacheKey, { players });
  return players;
}

// Source picker options for mode='sources'.
async function getDaddyliveSources(channelId) {
  const rawId = channelId.replace("daddylive_", "");
  const players = await fetchDaddylivePlayers(rawId);
  return players.map((p, index) => ({
    index,
    title: p.title || `Player ${index + 1}`,
    hoster: "Daddylive",
    sourceType: "embed",
  }));
}

// GET helper for daddylive pages.
async function fetchDaddyliveHtml(url, referer) {
  const resp = await axios.get(url, {
    headers: buildLivePageHeaders(referer),
    timeout: 15000,
  });
  return resp.data;
}

// Resolve the chosen player to a raw m3u8 + referer. Returns [] on miss.
// The player page now embeds an <iframe> whose page holds the Clappr
// `window.atob('<m3u8>')` source, so follow one iframe hop if the m3u8 is not
// inlined on the player page itself.
async function resolveDaddyliveStream(channelId, options = {}) {
  const rawId = channelId.replace("daddylive_", "");
  const requested =
    Number.isInteger(options.sourceIndex) && options.sourceIndex >= 0
      ? options.sourceIndex
      : 0;
  const players = await fetchDaddylivePlayers(rawId);
  const player = players[requested] || players[0];
  if (!player) return [];
  try {
    // Hop 1: player page (Referer = the watch.php page).
    const playerHtml = await fetchDaddyliveHtml(
      player.dataUrl,
      `${DADDYLIVE_BASE_URL}/watch.php?id=${rawId}`,
    );
    let m3u8 = extractDaddyliveM3u8(playerHtml);

    // Hop 2: follow the embedded iframe (Referer = dlhd root) if not inlined.
    if (!m3u8) {
      const iframeSrc = extractDaddyliveIframeSrc(playerHtml, player.dataUrl);
      if (iframeSrc) {
        const iframeHtml = await fetchDaddyliveHtml(
          iframeSrc,
          DADDYLIVE_REFERER,
        );
        m3u8 = extractDaddyliveM3u8(iframeHtml);
      }
    }

    if (!m3u8) return [];
    return [
      {
        title: player.title || `Player ${requested + 1}`,
        url: m3u8,
        referer: DADDYLIVE_REFERER,
        userAgent: LIVE_PAGE_USER_AGENT,
        _sourceIndex: requested,
      },
    ];
  } catch (error) {
    console.error(
      `[DADDYLIVE] Error resolving stream ${channelId} (player ${requested}):`,
      error.message,
    );
    return [];
  }
}

// === LINKZY CHANNELS (loaded from linkzy.json) ===
const LINKZY_CHANNELS = require("./linkzy.json");

/**
 * Returns Linkzy channels from linkzy.json (no API call / decryption needed)
 */
function fetchLinkzyChannels() {
  return LINKZY_CHANNELS.filter((ch) => ch.active);
}

/**
 * Get Linkzy channels for a specific category
 */
function getLinkzyChannelsByCategory(categoryId) {
  try {
    // Map catalog ID to API category string
    const categoryMap = {
      linkzy_generaliste: "general",
      linkzy_sport: "sports",
      linkzy_cinema: "movies",
      linkzy_info: "chaines_info",
      linkzy_jeunesse: "chaines_jeunesse",
    };

    const apiCategory = categoryMap[categoryId];
    if (!apiCategory) {
      console.error(`[LINKZY] Unknown category: ${categoryId}`);
      return [];
    }

    const allChannels = fetchLinkzyChannels();
    const filteredChannels = allChannels.filter(
      (ch) => ch.category === apiCategory,
    );

    console.log(
      `[LINKZY] Category ${categoryId} (${apiCategory}): ${filteredChannels.length} channels`,
    );

    return filteredChannels.map((ch) => ({
      id: `linkzy_${ch.id}`,
      type: "tv",
      name: ch.name,
      poster: ch.logo || null,
    }));
  } catch (error) {
    console.error(
      "[LINKZY] Error getting channels by category:",
      error.message,
    );
    return [];
  }
}

/**
 * Get stream URLs for a Linkzy channel (returns array of {label, url})
 */
function getLinkzyStream(channelId) {
  try {
    const numericId = parseInt(channelId.replace("linkzy_", ""));
    const allChannels = fetchLinkzyChannels();
    const channel = allChannels.find((ch) => ch.id === numericId);

    if (!channel) {
      console.error(`[LINKZY] Channel ${channelId} not found`);
      return [];
    }

    // streamUrl is a JSON string containing an array of {label, url}
    let sources = [];
    try {
      sources =
        typeof channel.streamUrl === "string"
          ? JSON.parse(channel.streamUrl)
          : channel.streamUrl;
    } catch (parseErr) {
      // Fallback: treat as a plain URL string
      console.warn(
        `[LINKZY] Could not parse streamUrl as JSON, using as plain URL`,
      );
      sources = [{ label: "Principal", url: channel.streamUrl }];
    }

    if (!Array.isArray(sources)) {
      sources = [{ label: "Principal", url: String(sources) }];
    }

    console.log(
      `[LINKZY] Stream for ${channel.name}: ${sources.length} source(s)`,
    );
    return sources;
  } catch (error) {
    console.error("[LINKZY] Error getting stream:", error.message);
    return [];
  }
}

// === ROUTES ===

/**
 * GET /api/livetv/resolve-livehdtv
 * Resolve a livehdtv.com embed URL to get the m3u8 stream URL
 * Uses got-scraping to bypass Cloudflare protection
 * Called by the browser extension
 */
router.get("/resolve-livehdtv", async (req, res) => {
  try {
    const { embedUrl } = req.query;

    if (!embedUrl) {
      return res.status(400).json({ error: "Missing embedUrl parameter" });
    }

    console.log(`[LIVEHDTV-API] Resolving embed URL: ${embedUrl}`);

    // Step 1: Fetch the livehdtv/yayin page to find the token.php iframe
    const { gotScraping } = await import("got-scraping");

    const livehdtvResponse = await gotScraping({
      url: embedUrl,
      headers: {
        Referer: "https://www.livehdtv.com/",
      },
      headerGeneratorOptions: {
        browsers: [{ name: "chrome", minVersion: 120 }],
        devices: ["desktop"],
        locales: ["fr-FR", "en-US"],
        operatingSystems: ["windows"],
      },
    });

    const livehdtvHtml = livehdtvResponse.body;
    console.log(`[LIVEHDTV-API] livehdtv page length: ${livehdtvHtml.length}`);

    // Find the inner iframe (token.php)
    const innerIframeMatch = livehdtvHtml.match(
      /<iframe[^>]*src=["']([^"']+)["']/i,
    );
    if (!innerIframeMatch) {
      console.error("[LIVEHDTV-API] No inner iframe found in livehdtv page");
      return res.status(404).json({ error: "No token.php iframe found" });
    }

    let tokenPhpUrl = innerIframeMatch[1];
    console.log(`[LIVEHDTV-API] Found token.php iframe: ${tokenPhpUrl}`);

    if (!tokenPhpUrl.startsWith("http")) {
      tokenPhpUrl = `https://www.livehdtv.com${tokenPhpUrl}`;
    }

    // Step 2: Fetch token.php with got-scraping (to bypass Cloudflare)
    const tokenResponse = await gotScraping({
      url: tokenPhpUrl,
      headers: {
        Referer: embedUrl, // Critical for validation
      },
      headerGeneratorOptions: {
        browsers: [{ name: "chrome", minVersion: 120 }],
        devices: ["desktop"],
        locales: ["fr-FR", "en-US"],
        operatingSystems: ["windows"],
      },
    });

    const tokenHtml = tokenResponse.body;
    console.log(
      `[LIVEHDTV-API] token.php response length: ${tokenHtml.length}`,
    );

    // Extract file: "...m3u8..." from JWPlayer setup
    const fileMatch = tokenHtml.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/);
    if (!fileMatch) {
      console.error("[LIVEHDTV-API] Could not extract m3u8 from token.php");
      console.log(
        "[LIVEHDTV-API] token.php preview:",
        tokenHtml.substring(0, 500),
      );
      return res
        .status(404)
        .json({ error: "Could not extract m3u8 from token.php" });
    }

    const m3u8Url = fileMatch[1];
    console.log(`[LIVEHDTV-API] Found m3u8: ${m3u8Url}`);

    return res.json({
      success: true,
      m3u8Url: m3u8Url,
      source: "livehdtv",
    });
  } catch (error) {
    console.error("[LIVEHDTV-API] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/livetv/manifest
 * Récupère le manifest combiné (TV Direct + Matches + WITV + LiveTV + Daddylive)
 */
router.get("/manifest", async (req, res) => {
  try {
    // v12 = removed dead Vavoo (tvvoo.hayd.uk) source
    const cacheKey = generateCacheKey("manifest_combined_v12");

    // Vérifier le cache
    const cached = await getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Récupérer le manifest TV Direct (catch pour ne pas bloquer si échec)
    const tvDirectRes = await axios
      .get(`${TVDIRECT_BASE_URL}/manifest.json`, {
        headers: STREMIO_HEADERS,
        timeout: 5000,
      })
      .catch((e) => ({ error: e }));

    // Manifeste de base
    const manifest = {
      id: "org.stremio.merged",
      version: "1.0.0",
      name: "Merged Live TV",
      description:
        "Merged TV sources (TV Direct, Matches, WITV, Bolaloca, LiveTV)",
      catalogs: [],
      resources: ["catalog", "meta", "stream"],
      types: ["tv"],
      idPrefixes: [],
    };

    // Fusionner TV Direct (User request: Don't use default tv-general etc.)
    // We only keep idPrefixes/resources if needed, but not catalogs
    if (tvDirectRes && !tvDirectRes.error && tvDirectRes.data) {
      const data = tvDirectRes.data;
      // if (data.catalogs) manifest.catalogs.push(...data.catalogs);
      if (data.idPrefixes) manifest.idPrefixes.push(...data.idPrefixes);
    }

    // Ajouter les catalogues WITV (Wiflix)
    const wiflixNames = {
      wiflix_generaliste: "Généraliste",
      wiflix_cinema: "Cinéma",
      wiflix_sport: "Sport",
      wiflix_documentaire: "Documentaire",
      wiflix_enfants: "Enfants",
      wiflix_info: "Info",
      wiflix_musique: "Musique",
    };

    for (const [key, name] of Object.entries(wiflixNames)) {
      manifest.catalogs.push({
        type: "tv",
        id: key,
        name: name,
      });
    }
    manifest.idPrefixes.push("wiflix_");

    // Ajouter les catalogues Sosplay
    const sosplayNames = {
      sosplay_chaines: "Bolaloca",
    };

    for (const [key, name] of Object.entries(sosplayNames)) {
      manifest.catalogs.push({
        type: "tv",
        id: key,
        name: name,
      });
    }
    manifest.idPrefixes.push("sosplay_");

    for (const [key, config] of Object.entries(LIVETV_CATEGORIES)) {
      manifest.catalogs.push({
        type: "tv",
        id: key,
        name: `${config.emoji || "📺"} ${config.name}`,
      });
    }
    manifest.idPrefixes.push("livetv_");

    for (const [code, cfg] of Object.entries(DADDYLIVE_COUNTRIES)) {
      manifest.catalogs.push({
        type: "tv",
        id: `daddylive_${code}`,
        name: cfg.name,
      });
    }
    manifest.idPrefixes.push("daddylive_");

    // Ajouter les catalogues Matches (FCTV) en premier dans la liste
    const matchesCatalogs = [];
    for (const [key, config] of Object.entries(FCTV_MATCHES_CATEGORIES)) {
      matchesCatalogs.push({
        type: "tv",
        id: key,
        name: config.name,
      });
    }
    // Prepend matches catalogs to the beginning
    manifest.catalogs = [...matchesCatalogs, ...manifest.catalogs];
    manifest.idPrefixes.push("match_");

    // [DÉSACTIVÉ] Linkzy temporairement désactivé
    // for (const [catId, config] of Object.entries(LINKZY_CATEGORIES)) {
    //     manifest.catalogs.push({
    //         type: 'tv',
    //         id: config.id,
    //         name: config.name,
    //         _free: true,
    //     });
    // }
    // manifest.idPrefixes.push('linkzy_');

    // Sauvegarder en cache
    await saveToCache(cacheKey, manifest);

    res.json(manifest);
  } catch (error) {
    console.error("[LIVETV] Erreur manifest:", error.message);
    res.status(500).json({ error: "Impossible de charger le manifest" });
  }
});

/**
 * GET /api/livetv/catalog/:type/:catalogId
 * Récupère un catalogue de chaînes
 */
router.get("/catalog/:type/:catalogId", async (req, res) => {
  const { type, catalogId } = req.params;

  try {
    const catalogCacheVersion = catalogId.startsWith("matches_")
      ? "v2"
      : catalogId.startsWith("sosplay_") || catalogId.startsWith("livetv_")
        ? "v5"
        : "v1";
    const cacheKey = generateCacheKey(
      `catalog_${type}_${catalogId}_${catalogCacheVersion}`,
    );
    const isMatchesCatalog = catalogId.startsWith("matches_");
    const isDynamicCatalog =
      isMatchesCatalog || catalogId.startsWith("livetv_");

    // Vérifier le cache (1 minute pour matches/LiveTV, 24h pour le reste)
    const cached = isDynamicCatalog
      ? await getFromCacheMs(cacheKey, 60000) // 1 minute pour matches/LiveTV
      : await getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let catalog = null;

    // Déterminer la source en fonction de l'ID du catalogue
    if (catalogId.startsWith("tvmio_")) {
      // Source TVMio (Local M3U)
      console.log(`[LIVETV] Fetching TVMio (M3U) catalog: ${catalogId}`);
      const tvmioConfig = TVMIO_CATEGORIES[catalogId];

      if (tvmioConfig) {
        const allChannels = await parseM3u();
        const remoteMetas = await fetchTvmioCatalogMetas(catalogId);
        const tvmioImagesMap = buildTvmioImagesMap(remoteMetas);
        const targetGroup = tvmioConfig.genre; // e.g. "FR | General"

        // Filter by group
        let filtered = allChannels.filter((ch) => ch.group === targetGroup);

        // Deduplicate by ID (pick first one for the catalog entry)
        const unique = [];
        const seen = new Set();
        for (const ch of filtered) {
          if (!seen.has(ch.id)) {
            seen.add(ch.id);
            const remoteImages = getTvmioRemoteImages(ch, tvmioImagesMap);
            unique.push({
              id: `tvmio-${ch.id}`, // Prefix for routing
              type: "tv",
              name: ch.title,
              poster: remoteImages.poster,
              logo: remoteImages.logo,
              background: remoteImages.background,
              description: ch.group,
            });
          }
        }

        catalog = { metas: unique };
      } else {
        catalog = { metas: [] };
      }
      console.log(
        `[TVMIO] Result: ${catalog.metas ? catalog.metas.length : 0} channels`,
      );
      // [DÉSACTIVÉ] Linkzy temporairement désactivé
      // } else if (catalogId.startsWith('linkzy_')) {
      //     const channels = await getLinkzyChannelsByCategory(catalogId);
      //     catalog = { metas: channels };
    } else if (catalogId.startsWith("matches_")) {
      // Source Matches (FCTV33)
      console.log(`[LIVETV] Fetching Matches catalog: ${catalogId}`);
      const matches = await scrapeFctvMatches(catalogId);
      console.log(`[LIVETV] Matches result: ${matches.length} matches`);
      catalog = {
        metas: matches,
      };
    } else if (catalogId.startsWith("sosplay_")) {
      // Source Bolaloca/Elitegol (compat prefix sosplay_)
      console.log(`[LIVETV] Fetching Bolaloca catalog: ${catalogId}`);
      const channels = await scrapeSosplayChannels(catalogId);
      console.log(
        `[LIVETV] Bolaloca channels result: ${channels.length} channels`,
      );
      catalog = {
        metas: channels,
      };
    } else if (catalogId.startsWith("livetv_")) {
      console.log(`[LIVETV] Fetching LiveTV catalog: ${catalogId}`);
      const channels = await scrapeLivetvChannels(catalogId);
      console.log(`[LIVETV] LiveTV channels result: ${channels.length} events`);
      catalog = {
        metas: channels,
      };
    } else if (catalogId.startsWith("daddylive_")) {
      console.log(`[LIVETV] Fetching Daddylive catalog: ${catalogId}`);
      const channels = await scrapeDaddyliveChannels(catalogId);
      catalog = {
        metas: channels,
      };
    } else if (catalogId.startsWith("wiflix_")) {
      // Source Witv (Wiflix)
      console.log(`[LIVETV] Fetching Wiflix catalog: ${catalogId}`);
      const channels = await scrapeWitvChannels(catalogId);
      console.log(
        `[LIVETV] Wiflix channels result: ${channels.length} channels`,
      );
      catalog = {
        metas: channels,
      };
      console.log(
        `[LIVETV] Wiflix catalog response: ${JSON.stringify(catalog).substring(0, 500)}`,
      );
    } else {
      // Source TV Direct (Défaut)
      const url = `${TVDIRECT_BASE_URL}/catalog/${type}/${catalogId}.json`;
      const response = await axios.get(url, {
        headers: STREMIO_HEADERS,
        timeout: 10000,
      });
      catalog = response.data;
    }

    // Sauvegarder en cache
    await saveToCache(cacheKey, catalog);

    res.json(catalog);
  } catch (error) {
    console.error(`[LIVETV] Erreur catalog ${catalogId}:`, error.message);
    res.status(500).json({ error: "Impossible de charger le catalogue" });
  }
});

/**
 * GET /api/livetv/stream/:type/:channelId
 * Récupère les flux d'une chaîne
 */
router.get("/stream/:type/:channelId", async (req, res) => {
  const { type, channelId } = req.params;
  const mode =
    String(req.query.mode || "").toLowerCase() === "sources"
      ? "sources"
      : "stream";
  const parsedSourceIndex = Number.parseInt(
    String(req.query.sourceIndex ?? ""),
    10,
  );
  const sourceIndex =
    Number.isInteger(parsedSourceIndex) && parsedSourceIndex >= 0
      ? parsedSourceIndex
      : null;

  try {
    const accessKey = req.headers["x-access-key"];

    let isVip = { vip: false };
    if (accessKey) {
      isVip = await verifyAccessKey(accessKey);
    }

    // Block VIP-only sources immediately if not VIP.
    // Matches (match_/matches_) are free: the IP-locked native stream is resolved
    // client-side by the extension/userscript (RESOLVE_FCTV), and free users without
    // it fall back to the embed player (see the match_ branch below). Only IPTV is
    // strictly VIP.
    if (channelId.startsWith("iptv_") && !isVip.vip) {
      return res.status(403).json({ error: "Réservé aux membres VIP" });
    }

    // IPTV Xtream — return proxified m3u8 URL directly
    if (channelId.startsWith("iptv_")) {
      const streamId = channelId.replace("iptv_", "");
      const directUrl = `${XTREAM_URL}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.m3u8`;
      const proxiedUrl = `${IPTV_STREAM_PROXY}/${directUrl}`;
      return res.json({
        streams: [
          {
            url: proxiedUrl,
            title: "IPTV Stream",
            behaviorHints: { notWebReady: false },
          },
        ],
      });
    }

    const skipOuterCache =
      channelId.startsWith("livetv_") || channelId.startsWith("daddylive_");
    const cacheKey = generateCacheKey(
      `stream_${type}_${channelId}_${mode}_${sourceIndex ?? "all"}_v6_${isVip.vip ? "vip" : "free"}`,
    );
    const streamCacheVariant = isVip.vip ? "vip" : "free";

    // Vérifier le cache (expiration plus courte pour les streams: 1h)
    const cached = skipOuterCache ? null : await getFromCache(cacheKey, 1);
    if (cached) {
      return res.json(cached);
    }

    let streamData = null;

    if (channelId.startsWith("tvmio-")) {
      // === SOURCE TVMIO (Local M3U) ===
      console.log(`[TVMIO] Getting stream for ${channelId}`);

      const targetId = channelId.replace("tvmio-", "");
      const allChannels = await parseM3u();

      // Find all entries for this ID (support multiple qualities/sources)
      const matches = allChannels.filter((ch) => ch.id === targetId);

      if (matches.length > 0) {
        console.log(
          `[TVMIO] Found ${matches.length} stream(s) for ${channelId}`,
        );

        const streams = matches.map((match, index) => {
          // Try to guess quality/label from title
          // Pattern: "FR | TF1 FHD"
          let title = match.title || `Source ${index + 1}`;
          // Simplify title if it contains common quality markers,
          // otherwise keep full title or index
          if (title.includes("FHD")) title = "FHD";
          else if (title.includes("HD") && !title.includes("UHD")) title = "HD";
          else if (title.includes("4K") || title.includes("UHD")) title = "4K";
          else if (title.includes("SD")) title = "SD";
          else if (index > 0 && title === matches[0].title)
            title = `Source ${index + 1}`;

          const originalUrl = match.stream;
          const encodedUrl = encodeURIComponent(originalUrl);
          // Use proxy server to help with CORS on some players (only if VIP)
          const proxyUrl = isVip.vip
            ? `${PROXY_SERVER_URL}?url=${encodedUrl}`
            : originalUrl;

          return {
            title: title,
            url: proxyUrl,
            originalUrl: originalUrl,
            _isTvmio: true,
            behaviorHints: {
              notWebReady: false,
            },
          };
        });

        streamData = { streams: streams };
      } else {
        console.log(`[TVMIO] No streams found for ${channelId} in M3U`);
        streamData = { streams: [] };
      }
      // [DÉSACTIVÉ] Linkzy temporairement désactivé
      // } else if (channelId.startsWith('linkzy_')) {
      //     const sources = await getLinkzyStream(channelId);
      //     if (sources && sources.length > 0) {
      //         streamData = {
      //             streams: sources.map(source => ({
      //                 title: `${source.label || 'Linkzy Stream'}`,
      //                 url: source.url,
      //                 behaviorHints: { notWebReady: false }
      //             }))
      //         };
      //     } else {
      //         streamData = { streams: [] };
      //     }
    } else if (channelId.startsWith("match_")) {
      // === SOURCE MATCHES (FCTV33) ===
      const matchCacheKey = generateCacheKey(
        `fctv_match_stream_${channelId}_ua1_${streamCacheVariant}`,
      );

      // Check for fresh cache (30 seconds)
      const cachedMatch = await getFromCacheMs(matchCacheKey, 30000);

      if (cachedMatch) {
        console.log(`[FCTV-MATCHES] Serving cached stream for ${channelId}`);
        return res.json(cachedMatch);
      }

      // No cache or expired - fetch fresh
      console.log(`[FCTV-MATCHES] Fetching fresh stream for ${channelId}`);
      const matchStreams = await resolveFctvMatchStream(channelId);

      if (!matchStreams || matchStreams.length === 0) {
        return res.status(404).json({ error: "Flux match introuvable" });
      }

      // Public base of THIS API, so the native playlist endpoint URL is absolute.
      const publicApiBase =
        process.env.PUBLIC_API_BASE ||
        `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;

      // VIP -> server proxies the segments. Free -> "raw" mode: the browser
      // extension / userscript injects the player Referer (no proxy needed).
      const fctvNativeMode = isVip.vip ? "proxy" : "raw";
      const fctvPlayerBase = await getFctvPlayerBaseUrl();
      const fctvApiBase = await getFctvApiBase();

      // Build streams array with all FCTV servers.
      const streams = matchStreams.map((stream) => {
        // Embed player (iframe) is loaded directly in an <iframe>; never proxy it.
        if (stream._isEmbed) {
          return {
            title: stream.title,
            url: stream.url,
            originalUrl: stream.url,
            _isEmbed: true,
            behaviorHints: { notWebReady: false },
          };
        }

        if (stream._fctvNative) {
          const p = stream._fctvNative;
          // VIP: the server proxies the (IP-consistent) segments via the smart
          // playlist endpoint + PROXY_SERVER_URL.
          if (fctvNativeMode === "proxy") {
            const url =
              `${publicApiBase}/api/livetv/fctv/playlist?matchId=${encodeURIComponent(p.matchId)}` +
              `&streamId=${encodeURIComponent(p.streamId)}&siteType=${encodeURIComponent(p.siteType)}` +
              `&sportType=${encodeURIComponent(p.sportType)}&mode=proxy`;
            return {
              title: stream.title,
              url,
              originalUrl: url,
              behaviorHints: { notWebReady: false },
            };
          }
          // Free: the stream is IP-locked, so it must be resolved in the user's
          // browser by the extension/userscript (RESOLVE_FCTV). Empty url here;
          // the frontend fills it. Without an extension the stub is dropped and
          // the user falls back to the embed player.
          return {
            title: stream.title,
            url: "",
            _fctvLocal: {
              matchId: p.matchId,
              streamId: p.streamId,
              siteType: p.siteType,
              sportType: p.sportType,
              apiBase: fctvApiBase,
            },
            _fctvReferer: `${fctvPlayerBase}/`,
            behaviorHints: { notWebReady: false },
          };
        }

        const encodedUrl = encodeURIComponent(stream.url);

        const refererBase = stream.referer || FCTV_PLAYER_BASE_URL;
        const headers = JSON.stringify(
          buildStreamProxyHeaders(
            refererBase,
            refererBase,
            stream.userAgent || STREAM_PROXY_USER_AGENT,
          ),
        );
        const encodedHeaders = encodeURIComponent(headers);
        // FCTV native m3u8 + TS segments are Referer-gated to the player origin,
        // so they MUST be proxied (the proxy injects that Referer) for every
        // user — not just VIP. Other streams keep the VIP-only proxy behaviour.
        const mustProxy = stream.needsProxy === true;
        const proxyUrl = PROXY_SERVER_URL && (mustProxy || isVip.vip)
          ? `${PROXY_SERVER_URL}?url=${encodedUrl}&headers=${encodedHeaders}`
          : stream.url;

        return {
          title: stream.title,
          url: proxyUrl,
          originalUrl: stream.url,
          referer: stream.referer,
          userAgent: stream.userAgent || STREAM_PROXY_USER_AGENT,
          behaviorHints: {
            notWebReady: false,
          },
        };
      });

      streamData = {
        streams: streams,
        _cacheTime: Date.now(),
      };

      // Save to cache with timestamp
      await saveToCache(matchCacheKey, streamData);
    } else if (channelId.startsWith("sosplay_")) {
      // === SOURCE BOLALOCA (compat prefix sosplay_) ===
      const sosplayCacheKey = generateCacheKey(
        `sosplay_stream_${channelId}_ua2_${streamCacheVariant}`,
      );

      // Check for fresh cache (30 seconds) - stale-while-revalidate pattern
      const cachedSosplay = await getFromCacheMs(sosplayCacheKey, 30000);

      if (cachedSosplay) {
        console.log(`[BOLALOCA] Serving cached stream for ${channelId}`);
        return res.json(cachedSosplay);
      }

      // No cache or expired - fetch fresh
      console.log(`[BOLALOCA] Fetching fresh stream for ${channelId}`);
      const sosplayStreams = await resolveSosplayStream(channelId);

      if (!sosplayStreams || sosplayStreams.length === 0) {
        return res.status(404).json({ error: "Flux Bolaloca introuvable" });
      }

      // Build streams array with all servers
      const streams = sosplayStreams.map((stream) => {
        if (stream._isEmbed) {
          return {
            title: `Bolaloca - ${stream.title}`,
            url: stream.url,
            originalUrl: stream.url,
            referer: stream.referer,
            userAgent: stream.userAgent || LIVE_PAGE_USER_AGENT,
            _isEmbed: true,
            behaviorHints: {
              notWebReady: false,
            },
          };
        }

        const encodedUrl = encodeURIComponent(stream.url);
        const headers = JSON.stringify(
          buildStreamProxyHeaders(
            stream.referer || BOLALOCA_BASE_URL,
            BOLALOCA_BASE_URL,
            stream.userAgent || LIVE_PAGE_USER_AGENT,
          ),
        );
        const encodedHeaders = encodeURIComponent(headers);
        // Only proxyify if VIP
        const proxyUrl = isVip.vip
          ? `${PROXY_SERVER_URL}?url=${encodedUrl}&headers=${encodedHeaders}`
          : stream.url;

        return {
          title: `Bolaloca - ${stream.title}`,
          url: proxyUrl,
          originalUrl: stream.url,
          referer: stream.referer, // Pass referer for extension
          userAgent: stream.userAgent || LIVE_PAGE_USER_AGENT,
          behaviorHints: {
            notWebReady: false,
          },
        };
      });

      streamData = {
        streams: streams,
        _cacheTime: Date.now(),
      };

      // Save to cache with timestamp
      await saveToCache(sosplayCacheKey, streamData);
    } else if (channelId.startsWith("livetv_")) {
      if (mode === "sources") {
        const livetvSourcesCacheKey = generateCacheKey(
          `livetv_sources_${channelId}_v1`,
        );
        const cachedLiveTvSources = await getFromCacheMs(
          livetvSourcesCacheKey,
          30000,
        );

        if (cachedLiveTvSources) {
          console.log(`[LIVETV] Serving cached source list for ${channelId}`);
          return res.json(cachedLiveTvSources);
        }

        console.log(`[LIVETV] Fetching source list for ${channelId}`);
        const sources = await getLivetvSources(channelId);

        if (!sources || sources.length === 0) {
          return res.status(404).json({ error: "Sources LiveTV introuvables" });
        }

        streamData = {
          sources,
          _cacheTime: Date.now(),
        };

        await saveToCache(livetvSourcesCacheKey, streamData);
      } else {
        const livetvCacheKey = generateCacheKey(
          `livetv_stream_${channelId}_source_${sourceIndex ?? "all"}_ua3_${streamCacheVariant}`,
        );
        const cachedLiveTv = await getFromCacheMs(livetvCacheKey, 30000);

        if (cachedLiveTv) {
          console.log(
            `[LIVETV] Serving cached stream for ${channelId} (source ${sourceIndex ?? "all"})`,
          );
          return res.json(cachedLiveTv);
        }

        console.log(
          `[LIVETV] Fetching fresh stream for ${channelId}${sourceIndex !== null ? ` (source ${sourceIndex + 1})` : ""}`,
        );
        const livetvStreams = await resolveLivetvStream(channelId, {
          sourceIndex,
        });

        if (!livetvStreams || livetvStreams.length === 0) {
          return res.status(404).json({ error: "Flux LiveTV introuvable" });
        }

        const streams = livetvStreams.map((stream) => {
          if (stream._isEmbed) {
            return {
              title: `LiveTV - ${stream.title}`,
              url: stream.url,
              originalUrl: stream.url,
              referer: stream.referer,
              userAgent: stream.userAgent || LIVE_PAGE_USER_AGENT,
              _isEmbed: true,
              _sourceIndex: stream._sourceIndex,
              behaviorHints: {
                notWebReady: false,
              },
            };
          }

          const encodedUrl = encodeURIComponent(stream.url);
          const headers = JSON.stringify(
            buildStreamProxyHeaders(
              stream.referer || LIVETV_BASE_URL,
              LIVETV_BASE_URL,
              stream.userAgent || LIVE_PAGE_USER_AGENT,
            ),
          );
          const encodedHeaders = encodeURIComponent(headers);
          const proxyUrl = isVip.vip
            ? `${PROXY_SERVER_URL}?url=${encodedUrl}&headers=${encodedHeaders}`
            : stream.url;

          return {
            title: `LiveTV - ${stream.title}`,
            url: proxyUrl,
            originalUrl: stream.url,
            referer: stream.referer,
            userAgent: stream.userAgent || LIVE_PAGE_USER_AGENT,
            _sourceIndex: stream._sourceIndex,
            behaviorHints: {
              notWebReady: false,
            },
          };
        });

        streamData = {
          streams,
          _cacheTime: Date.now(),
        };

        await saveToCache(livetvCacheKey, streamData);
      }
    } else if (channelId.startsWith("daddylive_")) {
      if (mode === "sources") {
        const ddSourcesCacheKey = generateCacheKey(
          `daddylive_sources_${channelId}_v1`,
        );
        const cachedDdSources = await getFromCacheMs(ddSourcesCacheKey, 600000); // 10 min
        if (cachedDdSources) {
          return res.json(cachedDdSources);
        }

        const sources = await getDaddyliveSources(channelId);
        if (!sources || sources.length === 0) {
          return res
            .status(404)
            .json({ error: "Sources Daddylive introuvables" });
        }

        streamData = { sources, _cacheTime: Date.now() };
        await saveToCache(ddSourcesCacheKey, streamData);
      } else {
        const ddCacheKey = generateCacheKey(
          `daddylive_stream_${channelId}_source_${sourceIndex ?? "all"}_${streamCacheVariant}`,
        );
        const cachedDd = await getFromCacheMs(ddCacheKey, 30000); // 30s (m3u8 has `expires`)
        if (cachedDd) {
          return res.json(cachedDd);
        }

        const ddStreams = await resolveDaddyliveStream(channelId, {
          sourceIndex,
        });
        if (!ddStreams || ddStreams.length === 0) {
          return res.status(404).json({ error: "Flux Daddylive introuvable" });
        }

        const streams = ddStreams.map((stream) => {
          const encodedUrl = encodeURIComponent(stream.url);
          const headers = JSON.stringify(
            buildStreamProxyHeaders(
              stream.referer || DADDYLIVE_REFERER,
              DADDYLIVE_ORIGIN,
              stream.userAgent || LIVE_PAGE_USER_AGENT,
            ),
          );
          const encodedHeaders = encodeURIComponent(headers);
          const proxyUrl = isVip.vip
            ? `${PROXY_SERVER_URL}?url=${encodedUrl}&headers=${encodedHeaders}`
            : stream.url;

          return {
            title: `Daddylive - ${stream.title}`,
            url: proxyUrl,
            originalUrl: stream.url,
            referer: stream.referer || DADDYLIVE_REFERER,
            userAgent: stream.userAgent || LIVE_PAGE_USER_AGENT,
            _sourceIndex: stream._sourceIndex,
            behaviorHints: { notWebReady: false },
          };
        });

        streamData = { streams, _cacheTime: Date.now() };
        await saveToCache(ddCacheKey, streamData);
      }
    } else if (channelId.startsWith("wiflix_")) {
      // === SOURCE WITV (WIFLIX) ===
      const wiflixCacheKey = generateCacheKey(
        `wiflix_stream_${channelId}_${streamCacheVariant}`,
      );

      // Check for fresh cache (30 seconds) - stale-while-revalidate pattern
      const cachedWiflix = await getFromCacheMs(wiflixCacheKey, 30000); // 30 seconds in ms

      if (cachedWiflix) {
        console.log(`[WITV] Serving cached stream for ${channelId}`);

        // Trigger background update if cache is older than 30 seconds
        const cacheAge = Date.now() - (cachedWiflix._cacheTime || 0);
        if (cacheAge > 30000) {
          // 30 seconds
          console.log(
            `[WITV] Cache is ${cacheAge}ms old, triggering background update`,
          );
          // Background update - don't await
          (async () => {
            try {
              const freshM3u8 = await resolveWitvStream(channelId);
              if (freshM3u8) {
                const encodedUrl = encodeURIComponent(freshM3u8);
                const proxyUrl = isVip.vip
                  ? `${PROXY_SERVER_URL}?url=${encodedUrl}`
                  : freshM3u8;
                const freshData = {
                  streams: [
                    {
                      title: "Orca",
                      url: proxyUrl,
                      originalUrl: freshM3u8,
                      behaviorHints: { notWebReady: false },
                    },
                  ],
                  _cacheTime: Date.now(),
                };
                await saveToCache(wiflixCacheKey, freshData);
                console.log(`[WITV] Background cache updated for ${channelId}`);
              }
            } catch (e) {
              console.error(`[WITV] Background update failed: ${e.message}`);
            }
          })();
        }

        return res.json(cachedWiflix);
      }

      // No cache or expired - fetch fresh
      console.log(`[WITV] Fetching fresh stream for ${channelId}`);
      const m3u8Url = await resolveWitvStream(channelId);

      if (!m3u8Url) {
        return res.status(404).json({ error: "Flux Wiflix introuvable" });
      }

      // For API access (VIP users), wrap URL in proxiesembed proxy
      // Extension users will use originalUrl to handle extraction themselves
      // Only proxyify if VIP
      const encodedUrl = encodeURIComponent(m3u8Url);
      const proxyUrl = isVip.vip
        ? `${PROXY_SERVER_URL}?url=${encodedUrl}`
        : m3u8Url; // Non-VIPs get raw URL (will fail without extension)

      streamData = {
        streams: [
          {
            title: "Orca",
            url: proxyUrl,
            originalUrl: m3u8Url, // Keep original for debugging/extension use
            behaviorHints: {
              notWebReady: false,
            },
          },
        ],
        _cacheTime: Date.now(),
      };

      // Save to cache with timestamp
      await saveToCache(wiflixCacheKey, streamData);
    } else {
      // === SOURCE TV DIRECT ===
      const url = `${TVDIRECT_BASE_URL}/stream/${type}/${channelId}.json`;
      const response = await axios.get(url, {
        headers: STREMIO_HEADERS,
        timeout: 10000,
      });
      streamData = response.data;

      if (streamData.streams) {
        // Résoudre les URLs (spécifique TV Direct)
        const resolvedStreams = await Promise.all(
          streamData.streams.map(async (stream) => {
            if (stream.url) {
              const resolvedUrl = await resolvePlayUrl(stream.url);
              return {
                ...stream,
                url: resolvedUrl || stream.url,
                originalUrl: stream.url,
              };
            }
            return stream;
          }),
        );
        streamData.streams = resolvedStreams.filter((s) => {
          // Filter out invalid streams
          if (!s.url) return false;

          // Filter out ALL FamilyRestream sources (User Request: "non fonctionnel")
          if (
            s.url.includes("familyrestream.com") ||
            (s.originalUrl && s.originalUrl.includes("familyrestream.com"))
          ) {
            return false;
          }

          return true;
        });
      }
    }

    if (
      mode !== "sources" &&
      (!streamData.streams || streamData.streams.length === 0)
    ) {
      return res.status(404).json({ error: "Aucun flux disponible" });
    }

    // Sauvegarder en cache
    if (!skipOuterCache) {
      await saveToCache(cacheKey, streamData);
    }

    res.json(streamData);
  } catch (error) {
    console.error(`[LIVETV] Erreur stream ${channelId}:`, error.message);
    res.status(500).json({ error: "Impossible de charger les flux" });
  }
});

/**
 * GET /api/livetv/fctv/playlist?matchId=&streamId=&siteType=&sportType=
 * FCTV native HLS smart-playlist. Resolves a fresh token, fetches the upstream
 * tokenised m3u8, and rewrites every segment to the playlist host + path-token
 * form (handles cdnSmartLink absolute/&token segments), routed through
 * PROXY_SERVER_URL so the player-origin Referer is injected. This is what makes
 * the Referer-gated v3b streams playable natively in HLSPlayer.
 */
router.get("/fctv/playlist", async (req, res) => {
  const matchId = req.query.matchId;
  const streamId = req.query.streamId;
  const siteType = req.query.siteType || FCTV_DEFAULT_SITE_TYPE;
  const sportType = req.query.sportType || 1;
  // proxy = segments via PROXY_SERVER_URL (VIP). raw = bare CDN urls; the
  // browser extension / userscript injects the player Referer (free users).
  const mode = req.query.mode === "raw" ? "raw" : "proxy";
  if (!matchId || !streamId) {
    return res.status(400).send("missing matchId/streamId");
  }

  try {
    const playerBase = await getFctvPlayerBaseUrl();
    const upstreamHeaders = {
      "User-Agent": STREAM_PROXY_USER_AGENT,
      Accept: "*/*",
      Origin: playerBase,
      Referer: `${playerBase}/`,
    };
    const fetchPlaylist = (data) =>
      axios.get(data.playlistUrl, {
        responseType: "text",
        headers: upstreamHeaders,
        timeout: 15000,
        validateStatus: () => true,
      });
    const ok = (r) =>
      r && r.status === 200 && typeof r.data === "string" && r.data.includes("#EXTM3U");

    // First try the (briefly cached) token; if the upstream rejects it (token
    // expired), re-resolve a fresh token and retry once.
    let resolved = await resolveFctvUpstreamPlaylist(streamId, siteType, matchId, sportType);
    let pr = resolved ? await fetchPlaylist(resolved) : null;
    if (!ok(pr)) {
      resolved = await resolveFctvUpstreamPlaylist(streamId, siteType, matchId, sportType, true);
      pr = resolved ? await fetchPlaylist(resolved) : null;
    }
    if (!resolved || !ok(pr)) {
      console.warn(`[FCTV-PLAYLIST] upstream ${pr ? pr.status : "no-resolve"} for match ${matchId} stream ${streamId}`);
      return res.status(502).send("upstream playlist failed");
    }

    // NOTE: the segment CDN's Referer ACL requires the TRAILING SLASH
    // (`https://host/` returns 200, `https://host` returns 403).
    const segProxyHeaders = encodeURIComponent(
      JSON.stringify(
        buildStreamProxyHeaders(`${playerBase}/`, playerBase, STREAM_PROXY_USER_AGENT),
      ),
    );

    const rewritten = pr.data
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        let abs;
        try {
          abs = new URL(trimmed, resolved.playlistUrl);
        } catch {
          return line;
        }
        // Normalise to: <playlist origin>/token-<T>/<path-after-host>?<query−token>
        abs.searchParams.delete("token");
        const path = abs.pathname.replace(/^\/token-[^/]+/, "");
        const norm = `${resolved.origin}/token-${resolved.token}${path}${abs.search}`;
        // raw mode (free + extension/userscript): bare CDN url; the extension
        // injects the player Referer on the request -> no proxy needed.
        if (mode === "raw") return norm;
        return PROXY_SERVER_URL
          ? `${PROXY_SERVER_URL}?url=${encodeURIComponent(norm)}&headers=${segProxyHeaders}`
          : norm;
      })
      .join("\n");

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    return res.send(rewritten);
  } catch (error) {
    console.error(`[FCTV-PLAYLIST] error match ${matchId} stream ${streamId}:`, error.message);
    return res.status(502).send("fctv playlist error");
  }
});

/**
 * GET /api/livetv/resolve/:playId
 * Résout une URL de lecture spécifique (TV Direct)
 */
router.get("/resolve/:playId", async (req, res) => {
  const { playId } = req.params;

  try {
    const playUrl = `${TVDIRECT_BASE_URL}/play/${playId}`;
    const resolvedUrl = await resolvePlayUrl(playUrl);

    if (!resolvedUrl) {
      return res.status(404).json({ error: "Impossible de résoudre l'URL" });
    }

    res.json({
      originalUrl: playUrl,
      resolvedUrl: resolvedUrl,
    });
  } catch (error) {
    console.error(`[LIVETV] Erreur resolve ${playId}:`, error.message);
    res.status(500).json({ error: "Erreur lors de la résolution" });
  }
});

/**
 * DELETE /api/livetv/cache
 * Nettoie le cache Live TV (admin only)
 */
router.delete("/cache", async (req, res) => {
  try {
    const files = await fsp.readdir(CACHE_DIR);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith(".json")) {
        await fsp.unlink(path.join(CACHE_DIR, file));
        deletedCount++;
      }
    }

    res.json({
      success: true,
      message: `Cache Live TV nettoyé: ${deletedCount} fichiers supprimés`,
    });
  } catch (error) {
    console.error("[LIVETV] Erreur nettoyage cache:", error.message);
    res.status(500).json({ error: "Erreur lors du nettoyage du cache" });
  }
});

// === IPTV WEB (Xtream API) — VIP ONLY ===
const XTREAM_URL = (process.env.XTREAM_URL || "").replace(/\/+$/, "");
const XTREAM_USER = process.env.XTREAM_USER || "";
const XTREAM_PASS = process.env.XTREAM_PASS || "";
const IPTV_IMAGE_PROXY = "https://proxy.movix.blog/proxy";
const IPTV_STREAM_PROXY = "https://proxiesembed.movix.blog/proxy";

// Cache catégories IPTV en mémoire (change rarement)
let iptvCategoriesCache = null;
let iptvCategoriesCacheTime = 0;
const IPTV_CATEGORIES_TTL = 30 * 60 * 1000; // 30 min

// Auto-clear IPTV cache after TTL to free memory when not actively used
setInterval(() => {
  if (
    iptvCategoriesCache &&
    Date.now() - iptvCategoriesCacheTime > IPTV_CATEGORIES_TTL
  ) {
    iptvCategoriesCache = null;
  }
}, IPTV_CATEGORIES_TTL).unref();

/**
 * GET /api/livetv/iptv/categories
 * Récupère les catégories live de l'API Xtream (VIP only)
 */
router.get("/iptv/categories", requireVip, async (req, res) => {
  try {
    const now = Date.now();
    if (
      iptvCategoriesCache &&
      now - iptvCategoriesCacheTime < IPTV_CATEGORIES_TTL
    ) {
      return res.json(iptvCategoriesCache);
    }

    const response = await axios.get(`${XTREAM_URL}/player_api.php`, {
      params: {
        username: XTREAM_USER,
        password: XTREAM_PASS,
        action: "get_live_categories",
      },
      timeout: 15000,
    });

    const categories = (response.data || []).map((cat) => ({
      category_id: cat.category_id,
      category_name: cat.category_name,
      parent_id: cat.parent_id || 0,
    }));

    iptvCategoriesCache = { categories };
    iptvCategoriesCacheTime = now;

    res.json({ categories });
  } catch (error) {
    console.error("[IPTV] Erreur get_live_categories:", error.message);
    res
      .status(500)
      .json({ error: "Erreur lors de la récupération des catégories IPTV" });
  }
});

/**
 * GET /api/livetv/iptv/streams/:categoryId
 * Récupère les chaînes d'une catégorie Xtream (VIP only)
 * Images proxifiées via proxy.movix.blog
 */
router.get("/iptv/streams/:categoryId", requireVip, async (req, res) => {
  const { categoryId } = req.params;

  try {
    const response = await axios.get(`${XTREAM_URL}/player_api.php`, {
      params: {
        username: XTREAM_USER,
        password: XTREAM_PASS,
        action: "get_live_streams",
        category_id: categoryId,
      },
      timeout: 15000,
    });

    const streams = (response.data || []).map((stream) => ({
      stream_id: stream.stream_id,
      name: stream.name,
      stream_icon: stream.stream_icon
        ? `${IPTV_IMAGE_PROXY}/${stream.stream_icon}`
        : null,
      epg_channel_id: stream.epg_channel_id || null,
      category_id: stream.category_id,
    }));

    res.json({ streams });
  } catch (error) {
    console.error(
      `[IPTV] Erreur get_live_streams cat=${categoryId}:`,
      error.message,
    );
    res
      .status(500)
      .json({ error: "Erreur lors de la récupération des chaînes IPTV" });
  }
});

/**
 * GET /api/livetv/iptv/stream-url/:streamId
 * Construit l'URL m3u8 proxifiée pour un stream Xtream (VIP only)
 */
router.get("/iptv/stream-url/:streamId", requireVip, async (req, res) => {
  const { streamId } = req.params;

  try {
    const directUrl = `${XTREAM_URL}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.m3u8`;
    const proxiedUrl = `${IPTV_STREAM_PROXY}/${directUrl}`;

    res.json({
      streams: [
        {
          url: proxiedUrl,
          title: "IPTV Stream",
          behaviorHints: { notWebReady: false },
        },
      ],
    });
  } catch (error) {
    console.error(`[IPTV] Erreur stream-url ${streamId}:`, error.message);
    res.status(500).json({ error: "Erreur lors de la construction de l'URL" });
  }
});

module.exports = router;
