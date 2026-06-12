/**
 * Shim Picture-in-Picture pour Android.
 *
 * Le WebView système Android n'implémente PAS l'API Web Picture-in-Picture
 * (`document.pictureInPictureEnabled` / `HTMLVideoElement.requestPictureInPicture`).
 * Quand l'utilisateur clique sur le bouton PiP du lecteur Movix, celui-ci
 * détecte l'absence de l'API et affiche « votre navigateur ne supporte pas le
 * PiP ».
 *
 * Sur Android, le PiP est une fonctionnalité au niveau de l'Activity, pas de
 * l'élément <video>. Ce shim fait croire au lecteur que l'API Web existe, puis
 * route l'appel vers le natif (`ENTER_PIP` → MainActivity.enterPictureInPictureMode).
 *
 * iOS n'a PAS besoin de ce shim : WebKit implémente nativement
 * requestPictureInPicture(), le bouton PiP du lecteur fonctionne déjà.
 */

export function buildAndroidPipShim(): string {
  return `
(function() {
  'use strict';
  if (window.__MOVIX_ANDROID_PIP_SHIM__) return;
  window.__MOVIX_ANDROID_PIP_SHIM__ = true;

  function postNative(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  // Fait croire à la page que le PiP est disponible.
  try {
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      configurable: true,
      get: function() { return true; },
    });
  } catch (e) {}

  if (!('pictureInPictureElement' in document)) {
    try {
      Object.defineProperty(document, 'pictureInPictureElement', {
        configurable: true,
        get: function() { return null; },
      });
    } catch (e) {}
  }

  if (typeof document.exitPictureInPicture !== 'function') {
    document.exitPictureInPicture = function() { return Promise.resolve(); };
  }

  try {
    // Route la demande PiP du lecteur vers le PiP natif de l'Activity.
    HTMLVideoElement.prototype.requestPictureInPicture = function() {
      postNative({ type: 'ENTER_PIP' });
      // Objet minimal façon PictureInPictureWindow pour ne pas casser le lecteur
      // s'il tente d'écouter des évènements dessus.
      var fakeWindow = {
        width: 0,
        height: 0,
        addEventListener: function() {},
        removeEventListener: function() {},
      };
      return Promise.resolve(fakeWindow);
    };
  } catch (e) {}

  try {
    Object.defineProperty(HTMLVideoElement.prototype, 'disablePictureInPicture', {
      configurable: true,
      get: function() { return false; },
      set: function() {},
    });
  } catch (e) {}
})();
true;
`;
}
