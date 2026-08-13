/**
 * Redirection des pubs / popups vers le navigateur système.
 *
 * Les portails de pub Movix (« regarde une pub pour continuer ») ouvrent
 * généralement la pub via `window.open(adUrl)`. Dans une WebView :
 *   - soit le popup est bloqué (setSupportMultipleWindows=false) → la pub ne
 *     s'ouvre pas du tout et le site redemande indéfiniment de la regarder ;
 *   - soit elle se charge dans la WebView courante (Android, multi-fenêtres
 *     désactivé) → l'utilisateur quitte le film sans moyen fiable de revenir.
 *
 * Ce shim remplace `window.open` :
 *   1. pour un hôte tiers (la pub), il poste `OPEN_EXTERNAL` au natif qui ouvre
 *      l'URL dans le navigateur système (Linking.openURL) — l'utilisateur garde
 *      son bouton retour OS et revient à l'app intacte ;
 *   2. il renvoie un FAUX objet `window` (truthy, `closed:false`) pour que la
 *      logique de gate publicitaire du site considère que la pub s'est bien
 *      ouverte et débloque la lecture (sinon « ne pense même pas que j'ai
 *      ouvert la pub »). Au retour au premier plan, les faux windows passent à
 *      `closed:true` pour satisfaire aussi les gates qui attendent la fermeture.
 *
 * Les `window.open` vers l'origine courante ou un hôte légitime (OAuth, captcha)
 * gardent le comportement natif.
 */

// Doit rester synchronisé avec AUXILIARY_ALLOWED_HOSTS de WebViewBrowser.tsx.
const AUXILIARY_ALLOWED_HOSTS = [
  'discord.com',
  'discordapp.com',
  'accounts.google.com',
  'challenges.cloudflare.com',
];

export function buildPopupRedirectScript(): string {
  const auxHostsJson = JSON.stringify(AUXILIARY_ALLOWED_HOSTS);
  return `
(function() {
  'use strict';
  if (window.__MOVIX_POPUP_REDIRECT_READY) return;
  window.__MOVIX_POPUP_REDIRECT_READY = true;

  var AUX_HOSTS = ${auxHostsJson};
  var fakeWindows = [];

  function postNative(url) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'OPEN_EXTERNAL', url: url })
        );
      }
    } catch (e) {}
  }

  function hostOf(u) {
    try { return new URL(u, location.href).hostname.toLowerCase(); }
    catch (e) { return ''; }
  }

  function isAllowedHost(host) {
    if (!host) return true;
    if (host === location.hostname) return true;
    for (var i = 0; i < AUX_HOSTS.length; i++) {
      var h = AUX_HOSTS[i];
      if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
    }
    return false;
  }

  // Faux objet window : truthy, fermable, avec une location qui re-route toute
  // affectation ultérieure (cas du « var w = window.open(); w.location = url »).
  function makeFakeWindow(initialUrl) {
    var fake = {
      closed: false,
      close: function() { this.closed = true; },
      focus: function() {},
      blur: function() {},
      postMessage: function() {},
      document: {
        write: function() {}, writeln: function() {}, close: function() {},
        open: function() {},
      },
    };
    var current = initialUrl || '';
    var loc = {
      replace: function(v) { route(v); },
      assign: function(v) { route(v); },
      toString: function() { return current; },
    };
    function route(v) {
      var u = String(v || '');
      current = u; // le getter de href renvoie current, pas besoin de l'écrire
      var host = hostOf(u);
      if (u && /^https?:/i.test(u) && !isAllowedHost(host)) postNative(u);
    }
    Object.defineProperty(loc, 'href', {
      get: function() { return current; },
      set: function(v) { route(v); },
      configurable: true,
    });
    fake.location = loc;
    fakeWindows.push(fake);
    return fake;
  }

  var origOpen = window.open;
  window.open = function(url, name, features) {
    try {
      var raw = url ? String(url) : '';
      var host = hostOf(raw);
      // Hôte légitime (même origine, OAuth, captcha) ou URL vide différée :
      // comportement natif, sauf si l'URL vide est ensuite routée via la
      // location du faux window (géré par makeFakeWindow).
      if (raw && /^https?:/i.test(raw) && !isAllowedHost(host)) {
        postNative(raw);
        return makeFakeWindow(raw);
      }
      if (raw && isAllowedHost(host)) {
        try { return origOpen.apply(window, arguments); } catch (e) {}
        return makeFakeWindow(raw);
      }
      // window.open() sans URL (ou about:blank) : on renvoie un faux window dont
      // la location interceptera l'affectation différée de l'URL de pub.
      return makeFakeWindow(raw);
    } catch (e) {
      return makeFakeWindow('');
    }
  };

  // Retour au premier plan : l'utilisateur a fini de regarder la pub dans le
  // navigateur système. On marque les faux popups comme fermés — c'est le
  // signal sur lequel débloquent les gates qui attendent la fermeture de la
  // pub — puis on rejoue focus/visibilité pour celles qui écoutent plutôt le
  // retour de l'onglet. Aucune navigation n'est déclenchée : la page garde son
  // état, ce qui évite le rechargement qui ramenait la gate publicitaire.
  function notifyExternalReturn() {
    for (var i = 0; i < fakeWindows.length; i++) {
      try { fakeWindows[i].closed = true; } catch (e) {}
    }
    fakeWindows = [];
    try { window.dispatchEvent(new Event('focus')); } catch (e) {}
    try { document.dispatchEvent(new Event('visibilitychange')); } catch (e) {}
    try { window.dispatchEvent(new Event('pageshow')); } catch (e) {}
  }

  // Appelé par le natif (AppState -> active) après l'ouverture d'une pub dans
  // le navigateur système : le WebView en arrière-plan ne reçoit pas toujours
  // visibilitychange de façon fiable selon la plateforme et la version d'OS.
  window.__movixNotifyExternalReturn = notifyExternalReturn;

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) notifyExternalReturn();
  });
})();
true;
`;
}
