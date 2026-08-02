/**
 * Versioned Android Cast bridge injected before the Movix frontend.
 *
 * Android media is always prepared by the locked userscript resolver and then
 * handed to the native LAN relay. This shim deliberately exposes no direct URL
 * loading or remote-proxy fallback.
 */
export function buildCastShim(): string {
  return `
(function() {
  'use strict';
  if (window.__MOVIX_ANDROID_CAST_INSTALLED__) return;
  window.__MOVIX_ANDROID_CAST_INSTALLED__ = true;

  var pendingCallbacks = Object.create(null);
  var idCounter = 0;
  var statusEventName = 'CAST_STATUS_CHANGED';
  var nativeWebView = window.ReactNativeWebView;
  var nativePostMessage =
    nativeWebView && typeof nativeWebView.postMessage === 'function'
      ? nativeWebView.postMessage.bind(nativeWebView)
      : null;
  var castCapability = null;

  try {
    var capabilityBytes = new Uint8Array(16);
    window.crypto.getRandomValues(capabilityBytes);
    castCapability = Array.prototype.map.call(
      capabilityBytes,
      function(value) { return value.toString(16).padStart(2, '0'); }
    ).join('');
  } catch (e) {
    // A cryptographically strong, closure-only capability is mandatory.
    nativePostMessage = null;
  }

  function nextId() {
    idCounter = (idCounter + 1) % 0x7fffffff;
    return 'mc' + Date.now().toString(36) + '_' + idCounter.toString(36);
  }

  function postNative(msg) {
    if (!nativePostMessage) return false;
    try {
      nativePostMessage(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }

  function registerCapability() {
    if (!castCapability) return false;
    return postNative({
      type: 'CASTSHIM_REGISTER_CAPABILITY',
      capability: castCapability,
    });
  }

  function callNative(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = nextId();
      pendingCallbacks[id] = { resolve: resolve, reject: reject };
      var msg = { type: type, id: id, capability: castCapability };
      if (payload) {
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) {
            msg[key] = payload[key];
          }
        }
      }
      // Registration is intentionally repeated immediately before the command.
      // A top-frame navigation callback can invalidate the fire-and-forget
      // registration emitted at document start; posting both messages in order
      // lets the current trusted document recover without reloading the page.
      if (!registerCapability() || !postNative(msg)) {
        delete pendingCallbacks[id];
        reject(new Error('Cast native bridge unavailable'));
      }
    });
  }

  if (castCapability) {
    registerCapability();
  }

  function getResolver() {
    var resolver = window.__MOVIX_PREPARE_CAST_SOURCE__;
    return typeof resolver === 'function' ? resolver : null;
  }

  function getPreparationProtocolVersion() {
    var resolver = getResolver();
    if (!resolver) return 0;
    try {
      var probe = resolver({
        type: 'CAST_PREPARE_SOURCE',
        url: 'https://cast-capability.invalid/probe',
      });
      return probe && probe.protocolVersion === 1 ? 1 : 0;
    } catch (e) {
      return 0;
    }
  }

  function prepareSource(url, contentType) {
    var resolver = getResolver();
    if (!resolver) throw new Error('Cast source preparation unavailable');
    var request = {
      type: 'CAST_PREPARE_SOURCE',
      url: String(url || ''),
    };
    if (typeof contentType === 'string' && contentType) {
      request.contentType = contentType;
    }
    var prepared;
    try {
      prepared = resolver(request);
    } catch (e) {
      throw new Error('Cast source preparation failed');
    }
    if (
      !prepared
      || prepared.protocolVersion !== 1
      || typeof prepared.url !== 'string'
      || !prepared.headers
      || typeof prepared.headers !== 'object'
      || Array.isArray(prepared.headers)
    ) {
      throw new Error('Cast source preparation unavailable');
    }
    var source = {
      url: prepared.url,
      headers: prepared.headers,
      protocolVersion: 1,
    };
    if (typeof prepared.contentType === 'string' && prepared.contentType) {
      source.contentType = prepared.contentType;
    }
    return source;
  }

  function prepareTracks(tracks) {
    if (tracks == null) return [];
    if (!Array.isArray(tracks) || tracks.length > 16) {
      throw new Error('Cast track preparation failed');
    }
    return tracks.map(function(track) {
      if (!track || typeof track !== 'object') {
        throw new Error('Cast track preparation failed');
      }
      var prepared;
      try {
        prepared = prepareSource(track.url, track.contentType || 'text/vtt');
      } catch (error) {
        error.castStage = 'track';
        error.castValue = track.url;
        throw error;
      }
      if (typeof track.language === 'string') {
        prepared.language = track.language;
      }
      if (typeof track.name === 'string') {
        prepared.name = track.name;
      }
      if (typeof track.active === 'boolean') {
        prepared.active = track.active;
      }
      return prepared;
    });
  }

  function reportPreparationFailure(error) {
    var message = error && error.message;
    var code = message === 'Cast source preparation failed'
      ? 'PREPARATION_FAILED'
      : message === 'Cast track preparation failed'
        ? 'TRACK_PREPARATION_FAILED'
        : 'PREPARATION_UNAVAILABLE';
    var stage = error && error.castStage === 'track' ? 'track' : 'media';
    var rawValue = stage === 'track' ? error.castValue : error && error.castValue;
    var schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(String(rawValue || ''));
    var scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'unknown';
    var host = '';
    var port = '';
    try {
      var diagnosticUrl = new URL(String(rawValue || ''));
      host = String(diagnosticUrl.hostname || '').slice(0, 253);
      port = String(diagnosticUrl.port || '');
    } catch (e) {
      // The scheme remains enough when the URL cannot be parsed safely.
    }
    registerCapability();
    postNative({
      type: 'CASTSHIM_DIAGNOSTIC',
      capability: castCapability,
      code: code,
      stage: stage,
      scheme: scheme,
      host: host,
      port: port,
    });
  }

  function normalizeStatus(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var states = {
      idle: true,
      loading: true,
      buffering: true,
      playing: true,
      paused: true,
      ended: true,
      error: true,
    };
    if (
      typeof raw.connected !== 'boolean'
      || !states[raw.state]
      || typeof raw.positionSec !== 'number'
      || !isFinite(raw.positionSec)
      || raw.positionSec < 0
      || (raw.durationSec !== null && (
        typeof raw.durationSec !== 'number'
        || !isFinite(raw.durationSec)
        || raw.durationSec < 0
      ))
      || typeof raw.canSeek !== 'boolean'
    ) {
      return null;
    }
    var status = {
      connected: raw.connected,
      deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : null,
      mediaSessionId:
        typeof raw.mediaSessionId === 'number' ? raw.mediaSessionId : null,
      state: raw.state,
      positionSec: raw.positionSec,
      durationSec: raw.durationSec,
      canSeek: raw.canSeek,
    };
    if (typeof raw.idleReason === 'string') status.idleReason = raw.idleReason;
    if (typeof raw.errorCode === 'string') status.errorCode = raw.errorCode;
    return status;
  }

  window.MovixAndroidCast = {
    isSupported: function() {
      return callNative('CASTSHIM_INIT').then(function(payload) {
        var capabilities = payload && payload.capabilities;
        return !!(
          payload
          && payload.supported === true
          && capabilities
          && capabilities.configured === true
          && capabilities.receiverProtocolVersion === 1
          && capabilities.castLanProxyVersion === 1
          && getPreparationProtocolVersion() === 1
        );
      });
    },
    loadMedia: function(
      url,
      title,
      poster,
      currentTime,
      contentType,
      tracks
    ) {
      var source;
      try {
        source = prepareSource(url, contentType);
        var preparedTracks = prepareTracks(tracks);
        if (preparedTracks.length > 0) source.tracks = preparedTracks;
      } catch (error) {
        if (!error.castValue) error.castValue = url;
        reportPreparationFailure(error);
        return Promise.reject(error);
      }
      return callNative('CASTSHIM_LOAD_MEDIA', {
        source: source,
        metadata: {
          title: title || 'Movix',
          poster: poster || '',
          currentTime:
            typeof currentTime === 'number' && currentTime >= 0
              ? currentTime
              : 0,
        },
      });
    },
    getStatus: function() {
      return callNative('CASTSHIM_GET_STATUS', { refresh: true }).then(
        function(raw) {
          var status = normalizeStatus(raw);
          if (!status) throw new Error('Invalid Cast status');
          return status;
        }
      );
    },
    play: function() {
      return callNative('CASTSHIM_PLAY');
    },
    pause: function() {
      return callNative('CASTSHIM_PAUSE');
    },
    seekTo: function(seconds) {
      if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) {
        return Promise.reject(new Error('Invalid Cast seek'));
      }
      return callNative('CASTSHIM_SEEK_TO', { seconds: seconds });
    },
    stop: function() {
      return callNative('CASTSHIM_STOP');
    },
    subscribe: function(listener) {
      if (typeof listener !== 'function') return function() {};
      var handler = function(event) {
        var status = normalizeStatus(event && event.detail);
        if (status) listener(status);
      };
      window.addEventListener(statusEventName, handler);
      return function() {
        window.removeEventListener(statusEventName, handler);
      };
    },
    getRelayDisclosurePreference: function() {
      return callNative('CASTSHIM_GET_RELAY_DISCLOSURE_PREFERENCE').then(
        function(payload) {
          return !!(payload && payload.suppressed === true);
        }
      );
    },
    setRelayDisclosureSuppressed: function(suppressed) {
      return callNative('CASTSHIM_SET_RELAY_DISCLOSURE_SUPPRESSED', {
        suppressed: suppressed === true,
      });
    },
    openBatterySettings: function() {
      return callNative('CASTSHIM_OPEN_BATTERY_SETTINGS');
    },
    requestRelayNotificationPermission: function() {
      callNative('CASTSHIM_REQUEST_NOTIFICATION_PERMISSION').catch(function() {
        // Optional and non-blocking by contract.
      });
    },
  };

  window.addEventListener('__MOVIX_CAST_SHIM__', function(event) {
    var detail = event && event.detail;
    if (!detail) return;
    if (detail.kind === 'RESPONSE') {
      var callback = pendingCallbacks[detail.id];
      if (!callback) return;
      delete pendingCallbacks[detail.id];
      if (detail.ok) {
        callback.resolve(detail.payload || null);
      } else {
        var message =
          detail.error
          && (detail.error.message || detail.error.description);
        callback.reject(new Error(message || 'Cast error'));
      }
      return;
    }
    if (detail.kind === 'STATUS_EVENT') {
      var status = normalizeStatus(detail.status);
      if (status) {
        window.dispatchEvent(new CustomEvent(statusEventName, {
          detail: status,
        }));
      }
    }
  });
})();
true;
`;
}
