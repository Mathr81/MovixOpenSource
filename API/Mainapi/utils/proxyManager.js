/**
 * Proxy management utilities.
 * Extracted from server.js — centralizes all proxy configuration, agent caching,
 * Cloudflare Workers proxy rotation, CORS fallback, and site-specific request helpers.
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const tough = require("tough-cookie");
const initCycleTLS = require("cycletls");

// === PROXY AGENT CACHES ===
const proxyAgentCache = new Map();
const darkinoProxyAgentCache = new Map();
const proxyRotationState = new Map();

// Initialize global agent keep-alive with socket limits
http.globalAgent.keepAlive = true;
http.globalAgent.maxSockets = 128;
http.globalAgent.maxFreeSockets = 32;
https.globalAgent.keepAlive = true;
https.globalAgent.maxSockets = 128;
https.globalAgent.maxFreeSockets = 32;

// === PROXY CONFIGURATION FLAGS ===
const ENABLE_DARKINO_PROXY = true; // Passe \u00e0 false pour d\u00e9sactiver le proxy pour Darkino
const ENABLE_COFLIX_PROXY = true; // Passe \u00e0 false pour d\u00e9sactiver le proxy pour Coflix
const ENABLE_FRENCH_STREAM_PROXY = true; // Active/d\u00e9sactive le proxy pour French-Stream
const ENABLE_LECTEURVIDEO_PROXY = true; // Active/d\u00e9sactive le proxy pour LecteurVideo
const ENABLE_FSTREAM_PROXY = true; // Active/d\u00e9sactive le proxy pour FStream
const ENABLE_ANIME_PROXY = true; // Active/d\u00e9sactive le proxy pour AnimeSama (via Cloudflare Workers)
const ENABLE_WIFLIX_PROXY = true; // Active/d\u00e9sactive le proxy pour Wiflix
const MAX_LECTEURVIDEO_PROXY_ATTEMPTS = 2;

// Constante pour l'enhancement Darkino
const darkiworld_premium = false; // Passe \u00e0 false pour d\u00e9sactiver l'enhancement Darkino

// === DARKINO 403 COOLDOWN ===
// Cooldown de 5 minutes apr\u00e8s une erreur 403 (Cloudflare challenge)
const DARKINO_403_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let darkino403CooldownUntil = 0; // Timestamp jusqu'auquel on ne fait plus de requ\u00eates

// === CPASMAL CONFIGURATION ===
const CPASMAL_BASE_URL = "https://www.cpasmal.rip";

const cpasmalJar = new tough.CookieJar(null, { rejectPublicSuffixes: false });

// Cache pour les agents SOCKS5 Cpasmal (Keep-Alive)
const cpasmalAgentCache = new Map();

function getCpasmalAgent(proxy) {
  if (!proxy) return null;
  const cacheKey = `${proxy.type}:${proxy.host}:${proxy.port}:${proxy.auth}`;

  if (cpasmalAgentCache.has(cacheKey)) {
    return cpasmalAgentCache.get(cacheKey);
  }

  // Configuration Keep-Alive optimis\u00e9e
  const agentOpts = {
    keepAlive: true,
    keepAliveMsecs: 15000, // 15s keep-alive
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000,
  };

  let agent;
  if (proxy.type === "socks5" || proxy.type === "socks5h") {
    const info = {
      hostname: proxy.host,
      port: proxy.port,
      protocol: "socks:",
      tls: { rejectUnauthorized: false },
      ...agentOpts,
    };

    // Auth handling
    if (proxy.auth) {
      const parts = proxy.auth.split(":");
      info.username = parts[0]; // Correction: userId -> username
      info.password = parts[1];
    }

    agent = new SocksProxyAgent(info);
  }

  if (agent) {
    cpasmalAgentCache.set(cacheKey, agent);
  }
  return agent;
}

// Fonction pour faire des requ\u00eates vers Cpasmal avec rotation de proxies SOCKS5
async function axiosCpasmalRequest(config) {
  const urlStr = config.url || "";

  // Constante pour Cpasmal Base URL si relative
  const baseURL = CPASMAL_BASE_URL;

  // Headers par d\u00e9faut
  const defaultHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    ...(config.headers || {}),
  };

  // Gestion des cookies (r\u00e9cup\u00e9ration manuelle pour compatibilit\u00e9 avec proxy agent)
  if (urlStr || config.baseURL) {
    try {
      // Reconstitution approximative de l'URL pour les cookies
      const targetUrl = urlStr.startsWith("http")
        ? urlStr
        : (config.baseURL || baseURL) + urlStr;
      const cookieString = await cpasmalJar.getCookieString(targetUrl);
      if (cookieString) {
        defaultHeaders["Cookie"] = cookieString;
      }
    } catch (err) {
      console.error("[Cpasmal CookieJar] Error getting cookies:", err);
    }
  }

  // Déterminer les agents proxy à utiliser :
  // 1. _cpasmalAgents fournis (session scopée avec DARKINO_PROXIES HTTP)
  // 2. _cpasmalProxy fourni (SOCKS5 override)
  // 3. Sinon : proxy SOCKS5 aléatoire (legacy)
  let httpAgent, httpsAgent, proxyLabel;

  if (config._cpasmalAgents) {
    httpAgent = config._cpasmalAgents.httpAgent;
    httpsAgent = config._cpasmalAgents.httpsAgent;
    proxyLabel = config._cpasmalAgents._label || "HTTP proxy";
  } else {
    const proxy =
      config._cpasmalProxy !== undefined
        ? config._cpasmalProxy
        : pickRandomProxyOrNone();
    const agent = getCpasmalAgent(proxy);
    httpAgent = agent;
    httpsAgent = agent;
    proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : "Direct";
  }

  // Nettoyer les champs internes avant de passer à axios
  const { _cpasmalProxy, _cpasmalAgents, ...cleanConfig } = config;

  try {
    if (process.env.DEBUG_CPASMAL === "true")
      console.time(`[Cpasmal] Request ${urlStr} (Proxy: ${proxyLabel})`);

    const response = await axios({
      ...cleanConfig,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent,
      proxy: false,
      timeout: config.timeout || 5000,
      decompress: true,
    });

    if (process.env.DEBUG_CPASMAL === "true")
      console.timeEnd(`[Cpasmal] Request ${urlStr} (Proxy: ${proxyLabel})`);

    // Gestion des cookies (sauvegarde manuelle)
    if (response.headers["set-cookie"]) {
      const cookies = response.headers["set-cookie"];
      const url = response.config.url;
      try {
        if (Array.isArray(cookies)) {
          for (const cookie of cookies) {
            await cpasmalJar.setCookie(cookie, url);
          }
        } else {
          await cpasmalJar.setCookie(cookies, url);
        }
      } catch (err) {
        console.error("[Cpasmal CookieJar] Error setting cookies:", err);
      }
    }

    return response;
  } catch (error) {
    // Ajouter infos debug
    error.cpasmalUrl = urlStr;
    error.cpasmalProxy = proxyLabel;

    // Propager l'erreur immédiatement
    throw error;
  }
}

// === CLOUDFLARE WORKERS PROXIES CONFIGURATION ===
const CLOUDFLARE_WORKERS_PROXIES = (
  process.env.CLOUDFLARE_WORKERS_PROXIES || ""
)
  .split(",")
  .map((proxy) => proxy.trim())
  .filter(Boolean);

// === CACHE POUR LES PROXIES CLOUDFLARE EN ERREUR ===
// Cache pour m\u00e9moriser les proxies en erreur (429, 500, timeout, etc.)
// Les proxies en erreur seront ignor\u00e9s pendant PROXY_ERROR_COOLDOWN_MS millisecondes
const proxyErrorCache = new Map(); // Map<proxyUrl, { errorTime: timestamp, errorCode: number|string, errorCount: number }>
const PROXY_ERROR_COOLDOWN_MS = 60000; // 60 secondes de cooldown pour un proxy en erreur
const PROXY_ERROR_COOLDOWN_429_MS = 120000; // 2 minutes de cooldown sp\u00e9cifique pour erreur 429 (rate limit)
const PROXY_ERROR_COOLDOWN_5XX_MS = 90000; // 1.5 minutes pour les erreurs serveur (500, 502, 503, 504)
const MAX_CONSECUTIVE_ERRORS = 3; // Nombre max d'erreurs cons\u00e9cutives avant cooldown prolong\u00e9
const PROXY_EXTENDED_COOLDOWN_MS = 300000; // 5 minutes de cooldown prolong\u00e9 si trop d'erreurs cons\u00e9cutives

/**
 * Marque un proxy comme \u00e9tant en erreur
 * @param {string} proxyUrl - URL du proxy
 * @param {number|string} errorCode - Code d'erreur (429, 500, 'timeout', etc.)
 */
function markProxyAsErrored(proxyUrl, errorCode) {
  const existing = proxyErrorCache.get(proxyUrl);
  const errorCount = existing ? existing.errorCount + 1 : 1;

  proxyErrorCache.set(proxyUrl, {
    errorTime: Date.now(),
    errorCode,
    errorCount,
  });

  // Log seulement si DEBUG activ\u00e9
  if (process.env.DEBUG_PROXY) {
    console.log(
      `[PROXY CACHE] Proxy marqu\u00e9 en erreur: ${proxyUrl} (code: ${errorCode}, count: ${errorCount})`,
    );
  }
}

/**
 * V\u00e9rifie si un proxy est actuellement en cooldown (\u00e0 \u00e9viter)
 * @param {string} proxyUrl - URL du proxy
 * @returns {boolean} - true si le proxy doit \u00eatre ignor\u00e9
 */
function isProxyInCooldown(proxyUrl) {
  const errorInfo = proxyErrorCache.get(proxyUrl);
  if (!errorInfo) return false;

  const now = Date.now();
  const timeSinceError = now - errorInfo.errorTime;

  // D\u00e9terminer le cooldown appropri\u00e9 selon le type d'erreur et le nombre d'erreurs
  let cooldownMs;
  if (errorInfo.errorCount >= MAX_CONSECUTIVE_ERRORS) {
    cooldownMs = PROXY_EXTENDED_COOLDOWN_MS;
  } else if (errorInfo.errorCode === 429) {
    cooldownMs = PROXY_ERROR_COOLDOWN_429_MS;
  } else if (errorInfo.errorCode >= 500 && errorInfo.errorCode < 600) {
    cooldownMs = PROXY_ERROR_COOLDOWN_5XX_MS;
  } else {
    cooldownMs = PROXY_ERROR_COOLDOWN_MS;
  }

  // Si le cooldown est pass\u00e9, supprimer l'entr\u00e9e du cache
  if (timeSinceError >= cooldownMs) {
    proxyErrorCache.delete(proxyUrl);
    return false;
  }

  return true;
}

/**
 * Retourne la liste des proxies disponibles (non en cooldown)
 * @param {string[]} allProxies - Liste de tous les proxies
 * @returns {string[]} - Liste des proxies disponibles
 */
function getAvailableProxies(allProxies) {
  const available = allProxies.filter((proxy) => !isProxyInCooldown(proxy));

  // Si tous les proxies sont en cooldown, on r\u00e9initialise le cache et on retourne tous les proxies
  // pour \u00e9viter de bloquer compl\u00e8tement le service
  if (available.length === 0) {
    if (process.env.DEBUG_PROXY) {
      console.log(
        "[PROXY CACHE] Tous les proxies sont en cooldown, r\u00e9initialisation du cache",
      );
    }
    proxyErrorCache.clear();
    return allProxies;
  }

  return available;
}

/**
 * R\u00e9initialise le compteur d'erreurs d'un proxy apr\u00e8s un succ\u00e8s
 * @param {string} proxyUrl - URL du proxy
 */
function markProxyAsHealthy(proxyUrl) {
  proxyErrorCache.delete(proxyUrl);
}

// Nettoyage p\u00e9riodique du proxyErrorCache — supprime les entr\u00e9es dont le cooldown a expir\u00e9
setInterval(
  () => {
    const now = Date.now();
    for (const [proxyUrl, errorInfo] of proxyErrorCache) {
      const maxCooldown = PROXY_EXTENDED_COOLDOWN_MS; // 5 min = cooldown le plus long
      if (now - errorInfo.errorTime > maxCooldown) {
        proxyErrorCache.delete(proxyUrl);
      }
    }
  },
  5 * 60 * 1000,
).unref(); // Toutes les 5 minutes — unref to not prevent process exit

/**
 * Construit l'URL proxy en fonction du type de proxy
 * Les proxies se terminant par '/' attendent l'URL encod\u00e9e
 * Les proxies se terminant par '?' attendent l'URL non-encod\u00e9e
 * @param {string} proxyUrl - URL du proxy Cloudflare
 * @param {string} targetUrl - URL cible \u00e0 proxyer
 * @returns {string} - URL finale \u00e0 appeler
 */
function buildProxiedUrl(proxyUrl, targetUrl) {
  if (proxyUrl.endsWith("/")) {
    // Proxy qui attend l'URL encod\u00e9e (ex: cors-worker-1)
    return proxyUrl + encodeURIComponent(targetUrl);
  } else {
    // Proxy qui attend l'URL en query string (ex: ?url=...)
    return proxyUrl + targetUrl;
  }
}

// Fonction pour faire une requ\u00eate avec fallback CORS en cas d'erreur 429
async function makeRequestWithCorsFallback(targetUrl, options = {}) {
  const {
    timeout = 7000,
    headers = {},
    decompress = true,
    method: requestMethod,
    data: requestData,
    ...otherOptions
  } = options;

  const method = (requestMethod || 'GET').toUpperCase();
  const defaultHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    priority: "u=1, i",
    "sec-ch-ua":
      '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...headers,
  };

  // Filtrer les proxies disponibles (non en cooldown)
  const availableProxies = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);

  if (availableProxies.length === 0) {
    return axios({
      url: targetUrl,
      method,
      headers: defaultHeaders,
      timeout,
      decompress,
      ...(requestData !== undefined ? { data: requestData } : {}),
      ...otherOptions,
    });
  }

  // Utiliser directement les proxies Cloudflare Workers disponibles
  let lastError = null;

  for (let i = 0; i < availableProxies.length; i++) {
    const currentProxy = availableProxies[i];
    try {
      const finalProxyUrl = buildProxiedUrl(currentProxy, targetUrl);

      const response = await axios({
        url: finalProxyUrl,
        method,
        headers: defaultHeaders,
        timeout,
        decompress,
        ...(requestData !== undefined ? { data: requestData } : {}),
        ...otherOptions,
      });

      // Succ\u00e8s : marquer le proxy comme sain
      markProxyAsHealthy(currentProxy);
      return response;
    } catch (proxyError) {
      lastError = proxyError;
      const statusCode = proxyError.response?.status;
      const errorCode = statusCode || proxyError.code || "unknown";

      // En cas d'erreur 400 ou 403, arr\u00eat imm\u00e9diat sans r\u00e9essayer avec d'autres proxies
      if (statusCode === 400 || statusCode === 403) {
        throw proxyError;
      }

      // Marquer le proxy en erreur pour les codes 429, 5xx, timeout, etc.
      if (
        statusCode === 429 ||
        (statusCode >= 500 && statusCode < 600) ||
        proxyError.code === "ECONNABORTED" ||
        proxyError.code === "ETIMEDOUT"
      ) {
        markProxyAsErrored(currentProxy, errorCode);
      }

      // Si c'est le dernier proxy et qu'on a une erreur, throw l'erreur
      if (i === availableProxies.length - 1) {
        throw proxyError;
      }
      // Sinon continuer avec le prochain proxy (429, etc.)
    }
  }

  // Si on arrive ici, tous les proxies ont \u00e9chou\u00e9
  throw lastError || new Error("Tous les proxies ont \u00e9chou\u00e9");
}

// Fonction pour faire une requ\u00eate Coflix avec rotation Cloudflare Workers.
async function makeCoflixRequest(targetUrl, options = {}) {
  const {
    timeout = 15000,
    headers = {},
    decompress = true,
    ...otherOptions
  } = options;

  // Nettoyer l'URL pour \u00e9viter les espaces ind\u00e9sirables
  const cleanTargetUrl = targetUrl.trim();

  // Headers pour les requ\u00eates Coflix via proxy
  const coflixProxyHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...headers,
  };

  // Supprimer les headers li\u00e9s \u00e0 l'IP d'origine pour \u00e9viter de les transmettre
  const headersToRemove = [
    "X-Forwarded-For",
    "X-Real-IP",
    "X-Client-IP",
    "CF-Connecting-IP",
    "True-Client-IP",
    "X-Original-Forwarded-For",
  ];
  const cleanHeaders = { ...coflixProxyHeaders };
  headersToRemove.forEach((header) => {
    delete cleanHeaders[header];
    delete cleanHeaders[header.toLowerCase()];
  });

  const proxyCandidates = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);
  let lastError = null;

  if (proxyCandidates.length === 0) {
    return axios({
      url: cleanTargetUrl,
      method: otherOptions.method || "GET",
      headers: cleanHeaders,
      timeout,
      decompress,
      responseType: "text",
      responseEncoding: "utf8",
      ...otherOptions,
    });
  }

  // Un 403/429 peut d\u00e9pendre du worker utilise : on tente chaque worker avant d'abandonner.
  for (let i = 0; i < proxyCandidates.length; i++) {
    const cloudflareProxy = proxyCandidates[i];
    const proxiedUrl = buildProxiedUrl(cloudflareProxy, cleanTargetUrl);

    try {
      const response = await axios({
        url: proxiedUrl,
        method: otherOptions.method || "GET",
        headers: cleanHeaders,
        timeout,
        decompress,
        responseType: "text",
        responseEncoding: "utf8",
        ...otherOptions,
      });

      markProxyAsHealthy(cloudflareProxy);
      return response;
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status;
      const errorCode = error.code || "unknown";

      error.coflixUrl = cleanTargetUrl;
      error.coflixProxy = cloudflareProxy;
      error.coflixProxiedUrl = proxiedUrl;

      if (statusCode === 403 || statusCode === 429) {
        markProxyAsErrored(cloudflareProxy, statusCode);
        continue;
      }

      if (statusCode >= 500 && statusCode < 600) {
        markProxyAsErrored(cloudflareProxy, statusCode);
        continue;
      }

      if (
        errorCode === "ECONNABORTED" ||
        errorCode === "ETIMEDOUT" ||
        errorCode === "ECONNRESET" ||
        errorCode === "EHOSTUNREACH" ||
        errorCode === "ENETUNREACH"
      ) {
        markProxyAsErrored(cloudflareProxy, errorCode);
        continue;
      }

      // Pour les erreurs fonctionnelles (400, 404, parsing, etc.), arr\u00eater imm\u00e9diatement.
      throw error;
    }
  }

  if (lastError) throw lastError;
  throw new Error(
    "Tous les Cloudflare Workers proxies ont \u00e9chou\u00e9 (Coflix)",
  );
}

// Fonction pour faire une requete LecteurVideo avec CycleTLS.
// On limite volontairement la rotation a 2 proxies max pour eviter de balayer tout le pool.
// Instance CycleTLS partagee (singleton)
let cycleTLSInstance = null;
let cycleTLSInitializing = false;
const cycleTLSWaiters = [];

async function getCycleTLS() {
  if (cycleTLSInstance) return cycleTLSInstance;
  if (cycleTLSInitializing) {
    return new Promise((resolve) => cycleTLSWaiters.push(resolve));
  }
  cycleTLSInitializing = true;
  try {
    cycleTLSInstance = await initCycleTLS();
    cycleTLSInitializing = false;
    for (const waiter of cycleTLSWaiters) waiter(cycleTLSInstance);
    cycleTLSWaiters.length = 0;
    return cycleTLSInstance;
  } catch (err) {
    cycleTLSInitializing = false;
    // Reject all waiters so they don't leak forever
    for (const waiter of cycleTLSWaiters) waiter(Promise.reject(err));
    cycleTLSWaiters.length = 0;
    throw err;
  }
}

// Graceful shutdown: kill CycleTLS Go subprocess
async function shutdownCycleTLS() {
  if (cycleTLSInstance) {
    try {
      await cycleTLSInstance.exit();
    } catch {
      /* ignore */
    }
    cycleTLSInstance = null;
  }
}

// JA3 fingerprint Chrome 120+
const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function pickLecteurVideoProxyCandidates() {
  const httpPool =
    HTTP_PROXIES.length > 0
      ? HTTP_PROXIES
      : parseProxyPayload(process.env.HTTP_PROXIES, "http")
          .map((entry) => sanitizeProxyEntry(entry, "http"))
          .filter(Boolean);

  const socksPool =
    PROXIES.length > 0
      ? PROXIES
      : parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
          .map((entry) => sanitizeProxyEntry(entry, "socks5"))
          .filter(Boolean);

  const preferredPool =
    httpPool.length > 0
      ? { proxies: httpPool, useSocks: false, label: "HTTP_PROXIES" }
      : { proxies: socksPool, useSocks: true, label: "SOCKS5_PROXIES" };

  if (!preferredPool.proxies || preferredPool.proxies.length === 0) {
    return {
      proxies: [],
      useSocks: false,
      label: "aucun",
      totalAvailable: 0,
    };
  }

  const selectedProxies = [...preferredPool.proxies]
    .sort(() => Math.random() - 0.5)
    .slice(0, MAX_LECTEURVIDEO_PROXY_ATTEMPTS);

  return {
    proxies: selectedProxies,
    useSocks: preferredPool.useSocks,
    label: preferredPool.label,
    totalAvailable: preferredPool.proxies.length,
  };
}

async function makeLecteurVideoRequest(targetUrl, options = {}) {
  const { headers = {} } = options;
  const cleanTargetUrl = targetUrl.trim();

  const {
    proxies,
    useSocks,
    label: proxyPoolLabel,
    totalAvailable,
  } = pickLecteurVideoProxyCandidates();

  if (!proxies || proxies.length === 0) {
    const cycleTLS = await getCycleTLS();
    const response = await cycleTLS(
      cleanTargetUrl,
      {
        body: "",
        ja3: CHROME_JA3,
        userAgent: CHROME_UA,
        headers: {
          Referer: "https://coflix.date/",
          Origin: "https://coflix.date",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9",
          ...headers,
        },
        timeout: 15,
      },
      "get",
    );

    const body =
      typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);
    return {
      data: body,
      status: response.status,
      headers: response.headers || {},
    };
  }

  const cycleTLS = await getCycleTLS();
  let lastError = null;

  console.log(
    `[LECTEURVIDEO] ${proxies.length} proxy(s) retenu(s) sur ${totalAvailable} depuis ${proxyPoolLabel}`,
  );

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = useSocks
      ? `socks5h://${auth}${proxy.host}:${proxy.port}`
      : `http://${auth}${proxy.host}:${proxy.port}`;

    console.log(
      `[LECTEURVIDEO] tentative ${i + 1}/${proxies.length} via cycletls + ${proxy.host}:${proxy.port} (${proxyPoolLabel})`,
    );

    try {
      const response = await cycleTLS(
        cleanTargetUrl,
        {
          body: "",
          ja3: CHROME_JA3,
          userAgent: CHROME_UA,
          proxy: proxyUrl,
          headers: {
            Referer: "https://coflix.date/",
            Origin: "https://coflix.date",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9",
            ...headers,
          },
          timeout: 15,
        },
        "get",
      );

      const body =
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
      const title = body.match(/<title>(.*?)<\/title>/i)?.[1] || "no title";
      console.log(
        `[LECTEURVIDEO] ${proxy.host}:${proxy.port} -> ${response.status} | title: ${title} | ${body.length} chars`,
      );

      if (
        response.status === 403 &&
        (body.includes("cf-wrapper") || body.includes("cloudflare"))
      ) {
        console.warn(
          `[LECTEURVIDEO] proxy ${i + 1}/${proxies.length} (${proxy.host}) bloque par Cloudflare, retry...`,
        );
        continue;
      }

      return {
        data: body,
        status: response.status,
        headers: response.headers || {},
      };
    } catch (error) {
      console.error(
        `[LECTEURVIDEO] proxy ${i + 1}/${proxies.length} (${proxy.host}) echoue: ${error.message?.substring(0, 100)}`,
      );
      lastError = error;
      continue;
    }
  }

  console.error(
    `[LECTEURVIDEO] tous les proxies ont echoue pour ${cleanTargetUrl}`,
  );
  throw lastError || new Error("[LECTEURVIDEO] Tous les proxies ont echoue");
}

// Fonction AnimeSama avec CycleTLS (cloudscraper-style : JA3 Chrome pour bypass Cloudflare).
// Utilise le SOCKS5_PROXIES env directement (proxies dedies) -- pas le pool ProxyScrape,
// pas de fallback direct sans proxy.
const MAX_ANIMESAMA_CYCLETLS_ATTEMPTS = 2;
const ANIMESAMA_SOCKS5_PROXIES = dedupeProxyEntries(
  parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(Boolean),
);

async function makeAnimeSamaRequest(targetUrl, options = {}) {
  const {
    headers = {},
    timeout = 30,
    method = "get",
    body = "",
  } = options;
  const cleanTargetUrl = targetUrl.trim();
  const lowerMethod = String(method).toLowerCase();

  const defaultHeaders = {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.6",
    ...headers,
  };

  const pool = [...ANIMESAMA_SOCKS5_PROXIES]
    .sort(() => Math.random() - 0.5)
    .slice(0, MAX_ANIMESAMA_CYCLETLS_ATTEMPTS);

  if (pool.length === 0) {
    throw new Error(
      "[ANIMESAMA CYCLETLS] aucun proxy SOCKS5 defini dans SOCKS5_PROXIES",
    );
  }

  const cycleTLS = await getCycleTLS();

  const asAxiosLike = (response) => {
    const data =
      typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);
    return { data, status: response.status, headers: response.headers || {} };
  };

  const isCloudflareBlock = (status, bodyStr) =>
    status === 403 &&
    typeof bodyStr === "string" &&
    (bodyStr.includes("cf-wrapper") || bodyStr.includes("cloudflare"));

  let lastError = null;

  for (let i = 0; i < pool.length; i++) {
    const proxy = pool[i];
    const auth = proxy.auth ? `${proxy.auth}@` : "";
    const proxyUrl = `socks5h://${auth}${proxy.host}:${proxy.port}`;

    try {
      const response = await cycleTLS(
        cleanTargetUrl,
        {
          body,
          ja3: CHROME_JA3,
          userAgent: CHROME_UA,
          proxy: proxyUrl,
          headers: defaultHeaders,
          timeout,
        },
        lowerMethod,
      );

      const result = asAxiosLike(response);
      if (isCloudflareBlock(result.status, result.data)) {
        lastError = new Error(
          `[ANIMESAMA CYCLETLS] cloudflare block via ${proxy.host}:${proxy.port}`,
        );
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("[ANIMESAMA CYCLETLS] tous les proxies ont echoue");
}

// === SOCKS5 PROXIES (from env) ===
const parseJsonArrayEnv = (envName, fallback = []) => {
  const rawValue = process.env[envName];
  if (!rawValue) return fallback;
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const { redis } = require("../config/redis");
const { acquireRedisLock } = require("./redisLock");

const PROXY_ROTATION_REDIS_PREFIX = "proxyscrape:rotation:v1";
const PROXY_RATE_LIMIT_REDIS_PREFIX = "proxyscrape:rate-limit:v1";
const proxyRateLimitState = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProxyRateLimitKey(poolName, proxy) {
  if (!proxy || !proxy.host || !proxy.port) return null;
  return `${PROXY_RATE_LIMIT_REDIS_PREFIX}:${poolName}:${proxy.type || "proxy"}:${proxy.host}:${proxy.port}:${proxy.auth || ""}`;
}

function reserveLocalRateLimitedProxy(proxyKey, minIntervalMs) {
  if (!proxyKey) return false;

  const now = Date.now();
  const nextAllowedAt = proxyRateLimitState.get(proxyKey) || 0;
  if (nextAllowedAt > now) {
    return false;
  }

  proxyRateLimitState.set(proxyKey, now + minIntervalMs);
  return true;
}

async function reserveRateLimitedProxy(poolName, proxy, minIntervalMs) {
  if (!proxy) return false;

  const safeIntervalMs = Math.max(0, Math.floor(Number(minIntervalMs) || 0));
  if (safeIntervalMs <= 0) {
    return true;
  }

  const proxyKey = buildProxyRateLimitKey(poolName, proxy);
  if (!proxyKey) {
    return false;
  }

  try {
    const reserved = await redis.set(
      proxyKey,
      String(Date.now()),
      "PX",
      safeIntervalMs,
      "NX",
    );
    if (reserved === "OK") {
      return true;
    }
    return false;
  } catch {
    // Fallback local si Redis n'est pas disponible.
  }

  return reserveLocalRateLimitedProxy(proxyKey, safeIntervalMs);
}

setInterval(() => {
  const now = Date.now();
  for (const [proxyKey, nextAllowedAt] of proxyRateLimitState) {
    if (!Number.isFinite(nextAllowedAt) || nextAllowedAt <= now) {
      proxyRateLimitState.delete(proxyKey);
    }
  }
}, 30 * 1000).unref();

function reserveLocalProxyWindow(poolName, poolLength, batchSize) {
  const existingCursor = proxyRotationState.get(poolName);
  const startIndex = Number.isInteger(existingCursor)
    ? existingCursor % poolLength
    : Math.floor(Math.random() * poolLength);

  proxyRotationState.set(poolName, (startIndex + batchSize) % poolLength);
  return startIndex;
}

async function reserveProxyWindow(poolName, poolLength, batchSize = 1) {
  if (!Number.isFinite(poolLength) || poolLength <= 0) {
    return 0;
  }

  const safeBatchSize = Math.min(
    poolLength,
    Math.max(1, Math.floor(Number(batchSize) || 1)),
  );

  try {
    const rotationKey = `${PROXY_ROTATION_REDIS_PREFIX}:${poolName}`;
    const nextValue = await redis.incrby(rotationKey, safeBatchSize);
    const startIndex = Number(nextValue) - safeBatchSize;
    return ((startIndex % poolLength) + poolLength) % poolLength;
  } catch {
    return reserveLocalProxyWindow(poolName, poolLength, safeBatchSize);
  }
}

async function pickNextProxyBatch(pool, count = 1, poolName = "default") {
  if (!Array.isArray(pool) || pool.length === 0) {
    return [];
  }

  const safeCount = Math.min(
    pool.length,
    Math.max(1, Math.floor(Number(count) || 1)),
  );
  const startIndex = await reserveProxyWindow(poolName, pool.length, safeCount);
  const selected = [];

  for (let offset = 0; offset < safeCount; offset++) {
    selected.push(pool[(startIndex + offset) % pool.length]);
  }

  return selected;
}

async function pickNextRateLimitedProxy(pool, options = {}) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return null;
  }

  const {
    poolName = "default",
    minIntervalMs = 0,
    waitTimeoutMs = 0,
    retryDelayMs = 25,
  } = options;

  const safeMinIntervalMs = Math.max(0, Math.floor(Number(minIntervalMs) || 0));
  if (safeMinIntervalMs <= 0) {
    const [proxy] = await pickNextProxyBatch(pool, 1, poolName);
    return proxy || null;
  }

  const deadline =
    Date.now() + Math.max(0, Math.floor(Number(waitTimeoutMs) || 0));

  while (true) {
    const startIndex = await reserveProxyWindow(poolName, pool.length, 1);

    for (let offset = 0; offset < pool.length; offset++) {
      const proxy = pool[(startIndex + offset) % pool.length];
      const reserved = await reserveRateLimitedProxy(
        poolName,
        proxy,
        safeMinIntervalMs,
      );
      if (reserved) {
        return proxy;
      }
    }

    if (Date.now() >= deadline) {
      return null;
    }

    const remainingMs = deadline - Date.now();
    await sleep(Math.max(5, Math.min(retryDelayMs, remainingMs)));
  }
}

async function pickNextSocks5Proxy(options = {}) {
  const proxy = await pickNextRateLimitedProxy(PROXIES, {
    poolName: "SOCKS5_PROXIES",
    ...options,
  });
  return proxy || null;
}

const splitCsvEnv = (envName, fallback = []) => {
  const rawValue = process.env[envName];
  if (!rawValue) return [...fallback];
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const parsePositiveIntEnv = (envName, fallback) => {
  const rawValue = process.env[envName];
  const parsed = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function normalizeProxyType(type, fallback = "http") {
  const normalized = String(type || fallback)
    .toLowerCase()
    .replace(/:$/, "")
    .trim();
  if (
    normalized === "socks" ||
    normalized === "socks5h" ||
    normalized.startsWith("socks5")
  ) {
    return "socks5";
  }
  if (normalized.startsWith("http")) {
    return "http";
  }
  return fallback;
}

function updateArrayInPlace(target, nextValues) {
  target.splice(0, target.length, ...nextValues);
  return target;
}

function dedupeProxyEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry || !entry.host || !entry.port) return false;
    const key = `${entry.type}:${entry.host}:${entry.port}:${entry.auth || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeProxyEntry(entry, fallbackType = "http") {
  if (!entry || !entry.host || !entry.port) return null;
  const port = Number.parseInt(entry.port, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    host: String(entry.host).trim(),
    port,
    auth: entry.auth ? String(entry.auth).trim() : undefined,
    type: normalizeProxyType(entry.type, fallbackType),
  };
}

function parseProxyString(value, defaultType = "http") {
  if (!value || typeof value !== "string") return null;
  const rawValue = value.trim();
  if (!rawValue) return null;

  if (/^[a-z]+:\/\//i.test(rawValue)) {
    try {
      const parsedUrl = new URL(rawValue);
      return sanitizeProxyEntry(
        {
          host: parsedUrl.hostname,
          port: parsedUrl.port,
          auth: parsedUrl.username
            ? `${decodeURIComponent(parsedUrl.username)}${parsedUrl.password ? `:${decodeURIComponent(parsedUrl.password)}` : ""}`
            : undefined,
          type: parsedUrl.protocol.replace(":", ""),
        },
        defaultType,
      );
    } catch {
      return null;
    }
  }

  const authSplitIndex = rawValue.lastIndexOf("@");
  let authPart = "";
  let hostPortPart = rawValue;
  if (authSplitIndex !== -1) {
    authPart = rawValue.slice(0, authSplitIndex).trim();
    hostPortPart = rawValue.slice(authSplitIndex + 1).trim();
  }

  const segments = hostPortPart
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 2) {
    return sanitizeProxyEntry(
      {
        host: segments[0],
        port: segments[1],
        auth: authPart || undefined,
        type: defaultType,
      },
      defaultType,
    );
  }

  if (!authPart && segments.length === 4) {
    const [a, b, c, d] = segments;
    if (/^\d+$/.test(b)) {
      return sanitizeProxyEntry(
        {
          host: a,
          port: b,
          auth: `${c}:${d}`,
          type: defaultType,
        },
        defaultType,
      );
    }
    if (/^\d+$/.test(d)) {
      return sanitizeProxyEntry(
        {
          host: c,
          port: d,
          auth: `${a}:${b}`,
          type: defaultType,
        },
        defaultType,
      );
    }
  }

  return null;
}

function parseProxyPayload(payload, defaultType = "http") {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return dedupeProxyEntries(
      payload
        .flatMap((item) => parseProxyPayload(item, defaultType))
        .filter(Boolean),
    );
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return parseProxyPayload(JSON.parse(trimmed), defaultType);
      } catch {
        // Keep parsing as raw text below.
      }
    }

    return dedupeProxyEntries(
      trimmed
        .split(/\r?\n/)
        .map((line) => parseProxyString(line, defaultType))
        .filter(Boolean),
    );
  }

  if (typeof payload === "object") {
    if (payload.host && payload.port) {
      return dedupeProxyEntries(
        [sanitizeProxyEntry(payload, defaultType)].filter(Boolean),
      );
    }

    const candidateKeys = ["proxies", "data", "items", "results", "list"];
    for (const key of candidateKeys) {
      if (payload[key] !== undefined) {
        const parsed = parseProxyPayload(payload[key], defaultType);
        if (parsed.length > 0) return parsed;
      }
    }

    const arrayValues = Object.values(payload).filter(Array.isArray);
    for (const value of arrayValues) {
      const parsed = parseProxyPayload(value, defaultType);
      if (parsed.length > 0) return parsed;
    }
  }

  return [];
}

function proxyToUrl(proxy, forcedType) {
  const safeProxy = sanitizeProxyEntry(
    proxy,
    forcedType || proxy?.type || "http",
  );
  if (!safeProxy) return null;
  const type = normalizeProxyType(forcedType || safeProxy.type, "http");
  const auth = safeProxy.auth ? `${safeProxy.auth}@` : "";
  return `${type}://${auth}${safeProxy.host}:${safeProxy.port}`;
}

const PROXY_POOL_REDIS_KEY = "proxyscrape:mainapi:pools:v1";
const PROXYSCRAPE_API_TOKEN = (
  process.env.PROXYSCRAPE_API_TOKEN ||
  process.env.PROXYSCRAPE_API_KEY ||
  ""
).trim();
const PROXYSCRAPE_ACCOUNT_ID = (
  process.env.PROXYSCRAPE_ACCOUNT_ID || ""
).trim();
const PROXYSCRAPE_ENABLED = Boolean(
  PROXYSCRAPE_API_TOKEN && PROXYSCRAPE_ACCOUNT_ID,
);
const PROXY_POOL_REDIS_TTL_SECONDS = 60 * 60;
const PROXYSCRAPE_ACCOUNT_BASE_URL = "https://api.proxyscrape.com";
const PROXYSCRAPE_ACCOUNT_PATH =
  "/v4/account/{accountId}/datacenter_shared/proxy-list";
const PROXYSCRAPE_TIMEOUT_MS = 12000;
const PROXYSCRAPE_REFRESH_MS = 15 * 60 * 1000;
const PROXYSCRAPE_MAX_PER_PROTOCOL = 1000;
const PROXYSCRAPE_HTTP_PROTOCOLS = ["http"];
const PROXYSCRAPE_SOCKS_PROTOCOLS = ["socks"];
const PROXYSCRAPE_ALLOW_LEGACY_FALLBACK = false;
const PROXYSCRAPE_DEBUG = false;

const legacySocksEnv =
  PROXYSCRAPE_ENABLED && !PROXYSCRAPE_ALLOW_LEGACY_FALLBACK
    ? []
    : parseJsonArrayEnv("SOCKS5_PROXIES", []);
const legacyHttpEnv =
  PROXYSCRAPE_ENABLED && !PROXYSCRAPE_ALLOW_LEGACY_FALLBACK
    ? []
    : parseJsonArrayEnv("HTTP_PROXIES", []);

const PROXIES = dedupeProxyEntries(
  (legacySocksEnv.length > 0
    ? legacySocksEnv
    : parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
  )
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(Boolean),
);

const COFLIX_SOCKS5_PROXIES = dedupeProxyEntries(
  parseProxyPayload(process.env.SOCKS5_PROXIES, "socks5")
    .map((entry) => sanitizeProxyEntry(entry, "socks5"))
    .filter(Boolean),
);

const HTTP_PROXIES = dedupeProxyEntries(
  (legacyHttpEnv.length > 0
    ? legacyHttpEnv
    : parseProxyPayload(process.env.HTTP_PROXIES, "http")
  )
    .map((entry) => sanitizeProxyEntry(entry, "http"))
    .filter(Boolean),
);

const DARKINO_HTTP_PROXIES = [];
const DARKINO_PROXIES = [];

function syncDerivedHttpProxyPools(httpEntries) {
  const normalizedHttpEntries = dedupeProxyEntries(
    httpEntries
      .map((entry) => sanitizeProxyEntry(entry, "http"))
      .filter(Boolean),
  );

  updateArrayInPlace(HTTP_PROXIES, normalizedHttpEntries);
  updateArrayInPlace(
    DARKINO_PROXIES,
    normalizedHttpEntries.map((entry) => ({ ...entry, type: "http" })),
  );
  updateArrayInPlace(
    DARKINO_HTTP_PROXIES,
    DARKINO_PROXIES.map((proxy) => proxyToUrl(proxy, "http")).filter(Boolean),
  );
}

syncDerivedHttpProxyPools(HTTP_PROXIES);

const proxyScrapeState = {
  refreshPromise: null,
  lastRefreshAt: 0,
  lastRefreshError: null,
  lastSuccessMeta: {
    socks: null,
    http: null,
  },
};

function getProxyPoolAgeMs(updatedAt = proxyScrapeState.lastRefreshAt) {
  const timestamp = Number(updatedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - timestamp;
}

function isProxyPoolFresh(updatedAt = proxyScrapeState.lastRefreshAt) {
  return getProxyPoolAgeMs(updatedAt) < PROXYSCRAPE_REFRESH_MS;
}

function buildProxyScrapeResult(source) {
  return {
    enabled: true,
    socks: PROXIES.length,
    http: HTTP_PROXIES.length,
    meta: proxyScrapeState.lastSuccessMeta,
    source,
  };
}

function limitProxyEntries(entries) {
  if (
    !Number.isFinite(PROXYSCRAPE_MAX_PER_PROTOCOL) ||
    PROXYSCRAPE_MAX_PER_PROTOCOL <= 0
  ) {
    return entries;
  }
  return entries.slice(0, PROXYSCRAPE_MAX_PER_PROTOCOL);
}

function buildProxyScrapeCandidates(protocol) {
  if (!PROXYSCRAPE_ACCOUNT_ID) {
    return [];
  }

  const accountPath = PROXYSCRAPE_ACCOUNT_PATH.replace(
    "{accountId}",
    PROXYSCRAPE_ACCOUNT_ID,
  );
  return [
    {
      url: `${PROXYSCRAPE_ACCOUNT_BASE_URL}${accountPath}`,
      headers: { "api-token": PROXYSCRAPE_API_TOKEN },
      params: {
        type: "getproxies",
        protocol,
        format: "normal",
      },
      label: `v4 account ${accountPath}`,
    },
  ];
}

function applyStoredProxyPools(storedPools) {
  if (!storedPools || typeof storedPools !== "object") return false;

  const socks = dedupeProxyEntries(
    (storedPools.socks || [])
      .map((entry) => sanitizeProxyEntry(entry, "socks5"))
      .filter(Boolean),
  );
  const httpEntries = dedupeProxyEntries(
    (storedPools.http || [])
      .map((entry) => sanitizeProxyEntry(entry, "http"))
      .filter(Boolean),
  );

  if (socks.length === 0 || httpEntries.length === 0) {
    return false;
  }

  updateArrayInPlace(
    PROXIES,
    socks.map((entry) => ({ ...entry, type: "socks5" })),
  );
  syncDerivedHttpProxyPools(httpEntries);
  proxyAgentCache.clear();
  darkinoProxyAgentCache.clear();
  cpasmalAgentCache.clear();
  return true;
}

async function loadProxyPoolsFromRedis() {
  try {
    const rawValue = await redis.get(PROXY_POOL_REDIS_KEY);
    if (!rawValue) return false;
    const parsed = JSON.parse(rawValue);
    if (!applyStoredProxyPools(parsed)) return false;
    proxyScrapeState.lastRefreshAt =
      Number(parsed.updatedAt) || proxyScrapeState.lastRefreshAt;
    proxyScrapeState.lastSuccessMeta =
      parsed.meta || proxyScrapeState.lastSuccessMeta;
    return true;
  } catch {
    return false;
  }
}

async function saveProxyPoolsToRedis(payload) {
  try {
    await redis.set(
      PROXY_POOL_REDIS_KEY,
      JSON.stringify(payload),
      "EX",
      PROXY_POOL_REDIS_TTL_SECONDS,
    );
  } catch {
    // ignore Redis persistence failures
  }
}

async function fetchProxyScrapeProtocol(defaultType, protocols) {
  const attemptErrors = [];

  for (const protocol of protocols) {
    const candidates = buildProxyScrapeCandidates(protocol);

    for (const candidate of candidates) {
      try {
        if (PROXYSCRAPE_DEBUG) {
          console.log(
            `[PROXYSCRAPE DEBUG] tentative ${candidate.label} | protocol=${protocol} | url=${candidate.url} | params=${JSON.stringify(candidate.params)}`,
          );
        }

        const response = await axios.get(candidate.url, {
          headers: candidate.headers,
          params: candidate.params,
          timeout: PROXYSCRAPE_TIMEOUT_MS,
          responseType: "text",
          transformResponse: [(data) => data],
        });

        const proxies = limitProxyEntries(
          dedupeProxyEntries(parseProxyPayload(response.data, defaultType)),
        );

        if (proxies.length === 0) {
          const message = `[PROXYSCRAPE] ${candidate.label} (${protocol}) a retourne 0 proxy`;
          attemptErrors.push(message);
          if (PROXYSCRAPE_DEBUG) {
            console.warn(
              `${message} | body=${String(response.data || "").slice(0, 300)}`,
            );
          }
          continue;
        }

        if (PROXYSCRAPE_DEBUG) {
          console.log(
            `[PROXYSCRAPE DEBUG] succes ${candidate.label} (${protocol}) -> ${proxies.length} proxies`,
          );
        }

        return {
          proxies,
          meta: {
            protocol,
            endpoint: candidate.label,
            count: proxies.length,
          },
        };
      } catch (error) {
        const status = error.response?.status;
        const message = `[PROXYSCRAPE] ${candidate.label} (${protocol}) a echoue: ${status || error.code || error.message}`;
        attemptErrors.push(message);
        if (PROXYSCRAPE_DEBUG) {
          console.warn(
            `${message} | body=${String(error.response?.data || "").slice(0, 300)}`,
          );
        }
      }
    }
  }

  throw new Error(
    attemptErrors.length > 0
      ? attemptErrors.join(" | ")
      : "[PROXYSCRAPE] Aucun endpoint n a repondu",
  );
}

async function refreshProxyScrapeProxies(options = {}) {
  const { force = false, silent = false } = options;

  if (!PROXYSCRAPE_ENABLED) {
    return {
      enabled: false,
      socks: PROXIES.length,
      http: HTTP_PROXIES.length,
    };
  }

  if (!force && proxyScrapeState.refreshPromise) {
    return proxyScrapeState.refreshPromise;
  }

  if (proxyScrapeState.refreshPromise) {
    return proxyScrapeState.refreshPromise;
  }

  if (!force) {
    const loadedFromRedis = await loadProxyPoolsFromRedis();
    if (loadedFromRedis && isProxyPoolFresh()) {
      if (!silent) {
        console.log(
          `[PROXYSCRAPE] Pools frais charges depuis Redis: ${PROXIES.length} SOCKS5, ${HTTP_PROXIES.length} HTTP`,
        );
      }
      return buildProxyScrapeResult("redis-fresh");
    }
  }

  proxyScrapeState.refreshPromise = (async () => {
    const lock = await acquireRedisLock(PROXY_POOL_REDIS_KEY, {
      ttl: Math.max(10, Math.ceil(PROXYSCRAPE_TIMEOUT_MS / 1000) * 2),
      retries: 40,
      retryDelay: 500,
    });

    if (!lock) {
      const loadedFromRedis = await loadProxyPoolsFromRedis();
      if (loadedFromRedis) {
        if (!silent) {
          console.log(
            `[PROXYSCRAPE] Pools charges depuis Redis: ${PROXIES.length} SOCKS5, ${HTTP_PROXIES.length} HTTP`,
          );
        }
        return buildProxyScrapeResult("redis");
      }
    }

    try {
      if (!force) {
        const loadedFromRedis = await loadProxyPoolsFromRedis();
        if (loadedFromRedis && isProxyPoolFresh()) {
          if (!silent) {
            console.log(
              `[PROXYSCRAPE] Pools frais recharges depuis Redis: ${PROXIES.length} SOCKS5, ${HTTP_PROXIES.length} HTTP`,
            );
          }
          return buildProxyScrapeResult("redis-fresh");
        }
      }

      const socksResult = await fetchProxyScrapeProtocol(
        "socks5",
        PROXYSCRAPE_SOCKS_PROTOCOLS,
      );
      const httpResult = await fetchProxyScrapeProtocol(
        "http",
        PROXYSCRAPE_HTTP_PROTOCOLS,
      );

      updateArrayInPlace(
        PROXIES,
        socksResult.proxies.map((proxy) => ({ ...proxy, type: "socks5" })),
      );
      syncDerivedHttpProxyPools(httpResult.proxies);

      proxyAgentCache.clear();
      darkinoProxyAgentCache.clear();
      cpasmalAgentCache.clear();

      proxyScrapeState.lastRefreshAt = Date.now();
      proxyScrapeState.lastRefreshError = null;
      proxyScrapeState.lastSuccessMeta = {
        socks: socksResult.meta,
        http: httpResult.meta,
      };

      await saveProxyPoolsToRedis({
        updatedAt: proxyScrapeState.lastRefreshAt,
        socks: PROXIES,
        http: HTTP_PROXIES,
        meta: proxyScrapeState.lastSuccessMeta,
      });

      if (!silent) {
        console.log(
          `[PROXYSCRAPE] Refresh OK: ${PROXIES.length} SOCKS5 via ${socksResult.meta.endpoint}, ${HTTP_PROXIES.length} HTTP via ${httpResult.meta.endpoint}`,
        );
      }

      return {
        enabled: true,
        socks: PROXIES.length,
        http: HTTP_PROXIES.length,
        meta: proxyScrapeState.lastSuccessMeta,
        source: "api",
      };
    } catch (error) {
      proxyScrapeState.lastRefreshError = error.message;

      const loadedFromRedis = await loadProxyPoolsFromRedis();
      if (loadedFromRedis) {
        if (!silent) {
          console.warn(
            `[PROXYSCRAPE] Refresh API echoue, fallback Redis utilise: ${error.message}`,
          );
        }
        return buildProxyScrapeResult("redis-fallback");
      }

      if (!silent) {
        console.error(`[PROXYSCRAPE] Refresh echoue: ${error.message}`);
      }
      throw error;
    } finally {
      if (lock && typeof lock.release === "function") {
        await lock.release();
      }
    }
  })().finally(() => {
    proxyScrapeState.refreshPromise = null;
  });

  return proxyScrapeState.refreshPromise;
}

function scheduleProxyScrapeRefresh() {
  if (!PROXYSCRAPE_ENABLED) return;

  setTimeout(() => {
    loadProxyPoolsFromRedis().catch(() => {});
  }, 0).unref();

  setInterval(() => {
    refreshProxyScrapeProxies({ silent: false }).catch(() => {});
  }, PROXYSCRAPE_REFRESH_MS).unref();
}

scheduleProxyScrapeRefresh();

// === WIFLIX FREE PROXY LIST (ProxyScrape v4 free) ===
const WIFLIX_FREE_PROXY_URL =
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text";
const WIFLIX_FREE_PROXY_REFRESH_MS = 5 * 60 * 1000; // 5 minutes
const WIFLIX_FREE_PROXY_MAX_ATTEMPTS = 10; // Try up to 10 proxies per request
const WIFLIX_FREE_PROXY_TIMEOUT = 5000; // 5s per proxy attempt (fail fast)
const wiflixFreeProxies = []; // HTTP-only proxy URL strings
const wiflixProxyAgentCache = new Map();
const wiflixDeadProxies = new Set(); // Proxies who echoue — survit entre les requetes, reset au refresh

async function fetchWiflixFreeProxies() {
  try {
    const res = await axios.get(WIFLIX_FREE_PROXY_URL, { timeout: 15000 });
    const text = typeof res.data === "string" ? res.data : "";
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = [];
    for (const line of lines) {
      // Only keep http/https — socks4 free proxies are too unreliable
      if (/^https?:\/\/.+:\d+$/.test(line)) {
        parsed.push(line);
      }
    }

    // Replace list in-place + reset dead list
    wiflixFreeProxies.length = 0;
    wiflixFreeProxies.push(...parsed);
    wiflixProxyAgentCache.clear();
    wiflixDeadProxies.clear();

    console.log(
      `[WIFLIX FREE PROXY] Refresh OK: ${wiflixFreeProxies.length} http proxies (${lines.length - parsed.length} socks ignores)`,
    );
  } catch (err) {
    console.error(
      `[WIFLIX FREE PROXY] Refresh echoue: ${err.message}`,
    );
  }
}

function getWiflixFreeProxyAgent(proxyUrl) {
  if (wiflixProxyAgentCache.has(proxyUrl)) {
    return wiflixProxyAgentCache.get(proxyUrl);
  }

  const agents = {
    httpAgent: new HttpProxyAgent(proxyUrl),
    httpsAgent: new HttpsProxyAgent(proxyUrl),
  };

  wiflixProxyAgentCache.set(proxyUrl, agents);
  return agents;
}

/**
 * Wiflix request — tries free HTTP proxies first, then falls back to Cloudflare Workers.
 */
async function makeWiflixRequest(targetUrl, options = {}) {
  const {
    timeout = 10000,
    headers = {},
    decompress = true,
    method: requestMethod,
    data: requestData,
    ...otherOptions
  } = options;

  const method = (requestMethod || "GET").toUpperCase();
  const defaultHeaders = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ...headers,
  };

  // --- Phase 1: free proxy list (skip already-dead ones) ---
  const alive = wiflixFreeProxies.filter((p) => !wiflixDeadProxies.has(p));
  if (alive.length > 0) {
    const shuffled = alive.sort(() => Math.random() - 0.5);
    const candidates = shuffled.slice(0, WIFLIX_FREE_PROXY_MAX_ATTEMPTS);

    for (let i = 0; i < candidates.length; i++) {
      const proxyUrl = candidates[i];
      try {
        const agents = getWiflixFreeProxyAgent(proxyUrl);
        const response = await axios({
          url: targetUrl,
          method,
          headers: defaultHeaders,
          timeout: WIFLIX_FREE_PROXY_TIMEOUT,
          decompress,
          ...agents,
          ...(requestData !== undefined ? { data: requestData } : {}),
          ...otherOptions,
        });

        // Verify we got a real response (not a proxy error page)
        const body = typeof response.data === "string" ? response.data : "";
        if (response.status === 200 && body.length > 100) {
          console.log(
            `[WIFLIX FREE PROXY] OK via ${proxyUrl} (tentative ${i + 1}/${candidates.length})`,
          );
          return response;
        }

        // Bad response — mark dead
        wiflixDeadProxies.add(proxyUrl);
      } catch {
        wiflixDeadProxies.add(proxyUrl);
        wiflixProxyAgentCache.delete(proxyUrl);
      }
    }

    console.log(
      `[WIFLIX FREE PROXY] ${candidates.length} echoues, ${alive.length - candidates.length} restants, fallback CF Workers`,
    );
  }

  // --- Phase 2: fallback to Cloudflare Workers ---
  return makeRequestWithCorsFallback(targetUrl, options);
}

// Initial fetch + 5-min refresh
fetchWiflixFreeProxies();
setInterval(() => {
  fetchWiflixFreeProxies();
}, WIFLIX_FREE_PROXY_REFRESH_MS).unref();

// Fonction utilitaire pour choisir aléatoirement un proxy (toujours utiliser un proxy)
function pickRandomProxyOrNone() {
  // Sélectionner toujours un proxy aléatoire parmi la liste
  if (!PROXIES || PROXIES.length === 0) return null;
  const idx = Math.floor(Math.random() * PROXIES.length);
  return PROXIES[idx] || null;
}

// Sélectionne un proxy aléatoire — retourne null si la liste est vide
function pickRandomProxy() {
  if (!PROXIES || PROXIES.length === 0) return null;
  const idx = Math.floor(Math.random() * PROXIES.length);
  return PROXIES[idx];
}

// Fonction utilitaire pour cr\u00e9er un agent proxy SOCKS5 (avec cache)
function getProxyAgent(proxy) {
  if (!proxy) return null;
  const auth = proxy.auth ? `${proxy.auth}@` : "";
  const proxyType = normalizeProxyType(proxy.type, "socks5");
  const cacheKey = `${proxyType}:${proxy.host}:${proxy.port}:${auth}`;

  // V\u00e9rifier le cache d'abord
  if (proxyAgentCache.has(cacheKey)) {
    return proxyAgentCache.get(cacheKey);
  }

  const protocol = proxyType === "socks5" ? "socks5h" : proxyType;
  const proxyUrl = `${protocol}://${auth}${proxy.host}:${proxy.port}`;
  const agent = new SocksProxyAgent(proxyUrl);

  // Mettre en cache l'agent
  proxyAgentCache.set(cacheKey, agent);
  return agent;
}

// Fonction utilitaire pour cr\u00e9er un agent proxy (pour Darkino) - avec cache
function getDarkinoHttpProxyAgent(proxy) {
  if (!proxy) return null;
  const auth = proxy.auth ? `${proxy.auth}@` : "";
  const proxyType = normalizeProxyType(proxy.type, "http");
  const cacheKey = `${proxyType}:${proxy.host}:${proxy.port}:${auth}`;

  // V\u00e9rifier le cache d'abord
  if (darkinoProxyAgentCache.has(cacheKey)) {
    return darkinoProxyAgentCache.get(cacheKey);
  }

  let agents;
  if (proxyType === "socks5") {
    const proxyUrl = `socks5://${auth}${proxy.host}:${proxy.port}`;
    const agent = new SocksProxyAgent(proxyUrl);
    agents = {
      httpAgent: agent,
      httpsAgent: agent,
    };
  } else {
    const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;
    agents = {
      httpAgent: new HttpProxyAgent(proxyUrl),
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    };
  }

  // Mettre en cache les agents
  darkinoProxyAgentCache.set(cacheKey, agents);
  return agents;
}

module.exports = {
  // Proxy agent caches
  proxyAgentCache,
  darkinoProxyAgentCache,

  // Proxy configuration flags
  ENABLE_DARKINO_PROXY,
  ENABLE_COFLIX_PROXY,
  ENABLE_FRENCH_STREAM_PROXY,
  ENABLE_LECTEURVIDEO_PROXY,
  ENABLE_FSTREAM_PROXY,
  ENABLE_ANIME_PROXY,
  ENABLE_WIFLIX_PROXY,
  darkiworld_premium,

  // Darkino 403 cooldown (expose getter/setter since it's mutable)
  DARKINO_403_COOLDOWN_MS,
  get darkino403CooldownUntil() {
    return darkino403CooldownUntil;
  },
  set darkino403CooldownUntil(val) {
    darkino403CooldownUntil = val;
  },

  // Cpasmal
  CPASMAL_BASE_URL,
  cpasmalJar,
  getCpasmalAgent,
  axiosCpasmalRequest,

  // Cloudflare Workers proxies
  CLOUDFLARE_WORKERS_PROXIES,
  proxyErrorCache,
  markProxyAsErrored,
  isProxyInCooldown,
  getAvailableProxies,
  markProxyAsHealthy,
  buildProxiedUrl,

  // Request helpers
  makeRequestWithCorsFallback,
  makeWiflixRequest,
  makeCoflixRequest,
  makeLecteurVideoRequest,
  makeAnimeSamaRequest,

  // SOCKS5 proxies
  PROXIES,
  HTTP_PROXIES,
  DARKINO_HTTP_PROXIES,
  DARKINO_PROXIES,
  refreshProxyScrapeProxies,

  // Agent helpers
  pickRandomProxyOrNone,
  pickRandomProxy,
  pickNextSocks5Proxy,
  getProxyAgent,
  getDarkinoHttpProxyAgent,

  // Cleanup
  shutdownCycleTLS,
};
