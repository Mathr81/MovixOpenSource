import type { AxiosInstance } from 'axios';

/**
 * Détecte en arrière-plan si le domaine principal est bloqué (FAI ban,
 * erreurs réseau répétées) et déclenche un redirect vers un miroir alive
 * via le Service Worker.
 *
 * Compte les échecs réseau consécutifs sur les appels axios. À partir de
 * THRESHOLD échecs, envoie un postMessage au SW qui répond avec l'URL
 * du miroir cible. Le SW est l'autorité sur la liste des miroirs.
 *
 * Le compteur est réinitialisé sur toute réponse HTTP réussie ou après
 * RESET_MS sans nouvelle erreur.
 */

const THRESHOLD = 5;
const RESET_MS = 30_000;
// Fenêtre de grâce après un retour de visibilité ou un event 'online'.
// Quand le téléphone sort de veille, le SPA refire en cascade plusieurs
// requêtes (auth, profil, sync, recommendations). Si la radio cellulaire
// n'est pas encore prête, elles fail toutes en burst < 1s — sans cette
// grâce, ça franchit le THRESHOLD et trigger une fausse redirection.
const RESUME_GRACE_MS = 8_000;
// Étalement minimum entre la première et la dernière erreur avant de
// considérer le compte comme un signal d'outage. Sinon : 5 erreurs en
// 200ms, c'est un seul blip réseau amplifié par les retry/parallel-fetch
// d'axios, pas 5 events séparés. Un VRAI blocage FAI persiste sur la
// durée — il franchira facilement cet étalement.
const MIN_ERROR_SPAN_MS = 2_000;

let consecutiveNetworkErrors = 0;
let firstErrorAt = 0;
let lastErrorAt = 0;
let graceUntil = 0;
let redirecting = false;
let messageListenerRegistered = false;
let resumeListenersRegistered = false;

// Dev/LAN guard : on n'enregistre pas l'interceptor sur localhost ou IP privée.
// Sinon un backend absent en dev balance le dev vers le miroir prod après 3
// network errors (bootstrap fait plusieurs axios calls qui fail en cascade).
function isLocalHost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.endsWith('.localhost')) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function isNetworkError(error: any): boolean {
  // Vraie erreur réseau : pas de response HTTP, pas un timeout axios explicite
  return Boolean(error) && !error.response && error.code !== 'ECONNABORTED';
}

function triggerRedirect(error: unknown) {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return;
  const e = error as Record<string, unknown> | null | undefined;
  const errMessage = (e?.message as string) || (e?.code as string) || 'Network error';
  sw.postMessage({
    type: 'MOVIX_FORCE_REDIRECT',
    error: String(errMessage).slice(0, 100),
  });
}

function ensureMessageListener() {
  if (messageListenerRegistered) return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data;
    if (
      data &&
      data.type === 'MOVIX_REDIRECT_TO' &&
      typeof data.url === 'string' &&
      /^https:\/\//i.test(data.url) &&
      !redirecting
    ) {
      redirecting = true;
      window.location.replace(data.url);
    }
  });
  messageListenerRegistered = true;
}

function resetOnResume() {
  consecutiveNetworkErrors = 0;
  firstErrorAt = 0;
  graceUntil = Date.now() + RESUME_GRACE_MS;
}

function ensureResumeListeners() {
  if (resumeListenersRegistered) return;
  if (typeof window === 'undefined') return;
  // Au retour de visibilité (tab restauré après backgrounding) et au retour
  // online, on reset le compteur ET on ouvre une fenêtre de grâce. Tout
  // burst d'erreurs pendant cette fenêtre est ignoré — le temps que le
  // réseau se stabilise après réveil/changement de connexion.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resetOnResume();
  });
  window.addEventListener('online', resetOnResume);
  // Premier load : grâce initiale pour absorber la cascade d'API au boot.
  graceUntil = Date.now() + RESUME_GRACE_MS;
  resumeListenersRegistered = true;
}

export function registerBlockDetection(axiosInstance: AxiosInstance): void {
  if (isLocalHost()) return;
  ensureMessageListener();
  ensureResumeListeners();
  axiosInstance.interceptors.response.use(
    (response) => {
      consecutiveNetworkErrors = 0;
      return response;
    },
    (error) => {
      if (redirecting) return Promise.reject(error);
      if (isNetworkError(error) && navigator.onLine) {
        const now = Date.now();
        // Pendant la fenêtre de grâce (boot, réveil, retour online), on
        // ignore les erreurs réseau — le SW fera de toute façon un ping
        // de confirmation s'il reçoit un trigger, mais autant ne pas
        // spammer la chaîne en amont.
        if (now < graceUntil) return Promise.reject(error);
        if (now - lastErrorAt > RESET_MS) {
          consecutiveNetworkErrors = 0;
          firstErrorAt = 0;
        }
        if (consecutiveNetworkErrors === 0) firstErrorAt = now;
        lastErrorAt = now;
        consecutiveNetworkErrors += 1;
        // Double-condition : compteur ET étalement temporel. Évite qu'un
        // burst sub-seconde de retry axios paralleles franchisse le seuil.
        if (
          consecutiveNetworkErrors >= THRESHOLD &&
          now - firstErrorAt >= MIN_ERROR_SPAN_MS
        ) {
          triggerRedirect(error);
        }
      }
      return Promise.reject(error);
    }
  );
}
