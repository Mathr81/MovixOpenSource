// Détecte si une erreur de lecture HLS ressemble à un blocage DNS au niveau
// FAI (typiquement un FAI français qui bloque un domaine par décision ARCOM).
// Retourne true uniquement si on est confiant que c'est DNS et pas un autre
// type de panne réseau (offline, host isolé mort, etc.).

export interface HlsErrorLike {
  type?: string;
  details?: string;
  fatal?: boolean;
  response?: { code?: number; text?: string } | null;
  networkDetails?: { status?: number } | null;
  reason?: string;
  error?: Error | null;
}

// Regex resserrée : on ne garde que les marqueurs réellement spécifiques à
// une résolution DNS qui échoue. Les anciennes entrées (`Failed to fetch`,
// `NetworkError`, `ERR_CONNECTION_REFUSED`, `ERR_INTERNET_DISCONNECTED`,
// `ERR_ADDRESS_UNREACHABLE`) matchaient aussi pour : CORS, source morte,
// timeout, proxy down, port fermé — résultat : la popup "FAI bloque" sortait
// dès qu'une source vidéo tombait. On veut ne signaler le FAI qu'avec un
// signal vraiment DNS.
const DNS_LIKE_MESSAGE_RE =
  /ERR_NAME_NOT_RESOLVED|DNS_PROBE_FINISHED_NXDOMAIN|getaddrinfo ENOTFOUND/i;

const MANIFEST_OR_LEVEL_DETAILS = new Set([
  'manifestLoadError',
  'manifestLoadTimeOut',
  'levelLoadError',
  'levelLoadTimeOut',
]);

export function isDnsLikeError(
  data: HlsErrorLike | null | undefined,
  videoError?: MediaError | null | undefined
): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  if (data) {
    const isManifestOrLevelError =
      data.type === 'networkError' &&
      typeof data.details === 'string' &&
      MANIFEST_OR_LEVEL_DETAILS.has(data.details);

    if (isManifestOrLevelError) {
      const reason = data.reason ?? data.error?.message ?? '';
      // Avant : retournait true dès que responseCode/networkStatus étaient 0
      // ou undefined — i.e. pour TOUTE erreur réseau sans réponse HTTP. C'était
      // la cause principale des faux positifs (CORS, source morte, timeout
      // étaient tous classés "FAI bloque"). On exige maintenant un marqueur
      // DNS explicite dans le message d'erreur. Le faux-positif résiduel est
      // attrapé par la gate de reachability dans `notifyDnsBlocked`.
      if (DNS_LIKE_MESSAGE_RE.test(reason)) {
        return true;
      }
    }
  }

  if (videoError) {
    const code = videoError.code;
    const msg = videoError.message ?? '';
    if ((code === 4 || code === 2) && DNS_LIKE_MESSAGE_RE.test(msg)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Reachability probe — gate de confirmation pour la popup
// ============================================================================

const ORIGIN_PROBE_PATH = '/movix.png';
const ORIGIN_PROBE_TIMEOUT_MS = 4000;
// Cache du résultat : pendant un burst d'erreurs vidéo, on ne refait pas un
// probe pour chaque erreur. 30s = window assez longue pour absorber une
// rafale, assez courte pour redétecter rapidement un blocage qui démarre.
const PROBE_CACHE_MS = 30_000;

let probeInFlight: Promise<boolean> | null = null;
let lastProbeAt = 0;
let lastProbeResult: boolean | null = null;

async function probeOrigin(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORIGIN_PROBE_TIMEOUT_MS);
    const url = new URL(
      `${ORIGIN_PROBE_PATH}?_dnsprobe=${Date.now()}`,
      window.location.origin
    ).href;
    const res = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
      credentials: 'omit',
    });
    clearTimeout(timer);
    // 2xx/3xx/4xx = origine joignable (même un 404 confirme le serveur). Seul
    // un échec réseau ou un 5xx massif compte comme injoignable.
    return res.status < 500;
  } catch {
    return false;
  }
}

async function checkOriginReachable(): Promise<boolean> {
  const now = Date.now();
  if (lastProbeResult !== null && now - lastProbeAt < PROBE_CACHE_MS) {
    return lastProbeResult;
  }
  if (probeInFlight) return probeInFlight;
  probeInFlight = probeOrigin();
  try {
    const result = await probeInFlight;
    lastProbeResult = result;
    lastProbeAt = Date.now();
    return result;
  } finally {
    probeInFlight = null;
  }
}

// Déclencheur global. Idempotent : dispatch plusieurs fois est safe, le
// banner gère lui-même le "1 fois par chargement".
// `switched` indique si on a réussi à basculer automatiquement sur un embed
// — le banner s'en sert pour afficher le message "on a changé de lecteur
// pour toi automatiquement" uniquement quand c'est vrai.
//
// Gate : on ne dispatch QUE si l'origine Movix est elle-même injoignable. Si
// on arrive à charger /movix.png, l'erreur vidéo vient du host vidéo tiers
// (source morte, CORS, proxy down…) et pas d'un blocage FAI sur Movix —
// montrer "ton FAI bloque ce lecteur" serait un faux positif.
export function notifyDnsBlocked(
  detail: { host?: string; details?: string; switched?: boolean }
): void {
  if (typeof window === 'undefined') return;
  void (async () => {
    const reachable = await checkOriginReachable();
    if (reachable) return;
    window.dispatchEvent(new CustomEvent('movix:dns-blocked', { detail }));
  })();
}
