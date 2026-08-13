/** Injects the limited browser Picture-in-Picture surface backed by Android PiP. */
export function buildPictureInPictureShim(enabled: boolean): string {
  return `
(function() {
  'use strict';
  if (${enabled !== true ? 'true' : 'false'}) return;

  var nativeWebView = window.ReactNativeWebView;
  if (!nativeWebView || typeof nativeWebView.postMessage !== 'function') return;
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return;
  if (typeof HTMLVideoElement !== 'function') return;

  var capabilityBytes = new Uint8Array(16);
  try {
    window.crypto.getRandomValues(capabilityBytes);
  } catch (error) {
    return;
  }
  var capability = Array.prototype.map.call(capabilityBytes, function(value) {
    return value.toString(16).padStart(2, '0');
  }).join('');
  if (!/^[a-f0-9]{32}$/.test(capability)) return;
  if (window.__MOVIX_ANDROID_PIP_INSTALLED__) return;
  window.__MOVIX_ANDROID_PIP_INSTALLED__ = true;

  var nativePostMessage = nativeWebView.postMessage.bind(nativeWebView);
  var pending = Object.create(null);
  var sequence = 0;
  var selectedVideo = null;
  var enteredVideo = null;
  var styleElement = null;
  var markedTargets = [];
  var markedAncestors = [];
  var CSS = [
    'html.movix-native-pip,html.movix-native-pip body{background:#000!important;overflow:hidden!important}',
    'html.movix-native-pip body *{visibility:hidden!important}',
    'html.movix-native-pip [data-movix-native-pip-ancestor]{visibility:visible!important;overflow:visible!important;transform:none!important;clip:auto!important;opacity:1!important}',
    'html.movix-native-pip video[data-movix-native-pip-target]{visibility:visible!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:contain!important;background:#000!important;z-index:2147483647!important}',
  ].join('');

  function postNative(message) {
    try {
      nativePostMessage(JSON.stringify(message));
      return true;
    } catch (error) {
      return false;
    }
  }

  function registerCapability() {
    return postNative({
      type: 'PIPSHIM_REGISTER_CAPABILITY',
      capability: capability,
    });
  }

  function makeError(name) {
    return new DOMException('', name);
  }

  function nextRequestId() {
    sequence = (sequence + 1) % 0x7fffffff;
    return 'pip-' + sequence + '-' + Date.now();
  }

  function connectedVideo(video) {
    return video instanceof HTMLVideoElement && video.isConnected === true;
  }

  function applyNativeAction(action) {
    var video = enteredVideo;
    if (!connectedVideo(video)) return;
    if (action === 'seek-backward') {
      video.currentTime = Math.max(0, Number(video.currentTime || 0) - 10);
      return;
    }
    if (action === 'seek-forward') {
      var forward = Number(video.currentTime || 0) + 10;
      video.currentTime = Number.isFinite(video.duration)
        ? Math.min(video.duration, forward)
        : forward;
      return;
    }
    if (action !== 'toggle-playback') return;
    if (video.paused || video.ended) {
      try {
        var result = video.play();
        if (result && typeof result.catch === 'function') result.catch(function() {});
      } catch (error) {}
    } else {
      video.pause();
    }
  }

  function selectVideo(preferred) {
    if (connectedVideo(preferred)) return preferred;
    var videos = document.querySelectorAll('video');
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index];
      if (connectedVideo(video) && video.paused === false && video.ended === false) {
        return video;
      }
    }
    return null;
  }

  function dispatchVideoEvent(video, type) {
    if (video) video.dispatchEvent(new CustomEvent(type));
  }

  function clearMarkers() {
    for (var targetIndex = 0; targetIndex < markedTargets.length; targetIndex += 1) {
      markedTargets[targetIndex].removeAttribute('data-movix-native-pip-target');
    }
    markedTargets = [];
    for (var ancestorIndex = 0; ancestorIndex < markedAncestors.length; ancestorIndex += 1) {
      markedAncestors[ancestorIndex].removeAttribute('data-movix-native-pip-ancestor');
    }
    markedAncestors = [];
  }

  function removePresentation() {
    var root = document.documentElement;
    if (root) root.classList.remove('movix-native-pip');
    clearMarkers();
    if (styleElement && styleElement.parentNode) {
      styleElement.parentNode.removeChild(styleElement);
    }
    styleElement = null;
    if (enteredVideo) dispatchVideoEvent(enteredVideo, 'leavepictureinpicture');
    enteredVideo = null;
    selectedVideo = null;
  }

  function applyPresentation() {
    var video = selectVideo(selectedVideo);
    if (!video) {
      removePresentation();
      return null;
    }
    clearMarkers();
    selectedVideo = video;
    var root = document.documentElement;
    if (root) root.classList.add('movix-native-pip');
    video.setAttribute('data-movix-native-pip-target', '');
    markedTargets.push(video);
    for (var ancestor = video.parentElement; ancestor; ancestor = ancestor.parentElement) {
      ancestor.setAttribute('data-movix-native-pip-ancestor', '');
      markedAncestors.push(ancestor);
    }
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.textContent = CSS;
      (document.head || root).appendChild(styleElement);
    }
    return video;
  }

  function rejectAll(name) {
    Object.keys(pending).forEach(function(id) {
      var request = pending[id];
      delete pending[id];
      clearTimeout(request.timeout);
      request.reject(makeError(name));
    });
  }

  function requestNative(type, video) {
    return new Promise(function(resolve, reject) {
      var id = nextRequestId();
      var timeout = setTimeout(function() {
        var request = pending[id];
        if (!request) return;
        delete pending[id];
        reject(makeError('AbortError'));
      }, 5000);
      pending[id] = { resolve: resolve, reject: reject, timeout: timeout };
      // Re-register immediately before every request. The initial registration
      // can be cleared by a top-frame navigation callback while the document is
      // still starting; ordered posts recover the current trusted document.
      if (
        !registerCapability()
        || !postNative({ type: type, id: id, capability: capability })
      ) {
        delete pending[id];
        clearTimeout(timeout);
        reject(makeError('NotAllowedError'));
        return;
      }
      if (type === 'PIPSHIM_ENTER') selectedVideo = selectVideo(video);
    });
  }

  Object.defineProperty(document, 'pictureInPictureEnabled', {
    configurable: true,
    get: function() { return true; },
  });
  Object.defineProperty(document, 'pictureInPictureElement', {
    configurable: true,
    get: function() { return enteredVideo; },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
    configurable: true,
    writable: true,
    value: function() {
      var video = this;
      return requestNative('PIPSHIM_ENTER', video).then(function() {
        return video;
      });
    },
  });
  Object.defineProperty(document, 'exitPictureInPicture', {
    configurable: true,
    writable: true,
    value: function() {
      return requestNative('PIPSHIM_EXIT', null);
    },
  });

  window.addEventListener('__MOVIX_PIP_SHIM__', function(event) {
    var detail = event && event.detail;
    if (!detail || typeof detail !== 'object') return;
    if (detail.kind === 'RESPONSE' && typeof detail.id === 'string') {
      var request = pending[detail.id];
      if (!request) return;
      delete pending[detail.id];
      clearTimeout(request.timeout);
      if (detail.ok === true) request.resolve();
      else request.reject(makeError('NotAllowedError'));
      return;
    }
    if (detail.kind !== 'NATIVE_EVENT' || !detail.event || typeof detail.event !== 'object') return;
    if (detail.event.kind === 'action') {
      applyNativeAction(detail.event.action);
      return;
    }
    if (detail.event.kind === 'prepare') {
      applyPresentation();
      return;
    }
    if (detail.event.kind === 'state') {
      if (detail.event.active === true) {
        var video = applyPresentation();
        if (video && enteredVideo !== video) {
          if (enteredVideo) dispatchVideoEvent(enteredVideo, 'leavepictureinpicture');
          enteredVideo = video;
          dispatchVideoEvent(video, 'enterpictureinpicture');
        }
      } else if (detail.event.active === false) {
        removePresentation();
      }
      return;
    }
    if (detail.event.kind === 'error') {
      rejectAll('AbortError');
      removePresentation();
    }
  });

  window.addEventListener('pagehide', function() {
    rejectAll('AbortError');
    removePresentation();
  });

  registerCapability();
})();
true;
`;
}
