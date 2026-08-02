/** Injected before site code so local players can opt into the native awake flag. */
export function buildPlaybackAwakeShim(): string {
  return `
(function() {
  'use strict';
  var lastActive = false;
  window.MovixAndroidPlaybackAwake = {
    setActive: function(active) {
      active = active === true;
      if (active === lastActive) return;
      lastActive = active;
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'PLAYBACK_AWAKE_SET',
          capability: 'MOVIX_PLAYBACK_AWAKE_V1',
          active: active
        }));
      }
    }
  };
  window.addEventListener('pagehide', function() { window.MovixAndroidPlaybackAwake.setActive(false); });
})();
true;
`;
}
