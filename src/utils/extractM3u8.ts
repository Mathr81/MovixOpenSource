// Utility functions to extract m3u8 URLs from supervideo and dropload players
import { isUserVip } from './authUtils';
import { getVipHeaders } from './vipUtils';
import { PROXIES_EMBED_API, buildProxyUrl } from '../config/runtime';
import { isM3u8ExtractorEnabled } from './extractionPrefs';
import { detectHoster } from './hosterRegistry';
import { getSourcePriorityPrefs } from './sourcePriorityPrefs';
import { sortHostersByPriority } from './sourceAutoSelect';
import type { PriorityCategory, TopLevelSourceId, LanguageId } from '../types/sourcePriority';

// Cache pour stocker les URLs qui ont échoué pour éviter les re-tentatives
const failedUrlsCache = new Set<string>();

/**
 * Helper interne : détection d'hoster via le registre + prefs utilisateur.
 * Utilisé par les aliases `isXxxEmbed` pour garder 100% de rétrocompat tout en
 * respectant les `patternOverrides` et `customHosters` définis par l'utilisateur.
 */
function detectHosterFromPrefs(url: string): string | null {
  const prefs = getSourcePriorityPrefs();
  return detectHoster(url, {
    patternOverrides: prefs.patternOverrides,
    customHosters: prefs.customHosters,
  });
}

// Constante pour le serveur proxy embed
// ===== Extension Nexus Extractors Bridge =====
// When the Movix extension is installed, extraction runs locally (no server needed).
// Falls back to server-side extraction when extension is not available.

declare global {
  interface Window {
    hasMovixExtension?: boolean;
    hasMovixNexusExtractor?: boolean;
    movixExtractM3u8?: (type: string | null, url: string) => Promise<M3u8Result>;
    movixExtractAllM3u8?: (sources: (string | PlayerInfo)[]) => Promise<{ success: boolean; total: number; successCount: number; results: any[] }>;
    movixDetectEmbeds?: (sources: (string | PlayerInfo)[]) => Promise<{ embeds: any[] }>;
    movixSetupHeaders?: (type: string, url: string) => Promise<{ success: boolean; error?: string }>;
  }
}

/**
 * Check if the Movix extension with Nexus extractors is available
 */
function hasNexusExtractors(): boolean {
  return !!(window.hasMovixNexusExtractor && window.movixExtractM3u8);
}

/**
 * The extension/userscript injects its API very early, but still asynchronously.
 * On fast page loads we can start source extraction before the page API exists,
 * which makes some hosters disappear until a manual refresh.
 */
async function waitForNexusExtractors(timeoutMs = 1500): Promise<boolean> {
  if (hasNexusExtractors()) {
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    let intervalId: number | null = null;
    let timeoutId: number | null = null;

    const cleanup = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener('movix-extension-loaded', handleLoaded);
    };

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ready);
    };

    const handleLoaded = () => {
      finish(hasNexusExtractors());
    };

    window.addEventListener('movix-extension-loaded', handleLoaded, { once: true });

    intervalId = window.setInterval(() => {
      if (hasNexusExtractors()) {
        finish(true);
      }
    }, 50);

    timeoutId = window.setTimeout(() => {
      finish(hasNexusExtractors());
    }, timeoutMs);
  });
}

/**
 * Try extraction via extension first, fallback to server
 */
async function tryExtensionFirst(type: string, url: string, serverFallback: () => Promise<M3u8Result | null>): Promise<M3u8Result | null> {
  const extensionReady = hasNexusExtractors() || await waitForNexusExtractors();

  if (extensionReady && window.movixExtractM3u8) {
    try {
      console.log(`[NEXUS] Using extension for ${type} extraction: ${url}`);
      const result = await window.movixExtractM3u8!(type, url);
      if (result && result.success) {
        console.log(`[NEXUS] Extension extraction success for ${type}`);
        return result;
      }
      // Extension failed - only fallback to server if VIP
      if (isUserVip()) {
        console.warn(`[NEXUS] Extension failed for ${type}, falling back to server (VIP)`);
        return serverFallback();
      }
      console.warn(`[NEXUS] Extension failed for ${type}, no server fallback (non-VIP)`);
      return result || { success: false, error: `${type} extraction failed via extension` };
    } catch (e) {
      console.warn(`[NEXUS] Extension error for ${type}:`, e);
      if (isUserVip()) {
        return serverFallback();
      }
      return { success: false, error: `Extension error for ${type}` };
    }
  }
  // No extension - server requires VIP (checked inside server functions)
  return serverFallback();
}

// Feature flags pour les extracteurs jamais exposés côté UI (hors-scope du
// panneau de contrôle — laissés hardcodés).
const SUPERVIDEO_EXTRACTIONS_ENABLED = false;
const DROPLOAD_EXTRACTIONS_ENABLED = false;
const ONEUPLOAD_EXTRACTIONS_ENABLED = false;
const DARKIBOX_EXTRACTIONS_ENABLED = true;

// Les extracteurs ci-dessous sont pilotés par les préférences utilisateur via
// `isM3u8ExtractorEnabled`. Les appelants externes (WatchMovie, WatchTv)
// doivent migrer des anciennes constantes vers ces getters.
export const isVoeExtractionEnabled = () => isM3u8ExtractorEnabled('voe');
export const isUqloadExtractionEnabled = () => isM3u8ExtractorEnabled('uqload');
export const isVidzyExtractionEnabled = () => isM3u8ExtractorEnabled('vidzy');
export const isFsvidExtractionEnabled = () => isM3u8ExtractorEnabled('fsvid');
export const isVidmolyExtractionEnabled = () => isM3u8ExtractorEnabled('vidmoly');
export const isSibnetExtractionEnabled = () => isM3u8ExtractorEnabled('sibnet');
export const isDoodStreamExtractionEnabled = () => isM3u8ExtractorEnabled('doodstream');
export const isSeekStreamingExtractionEnabled = () => isM3u8ExtractorEnabled('seekstreaming');

export interface PlayerInfo {
  player: string;
  link: string;
  is_hd?: boolean;
  label?: string;
}

export interface M3u8Result {
  hlsUrl?: string;
  m3u8Url?: string;
  success: boolean;
  error?: string;
  fromCache?: boolean;
}

// Nouvelles interfaces pour le système d'extraction anticipée
// M9 (Task 9.3.3) : en plus des types built-in, `type` accepte aussi les ids
// de hosters custom (string prefixée `custom_…`) pour permettre aux custom
// hosters d'être découverts par `detectSupportedEmbeds`.
// `sortHostersByPriority` utilisera ces ids pour les trier selon la
// préférence utilisateur. La signature reste union de literals + `string`
// fallback pour ne pas casser le narrowing des usages existants.
export type BuiltinEmbedType =
  | 'supervideo' | 'dropload' | 'voe' | 'uqload' | 'darkibox' | 'vidzy'
  | 'fsvid' | 'sibnet' | 'doodstream' | 'seekstreaming';

export interface EmbedDetectionResult {
  type: BuiltinEmbedType | string;
  url: string;
  enabled: boolean;
  priority: number; // 1 = haute priorité, 5 = basse priorité
}

export interface ExtractionProgress {
  type: string;
  url: string;
  status: 'pending' | 'extracting' | 'success' | 'error';
  result?: M3u8Result;
  error?: string;
  timestamp: number;
}

export type ExtractionCallback = (progress: ExtractionProgress) => void;

/**
 * Extract m3u8 URL from supervideo or dropload embed
 * @param player Player information object
 * @param MAIN_API Main API base URL
 * @returns Promise<M3u8Result | null>
 */
export async function extractM3u8FromEmbed(
  player: PlayerInfo,
  MAIN_API: string
): Promise<M3u8Result | null> {
  // Vérifier le type d'extraction spécifique
  if (player.player && player.player.toLowerCase().includes('supervideo') && !SUPERVIDEO_EXTRACTIONS_ENABLED) {
    return {
      success: false,
      error: 'Extractions Supervideo désactivées'
    };
  }

  if (player.player && player.player.toLowerCase().includes('dropload') && !DROPLOAD_EXTRACTIONS_ENABLED) {
    return {
      success: false,
      error: 'Extractions Dropload désactivées'
    };
  }

  if (!player || !player.link) return null;

  const url = player.link;

  // Vérifier si cette URL a déjà échoué
  if (failedUrlsCache.has(url)) {
    return {
      success: false,
      error: 'URL précédemment échouée - pas de nouvelle tentative',
      fromCache: true
    };
  }

  let apiUrl: string | null = null;

  if (player.player && player.player.toLowerCase().includes('supervideo')) {
    apiUrl = `${MAIN_API}/api/extract-supervideo?url=${encodeURIComponent(url)}`;
  } else if (player.player && player.player.toLowerCase().includes('dropload')) {
    apiUrl = `${MAIN_API}/api/extract-dropload?url=${encodeURIComponent(url)}`;
  }

  if (!apiUrl) return null;

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Handle supervideo response format
    if (data.hlsUrl) {
      return {
        hlsUrl: data.hlsUrl,
        success: true
      };
    }

    // Handle dropload response format
    if (data.m3u8Url) {
      return {
        m3u8Url: data.m3u8Url,
        success: true
      };
    }

    // Ajouter l'URL au cache des échecs
    failedUrlsCache.add(url);
    return {
      success: false,
      error: 'No m3u8 URL found in response'
    };

  } catch (error) {
    console.error('Error extracting m3u8:', error);
    // Ajouter l'URL au cache des échecs
    failedUrlsCache.add(url);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}


/**
 * Détecter si une URL est un embed OneUpload
 * @param url URL à vérifier
 * @returns boolean
 */
export function isOneUploadEmbed(url: string): boolean {
  return detectHosterFromPrefs(url) === 'oneupload';
}

/**
 * Détecter si une URL est un embed VOE
 * @param url URL à vérifier
 * @returns boolean
 */
export function isVoeEmbed(url: string): boolean {
  return detectHosterFromPrefs(url) === 'voe';
}

/**
 * Vider le cache des URLs échouées
 */
export function clearFailedUrlsCache(): void {
  failedUrlsCache.clear();
}

/**
 * Retirer une URL spécifique du cache des échecs
 * @param url URL à retirer du cache
 */
export function removeFromFailedCache(url: string): void {
  failedUrlsCache.delete(url);
}

/**
 * Vérifier si une URL est dans le cache des échecs
 * @param url URL à vérifier
 */
export function isUrlInFailedCache(url: string): boolean {
  return failedUrlsCache.has(url);
}

/**
 * Extraire l'URL HLS depuis VOE.SX
 * @param voeUrl URL VOE.SX
 * @returns Promise<M3u8Result | null>
 */
export async function extractVoeM3u8(
  voeUrl: string
): Promise<M3u8Result | null> {
  if (!isVoeExtractionEnabled()) {
    return { success: false, error: 'Extractions VOE désactivées' };
  }

  if (!voeUrl) return null;

  // Try extension first (no VIP needed - everyone gets access via extension)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('voe', voeUrl, () => extractVoeM3u8Server(voeUrl));
  }

  return extractVoeM3u8Server(voeUrl);
}

async function extractVoeM3u8Server(voeUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return { success: false, error: 'Accès VOE réservé aux utilisateurs VIP ou connectés' };
  }

  if (failedUrlsCache.has(voeUrl)) {
    return { success: false, error: 'URL VOE précédemment échouée', fromCache: true };
  }

  try {
    const encodedUrl = btoa(voeUrl);
    const response = await fetch(`${PROXIES_EMBED_API}/api/voe/m3u8?url=${encodedUrl}`, { headers: getVipHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.source) {
      return {
        hlsUrl: data.source,
        success: true
      };
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(voeUrl);
    return {
      success: false,
      error: 'Aucune source HLS trouvée dans la réponse VOE'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction VOE:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(voeUrl);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue VOE'
    };
  }
}

/**
 * Extraire l'URL de fichier depuis UQLOAD
 * @param uqloadUrl URL UQLOAD
 * @param MAIN_API API principale
 * @returns Promise<M3u8Result | null>
 */
export async function extractUqloadFile(
  uqloadUrl: string,
  _MAIN_API: string
): Promise<M3u8Result | null> {
  if (!isUqloadExtractionEnabled()) {
    return { success: false, error: 'Extractions UQLOAD désactivées' };
  }

  if (!uqloadUrl) return null;

  // Normaliser tous TLDs uqload.* → uqload.is avant transmission (extension/serveur)
  const normalizedUrl = uqloadUrl.replace(/uqload\.[a-z0-9-]+/gi, 'uqload.is');

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('uqload', normalizedUrl, () => extractUqloadFileServer(normalizedUrl));
  }

  return extractUqloadFileServer(normalizedUrl);
}

async function extractUqloadFileServer(uqloadUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return {
      success: false,
      error: 'Accès UQLOAD réservé aux utilisateurs VIP ou connectés'
    };
  }

  if (!uqloadUrl) return null;

  // Vérifier si cette URL a déjà échoué
  if (failedUrlsCache.has(uqloadUrl)) {
    return {
      success: false,
      error: 'URL UQLOAD précédemment échouée - pas de nouvelle tentative',
      fromCache: true
    };
  }

  try {
    // Normaliser le domaine UQLOAD vers uqload.is (tous TLDs)
    const normalizedUrl = uqloadUrl.replace(/uqload\.[a-z0-9-]+/gi, 'uqload.is');
    console.log(`[UQLOAD] Normalized URL: ${normalizedUrl}`);

    // Utiliser le serveur Python pour l'extraction UQLOAD
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-uqload?url=${encodeURIComponent(normalizedUrl)}`, { headers: getVipHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Handle both possible response formats
    const fileUrl = data.data?.url || data.url;
    if (fileUrl) {
      return {
        m3u8Url: fileUrl,
        success: true
      };
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(uqloadUrl);
    return {
      success: false,
      error: 'Aucun fichier trouvé dans la réponse UQLOAD'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction UQLOAD:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(uqloadUrl);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue UQLOAD'
    };
  }
}

/**
 * Extraire les sources depuis un embed Darkibox
 * @param darkiboxUrl URL Darkibox
 * @param _MAIN_API API principale (non utilisée pour Darkibox)
 * @returns Promise<M3u8Result | null>
 */
export async function extractDarkiboxSources(
  darkiboxUrl: string,
  _MAIN_API: string
): Promise<M3u8Result | null> {
  // Vérifier si les extractions Darkibox sont activées
  if (!DARKIBOX_EXTRACTIONS_ENABLED) {
    return {
      success: false,
      error: 'Extractions Darkibox désactivées'
    };
  }

  if (!darkiboxUrl) return null;

  // Vérifier si cette URL a déjà échoué
  if (failedUrlsCache.has(darkiboxUrl)) {
    return {
      success: false,
      error: 'URL Darkibox précédemment échouée - pas de nouvelle tentative',
      fromCache: true
    };
  }

  try {
    // Extraction du HTML Darkibox via proxy CORS avec timeout de 3s
    const encodedDarkiboxUrl = encodeURIComponent(darkiboxUrl);
    const corsProxyUrl = buildProxyUrl(encodedDarkiboxUrl);

    // Créer un AbortController pour le timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 3000); // 3 secondes

    const response = await fetch(corsProxyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      signal: abortController.signal
    });

    // Nettoyer le timeout si la requête réussit
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const htmlContent = await response.text();

    // Extract sources from the HTML using regex
    const sourcesMatch = htmlContent.match(/sources:\s*\[([\s\S]*?)\]/);
    if (sourcesMatch) {
      const sourcesContent = sourcesMatch[1];
      const srcMatch = sourcesContent.match(/src:\s*"([^"]+)"/);
      if (srcMatch) {
        const m3u8Url = srcMatch[1];
        if (m3u8Url && m3u8Url.includes('.m3u8')) {
          return {
            hlsUrl: m3u8Url,
            success: true
          };
        }
      }
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(darkiboxUrl);
    return {
      success: false,
      error: 'Aucune source HLS trouvée dans le HTML Darkibox'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction Darkibox:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(darkiboxUrl);

    // Gestion spécifique du timeout
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        error: 'Timeout: La requête Darkibox a pris plus de 3 secondes'
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue Darkibox'
    };
  }
}

/**
 * Extraire l'URL M3U8 depuis Vidzy via le serveur Python
 * @param vidzyUrl URL Vidzy
 * @param _MAIN_API API principale (non utilisée pour Vidzy - utilise le serveur Python)
 * @returns Promise<M3u8Result | null>
 */
export async function extractVidzyM3u8(
  vidzyUrl: string,
  _MAIN_API: string
): Promise<M3u8Result | null> {
  if (!isVidzyExtractionEnabled()) {
    return { success: false, error: 'Extractions Vidzy désactivées' };
  }

  if (!vidzyUrl) return null;

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('vidzy', vidzyUrl, () => extractVidzyM3u8Server(vidzyUrl));
  }

  return extractVidzyM3u8Server(vidzyUrl);
}

async function extractVidzyM3u8Server(vidzyUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return {
      success: false,
      error: 'Accès Vidzy réservé aux utilisateurs VIP ou connectés'
    };
  }

  if (!vidzyUrl) return null;

  // Vérifier si cette URL a déjà échoué
  if (failedUrlsCache.has(vidzyUrl)) {
    return {
      success: false,
      error: 'URL Vidzy précédemment échouée - pas de nouvelle tentative',
      fromCache: true
    };
  }

  try {
    // Utiliser le serveur Python pour l'extraction Vidzy
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-vidzy?url=${vidzyUrl}`, { headers: getVipHeaders() });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.m3u8Url) {
      return {
        m3u8Url: data.m3u8Url,
        success: true
      };
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(vidzyUrl);
    return {
      success: false,
      error: 'Aucune URL M3U8 trouvée dans la réponse API'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction Vidzy:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(vidzyUrl);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue Vidzy'
    };
  }
}

/**
 * Extraire l'URL M3U8 depuis Fsvid via le backend principal
 * @param fsvidUrl URL Fsvid
 * @param mainApiBase API principale
 * @returns Promise<M3u8Result | null>
 */
export async function extractFsvidM3u8(
  fsvidUrl: string,
  _mainApiBase: string
): Promise<M3u8Result | null> {
  if (!isFsvidExtractionEnabled()) {
    return { success: false, error: 'Extractions Fsvid désactivées' };
  }

  if (!fsvidUrl) return null;

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('fsvid', fsvidUrl, () => extractFsvidM3u8Server(fsvidUrl));
  }

  return extractFsvidM3u8Server(fsvidUrl);
}

async function extractFsvidM3u8Server(fsvidUrl: string): Promise<M3u8Result | null> {
  if (!isFsvidExtractionEnabled()) {
    return { success: false, error: 'Extractions Fsvid désactivées' };
  }

  const isVip = isUserVip();
  if (!isVip) {
    return { success: false, error: 'Accès Fsvid réservé aux utilisateurs VIP' };
  }

  if (!fsvidUrl) return null;

  if (failedUrlsCache.has(fsvidUrl)) {
    return { success: false, error: 'URL Fsvid précédemment échouée', fromCache: true };
  }

  try {
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-fsvid?url=${encodeURIComponent(fsvidUrl)}`, { headers: getVipHeaders() });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    const streamUrl = data.m3u8Url || data.url || data.link || data.file || data.source;

    if (streamUrl) {
      return { m3u8Url: streamUrl, success: true };
    }

    failedUrlsCache.add(fsvidUrl);
    return { success: false, error: 'Aucune URL M3U8 trouvée dans la réponse API' };

  } catch (error) {
    console.error('Erreur lors de l\'extraction Fsvid:', error);
    failedUrlsCache.add(fsvidUrl);
    return { success: false, error: error instanceof Error ? error.message : 'Erreur inconnue Fsvid' };
  }
}

/**
 * Extraire l'URL M3U8 depuis Vidmoly via le serveur Python
 * @param vidmolyUrl URL Vidmoly
 * @param _MAIN_API API principale (non utilisée pour Vidmoly - utilise le serveur Python)
 * @returns Promise<M3u8Result | null>
 */
export async function extractVidmolyM3u8(
  vidmolyUrl: string,
  _MAIN_API: string
): Promise<M3u8Result | null> {
  if (!isVidmolyExtractionEnabled()) {
    return { success: false, error: 'Extractions Vidmoly désactivées' };
  }

  if (!vidmolyUrl) return null;

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('vidmoly', vidmolyUrl, () => extractVidmolyM3u8Server(vidmolyUrl));
  }

  return extractVidmolyM3u8Server(vidmolyUrl);
}

async function extractVidmolyM3u8Server(vidmolyUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return { success: false, error: 'Accès Vidmoly réservé aux utilisateurs VIP ou connectés' };
  }

  if (failedUrlsCache.has(vidmolyUrl)) {
    return { success: false, error: 'URL Vidmoly précédemment échouée', fromCache: true };
  }

  try {
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-vidmoly?url=${vidmolyUrl}`, { headers: getVipHeaders() });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.sourceUrl) {
      return {
        m3u8Url: data.sourceUrl,
        success: true
      };
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(vidmolyUrl);
    return {
      success: false,
      error: 'Aucune URL M3U8 trouvée dans la réponse API'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction Vidmoly:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(vidmolyUrl);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue Vidmoly'
    };
  }
}

/**
 * Extraire l'URL M3U8 depuis Sibnet via le serveur Python
 * @param sibnetUrl URL Sibnet
 * @param _MAIN_API API principale (non utilisée pour Sibnet - utilise le serveur Python)
 * @returns Promise<M3u8Result | null>
 */
export async function extractSibnetM3u8(
  sibnetUrl: string,
  _MAIN_API: string
): Promise<M3u8Result | null> {
  if (!isSibnetExtractionEnabled()) {
    return { success: false, error: 'Extractions Sibnet désactivées' };
  }

  if (!sibnetUrl) return null;

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('sibnet', sibnetUrl, () => extractSibnetM3u8Server(sibnetUrl));
  }

  return extractSibnetM3u8Server(sibnetUrl);
}

async function extractSibnetM3u8Server(sibnetUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return { success: false, error: 'Accès Sibnet réservé aux utilisateurs VIP ou connectés' };
  }

  if (failedUrlsCache.has(sibnetUrl)) {
    return { success: false, error: 'URL Sibnet précédemment échouée', fromCache: true };
  }

  try {
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-sibnet?url=${encodeURIComponent(sibnetUrl)}`, { headers: getVipHeaders() });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.sourceUrl) {
      return {
        m3u8Url: data.sourceUrl,
        success: true
      };
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(sibnetUrl);
    return {
      success: false,
      error: 'Aucune URL M3U8 trouvée dans la réponse API'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction Sibnet:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(sibnetUrl);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue Sibnet'
    };
  }
}


export async function extractOneUploadSources(
  oneuploadUrl: string
): Promise<M3u8Result | null> {
  // Vérifier si les extractions OneUpload sont activées
  if (!ONEUPLOAD_EXTRACTIONS_ENABLED) {
    return {
      success: false,
      error: 'Extractions OneUpload désactivées'
    };
  }

  if (!oneuploadUrl) return null;

  // Vérifier si cette URL a déjà échoué
  if (failedUrlsCache.has(oneuploadUrl)) {
    return {
      success: false,
      error: 'URL OneUpload précédemment échouée - pas de nouvelle tentative',
      fromCache: true
    };
  }

  try {
    // Utiliser le proxy CORS spécifié
    const corsProxyUrl = buildProxyUrl(oneuploadUrl);

    // Créer un AbortController pour le timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 2000); // 2 secondes

    const response = await fetch(corsProxyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://oneupload.net/'
      },
      signal: abortController.signal
    });

    // Nettoyer le timeout si la requête réussit
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const htmlContent = await response.text();

    // Extraire les sources depuis le HTML OneUpload
    // Rechercher les patterns typiques de OneUpload pour les sources vidéo
    const patterns = [
      /file:\s*["']([^"']+\.m3u8[^"']*)/i,
      /source:\s*["']([^"']+\.m3u8[^"']*)/i,
      /src:\s*["']([^"']+\.m3u8[^"']*)/i,
      /"file":\s*"([^"]+\.m3u8[^"]*)"/i,
      /"source":\s*"([^"]+\.m3u8[^"]*)"/i
    ];

    for (const pattern of patterns) {
      const match = htmlContent.match(pattern);
      if (match && match[1]) {
        const m3u8Url = match[1];
        console.log('OneUpload M3U8 trouvé:', m3u8Url);
        return {
          hlsUrl: m3u8Url,
          success: true
        };
      }
    }

    // Si aucun M3U8 trouvé, chercher des sources MP4
    const mp4Patterns = [
      /file:\s*["']([^"']+\.mp4[^"']*)/i,
      /source:\s*["']([^"']+\.mp4[^"']*)/i,
      /src:\s*["']([^"']+\.mp4[^"']*)/i,
      /"file":\s*"([^"]+\.mp4[^"]*)"/i,
      /"source":\s*"([^"]+\.mp4[^"]*)"/i
    ];

    for (const pattern of mp4Patterns) {
      const match = htmlContent.match(pattern);
      if (match && match[1]) {
        const mp4Url = match[1];
        console.log('OneUpload MP4 trouvé:', mp4Url);
        return {
          m3u8Url: mp4Url, // Utiliser m3u8Url pour les fichiers MP4 aussi
          success: true
        };
      }
    }

    // Ajouter au cache des échecs
    failedUrlsCache.add(oneuploadUrl);
    return {
      success: false,
      error: 'Aucune source vidéo trouvée dans le HTML OneUpload'
    };

  } catch (error) {
    console.error('Erreur lors de l\'extraction OneUpload:', error);
    // Ajouter au cache des échecs
    failedUrlsCache.add(oneuploadUrl);

    // Gestion spécifique du timeout
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        error: 'Timeout: La requête OneUpload a pris plus de 2 secondes'
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erreur inconnue OneUpload'
    };
  }
}

/**
 * Détecte automatiquement les types d'embeds supportés dans une liste d'URLs ou de PlayerInfo
 * @param sources Liste des sources à analyser (URLs ou PlayerInfo)
 * @param context Optionnel. Si fourni, trie les résultats selon la priorité utilisateur
 *                pour cette catégorie et (optionnellement) ce top-level (source ou langue).
 *                Sans contexte : ordre legacy par `priority` hardcodé (rétrocompat).
 * @returns Liste des embeds détectés avec leur priorité
 */
export function detectSupportedEmbeds(
  sources: (string | PlayerInfo)[],
  context?: { category: PriorityCategory; topLevel?: TopLevelSourceId | LanguageId },
): EmbedDetectionResult[] {
  const detectedEmbeds: EmbedDetectionResult[] = [];

  sources.forEach(source => {
    const url = typeof source === 'string' ? source : source.link;
    const playerType = typeof source === 'string' ? '' : (source.player || '');

    if (!url) return;

    const urlLower = url.toLowerCase();
    const playerLower = playerType.toLowerCase();

    // Détection Supervideo
    if ((urlLower.includes('supervideo') || playerLower.includes('supervideo')) && SUPERVIDEO_EXTRACTIONS_ENABLED) {
      detectedEmbeds.push({
        type: 'supervideo',
        url,
        enabled: SUPERVIDEO_EXTRACTIONS_ENABLED,
        priority: 2
      });
    }

    // Détection Dropload
    if ((urlLower.includes('dropload') || playerLower.includes('dropload')) && DROPLOAD_EXTRACTIONS_ENABLED) {
      detectedEmbeds.push({
        type: 'dropload',
        url,
        enabled: DROPLOAD_EXTRACTIONS_ENABLED,
        priority: 2
      });
    }

    // Détection VOE et UQLOAD (VIP requis sauf si extension Nexus installée)
    const isVip = isUserVip();
    const hasExtension = hasNexusExtractors();
    const canAccess = isVip || hasExtension;
    
    if (urlLower.includes('voe.sx') && isVoeExtractionEnabled() && canAccess) {
      detectedEmbeds.push({
        type: 'voe',
        url,
        enabled: isVoeExtractionEnabled(),
        priority: 1
      });
    }

    if (urlLower.includes('uqload') && isUqloadExtractionEnabled() && canAccess) {
      detectedEmbeds.push({
        type: 'uqload',
        url,
        enabled: isUqloadExtractionEnabled(),
        priority: 1
      });
    }

    // Détection Darkibox
    if (urlLower.includes('darkibox') && DARKIBOX_EXTRACTIONS_ENABLED) {
      detectedEmbeds.push({
        type: 'darkibox',
        url,
        enabled: DARKIBOX_EXTRACTIONS_ENABLED,
        priority: 4
      });
    }

    // Détection Vidzy (VIP ou extension)
    if (urlLower.includes('vidzy') && isVidzyExtractionEnabled() && canAccess) {
      detectedEmbeds.push({
        type: 'vidzy',
        url,
        enabled: isVidzyExtractionEnabled(),
        priority: 1
      });
    }

    // Détection Fsvid (VIP requis)
    if (urlLower.includes('fsvid') && isFsvidExtractionEnabled() && isVip) {
      detectedEmbeds.push({
        type: 'fsvid',
        url,
        enabled: isFsvidExtractionEnabled(),
        priority: 1
      });
    }

    // Détection Sibnet (VIP ou extension)
    if (urlLower.includes('sibnet.ru') && isSibnetExtractionEnabled() && canAccess) {
      detectedEmbeds.push({
        type: 'sibnet',
        url,
        enabled: isSibnetExtractionEnabled(),
        priority: 1
      });
    }

    // Détection DoodStream (VIP ou extension)
    if (isDoodStreamEmbed(url) && isDoodStreamExtractionEnabled() && canAccess) {
      detectedEmbeds.push({
        type: 'doodstream',
        url,
        enabled: isDoodStreamExtractionEnabled(),
        priority: 2
      });
    }

    // Détection SeekStreaming / embed4me / embedseek (VIP ou extension)
    if (isSeekStreamingEmbed(url) && isSeekStreamingExtractionEnabled() && canAccess) {
      detectedEmbeds.push({
        type: 'seekstreaming',
        url,
        enabled: isSeekStreamingExtractionEnabled(),
        priority: 1
      });
    }

    // Détection des hosters custom définis par l'utilisateur (M9 Task 9.3.3).
    // Les custom hosters sont joués en iframe (pas d'extraction m3u8), mais
    // on les déclare ici pour qu'ils soient pris en compte par le tri
    // `sortHostersByPriority`. Priorité 99 par défaut = bas de la liste
    // natif ; l'utilisateur peut remonter via drag-and-drop dans Settings.
    // Un try/catch par pattern protège contre les regex invalides
    // historiques (un ajout via l'éditeur valide déjà la regex live, mais
    // des données migrées pourraient contenir un pattern corrompu).
    try {
      const sp = getSourcePriorityPrefs();
      for (const custom of sp.customHosters) {
        for (const p of custom.patterns) {
          try {
            const re = new RegExp(p, 'i');
            if (re.test(urlLower)) {
              detectedEmbeds.push({
                type: custom.id, // `custom_<slug>`
                url,
                enabled: true,
                priority: 99,
              });
              break; // Un seul match suffit par custom hoster × source
            }
          } catch { /* regex invalide : on ignore ce pattern */ }
        }
      }
    } catch { /* getSourcePriorityPrefs ne lève pas normalement — safety net */ }
  });

  const enabled = detectedEmbeds.filter(embed => embed.enabled);

  // Si un contexte est fourni, trier selon les prefs utilisateur (hosterOrder ou
  // override par top-level). Sinon, ancien tri par priorité hardcodée (rétrocompat).
  if (context) {
    return sortHostersByPriority(enabled, context);
  }
  return enabled.sort((a, b) => a.priority - b.priority);
}

/**
 * Lance l'extraction en parallèle dès la détection des embeds
 * @param sources Sources à analyser
 * @param MAIN_API URL de l'API principale
 * @param onProgress Callback appelé pour chaque progression
 * @returns Promise qui se résout quand toutes les extractions sont terminées
 */
export async function extractM3u8OnDetection(
  sources: (string | PlayerInfo)[],
  MAIN_API: string,
  onProgress?: ExtractionCallback,
  context?: { category: PriorityCategory; topLevel?: TopLevelSourceId | LanguageId },
): Promise<ExtractionProgress[]> {

  const extensionReady = hasNexusExtractors() || await waitForNexusExtractors();

  // If extension with Nexus extractors is available, use its bulk extraction for better performance
  if (extensionReady && window.movixExtractAllM3u8) {
    console.log('🔌 Using Movix Extension Nexus extractors for parallel extraction');
    try {
      const extensionResult = await window.movixExtractAllM3u8(sources);
      if (extensionResult && extensionResult.results) {
        return extensionResult.results.map((r: any) => ({
          type: r.type || 'unknown',
          url: r.url || '',
          status: r.success ? 'success' as const : 'error' as const,
          result: r.success ? { hlsUrl: r.hlsUrl, m3u8Url: r.m3u8Url, success: true } : undefined,
          error: r.error,
          timestamp: Date.now(),
        }));
      }
    } catch (e) {
      console.warn('⚠️ Extension bulk extraction failed, falling back to individual extraction:', e);
    }
  }

  // Étape 1: Détection des embeds (avec tri selon prefs utilisateur si contexte fourni)
  const detectedEmbeds = detectSupportedEmbeds(sources, context);

  if (detectedEmbeds.length === 0) {
    console.log('ℹ️ Aucun embed supporté détecté');
    return [];
  }

  console.log(`🚀 Lancement de ${detectedEmbeds.length} extractions en parallèle:`, detectedEmbeds.map(e => e.type));

  // Étape 2: Créer toutes les promesses d'extraction IMMÉDIATEMENT (sans attendre)
  const extractionPromises = detectedEmbeds.map((embed, index) => {
    const startTime = Date.now();

    return (async () => {
      const progress: ExtractionProgress = {
        type: embed.type,
        url: embed.url,
        status: 'pending',
        timestamp: startTime
      };

      // Notifier le début immédiatement
      onProgress?.(progress);

      // Vérifier le cache des échecs
      if (failedUrlsCache.has(embed.url)) {
        progress.status = 'error';
        progress.error = 'URL précédemment échouée - pas de nouvelle tentative';
        progress.result = {
          success: false,
          error: progress.error,
          fromCache: true
        };
        progress.timestamp = Date.now();
        onProgress?.(progress);
        return progress;
      }

      // Marquer comme en cours d'extraction
      progress.status = 'extracting';
      progress.timestamp = Date.now();
      onProgress?.(progress);

      console.log(`🔄 [${index + 1}/${detectedEmbeds.length}] Début extraction ${embed.type}...`);

      try {
        let result: M3u8Result | null = null;

        // Appeler la fonction d'extraction appropriée DIRECTEMENT
        switch (embed.type) {
          case 'supervideo':
          case 'dropload':
            const playerInfo: PlayerInfo = typeof sources.find(s =>
              (typeof s === 'string' ? s : s.link) === embed.url
            ) === 'object' ? sources.find(s =>
              (typeof s === 'string' ? s : s.link) === embed.url
            ) as PlayerInfo : { player: embed.type, link: embed.url };
            result = await extractM3u8FromEmbed(playerInfo, MAIN_API);
            break;

          case 'voe':
            result = await extractVoeM3u8(embed.url);
            break;

          case 'uqload':
            result = await extractUqloadFile(embed.url, MAIN_API);
            break;

          case 'darkibox':
            result = await extractDarkiboxSources(embed.url, MAIN_API);
            break;

          case 'vidzy':
            result = await extractVidzyM3u8(embed.url, MAIN_API);
            break;

          case 'fsvid':
            result = await extractFsvidM3u8(embed.url, MAIN_API);
            break;

          case 'sibnet':
            result = await extractSibnetM3u8(embed.url, MAIN_API);
            break;

          case 'doodstream':
            result = await extractDoodStreamFile(embed.url);
            break;

          case 'seekstreaming':
            result = await extractSeekStreamingM3u8(embed.url);
            break;

          default:
            throw new Error(`Type d'embed non supporté: ${embed.type}`);
        }

        // Mettre à jour le progrès avec le résultat
        const duration = Date.now() - startTime;
        if (result?.success) {
          progress.status = 'success';
          progress.result = result;
          console.log(`✅ [${index + 1}/${detectedEmbeds.length}] ${embed.type} réussi en ${duration}ms:`, result.hlsUrl || result.m3u8Url);
        } else {
          progress.status = 'error';
          progress.error = result?.error || 'Extraction échouée';
          progress.result = result || { success: false, error: progress.error };
          console.log(`❌ [${index + 1}/${detectedEmbeds.length}] ${embed.type} échoué en ${duration}ms:`, progress.error);
        }

      } catch (error) {
        const duration = Date.now() - startTime;
        progress.status = 'error';
        progress.error = error instanceof Error ? error.message : 'Erreur inconnue';
        progress.result = {
          success: false,
          error: progress.error
        };
        console.error(`💥 [${index + 1}/${detectedEmbeds.length}] ${embed.type} erreur en ${duration}ms:`, error);
      }

      progress.timestamp = Date.now();
      onProgress?.(progress);
      return progress;
    })();
  });

  // Étape 3: Attendre TOUTES les extractions en parallèle (Promise.allSettled garantit le parallélisme)
  console.log(`⏳ Attente de ${extractionPromises.length} extractions en parallèle...`);
  const results = await Promise.allSettled(extractionPromises);

  // Étape 4: Traiter les résultats
  const finalResults = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error(`💀 Promise ${index + 1} rejetée:`, result.reason);
      return {
        type: detectedEmbeds[index]?.type || 'unknown',
        url: detectedEmbeds[index]?.url || 'unknown',
        status: 'error' as const,
        error: 'Promise rejected: ' + (result.reason?.message || result.reason),
        timestamp: Date.now()
      };
    }
  });

  const successCount = finalResults.filter(r => r.status === 'success').length;
  const errorCount = finalResults.filter(r => r.status === 'error').length;

  console.log(`🎯 Extraction parallèle terminée: ${successCount} succès, ${errorCount} échecs sur ${finalResults.length} tentatives`);

  return finalResults;
}

/**
 * Version simplifiée qui retourne seulement les URLs M3U8 extraites avec succès
 * @param sources Sources à analyser
 * @param MAIN_API URL de l'API principale
 * @returns Promise<string[]> Liste des URLs M3U8 extraites
 */
export async function extractM3u8UrlsOnDetection(
  sources: (string | PlayerInfo)[],
  MAIN_API: string
): Promise<string[]> {
  const results = await extractM3u8OnDetection(sources, MAIN_API);

  return results
    .filter(result => result.status === 'success' && result.result?.success)
    .map(result => result.result!.hlsUrl || result.result!.m3u8Url)
    .filter(url => url) as string[];
}

/**
 * Détecter si une URL est un embed Fsvid
 * @param url URL à vérifier
 * @returns boolean
 */
export function isFsvidEmbed(url: string): boolean {
  return detectHosterFromPrefs(url) === 'fsvid';
}

/**
 * Détecter si une URL est un embed Sibnet
 * @param url URL à vérifier
 * @returns boolean
 */
export function isSibnetEmbed(url: string): boolean {
  return detectHosterFromPrefs(url) === 'sibnet';
}

/**
 * Détecter si une URL est un embed DoodStream
 * @param url URL à vérifier
 * @returns boolean
 */
export function isDoodStreamEmbed(url: string): boolean {
  return detectHosterFromPrefs(url) === 'doodstream';
}

/**
 * Détecter si une URL est un embed SeekStreaming (embed4me / embedseek)
 * Note : ancien comportement matchait aussi toute URL contenant `/#`. On conserve
 * ce fallback pour rétrocompat (sinon certains embeds custom lazy-hash casseraient).
 * @param url URL à vérifier
 * @returns boolean
 */
export function isSeekStreamingEmbed(url: string): boolean {
  return detectHosterFromPrefs(url) === 'seekstreaming' || url.includes('/#');
}

/**
 * Extraire l'URL vidéo depuis DoodStream via le serveur Python
 * @param doodUrl URL DoodStream (d0000d.com, myvidplay.com, etc.)
 * @returns Promise<M3u8Result | null>
 */
export async function extractDoodStreamFile(
  doodUrl: string
): Promise<M3u8Result | null> {
  if (!isDoodStreamExtractionEnabled()) {
    return { success: false, error: 'Extractions DoodStream désactivées' };
  }

  if (!doodUrl) return null;

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('doodstream', doodUrl, () => extractDoodStreamFileServer(doodUrl));
  }

  return extractDoodStreamFileServer(doodUrl);
}

async function extractDoodStreamFileServer(doodUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return { success: false, error: 'Accès DoodStream réservé aux utilisateurs VIP ou connectés' };
  }

  if (failedUrlsCache.has(doodUrl)) {
    return { success: false, error: 'URL DoodStream précédemment échouée', fromCache: true };
  }

  try {
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-doodstream?url=${encodeURIComponent(doodUrl)}`, { headers: getVipHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.url) {
      return { m3u8Url: data.url, success: true };
    }

    failedUrlsCache.add(doodUrl);
    return { success: false, error: 'Aucune URL trouvée dans la réponse DoodStream' };
  } catch (error) {
    console.error('Erreur lors de l\'extraction DoodStream:', error);
    failedUrlsCache.add(doodUrl);
    return { success: false, error: error instanceof Error ? error.message : 'Erreur inconnue DoodStream' };
  }
}

/**
 * Extraire l'URL HLS depuis SeekStreaming (embed4me / embedseek) via le serveur Python
 * @param seekUrl URL SeekStreaming
 * @returns Promise<M3u8Result | null>
 */
export async function extractSeekStreamingM3u8(
  seekUrl: string
): Promise<M3u8Result | null> {
  if (!isSeekStreamingExtractionEnabled()) {
    return { success: false, error: 'Extractions SeekStreaming désactivées' };
  }

  if (!seekUrl) return null;

  // Try extension first (no VIP needed)
  if (hasNexusExtractors()) {
    return tryExtensionFirst('seekstreaming', seekUrl, () => extractSeekStreamingM3u8Server(seekUrl));
  }

  return extractSeekStreamingM3u8Server(seekUrl);
}

async function extractSeekStreamingM3u8Server(seekUrl: string): Promise<M3u8Result | null> {
  const isVip = isUserVip();
  if (!isVip) {
    return { success: false, error: 'Accès SeekStreaming réservé aux utilisateurs VIP ou connectés' };
  }

  if (failedUrlsCache.has(seekUrl)) {
    return { success: false, error: 'URL SeekStreaming précédemment échouée', fromCache: true };
  }

  try {
    const encodedUrl = seekUrl.replace(/#/g, '%23');
    const response = await fetch(`${PROXIES_EMBED_API}/api/extract-seekstreaming?url=${encodeURIComponent(encodedUrl)}`, { headers: getVipHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Préférer l'URL CF (CDN), sinon utiliser l'URL IP
    const videoUrl = data.url || data.ip_url;
    if (videoUrl) {
      return { hlsUrl: videoUrl, success: true };
    }

    failedUrlsCache.add(seekUrl);
    return { success: false, error: 'Aucune source trouvée dans la réponse SeekStreaming' };
  } catch (error) {
    console.error('Erreur lors de l\'extraction SeekStreaming:', error);
    failedUrlsCache.add(seekUrl);
    return { success: false, error: error instanceof Error ? error.message : 'Erreur inconnue SeekStreaming' };
  }
}

/**
 * Version ultra-rapide qui retourne les résultats dès qu'ils arrivent
 * Utilise un callback pour chaque résultat disponible immédiatement
 * @param sources Sources à analyser
 * @param MAIN_API URL de l'API principale
 * @param onResult Callback appelé dès qu'un résultat est disponible
 * @returns Promise<void> Se résout quand toutes les extractions sont lancées
 */
export async function extractM3u8RealTime(
  sources: (string | PlayerInfo)[],
  MAIN_API: string,
  onResult: (result: { type: string; url: string; m3u8Url?: string; success: boolean; error?: string; duration: number }) => void
): Promise<void> {

  const detectedEmbeds = detectSupportedEmbeds(sources);

  if (detectedEmbeds.length === 0) {
    console.log('ℹ️ Aucun embed supporté détecté');
    return;
  }

  console.log(`⚡ Lancement IMMÉDIAT de ${detectedEmbeds.length} extractions en temps réel`);

  // Lancer toutes les extractions IMMÉDIATEMENT sans attendre
  detectedEmbeds.forEach((embed, index) => {
    const startTime = Date.now();

    // Chaque extraction s'exécute de façon complètement indépendante
    (async () => {
      try {
        // Vérifier le cache des échecs
        if (failedUrlsCache.has(embed.url)) {
          onResult({
            type: embed.type,
            url: embed.url,
            success: false,
            error: 'URL précédemment échouée - pas de nouvelle tentative',
            duration: Date.now() - startTime
          });
          return;
        }

        console.log(`🚀 [${index + 1}/${detectedEmbeds.length}] Extraction ${embed.type} démarrée...`);

        let result: M3u8Result | null = null;

        // Appeler la fonction d'extraction appropriée
        switch (embed.type) {
          case 'supervideo':
          case 'dropload':
            const playerInfo: PlayerInfo = typeof sources.find(s =>
              (typeof s === 'string' ? s : s.link) === embed.url
            ) === 'object' ? sources.find(s =>
              (typeof s === 'string' ? s : s.link) === embed.url
            ) as PlayerInfo : { player: embed.type, link: embed.url };
            result = await extractM3u8FromEmbed(playerInfo, MAIN_API);
            break;

          case 'voe':
            result = await extractVoeM3u8(embed.url);
            break;

          case 'uqload':
            result = await extractUqloadFile(embed.url, MAIN_API);
            break;

          case 'darkibox':
            result = await extractDarkiboxSources(embed.url, MAIN_API);
            break;

          case 'vidzy':
            result = await extractVidzyM3u8(embed.url, MAIN_API);
            break;

          case 'fsvid':
            result = await extractFsvidM3u8(embed.url, MAIN_API);
            break;

          case 'sibnet':
            result = await extractSibnetM3u8(embed.url, MAIN_API);
            break;

          case 'doodstream':
            result = await extractDoodStreamFile(embed.url);
            break;

          case 'seekstreaming':
            result = await extractSeekStreamingM3u8(embed.url);
            break;

          default:
            throw new Error(`Type d'embed non supporté: ${embed.type}`);
        }

        const duration = Date.now() - startTime;

        if (result?.success) {
          console.log(`⚡ [${index + 1}/${detectedEmbeds.length}] ${embed.type} RÉUSSI en ${duration}ms`);
          onResult({
            type: embed.type,
            url: embed.url,
            m3u8Url: result.hlsUrl || result.m3u8Url,
            success: true,
            duration
          });
        } else {
          console.log(`💨 [${index + 1}/${detectedEmbeds.length}] ${embed.type} échoué en ${duration}ms`);
          onResult({
            type: embed.type,
            url: embed.url,
            success: false,
            error: result?.error || 'Extraction échouée',
            duration
          });
        }

      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`💥 [${index + 1}/${detectedEmbeds.length}] ${embed.type} erreur en ${duration}ms:`, error);
        onResult({
          type: embed.type,
          url: embed.url,
          success: false,
          error: error instanceof Error ? error.message : 'Erreur inconnue',
          duration
        });
      }
    })().catch(error => {
      // Gestion d'erreur de dernier recours
      console.error(`🔥 Erreur critique pour ${embed.type}:`, error);
      onResult({
        type: embed.type,
        url: embed.url,
        success: false,
        error: 'Erreur critique: ' + (error?.message || error),
        duration: Date.now() - startTime
      });
    });
  });

  console.log(`🎯 ${detectedEmbeds.length} extractions lancées en mode temps réel`);
}
