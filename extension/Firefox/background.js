// Firefox-compatible background script for Movix Extension
// In Firefox MV3, background scripts run in an event page context.
// extractors.js is loaded before this file via manifest "background.scripts".

const browserAPI = typeof browser !== "undefined" ? browser : chrome;

const VAVOO_BASE_URL = "https://tvvoo.hayd.uk/cfg-fr";
const WITV_BASE_URL = "https://witv.team";
const SOSPLAY_BASE_URL = "https://streamonsport.art";
const LIVETV_BASE_URL = "https://livetv882.me/frx/";
const LIVETV_EMBED_ORIGIN = "https://livetv882.me";
const LIVETV_EMBED_REFERER = LIVETV_BASE_URL;
// Backend API URL for got-scraping based extraction
const API_BASE_URL = "https://api.movix.cash";
const STREAM_PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Access extractors loaded via manifest background.scripts
const Extractors = globalThis.MovixExtractors;

// Cache for Wiflix channels with their page slugs
let wiflixChannelCache = {};

// Extension enabled state
let extensionEnabled = true;

// User extraction preferences (synced from site via SET_EXTRACTION_PREFS)
const DEFAULT_EXTRACTION_PREFS = {
  version: 1,
  m3u8: {
    voe: true, fsvid: true, vidzy: true, vidmoly: true,
    sibnet: true, uqload: true, doodstream: true, seekstreaming: true,
  },
  livetv: {
    linkzy: true, wiflix: true, sosplay: true, livetv: true, matches: true,
  },
};
let extractionPrefs = DEFAULT_EXTRACTION_PREFS;

// Stats tracking (enriched with per-type counters)
let sessionStats = {
  extractions: 0,
  corsFixed: 0,
  cached: 0,
  byType: { voe: 0, fsvid: 0, vidzy: 0, vidmoly: 0, sibnet: 0, uqload: 0, doodstream: 0, seekstreaming: 0 },
};

// Load initial state
browserAPI.storage.local.get(["extensionEnabled", "stats", "extractionPrefs"], (result) => {
  extensionEnabled = result.extensionEnabled !== false;
  if (result.stats) {
    sessionStats = { ...sessionStats, ...result.stats };
    // Guarantee byType subobject even for stats saved before this migration
    if (!sessionStats.byType) {
      sessionStats.byType = { voe: 0, fsvid: 0, vidzy: 0, vidmoly: 0, sibnet: 0, uqload: 0, doodstream: 0, seekstreaming: 0 };
    }
  }
  if (result.extractionPrefs) extractionPrefs = result.extractionPrefs;
});

// Initial setup
browserAPI.runtime.onInstalled.addListener(() => {
  setupRules();
});

browserAPI.runtime.onStartup.addListener(() => {
  setupRules();
  // Reset session stats on startup (keep byType shape to avoid silent miss-counts)
  sessionStats = {
    extractions: 0,
    corsFixed: 0,
    cached: 0,
    byType: { voe: 0, fsvid: 0, vidzy: 0, vidmoly: 0, sibnet: 0, uqload: 0, doodstream: 0, seekstreaming: 0 },
  };
  browserAPI.storage.local.set({ stats: sessionStats });
});

// Configure DNR rules for CORS and Headers
async function setupRules() {
  // Clear existing dynamic rules to prevent accumulation
  const existingRules =
    await browserAPI.declarativeNetRequest.getDynamicRules();
  const ruleIds = existingRules.map((rule) => rule.id);
  await browserAPI.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
  });

  // Reset rule counter when rules are cleared
  ruleIdCounter = 100;

  const rules = [
    // 1. Allow CORS for everything (Response Headers)
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          {
            header: "Access-Control-Allow-Origin",
            operation: "set",
            value: "*",
          },
          {
            header: "Access-Control-Allow-Methods",
            operation: "set",
            value: "GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH",
          },
          {
            header: "Access-Control-Allow-Headers",
            operation: "set",
            value: "*",
          },
        ],
      },
      condition: {
        urlFilter: "*",
        initiatorDomains: [
          "localhost",
          "127.0.0.1",
          "movix.cash",
          "movix.cloud",
          "movix.tax",
          "movix.club",
        ],
        resourceTypes: [
          "xmlhttprequest",
          "other",
          "media",
          "image",
          "script",
          "stylesheet",
          "font",
          "websocket",
        ],
      },
    },
  ];

  await browserAPI.declarativeNetRequest.updateDynamicRules({
    addRules: rules,
  });
}

/**
 * Map a catalogId (e.g. "wiflix_sport") to a livetv source key.
 * Returns null if unknown — unknown keys are allowed by default.
 */
function getLiveTvSourceKey(catalogId) {
  if (!catalogId || typeof catalogId !== 'string') return null;
  if (catalogId.startsWith('linkzy_')) return 'linkzy';
  if (catalogId.startsWith('wiflix_')) return 'wiflix';
  if (catalogId.startsWith('sosplay_')) return 'sosplay';
  if (catalogId.startsWith('livetv_')) return 'livetv';
  if (catalogId.startsWith('matches_')) return 'matches';
  return null;
}

function isLiveTvAllowed(catalogId) {
  const key = getLiveTvSourceKey(catalogId);
  if (!key) return true; // Unknown source → allow by default
  return extractionPrefs.livetv[key] !== false;
}

function isEmbedAllowed(type) {
  if (!type) return true;
  return extractionPrefs.m3u8[type] !== false;
}

// Handle messages
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  const { action, payload } = message;

  // Handle toggle action (always allowed)
  if (action === "TOGGLE_EXTENSION") {
    extensionEnabled = payload.enabled;
    if (extensionEnabled) {
      await setupRules();
    } else {
      // Remove all DNR rules when disabled
      const existingRules =
        await browserAPI.declarativeNetRequest.getDynamicRules();
      const ruleIds = existingRules.map((rule) => rule.id);
      if (ruleIds.length > 0) {
        await browserAPI.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: ruleIds,
        });
      }
    }
    return { success: true, enabled: extensionEnabled };
  }

  // Handle stats request (always allowed)
  if (action === "GET_STATS") {
    return sessionStats;
  }

  // Block all other actions if disabled
  if (!extensionEnabled) {
    return { error: "Extension is disabled" };
  }

  switch (action) {
    case "GET_MANIFEST":
      return await getManifest();
    case "GET_CATALOG": {
      const catalogId = payload?.id || '';
      if (!isLiveTvAllowed(catalogId)) {
        return { metas: [], disabled_by_user: true };
      }
      return await getCatalog(payload.type, payload.id, payload?.accessKey);
    }
    case "GET_STREAM": {
      const channelId = payload?.id || '';
      if (!isLiveTvAllowed(channelId)) {
        return { error: "disabled_by_user", source: getLiveTvSourceKey(channelId) };
      }
      return await getStream(payload.type, payload.id, payload?.accessKey, payload);
    }
    case "PROXY_HTTP":
      return await proxyHttpRequest(payload.url, payload.headers);

    // === Nexus M3U8 Extraction (runs locally in extension, no server needed) ===
    case "EXTRACT_M3U8": {
      const { url: embedUrl, type: hintedType } = payload || {};
      const detectedType = hintedType || (Extractors.detectEmbedType ? Extractors.detectEmbedType(embedUrl) : null);
      if (detectedType && !isEmbedAllowed(detectedType)) {
        return { success: false, error: "disabled_by_user", type: detectedType };
      }
      sessionStats.extractions++;
      if (detectedType && sessionStats.byType) {
        sessionStats.byType[detectedType] = (sessionStats.byType[detectedType] || 0) + 1;
      }
      browserAPI.storage.local.set({ stats: sessionStats });
      return await handleExtractM3u8(payload);
    }
    case "EXTRACT_ALL_M3U8": {
      const filteredSources = (payload?.sources || []).filter((source) => {
        const srcUrl = typeof source === 'string' ? source : (source?.link || source?.url || '');
        const srcType = Extractors.detectEmbedType ? Extractors.detectEmbedType(srcUrl) : null;
        return !srcType || isEmbedAllowed(srcType);
      });
      sessionStats.extractions++;
      browserAPI.storage.local.set({ stats: sessionStats });
      return await handleExtractAllM3u8({ ...payload, sources: filteredSources });
    }
    case "DETECT_EMBEDS":
      return handleDetectEmbeds(payload);

    case "SETUP_HEADERS": {
      const headerInfo = await Extractors.setupHeadersForService(
        payload.type,
        payload.url,
      );
      if (headerInfo) {
        await addHeadersRule(headerInfo.domainPattern, headerInfo.headers);
        console.log(
          `[NEXUS] DNR headers set for ${payload.type}: ${headerInfo.domainPattern}`,
        );
        return { success: true };
      }
      return { success: false, error: "Could not setup headers" };
    }

    case "SET_EXTRACTION_PREFS": {
      const incoming = payload?.prefs;
      if (incoming && incoming.version === 1 && incoming.m3u8 && incoming.livetv) {
        extractionPrefs = {
          version: 1,
          m3u8: { ...DEFAULT_EXTRACTION_PREFS.m3u8, ...incoming.m3u8 },
          livetv: { ...DEFAULT_EXTRACTION_PREFS.livetv, ...incoming.livetv },
        };
        await browserAPI.storage.local.set({ extractionPrefs });
        return { success: true };
      }
      return { success: false, error: "Invalid prefs shape" };
    }

    case "GET_EXTRACTION_PREFS":
      return extractionPrefs;

    case "GET_CACHE_STATS": {
      if (typeof Extractors.getCacheSizes === 'function') {
        return Extractors.getCacheSizes();
      }
      return {};
    }

    case "CLEAR_EXTRACTION_CACHE": {
      if (typeof Extractors.clearCaches === 'function') {
        Extractors.clearCaches(payload?.type);
        return { success: true };
      }
      return { success: false, error: "Cache API unavailable" };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// Helper to proxy HTTP requests via extension (to bypass Mixed Content)
async function proxyHttpRequest(url, headers = {}) {
  try {
    if (headers && Object.keys(headers).length > 0) {
      try {
        const parsedUrl = new URL(url);
        const rulePattern = `*://${parsedUrl.host}${parsedUrl.pathname}*`;
        await addHeadersRule(rulePattern, headers);
      } catch (ruleError) {
        console.warn("[PROXY_HTTP] Failed to add DNR headers rule:", ruleError);
      }
    }

    const response = await fetch(url, { headers });
    const buffer = await response.arrayBuffer();

    // Convert ArrayBuffer to Base64
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return {
      data: base64,
      contentType: response.headers.get("content-type"),
      status: response.status,
      finalUrl: response.url,
    };
  } catch (e) {
    console.error("Proxy HTTP error:", e);
    return { error: e.message };
  }
}

// === NEXUS M3U8 EXTRACTION HANDLERS ===

/**
 * Handle single embed extraction request
 * payload: { type: 'voe'|'fsvid'|..., url: 'https://...' }
 */
async function handleExtractM3u8(payload) {
  const { type, url } = payload;
  if (!url) return { success: false, error: "Missing URL" };

  // Auto-detect type if not provided
  const embedType = type || Extractors.detectEmbedType(url);
  if (!embedType) return { success: false, error: "Unknown embed type" };

  // Set up DNR headers BEFORE extraction so the fetch request succeeds
  try {
    const headerInfo = await Extractors.setupHeadersForService(embedType, url);
    if (headerInfo) {
      await addHeadersRule(headerInfo.domainPattern, headerInfo.headers);
      console.log(
        `[NEXUS] Pre-extraction DNR headers set for ${embedType}: ${headerInfo.domainPattern}`,
      );
    }
  } catch (e) {
    console.warn("[NEXUS] Failed to set pre-extraction headers:", e);
  }

  console.log(`[NEXUS] Extracting ${embedType} from: ${url}`);
  const result = await Extractors.extractSingle(embedType, url);

  // Set up DNR headers for the extracted URL so the page player can use it
  if (result.success) {
    const videoUrl = result.hlsUrl || result.m3u8Url;
    // If the video URL is different from the page URL (likely), set headers for it too
    if (videoUrl && videoUrl !== url) {
      const headerInfo = await Extractors.setupHeadersForService(
        embedType,
        videoUrl,
      );
      if (headerInfo) {
        await addHeadersRule(headerInfo.domainPattern, headerInfo.headers);
        console.log(
          `[NEXUS] DNR headers set for ${embedType}: ${headerInfo.domainPattern}`,
        );
      }
    }
  }

  return result;
}

/**
 * Handle parallel extraction of all supported embeds from a sources list
 * payload: { sources: ['url1', 'url2', ...] or [{link:'url', player:'name'}, ...] }
 */
async function handleExtractAllM3u8(payload) {
  const { sources } = payload;
  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return { success: false, error: "No sources provided", results: [] };
  }

  console.log(`[NEXUS] Extracting all from ${sources.length} sources`);

  // Set up DNR headers for all sources BEFORE extraction
  try {
    const detected = Extractors.detectSupportedEmbeds(sources);
    for (const item of detected) {
      const headerInfo = await Extractors.setupHeadersForService(
        item.type,
        item.url,
      );
      if (headerInfo) {
        await addHeadersRule(headerInfo.domainPattern, headerInfo.headers);
      }
    }
    console.log(
      `[NEXUS] Pre-extraction headers set for ${detected.length} sources`,
    );
  } catch (e) {
    console.warn("[NEXUS] Failed to set pre-extraction headers for batch:", e);
  }

  const results = await Extractors.extractAll(sources);

  // Set up DNR headers for all successful extractions (video URLs)
  for (const result of results) {
    if (result.success) {
      const videoUrl = result.hlsUrl || result.m3u8Url;
      if (videoUrl) {
        const headerInfo = await Extractors.setupHeadersForService(
          result.type,
          videoUrl,
        );
        if (headerInfo) {
          await addHeadersRule(headerInfo.domainPattern, headerInfo.headers);
        }
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  return {
    success: successCount > 0,
    total: results.length,
    successCount,
    results,
  };
}

/**
 * Handle embed type detection only (no extraction)
 * payload: { sources: ['url1', 'url2', ...] }
 */
function handleDetectEmbeds(payload) {
  const { sources } = payload;
  if (!sources || !Array.isArray(sources)) return { embeds: [] };
  return { embeds: Extractors.detectSupportedEmbeds(sources) };
}

// === API LOGIC ===

function buildBackendApiHeaders(accessKey, extraHeaders = {}) {
  const headers = {
    Accept: "application/json",
    Origin: "https://movix.cash",
    Referer: "https://movix.cash/",
    ...extraHeaders,
  };

  if (accessKey) {
    headers["x-access-key"] = accessKey;
  }

  return headers;
}

async function getManifest() {
  console.log("Fetching manifest from Vavoo...");
  const vavooData = await fetchSafe(`${VAVOO_BASE_URL}/manifest.json`, "Vavoo");

  const manifest = {
    id: "org.stremio.merged",
    version: "1.0.0",
    name: "Live TV (Extension)",
    description: "TV sources via Extension",
    catalogs: [],
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    idPrefixes: [],
  };

  // Add Vavoo catalogs
  if (vavooData) {
    if (vavooData.catalogs) manifest.catalogs.push(...vavooData.catalogs);
    if (vavooData.idPrefixes) {
      manifest.idPrefixes.push(...vavooData.idPrefixes);
    } else {
      manifest.idPrefixes.push("vavoo_");
    }
  }

  // Add Wiflix (WITV) catalogs
  const wiflixCatalogs = [
    { type: "tv", id: "wiflix_sport", name: "⚽ Sport" },
    { type: "tv", id: "wiflix_cinema", name: "🎥 Cinéma" },
    { type: "tv", id: "wiflix_generaliste", name: "📺 Généraliste" },
    { type: "tv", id: "wiflix_documentaire", name: "🌍 Documentaire" },
    { type: "tv", id: "wiflix_enfants", name: "🎈 Enfants" },
    { type: "tv", id: "wiflix_info", name: "📰 Info" },
    { type: "tv", id: "wiflix_musique", name: "🎵 Musique" },
  ];

  manifest.catalogs.push(...wiflixCatalogs);
  manifest.idPrefixes.push("wiflix_");

  // Add Bolaloca catalog (compat prefix sosplay_)
  const sosplayCatalogs = [
    { type: "tv", id: "sosplay_chaines", name: "📺 Chaînes (Bolaloca)" },
  ];
  manifest.catalogs.push(...sosplayCatalogs);
  manifest.idPrefixes.push("sosplay_");

  const livetvCatalogs = [
    { type: "tv", id: "livetv_live", name: "🔴 En direct" },
  ];
  manifest.catalogs.push(...livetvCatalogs);
  manifest.idPrefixes.push("livetv_");
  manifest.catalogs.push(
    { type: "tv", id: "livetv_all", name: "📅 Tous les sports" },
    { type: "tv", id: "livetv_football", name: "⚽ Football" },
    { type: "tv", id: "livetv_hockey", name: "🏒 Hockey" },
    { type: "tv", id: "livetv_basketball", name: "🏀 Basketball" },
    { type: "tv", id: "livetv_tennis", name: "🎾 Tennis" },
    { type: "tv", id: "livetv_volleyball", name: "🏐 Volley-ball" },
    { type: "tv", id: "livetv_handball", name: "🤾 Handball" },
    { type: "tv", id: "livetv_rugby", name: "🏉 Rugby" },
    { type: "tv", id: "livetv_combat", name: "🥊 Sports de combat" },
    { type: "tv", id: "livetv_motorsport", name: "🏎️ Sports mecaniques" },
    { type: "tv", id: "livetv_winter", name: "🎿 Sports d'hiver" },
    { type: "tv", id: "livetv_athletics", name: "🏃 Athletisme" },
    { type: "tv", id: "livetv_other", name: "🏟️ Autres sports" },
  );

  return manifest;
}

async function getCatalog(type, catalogId, accessKey = null) {
  // Check if this is a Wiflix catalog
  if (catalogId.startsWith("wiflix_")) {
    return await getWiflixCatalog(catalogId);
  }

  // Check if this is a Bolaloca/LiveTV catalog resolved by backend
  if (catalogId.startsWith("sosplay_")) {
    console.log(`[SOSPLAY] Fetching catalog via Backend: ${catalogId}`);
    const response = await fetch(
      `${API_BASE_URL}/api/livetv/catalog/tv/${catalogId}`,
      {
        headers: buildBackendApiHeaders(accessKey),
      },
    );
    if (!response.ok) throw new Error(`Backend API error: ${response.status}`);
    return await response.json();
  }

  if (catalogId.startsWith("livetv_")) {
    console.log(`[LIVETV] Fetching catalog via Backend: ${catalogId}`);
    const response = await fetch(
      `${API_BASE_URL}/api/livetv/catalog/tv/${catalogId}`,
      {
        headers: buildBackendApiHeaders(accessKey),
      },
    );
    if (!response.ok) throw new Error(`Backend API error: ${response.status}`);
    return await response.json();
  }

  // Default: Vavoo catalog
  const url = `${VAVOO_BASE_URL}/catalog/${type}/${catalogId}.json`;
  const catalog = await fetchSafe(url, "Catalog " + catalogId);
  if (!catalog) throw new Error("Catalog fetch failed");

  return catalog;
}

// Wiflix catalog categories mapping (URL paths)
const WITV_CATEGORIES = {
  wiflix_sport: "/chaines-live/sport/",
  wiflix_cinema: "/chaines-live/cinema/",
  wiflix_generaliste: "/chaines-live/generaliste/",
  wiflix_documentaire: "/chaines-live/documentaire/",
  wiflix_enfants: "/chaines-live/enfants/",
  wiflix_info: "/chaines-live/info/",
  wiflix_musique: "/chaines-live/musique/",
};

// Scrape Wiflix channels from WITV website
async function getWiflixCatalog(catalogId) {
  const categoryPath = WITV_CATEGORIES[catalogId];
  if (!categoryPath) {
    throw new Error(`Unknown Wiflix catalog: ${catalogId}`);
  }

  console.log(`[WITV] Fetching catalog for: ${catalogId}`);

  try {
    const categoryUrl = `${WITV_BASE_URL}${categoryPath}`;
    console.log(`[WITV] Category URL: ${categoryUrl}`);

    const response = await fetch(categoryUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch category page: ${response.status}`);
    }

    const html = await response.text();
    console.log(`[WITV] Category page length: ${html.length}`);

    // Parse channels from HTML
    const channels = [];

    const cardRegex =
      /<div[^>]*class="[^"]*holographic-card[^"]*"[^>]*>[\s\S]*?<a[^>]*href="[^"]*\/(\d+)-[^"]*"[^>]*>[\s\S]*?<[^>]*class="[^"]*ann-short_price[^"]*"[^>]*>([^<]+)</gi;
    let match;

    while ((match = cardRegex.exec(html)) !== null) {
      const id = match[1];
      const name = match[2].trim();

      if (id && name && !channels.find((c) => c.id === `wiflix_${id}`)) {
        const slugMatch = html.match(
          new RegExp(`href="([^"]*/${id}-[^"\.]+\.html)"`),
        );
        const pageSlug = slugMatch ? slugMatch[1] : null;

        const channel = {
          id: `wiflix_${id}`,
          type: "tv",
          name: name,
          poster: null,
          genres: [catalogId.replace("wiflix_", "")],
          _pageSlug: pageSlug,
          _categoryPath: categoryPath,
        };
        channels.push(channel);

        wiflixChannelCache[channel.id] = channel;
      }
    }

    // Pattern 2 fallback
    if (channels.length === 0) {
      console.log("[WITV] Pattern 1 failed, trying fallback pattern...");
      const fallbackRegex =
        /href="[^"]*\/(\d+)-([^"]+)\.html"[^>]*>[\s\S]*?<[^>]*class="[^"]*ann-short_price[^"]*"[^>]*>([^<]+)</gi;

      while ((match = fallbackRegex.exec(html)) !== null) {
        const id = match[1];
        const name = match[3].trim();

        if (id && name && !channels.find((c) => c.id === `wiflix_${id}`)) {
          const slugMatch = html.match(
            new RegExp(`href="([^"]*/${id}-[^"\.]+\.html)"`),
          );
          const pageSlug = slugMatch ? slugMatch[1] : null;

          const channel = {
            id: `wiflix_${id}`,
            type: "tv",
            name: name,
            poster: null,
            genres: [catalogId.replace("wiflix_", "")],
            _pageSlug: pageSlug,
            _categoryPath: categoryPath,
          };
          channels.push(channel);
          wiflixChannelCache[channel.id] = channel;
        }
      }
    }

    // Pattern 3: Ultra-simple
    if (channels.length === 0) {
      console.log("[WITV] Pattern 2 failed, trying ultra-simple pattern...");
      console.log("[WITV] HTML preview:", html.substring(0, 2000));

      const simpleRegex = /href="[^"]*\/(\d+)-([^"\.]+)/gi;
      const seenIds = new Set();

      while ((match = simpleRegex.exec(html)) !== null) {
        const id = match[1];
        const slug = match[2];

        const name = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());

        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          const channel = {
            id: `wiflix_${id}`,
            type: "tv",
            name: name,
            poster: null,
            genres: [catalogId.replace("wiflix_", "")],
            _pageSlug: `${id}-${slug}.html`,
            _categoryPath: categoryPath,
          };
          channels.push(channel);
          wiflixChannelCache[channel.id] = channel;
        }
      }
    }

    console.log(`[WITV] Found ${channels.length} channels in ${catalogId}`);

    return { metas: channels };
  } catch (error) {
    console.error("[WITV] Error fetching catalog:", error);
    throw error;
  }
}

async function getStream(type, channelId, accessKey = null, options = {}) {
  // Check if this is a Wiflix channel
  if (channelId.startsWith("wiflix_")) {
    return await getWiflixStream(channelId, accessKey);
  }

  // Check if this is a Sosplay channel
  if (channelId.startsWith("sosplay_")) {
    return await getSosplayStream(channelId, accessKey);
  }

  if (channelId.startsWith("livetv_")) {
    return await getLiveTvStream(channelId, accessKey, options);
  }

  // Default: Vavoo stream
  const url = `${VAVOO_BASE_URL}/stream/${type}/${channelId}.json`;
  const streamData = await fetchSafe(url, "Vavoo Stream");

  if (streamData && streamData.streams) {
    for (const stream of streamData.streams) {
      if (stream.url) {
        await addUserAgentRule(stream.url, "VAVOO/2.6");
      }
    }
  }

  if (!streamData) throw new Error("Stream fetch failed");

  return streamData;
}

// Find the channel page URL from cache or by searching
async function findWiflixChannelPageUrl(channelId) {
  if (wiflixChannelCache[channelId]) {
    const channel = wiflixChannelCache[channelId];
    if (channel._pageSlug) {
      const pageUrl = channel._pageSlug.startsWith("http")
        ? channel._pageSlug
        : `${WITV_BASE_URL}${channel._categoryPath}${channel._pageSlug.replace(/^\//, "")}`;
      console.log(`[WITV] Found channel page URL in cache: ${pageUrl}`);
      return pageUrl;
    }
  }

  const id = channelId.replace("wiflix_", "");
  console.log(`[WITV] Channel ${channelId} not in cache, searching...`);

  for (const [catId, categoryPath] of Object.entries(WITV_CATEGORIES)) {
    try {
      const categoryUrl = `${WITV_BASE_URL}${categoryPath}`;
      const response = await fetch(categoryUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) continue;

      const html = await response.text();
      const regex = new RegExp(`href="([^"]*/${id}-[^"\.]+\.html)"`, "i");
      const match = html.match(regex);

      if (match) {
        const channelPath = match[1];
        const pageUrl = channelPath.startsWith("http")
          ? channelPath
          : `${WITV_BASE_URL}${channelPath}`;
        console.log(`[WITV] Found channel page URL via search: ${pageUrl}`);
        return pageUrl;
      }
    } catch (e) {
      console.warn(`[WITV] Error searching in ${catId}: ${e.message}`);
    }
  }

  return null;
}

// Wiflix (WITV) stream extraction
async function getWiflixStream(channelId, accessKey = null) {
  console.log(`[WITV] Extracting stream for channel: ${channelId}`);

  try {
    const channelPageUrl = await findWiflixChannelPageUrl(channelId);

    if (!channelPageUrl) {
      throw new Error(`Could not find page URL for ${channelId}`);
    }

    console.log(`[WITV] Channel page URL: ${channelPageUrl}`);

    const pageResponse = await fetch(channelPageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: WITV_BASE_URL + "/",
      },
    });

    if (!pageResponse.ok) {
      throw new Error(`Failed to fetch channel page: ${pageResponse.status}`);
    }

    const pageHtml = await pageResponse.text();
    console.log(`[WITV] Channel page length: ${pageHtml.length}`);

    const iframeMatch = pageHtml.match(/<iframe[^>]*src=["']([^"']+)["']/i);

    if (!iframeMatch) {
      console.error("[WITV] No iframe found on channel page");
      throw new Error("No iframe found on page");
    }

    let embedSrc = iframeMatch[1];
    console.log(`[WITV] Found embed iframe: ${embedSrc}`);

    // Type 1: witv-player.php
    if (embedSrc.includes("witv-player.php")) {
      const playerUrl = embedSrc.startsWith("http")
        ? embedSrc
        : `${WITV_BASE_URL}${embedSrc}`;
      console.log(`[WITV] Type 1: witv-player detected, fetching ${playerUrl}`);

      const playerResponse = await fetch(playerUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: channelPageUrl,
        },
      });

      if (!playerResponse.ok) {
        throw new Error(
          `Failed to fetch player page: ${playerResponse.status}`,
        );
      }

      const playerHtml = await playerResponse.text();

      let m3u8Url = null;
      const streamMatch = playerHtml.match(
        /var\s+streamUrl\s*=\s*["']([^"']+)["']/,
      );
      if (streamMatch) {
        m3u8Url = streamMatch[1];
      } else {
        const fileMatch = playerHtml.match(
          /file:\s*["']([^"']+\.m3u8[^"']*)["']/,
        );
        if (fileMatch) {
          m3u8Url = fileMatch[1];
        } else {
          const genericMatch = playerHtml.match(
            /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/,
          );
          if (genericMatch) {
            m3u8Url = genericMatch[1];
          }
        }
      }

      if (!m3u8Url) {
        throw new Error("Could not extract stream URL from witv-player");
      }

      await addWiflixHeadersRule(m3u8Url);

      return {
        streams: [
          {
            title: "Orca",
            url: m3u8Url,
            originalUrl: m3u8Url,
            behaviorHints: { notWebReady: false },
          },
        ],
      };
    }

    // Type 2: livehdtv.com
    if (embedSrc.includes("livehdtv.com")) {
      const cacheKey = `witv_livehdtv_${channelId}`;
      const cachedStream = await getFromCache(cacheKey);

      if (cachedStream) {
        console.log(`[WITV] Found valid stream in cache for ${channelId}`);
        await addWiflixHeadersRule(
          cachedStream.url,
          "https://www.livehdtv.com/",
        );
        return { streams: [cachedStream] };
      }

      console.log(
        `[WITV] Type 2: livehdtv detected, using backend stream API...`,
      );

      const apiUrl = `${API_BASE_URL}/api/livetv/stream/tv/${channelId}`;
      console.log(`[WITV] Calling backend stream API: ${apiUrl}`);

      try {
        const apiResponse = await fetch(apiUrl, {
          headers: buildBackendApiHeaders(accessKey),
        });

        if (!apiResponse.ok) {
          throw new Error(`Backend API error: ${apiResponse.status}`);
        }

        const apiData = await apiResponse.json();

        if (apiData.error) {
          throw new Error(apiData.error);
        }

        if (!apiData.streams || apiData.streams.length === 0) {
          throw new Error("No streams returned from backend");
        }

        const stream = apiData.streams[0];
        const m3u8Url = stream.originalUrl || stream.url;

        await addWiflixHeadersRule(m3u8Url, "https://www.livehdtv.com/");

        // Verify stream availability
        console.log("[WITV] Verifying stream availability...");
        let retries = 0;
        const maxRetries = 20;

        while (retries < maxRetries) {
          try {
            const checkResponse = await fetch(m3u8Url, {
              method: "GET",
              headers: {
                Origin: "https://www.livehdtv.com",
                Referer: "https://www.livehdtv.com/",
              },
            });

            if (checkResponse.ok) {
              console.log(`[WITV] Stream verified after ${retries} retries`);
              break;
            }
          } catch (e) {
            // retry
          }

          await new Promise((resolve) => setTimeout(resolve, 500));
          retries++;
        }

        const streamData = {
          title: "Orca",
          url: m3u8Url,
          originalUrl: m3u8Url,
          behaviorHints: { notWebReady: false },
        };

        await saveToCache(cacheKey, streamData, 1);

        return { streams: [streamData] };
      } catch (apiError) {
        console.error(
          `[WITV] Backend API failed, trying direct fetch fallback:`,
          apiError.message,
        );

        const livehdtvResponse = await fetch(embedSrc, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
            Referer: "https://www.livehdtv.com/",
          },
        });

        if (!livehdtvResponse.ok) {
          throw new Error(
            `Failed to fetch livehdtv page: ${livehdtvResponse.status}`,
          );
        }

        const livehdtvHtml = await livehdtvResponse.text();

        const innerIframeMatch = livehdtvHtml.match(
          /<iframe[^>]*src=["']([^"']+)["']/i,
        );
        if (!innerIframeMatch) {
          throw new Error("No inner iframe found in livehdtv page");
        }

        let tokenPhpUrl = innerIframeMatch[1];
        if (!tokenPhpUrl.startsWith("http")) {
          tokenPhpUrl = `https://www.livehdtv.com${tokenPhpUrl}`;
        }

        const tokenResponse = await fetch(tokenPhpUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
            Referer: embedSrc,
          },
        });

        if (!tokenResponse.ok) {
          throw new Error(`Failed to fetch token.php: ${tokenResponse.status}`);
        }

        const tokenHtml = await tokenResponse.text();
        const fileMatch = tokenHtml.match(
          /file:\s*["']([^"']+\.m3u8[^"']*)["']/,
        );

        if (!fileMatch) {
          throw new Error("Could not extract m3u8 from token.php");
        }

        const m3u8Url = fileMatch[1];
        await addWiflixHeadersRule(m3u8Url, "https://www.livehdtv.com/");

        return {
          streams: [
            {
              title: "Orca",
              url: m3u8Url,
              originalUrl: m3u8Url,
              behaviorHints: { notWebReady: false },
            },
          ],
        };
      }
    }

    // Type 3: Unknown embed - try generic extraction
    console.log(
      `[WITV] Unknown embed type, attempting generic extraction from: ${embedSrc}`,
    );

    const unknownUrl = embedSrc.startsWith("http")
      ? embedSrc
      : `${WITV_BASE_URL}${embedSrc}`;
    const unknownResponse = await fetch(unknownUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: channelPageUrl,
      },
    });

    if (!unknownResponse.ok) {
      throw new Error(
        `Failed to fetch unknown embed: ${unknownResponse.status}`,
      );
    }

    const unknownHtml = await unknownResponse.text();
    const m3u8Match = unknownHtml.match(
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/,
    );

    if (!m3u8Match) {
      throw new Error("Could not extract stream URL from unknown embed");
    }

    const m3u8Url = m3u8Match[1];
    await addWiflixHeadersRule(m3u8Url);

    return {
      streams: [
        {
          title: "Orca",
          url: m3u8Url,
          originalUrl: m3u8Url,
          behaviorHints: { notWebReady: false },
        },
      ],
    };
  } catch (error) {
    console.error("[WITV] Error extracting stream:", error);
    throw error;
  }
}

// Add DNR rule for Wiflix headers
async function addWiflixHeadersRule(
  urlPattern,
  referer = "https://witv.team/",
) {
  try {
    const url = new URL(urlPattern);
    const domainPattern = `*://${url.hostname}/*`;
    const origin = referer.endsWith("/") ? referer.slice(0, -1) : referer;

    await addHeadersRule(domainPattern, {
      Origin: origin,
      Referer: referer,
    });
  } catch (e) {
    console.error("[WITV] Failed to add headers rule:", e);
  }
}

async function getBackendIframeSourceStream(
  channelId,
  accessKey = null,
  logPrefix = "LIVE",
  options = {},
) {
  const requestUrl = new URL(
    `${API_BASE_URL}/api/livetv/stream/tv/${channelId}`,
  );
  if (options.mode === "sources") {
    requestUrl.searchParams.set("mode", "sources");
  }
  if (Number.isInteger(options.sourceIndex) && options.sourceIndex >= 0) {
    requestUrl.searchParams.set("sourceIndex", String(options.sourceIndex));
  }

  const response = await fetch(requestUrl.toString(), {
    headers: buildBackendApiHeaders(accessKey),
  });
  if (!response.ok) throw new Error(`Backend API error: ${response.status}`);

  const data = await response.json();

  if (options.mode === "sources") {
    console.log(
      `[${logPrefix}] Backend returned ${data.sources?.length || 0} source(s) for ${channelId}`,
    );
    return data;
  }

  if (data.streams && data.streams.length > 0) {
    const normalizedStreams = [];
    const isLiveTvRequest =
      channelId.startsWith("livetv_") || logPrefix === "LIVETV";

    for (const stream of data.streams) {
      if (stream._isEmbed) {
        const url = stream.originalUrl || stream.url;
        if (isLiveTvRequest && url?.startsWith("http")) {
          await addLiveTvEmbedHeadersRule(url);
        }

        normalizedStreams.push({
          ...stream,
          url: url || stream.url,
          originalUrl: url || stream.originalUrl,
          referer: isLiveTvRequest ? LIVETV_EMBED_REFERER : stream.referer,
          behaviorHints: { notWebReady: false },
        });
        continue;
      }

      const url = stream.originalUrl || stream.url;
      if (!url || !url.startsWith("http")) continue;

      if (isLiveTvRequest) {
        await addLiveTvHeadersRule(url, stream.userAgent);
      } else {
        await addSosplayHeadersRule(url, stream.referer, stream.userAgent);
      }
      normalizedStreams.push({
        ...stream,
        url,
        originalUrl: url,
        referer: isLiveTvRequest ? LIVETV_EMBED_REFERER : stream.referer,
        behaviorHints: { notWebReady: false },
      });
    }

    data.streams = normalizedStreams;
  }

  console.log(
    `[${logPrefix}] Backend returned ${data.streams?.length || 0} stream(s) for ${channelId}`,
  );
  return data;
}

async function getSosplayStream(channelId, accessKey = null) {
  console.log(`[SOSPLAY] Fetching stream logic via Extension: ${channelId}`);
  try {
    return await getBackendIframeSourceStream(channelId, accessKey, "BOLALOCA");

    let slug = channelId.replace("sosplay_", "");
    let channelPageUrl = `${SOSPLAY_BASE_URL}/regardertv-${slug}-streaming-direct`;

    console.log(`[SOSPLAY] Fetching channel page: ${channelPageUrl}`);
    const pageResponse = await fetch(channelPageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: SOSPLAY_BASE_URL,
      },
    });

    if (!pageResponse.ok) {
      console.log(
        `[SOSPLAY] Failed to fetch channel page: ${pageResponse.status}`,
      );
    }

    const pageHtml = await pageResponse.text();

    const serverRegex =
      /class="[^"]*change-video[^"]*"[^>]*data-embed="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;

    let match;
    const servers = [];

    while ((match = serverRegex.exec(pageHtml)) !== null) {
      const rawName = match[2];
      const cleanName = rawName.replace(/<[^>]+>/g, "").trim();

      if (match[1] && cleanName) {
        const idMatch = match[1].match(/id=(\d+)\/(\d+)/);
        servers.push({
          embedPath: match[1],
          name: cleanName,
          channelNum: idMatch ? idMatch[1] : null,
          serverNum: idMatch ? idMatch[2] : null,
        });
      }
    }

    console.log(
      `[SOSPLAY] Found ${servers.length} servers: ${servers.map((s) => s.name).join(", ")}`,
    );

    const allStreams = [];
    const allEmbeds = [];

    for (const server of servers) {
      try {
        console.log(`[SOSPLAY] Trying server: ${server.name}`);

        const partUrl = `${SOSPLAY_BASE_URL}${server.embedPath}`;

        const partResponse = await fetch(partUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Referer: channelPageUrl,
          },
        });

        const partHtml = await partResponse.text();

        const tyIframeMatch = partHtml.match(/<iframe[^>]+src=["']([^"']+)/i);
        if (!tyIframeMatch) {
          console.warn(`[SOSPLAY] No iframe in /part/ page for ${server.name}`);
          continue;
        }

        let tyPageUrl = tyIframeMatch[1];
        if (tyPageUrl.startsWith("//")) tyPageUrl = "https:" + tyPageUrl;
        if (tyPageUrl.startsWith("/")) tyPageUrl = SOSPLAY_BASE_URL + tyPageUrl;

        const tyPageResponse = await fetch(tyPageUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Referer: partUrl,
          },
        });

        const tyPageHtml = await tyPageResponse.text();

        const playerIframeMatch = tyPageHtml.match(
          /<iframe[^>]+src=["']([^"']+)/i,
        );
        if (!playerIframeMatch) {
          console.warn(
            `[SOSPLAY] No player iframe in ty page for ${server.name}`,
          );
          continue;
        }

        let playerUrl = playerIframeMatch[1];
        if (playerUrl.startsWith("//")) playerUrl = "https:" + playerUrl;

        try {
          const playerDomain = new URL(playerUrl).hostname;
          await addHeadersRule(`*://${playerDomain}/*`, {
            Referer: tyPageUrl,
            Origin: new URL(tyPageUrl).origin,
          });
        } catch (e) {
          console.warn(
            `[SOSPLAY] Could not add pre-fetch DNR rule for ${server.name}:`,
            e,
          );
        }

        const playerResponse = await fetch(playerUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        const playerHtml = await playerResponse.text();

        let m3u8Url = null;
        const isHoca =
          server.name.toLowerCase().includes("hoca") ||
          playerUrl.includes("hoca");

        if (isHoca) {
          m3u8Url = decodeHocaStream(playerHtml);
        } else {
          m3u8Url = decodeWigiStream(playerHtml);
        }

        if (m3u8Url) {
          console.log(`[SOSPLAY] Found stream for ${server.name}: ${m3u8Url}`);

          await addSosplayHeadersRule(m3u8Url, playerUrl);

          allStreams.push({
            title: `Sosplay - ${server.name}`,
            url: m3u8Url,
            originalUrl: m3u8Url,
            behaviorHints: { notWebReady: false },
            _referer: playerUrl,
            userAgent: STREAM_PROXY_USER_AGENT,
          });
        } else {
          console.warn(`[SOSPLAY] Failed to decode stream for ${server.name}`);
        }
      } catch (serverError) {
        console.warn(
          `[SOSPLAY] Error with server ${server.name}:`,
          serverError.message || serverError,
        );
        continue;
      }
    }

    if (allStreams.length > 0) {
      console.log(
        `[SOSPLAY] Total streams found locally: ${allStreams.length}`,
      );
      return { streams: allStreams };
    }

    // Fallback: Use backend API
    console.log(
      "[SOSPLAY] Local extraction failed, falling back to Backend API",
    );
    const response = await fetch(
      `${API_BASE_URL}/api/livetv/stream/tv/${channelId}`,
    );
    if (!response.ok) throw new Error(`Backend API error: ${response.status}`);

    const data = await response.json();

    if (data.streams && data.streams.length > 0) {
      for (const stream of data.streams) {
        const url = stream.originalUrl || stream.url;
        if (url && url.startsWith("http")) {
          await addSosplayHeadersRule(url, stream.referer);
          stream.url = url;
          stream.behaviorHints = { notWebReady: false };
        }
      }
    }

    return data;
  } catch (error) {
    console.error("[SOSPLAY] Error fetching stream:", error);
    throw error;
  }
}

async function getLiveTvStream(channelId, accessKey = null, options = {}) {
  console.log(`[LIVETV] Fetching stream logic via Extension: ${channelId}`);
  try {
    const sourceIndex =
      Number.isInteger(options?.sourceIndex) && options?.sourceIndex >= 0
        ? options.sourceIndex
        : null;
    const mode = options?.mode === "sources" ? "sources" : "stream";
    const decodedPath = decodeLiveTvChannelPath(channelId);
    if (!decodedPath) {
      throw new Error(`Could not decode channel path for ${channelId}`);
    }

    const eventUrl = absolutizeLiveTvUrl(
      decodedPath,
      LIVETV_BASE_URL,
      LIVETV_BASE_URL,
    );
    if (!eventUrl) {
      throw new Error(`Could not build event URL for ${channelId}`);
    }

    const eventPage = await fetchLiveTvText(eventUrl, LIVETV_BASE_URL);
    if (!eventPage?.html) {
      throw new Error(`Could not fetch event page ${eventUrl}`);
    }

    const webplayerEntries = extractLiveTvWebplayerEntries(
      eventPage.html,
      eventPage.finalUrl || eventUrl,
    );
    console.log(
      `[LIVETV] Extracted ${webplayerEntries.length} webplayer link(s) locally for ${channelId}`,
    );

    if (mode === "sources") {
      return {
        sources: buildLiveTvSourceOptions(webplayerEntries),
      };
    }

    const selectedEntries =
      sourceIndex === null
        ? webplayerEntries
        : webplayerEntries.filter((_, index) => index === sourceIndex);

    if (selectedEntries.length === 0) {
      return await getBackendIframeSourceStream(
        channelId,
        accessKey,
        "LIVETV",
        options,
      );
    }

    const allStreams = [];
    const allEmbeds = [];

    for (const entry of selectedEntries) {
      const candidateUrls = dedupeLiveTvItems(
        [entry.exportUrl, entry.webplayerUrl].filter(Boolean),
        (url) => url,
      );

      let resolved = { streams: [], embeds: [] };
      for (const candidateUrl of candidateUrls) {
        resolved = await resolveLiveTvMediaFromUrl(
          candidateUrl,
          eventPage.finalUrl || eventUrl,
          6,
          new Set(),
        );

        if (resolved.streams.length > 0 || resolved.embeds.length > 0) {
          break;
        }
      }

      for (const [streamIndex, stream] of resolved.streams.entries()) {
        await addLiveTvHeadersRule(stream.url);
        allStreams.push({
          title:
            resolved.streams.length > 1
              ? `${entry.title} ${streamIndex + 1}`
              : entry.title,
          url: stream.url,
          originalUrl: stream.url,
          behaviorHints: { notWebReady: false },
          _referer: LIVETV_EMBED_REFERER,
          userAgent: STREAM_PROXY_USER_AGENT,
        });
      }

      for (const [embedIndex, embed] of resolved.embeds.entries()) {
        await addLiveTvEmbedHeadersRule(embed.url);
        allEmbeds.push({
          title:
            resolved.embeds.length > 1
              ? `${entry.title} Embed ${embedIndex + 1}`
              : `${entry.title} Embed`,
          url: embed.url,
          originalUrl: embed.url,
          referer: LIVETV_EMBED_REFERER,
          behaviorHints: { notWebReady: false },
          _referer: LIVETV_EMBED_REFERER,
          userAgent: STREAM_PROXY_USER_AGENT,
          _isEmbed: true,
        });
      }
    }

    const uniqueStreams = dedupeLiveTvItems(
      allStreams,
      (stream) => `${stream.url}__${stream._referer || ""}`,
    );
    const uniqueEmbeds = dedupeLiveTvItems(
      allEmbeds,
      (embed) => `${embed.url}__${embed._referer || ""}`,
    );

    if (uniqueStreams.length > 0 || uniqueEmbeds.length > 0) {
      console.log(
        `[LIVETV] Resolved ${uniqueStreams.length} direct stream(s) and ${uniqueEmbeds.length} embed(s) locally for ${channelId}`,
      );
      return { streams: uniqueStreams.length > 0 ? uniqueStreams : uniqueEmbeds };
    }

    console.log(
      "[LIVETV] Local extraction failed, falling back to Backend API",
    );
    return await getBackendIframeSourceStream(
      channelId,
      accessKey,
      "LIVETV",
      options,
    );
  } catch (error) {
    console.warn(
      `[LIVETV] Local extraction error for ${channelId}:`,
      error.message || error,
    );
    return await getBackendIframeSourceStream(
      channelId,
      accessKey,
      "LIVETV",
      options,
    );
  }
}

function decodeLiveTvChannelPath(channelId) {
  try {
    const encodedPath = String(channelId || "").replace(/^livetv_/, "");
    const normalized = encodedPath.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4 || 4)) % 4;
    return atob(`${normalized}${"=".repeat(paddingLength)}`);
  } catch (error) {
    return null;
  }
}

function absolutizeLiveTvUrl(
  rawUrl,
  currentUrl = "",
  fallbackBase = LIVETV_BASE_URL,
) {
  if (!rawUrl) return null;

  const normalized = String(rawUrl)
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\s+/g, "");

  if (!normalized) return null;

  if (normalized.startsWith("//")) {
    const protocol = String(currentUrl || fallbackBase).startsWith("http://")
      ? "http:"
      : "https:";
    return `${protocol}${normalized}`;
  }

  try {
    return new URL(normalized, currentUrl || fallbackBase).href;
  } catch (error) {
    return null;
  }
}

function dedupeLiveTvItems(items, getKey) {
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

function stripLiveTvHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function buildLiveTvExportUrl(webplayerUrl, eventUrl = "") {
  try {
    const parsed = new URL(webplayerUrl, eventUrl || LIVETV_BASE_URL);

    if (/\/export\/webplayer\.iframe\.php$/i.test(parsed.pathname)) {
      return parsed.href;
    }

    if (!/\/webplayer(?:2)?\.php$/i.test(parsed.pathname)) {
      return parsed.href;
    }

    let cdnHost = parsed.hostname;
    if (!cdnHost.startsWith("cdn.")) {
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

function extractLiveTvWebplayerEntries(html, eventUrl) {
  const entries = [];
  const rawHtml = String(html || "");
  const rowPattern = /<table[^>]+class=["']lnktbj["'][\s\S]*?<\/table>/gi;

  for (const rowMatch of rawHtml.matchAll(rowPattern)) {
    const rowHtml = rowMatch[0];
    const hrefMatch = rowHtml.match(
      /href=["']([^"']*\/webplayer(?:2)?\.php[^"']*)["']/i,
    );
    if (!hrefMatch) continue;

    const webplayerUrl = absolutizeLiveTvUrl(
      hrefMatch[1],
      eventUrl,
      LIVETV_BASE_URL,
    );
    if (!webplayerUrl) continue;

    let streamType = "";
    try {
      streamType = new URL(webplayerUrl).searchParams.get("t") || "";
    } catch (error) {
      streamType = "";
    }

    if (streamType.toLowerCase() === "acestream") {
      continue;
    }

    const language =
      stripLiveTvHtml(
        rowHtml.match(/<img[^>]+title=["']([^"']+)["']/i)?.[1] || "",
      ) || "Stream";
    const bitrate = stripLiveTvHtml(
      rowHtml.match(/class=["']bitrate["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || "",
    );
    const hoster = stripLiveTvHtml(
      rowHtml.match(/class=["']lnktyt["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || "",
    );
    const title =
      [language, hoster, bitrate].filter(Boolean).join(" - ") || language;

    entries.push({
      title,
      language,
      bitrate,
      hoster,
      sourceType: streamType,
      webplayerUrl,
      exportUrl: buildLiveTvExportUrl(webplayerUrl, eventUrl),
    });
  }

  if (entries.length === 0) {
    for (const hrefMatch of rawHtml.matchAll(
      /href=["']([^"']*\/webplayer(?:2)?\.php[^"']*)["']/gi,
    )) {
      const webplayerUrl = absolutizeLiveTvUrl(
        hrefMatch[1],
        eventUrl,
        LIVETV_BASE_URL,
      );
      if (!webplayerUrl) continue;

      entries.push({
        title: "Stream",
        language: "",
        bitrate: "",
        hoster: "",
        sourceType: "",
        webplayerUrl,
        exportUrl: buildLiveTvExportUrl(webplayerUrl, eventUrl),
      });
    }
  }

  if (entries.length === 0) {
    const onclickPattern =
      /show_webplayer\('([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']+)'\)/gi;

    for (const match of rawHtml.matchAll(onclickPattern)) {
      const [, type, contentId, eventId, linkId, countryId, streamId, lang] =
        match;
      if (String(type).toLowerCase() === "acestream") continue;

      const webplayerUrl = absolutizeLiveTvUrl(
        `/webplayer2.php?t=${encodeURIComponent(type)}&c=${encodeURIComponent(contentId)}&lang=${encodeURIComponent(lang)}&eid=${eventId}&lid=${linkId}&ci=${countryId}&si=${streamId}`,
        eventUrl,
        LIVETV_BASE_URL,
      );

      if (!webplayerUrl) continue;

      entries.push({
        title: stripLiveTvHtml(type) || "Stream",
        language: stripLiveTvHtml(lang) || "",
        bitrate: "",
        hoster: "",
        sourceType: stripLiveTvHtml(type) || "",
        webplayerUrl,
        exportUrl: buildLiveTvExportUrl(webplayerUrl, eventUrl),
      });
    }
  }

  return dedupeLiveTvItems(
    entries,
    (entry) => `${entry.exportUrl}__${entry.webplayerUrl}`,
  );
}

function buildLiveTvSourceOptions(entries) {
  return entries.map((entry, index) => ({
    index,
    title: entry.title || `Source ${index + 1}`,
    language: entry.language || "",
    bitrate: entry.bitrate || "",
    hoster: entry.hoster || "",
    sourceType: entry.sourceType || "",
  }));
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
      hostname === "ads.livetv882.me" ||
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

function isLiveTvExportIframePage(rawUrl) {
  try {
    const parsed = new URL(rawUrl, LIVETV_BASE_URL);
    return /\/export\/webplayer\.iframe\.php$/i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function shouldFollowLiveTvIframeForExtraction(iframeUrl, pageUrl) {
  try {
    const page = new URL(pageUrl, LIVETV_BASE_URL);
    if (!isLiveTvExportIframePage(page.href)) {
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

function extractLiveTvIframeUrls(html, currentUrl) {
  const iframeUrls = [];
  const iframePattern = /<iframe[^>]+src=["']([^"']+)["']/gi;

  for (const match of String(html || "").matchAll(iframePattern)) {
    const iframeUrl = absolutizeLiveTvUrl(
      match[1],
      currentUrl,
      LIVETV_BASE_URL,
    );
    if (iframeUrl && !shouldIgnoreLiveTvIframeUrl(iframeUrl)) {
      iframeUrls.push(iframeUrl);
    }
  }

  return dedupeLiveTvItems(iframeUrls, (url) => url);
}

function extractLiveTvDirectStreams(html, referer) {
  const streams = [];
  const cleaned = String(html || "").replace(/\\\//g, "/");

  const addCandidate = (rawUrl, candidateReferer = referer) => {
    const absoluteUrl = absolutizeLiveTvUrl(
      rawUrl,
      candidateReferer,
      LIVETV_BASE_URL,
    );
    if (!absoluteUrl) return;
    if (!/\.(m3u8|mpd)(?:[?#]|$)/i.test(absoluteUrl)) return;
    streams.push({ url: absoluteUrl, referer: candidateReferer });
  };

  const packedStreamUrl = decodeWigiStream(cleaned);
  if (packedStreamUrl) {
    addCandidate(packedStreamUrl, referer);
  }

  const hocaStreamUrl = decodeHocaStream(cleaned);
  if (hocaStreamUrl) {
    addCandidate(hocaStreamUrl, referer);
  }

  for (const match of cleaned.matchAll(
    /pl\.init\(\s*['"]([^'"]+)['"]\s*\)/gi,
  )) {
    addCandidate(match[1], referer);
  }

  for (const match of cleaned.matchAll(
    /manifestUrl\s*:\s*['"]([^'"]+)['"]/gi,
  )) {
    addCandidate(match[1], referer);
  }

  for (const match of cleaned.matchAll(
    /(?:source|file|src)\s*[:=]\s*['"]([^'"]+\.(?:m3u8|mpd)[^'"]*)['"]/gi,
  )) {
    addCandidate(match[1], referer);
  }

  for (const match of cleaned.matchAll(
    /['"]((?:https?:)?\/\/[^'"]+\.(?:m3u8|mpd)[^'"]*)['"]/gi,
  )) {
    addCandidate(match[1], referer);
  }

  return dedupeLiveTvItems(
    streams,
    (stream) => `${stream.url}__${stream.referer || ""}`,
  );
}

async function addLiveTvHeadersRule(
  targetUrl,
  userAgent = STREAM_PROXY_USER_AGENT,
) {
  try {
    const url = new URL(targetUrl);
    const rulePattern = `*://${url.host}${url.pathname}*`;

    await addHeadersRule(rulePattern, {
      Origin: LIVETV_EMBED_ORIGIN,
      Referer: LIVETV_EMBED_REFERER,
      "User-Agent": userAgent || STREAM_PROXY_USER_AGENT,
    });
  } catch (error) {
    console.warn("[LIVETV] Failed to add page headers rule:", error);
  }
}

async function addLiveTvEmbedHeadersRule(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const rulePattern = `*://${url.host}${url.pathname}*`;

    await addHeadersRule(rulePattern, {
      Origin: LIVETV_EMBED_ORIGIN,
      Referer: LIVETV_EMBED_REFERER,
    });
  } catch (error) {
    console.warn("[LIVETV] Failed to add embed headers rule:", error);
  }
}

async function fetchLiveTvText(url, referer = "") {
  try {
    const absoluteUrl = absolutizeLiveTvUrl(url, referer, LIVETV_BASE_URL);
    if (!absoluteUrl) return null;

    await addLiveTvHeadersRule(absoluteUrl);

    const response = await fetch(absoluteUrl, {
      method: "GET",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent": STREAM_PROXY_USER_AGENT,
      },
      cache: "no-cache",
      redirect: "follow",
    });

    if (!response.ok) {
      console.warn(
        `[LIVETV] Fetch failed for ${absoluteUrl}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    return {
      html: await response.text(),
      finalUrl: response.url || absoluteUrl,
    };
  } catch (error) {
    console.warn(`[LIVETV] Fetch error for ${url}:`, error.message || error);
    return null;
  }
}

async function resolveLiveTvMediaFromUrl(
  startUrl,
  referer,
  depth = 4,
  visited = new Set(),
) {
  const absoluteUrl = absolutizeLiveTvUrl(startUrl, referer, LIVETV_BASE_URL);
  if (!absoluteUrl || visited.has(absoluteUrl)) {
    return { streams: [], embeds: [] };
  }

  visited.add(absoluteUrl);

  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(absoluteUrl)) {
    return {
      streams: [{ url: absoluteUrl, referer: referer || absoluteUrl }],
      embeds: [],
    };
  }

  const page = await fetchLiveTvText(absoluteUrl, referer);
  if (!page?.html) {
    return { streams: [], embeds: [] };
  }

  let streams = extractLiveTvDirectStreams(
    page.html,
    page.finalUrl || absoluteUrl,
  );
  let embeds = [];
  const currentPageUrl = page.finalUrl || absoluteUrl;
  const iframeUrls = extractLiveTvIframeUrls(
    page.html,
    page.finalUrl || absoluteUrl,
  );

  if (depth <= 0) {
    return {
      streams,
      embeds: iframeUrls.map((url) => ({
        url,
        referer: LIVETV_EMBED_REFERER,
      })),
    };
  }

  for (const iframeUrl of iframeUrls) {
    if (!shouldFollowLiveTvIframeForExtraction(iframeUrl, currentPageUrl)) {
      embeds.push({ url: iframeUrl, referer: LIVETV_EMBED_REFERER });
      continue;
    }

    console.log(`[LIVETV] Following iframe locally: ${iframeUrl}`);
    const nested = await resolveLiveTvMediaFromUrl(
      iframeUrl,
      page.finalUrl || absoluteUrl,
      depth - 1,
      visited,
    );
    streams = streams.concat(nested.streams);
    embeds = embeds.concat(nested.embeds);

    if (nested.streams.length === 0 && nested.embeds.length === 0) {
      embeds.push({ url: iframeUrl, referer: LIVETV_EMBED_REFERER });
    }
  }

  return {
    streams: dedupeLiveTvItems(
      streams,
      (stream) => `${stream.url}__${stream.referer || ""}`,
    ),
    embeds: dedupeLiveTvItems(
      embeds,
      (embed) => `${embed.url}__${embed.referer || ""}`,
    ),
  };
}

async function addSosplayHeadersRule(
  urlPattern,
  customReferer = null,
  customUserAgent = STREAM_PROXY_USER_AGENT,
) {
  try {
    const url = new URL(urlPattern);
    const pathNoExt = url.pathname.replace(/\.[^/.]+$/, "");
    const rulePattern = `*://${url.host}${pathNoExt}*`;

    const referer = customReferer || "https://dishtrainer.net/";

    let origin;
    try {
      origin = new URL(referer).origin;
    } catch {
      origin = "https://dishtrainer.net";
    }

    const userAgent = customUserAgent || STREAM_PROXY_USER_AGENT;

    await addHeadersRule(rulePattern, {
      Origin: origin,
      Referer: referer,
      "User-Agent": userAgent,
    });
  } catch (e) {
    console.error("[SOSPLAY] Failed to add headers rule:", e);
  }
}

// === UTILS ===

function decodeHocaStream(html) {
  try {
    const atobMatch = html.match(/atob\(['"]([^'"]+)['"]\)/);
    if (atobMatch) {
      try {
        const decoded = atob(atobMatch[1]);
        if (decoded.includes(".m3u8")) return decoded;
      } catch (e) {}
    }

    const urlArrayMatch = html.match(/return\s*\(\[([^\]]+)\]\.join/);
    if (urlArrayMatch) {
      try {
        const chars = urlArrayMatch[1].match(/"([^"]*)"/g);
        if (chars) {
          let url = chars.map((c) => c.replace(/"/g, "")).join("");
          url = url.replace(/\\\//g, "/");
          if (url.includes(".m3u8")) return url;
        }
      } catch (e) {}
    }

    const srcMatch = html.match(
      /(?:source|src|file)\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
    );
    if (srcMatch) {
      return srcMatch[1].replace(/\\\//g, "/");
    }

    const m3u8Match = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/);
    if (m3u8Match) {
      return m3u8Match[1].replace(/\\\//g, "/");
    }

    const packerResult = decodeWigiStream(html);
    if (packerResult) return packerResult;

    return null;
  } catch (error) {
    console.error("[SOSPLAY-HOCA] Error:", error.message || error);
    return null;
  }
}

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

function decodeWigiStream(html) {
  try {
    const packerRegex =
      /eval\(function\(p,a,c,k,e,(?:d|r)\)\{.*?return p\}\(\s*['"]([\s\S]*?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\s*\.split\(['"]\|['"]\)\s*(?:,\s*0\s*,\s*\{\})?\s*\)\)/gs;
    const packerMatches = [...html.matchAll(packerRegex)];

    if (packerMatches.length === 0) {
      const evalPositions = [];
      let searchPos = 0;
      while (true) {
        const idx = html.indexOf("eval(function(p,a,c,k,e,", searchPos);
        if (idx === -1) break;
        evalPositions.push(idx);
        searchPos = idx + 1;
      }

      for (const pos of evalPositions) {
        const chunk = html.substring(pos, pos + 5000);

        const splitIdx = chunk.indexOf(".split('|')");
        const splitIdx2 = chunk.indexOf('.split("|")');
        const actualSplitIdx = splitIdx !== -1 ? splitIdx : splitIdx2;

        if (actualSplitIdx !== -1) {
          let kwEnd = actualSplitIdx;
          let kwStart = chunk.lastIndexOf("'", kwEnd - 1);
          if (kwStart === -1) kwStart = chunk.lastIndexOf('"', kwEnd - 1);

          if (kwStart !== -1) {
            const keywords = chunk.substring(kwStart + 1, kwEnd).split("|");

            const payloadStartMarker = chunk.indexOf("}('");
            const payloadStartMarker2 = chunk.indexOf('}("');
            const pStart =
              payloadStartMarker !== -1
                ? payloadStartMarker
                : payloadStartMarker2;

            if (pStart !== -1) {
              const quoteChar = chunk[pStart + 2];
              const payloadStart = pStart + 3;
              const payloadEnd = chunk.indexOf(quoteChar + ",", payloadStart);

              if (payloadEnd !== -1) {
                const payload = chunk.substring(payloadStart, payloadEnd);
                const afterPayload = chunk.substring(payloadEnd + 2);
                const numMatch = afterPayload.match(
                  /^\s*(\d+)\s*,\s*(\d+)\s*,/,
                );

                if (numMatch) {
                  const radix = parseInt(numMatch[1]);
                  const count = parseInt(numMatch[2]);
                  const d = {};
                  const decodedScript = unpackPacker(
                    payload,
                    radix,
                    count,
                    keywords,
                    null,
                    d,
                  );

                  if (
                    decodedScript &&
                    (decodedScript.includes(".m3u8") ||
                      decodedScript.includes("hls") ||
                      decodedScript.includes("Clappr"))
                  ) {
                    const urlRegex = /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g;
                    let urlMatch;
                    const urls = [];
                    while ((urlMatch = urlRegex.exec(decodedScript)) !== null) {
                      urls.push(urlMatch[1].replace(/\\/ / g, "/"));
                    }
                    if (urls.length > 0) {
                      const backupUrl = urls.find(
                        (u) => u.includes("vuunov") || u.includes("live"),
                      );
                      const primaryUrl = urls.find(
                        (u) => u.includes("shop") || u.includes("srvagu"),
                      );
                      return backupUrl || primaryUrl || urls[0];
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < packerMatches.length; i++) {
      const packerMatch = packerMatches[i];
      const payload = packerMatch[1];
      const radix = parseInt(packerMatch[2]);
      const count = parseInt(packerMatch[3]);
      const keywords = packerMatch[4].split("|");
      const d = {};
      const decodedScript = unpackPacker(
        payload,
        radix,
        count,
        keywords,
        null,
        d,
      );

      if (
        !decodedScript.includes("Clappr") &&
        !decodedScript.includes(".m3u8") &&
        !decodedScript.includes("hls")
      ) {
        continue;
      }

      const urlRegex = /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g;
      let urlMatch;
      const urls = [];

      while ((urlMatch = urlRegex.exec(decodedScript)) !== null) {
        urls.push(urlMatch[1].replace(/\\\//g, "/"));
      }

      if (urls.length > 0) {
        const backupUrl = urls.find(
          (u) => u.includes("vuunov") || u.includes("live"),
        );
        const primaryUrl = urls.find(
          (u) => u.includes("shop") || u.includes("srvagu"),
        );
        return backupUrl || primaryUrl || urls[0];
      }
    }

    const srcMatch = html.match(/src:\s*["']([^"']+\.m3u8[^"']*)/i);
    if (srcMatch) return srcMatch[1].replace(/\\\//g, "/");

    const streamMatch = html.match(/["'](https?:\/\/[^"']*\.m3u8[^"']*)/);
    if (streamMatch) return streamMatch[1].replace(/\\\//g, "/");

    const varSrcMatch = html.match(/var\s+src\s*=\s*["']([^"']+)/i);
    if (varSrcMatch && varSrcMatch[1].includes(".m3u8")) {
      return varSrcMatch[1].replace(/\\\//g, "/");
    }

    return null;
  } catch (error) {
    return null;
  }
}

async function fetchSafe(url, context = "") {
  try {
    const options = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      cache: "no-cache",
    };

    const response = await fetch(url, options);
    if (!response.ok) {
      console.error(
        `Fetch failed for ${context || url}: ${response.status} ${response.statusText}`,
      );
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error(`Fetch error for ${context || url}:`, e);
    return null;
  }
}

// Cache helpers
async function getFromCache(key) {
  const result = await browserAPI.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    browserAPI.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

async function saveToCache(key, data, ttlMinutes) {
  const expiry = Date.now() + ttlMinutes * 60 * 1000;
  await browserAPI.storage.local.set({ [key]: { data, expiry } });
}

// DNR Helper
let ruleIdCounter = 100;

async function addUserAgentRule(urlPattern, userAgent) {
  return addHeadersRule(urlPattern, { "User-Agent": userAgent });
}

async function addHeadersRule(urlPattern, headers) {
  const existingRules =
    await browserAPI.declarativeNetRequest.getDynamicRules();
  const existingIds = new Set(existingRules.map((r) => r.id));

  let id = ruleIdCounter;
  while (existingIds.has(id)) {
    id++;
  }
  ruleIdCounter = id + 1;

  const requestHeaders = Object.entries(headers).map(([header, value]) => ({
    header: header,
    operation: "set",
    value: value,
  }));

  const rule = {
    id: id,
    priority: 10,
    action: {
      type: "modifyHeaders",
      requestHeaders: requestHeaders,
    },
    condition: {
      urlFilter: urlPattern,
      resourceTypes: [
        "xmlhttprequest",
        "media",
        "websocket",
        "other",
        "sub_frame",
        "main_frame",
      ],
    },
  };

  try {
    await browserAPI.declarativeNetRequest.updateDynamicRules({
      addRules: [rule],
    });
  } catch (e) {
    console.error("Failed to add dynamic rule:", e);
  }
}
