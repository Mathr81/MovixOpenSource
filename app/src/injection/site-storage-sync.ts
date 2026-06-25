/**
 * Persistance de session inter-domaines.
 *
 * Le domaine actif de Movix change régulièrement (mirroring anti-blocage —
 * voir AddressContext/addressResolver) : movix.tax aujourd'hui, movix.chat
 * demain. `localStorage` est scopé par origine, donc chaque changement de
 * domaine déconnecte l'utilisateur (le site stocke vraisemblablement son
 * bearer token + profil actif en localStorage).
 *
 * On contourne ça en copiant l'intégralité du localStorage du domaine actif
 * (capture périodique + sur perte de visibilité) vers AsyncStorage côté
 * natif, puis en la réinjectant dans le localStorage du nouveau domaine
 * avant que ses propres scripts ne s'exécutent — uniquement si ce nouveau
 * domaine n'a pas déjà sa propre session (localStorage vide), pour ne
 * jamais écraser un état distinct créé volontairement par l'utilisateur.
 */

export function buildStorageCaptureScript(): string {
  return `
(function() {
  'use strict';
  if (window.__MOVIX_STORAGE_SYNC_READY) return;
  window.__MOVIX_STORAGE_SYNC_READY = true;

  function postNative(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  function snapshotLocalStorage() {
    try {
      var data = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k == null) continue;
        data[k] = localStorage.getItem(k);
      }
      return data;
    } catch (e) { return null; }
  }

  var lastSent = null;
  function captureAndSend() {
    var data = snapshotLocalStorage();
    if (!data) return;
    var keys = Object.keys(data);
    if (!keys.length) return;
    var json = JSON.stringify(data);
    if (json === lastSent) return;
    lastSent = json;
    postNative({ type: 'SITE_STORAGE_SNAPSHOT', data: data });
  }

  // Pas d'évènement standard pour "le site a écrit dans localStorage" :
  // capture périodique + aux moments clés du cycle de vie de la page.
  setInterval(captureAndSend, 8000);
  setTimeout(captureAndSend, 2000);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) captureAndSend();
  });
  window.addEventListener('pagehide', captureAndSend);
})();
true;
`;
}

export function buildStorageRestoreScript(
  snapshot: Record<string, string> | null | undefined,
): string {
  if (!snapshot || !Object.keys(snapshot).length) {
    return '// Aucun instantané de session à restaurer';
  }
  const json = JSON.stringify(snapshot);
  return `
(function() {
  'use strict';
  try {
    if (window.localStorage && window.localStorage.length === 0) {
      var snapshot = ${json};
      for (var k in snapshot) {
        if (Object.prototype.hasOwnProperty.call(snapshot, k)) {
          window.localStorage.setItem(k, snapshot[k]);
        }
      }
    }
  } catch (e) {}
})();
true;
`;
}
