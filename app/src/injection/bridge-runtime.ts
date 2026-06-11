/**
 * Runtime bridge injecté dans le WebView AVANT le chargement de la page.
 *
 * Fournit les équivalents de GM_xmlhttpRequest, GM_getValue, GM_setValue,
 * GM_deleteValue et unsafeWindow pour que le userscript fonctionne
 * dans le WebView React Native.
 */

export function buildBridgeRuntime(): string {
  return `
(function() {
  'use strict';

  // Empêche la double-injection
  if (window.__MOVIX_BRIDGE_READY) return;
  window.__MOVIX_BRIDGE_READY = true;

  // --- Pending requests ---
  var _pendingRequests = {};
  var _requestCounter = 0;

  function generateId() {
    return 'req_' + (++_requestCounter) + '_' + Date.now();
  }

  function sendToNative(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  // --- Capture console -> bridge (pour la console de debug de l'app) ---
  (function() {
    var levels = ['log', 'info', 'warn', 'error'];
    levels.forEach(function(level) {
      var orig = typeof console[level] === 'function'
        ? console[level].bind(console)
        : function() {};
      console[level] = function() {
        try {
          var args = Array.prototype.slice.call(arguments).map(function(a) {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
            try { return JSON.stringify(a); } catch (e) { return String(a); }
          });
          sendToNative({ type: 'CONSOLE_LOG', level: level, args: args });
        } catch (e) {}
        orig.apply(console, arguments);
      };
    });
  })();

  // Réception des réponses du bridge React Native
  window.addEventListener('__MOVIX_BRIDGE_RESPONSE', function(event) {
    var response = event.detail;
    if (!response || !response.id) return;
    var handler = _pendingRequests[response.id];
    if (handler) {
      delete _pendingRequests[response.id];
      handler(response);
    }
  });

  function bridgeRequest(message) {
    return new Promise(function(resolve) {
      var id = generateId();
      message.id = id;
      _pendingRequests[id] = resolve;
      sendToNative(message);

      // Timeout de sécurité (60s)
      setTimeout(function() {
        if (_pendingRequests[id]) {
          delete _pendingRequests[id];
          resolve({ id: id, success: false, error: 'Timeout bridge' });
        }
      }, 60000);
    });
  }

  // --- Base64 helpers ---
  function base64ToArrayBuffer(base64) {
    var binaryString = atob(base64);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // --- Helper: extrait le corps d'une requête GM en string ---
  function gmBodyToString(data) {
    if (data == null) return null;
    if (typeof data === 'string') return data;
    if (data instanceof URLSearchParams) return data.toString();
    return String(data);
  }

  // --- GM_xmlhttpRequest DIRECT (proxy désactivé) ---
  // Exécute la requête dans le contexte du WebView via XMLHttpRequest.
  // Pas de bypass CORS, pas d'injection de headers : utilise le réseau et les
  // cookies de la page directement.
  function GM_xmlhttpRequest_direct(details) {
    var xhr = new XMLHttpRequest();
    var method = (details.method || 'GET').toUpperCase();
    try {
      xhr.open(method, details.url, true);
    } catch (e) {
      if (details.onerror) details.onerror({ error: String(e), status: 0, statusText: 'open failed' });
      return { abort: function() {} };
    }

    if (details.responseType === 'arraybuffer') {
      try { xhr.responseType = 'arraybuffer'; } catch (e) {}
    }
    if (details.timeout) xhr.timeout = details.timeout;

    var headers = details.headers || {};
    for (var hk in headers) {
      try { xhr.setRequestHeader(hk, headers[hk]); } catch (e) {}
    }

    xhr.onload = function() {
      if (!details.onload) return;
      var isBuffer = details.responseType === 'arraybuffer';
      details.onload({
        status: xhr.status,
        statusText: xhr.statusText,
        responseHeaders: xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : '',
        response: xhr.response,
        responseText: isBuffer ? '' : (xhr.responseText || ''),
        finalUrl: xhr.responseURL || details.url
      });
    };
    xhr.onerror = function() {
      if (details.onerror) details.onerror({ error: 'Network error', status: xhr.status || 0, statusText: xhr.statusText || 'error' });
    };
    xhr.ontimeout = function() {
      if (details.onerror) details.onerror({ error: 'Timeout', status: 0, statusText: 'timeout' });
    };

    try {
      xhr.send(gmBodyToString(details.data));
    } catch (e) {
      if (details.onerror) details.onerror({ error: String(e), status: 0, statusText: 'send failed' });
    }

    return { abort: function() { try { xhr.abort(); } catch (e) {} } };
  }

  // --- GM_xmlhttpRequest ---
  function GM_xmlhttpRequest(details) {
    // Proxy intégré désactivé -> requête directe dans le WebView.
    if (window.__MOVIX_PROXY_ENABLED === false) {
      return GM_xmlhttpRequest_direct(details);
    }

    var headers = details.headers || {};

    var bodyStr = null;
    if (details.data != null) {
      if (typeof details.data === 'string') {
        bodyStr = details.data;
      } else if (details.data instanceof URLSearchParams) {
        bodyStr = details.data.toString();
      } else {
        bodyStr = String(details.data);
      }
    }

    var message = {
      type: 'GM_FETCH',
      url: details.url,
      method: (details.method || 'GET').toUpperCase(),
      headers: headers,
      body: bodyStr,
      responseType: details.responseType || '',
      timeout: details.timeout || 30000
    };

    bridgeRequest(message).then(function(response) {
      if (!response.success) {
        if (details.onerror) {
          details.onerror({
            error: response.error || 'Requête échouée',
            status: 0,
            statusText: response.error || 'Erreur'
          });
        }
        return;
      }

      var responseBody;
      if (details.responseType === 'arraybuffer' && response.body) {
        responseBody = base64ToArrayBuffer(response.body);
      } else {
        responseBody = response.body || '';
      }

      var headersStr = '';
      if (response.headers) {
        for (var key in response.headers) {
          headersStr += key + ': ' + response.headers[key] + '\\r\\n';
        }
      }

      var gmResponse = {
        status: response.status || 0,
        statusText: response.statusText || '',
        responseHeaders: headersStr,
        response: responseBody,
        responseText: typeof responseBody === 'string' ? responseBody : '',
        finalUrl: response.finalUrl || details.url
      };

      if (details.onload) {
        details.onload(gmResponse);
      }
    });

    return { abort: function() {} };
  }

  // --- GM_getValue / GM_setValue / GM_deleteValue ---
  // Version synchrone avec cache local + sync async vers le natif
  var _storageCache = {};

  function GM_getValue(key, defaultValue) {
    if (key in _storageCache) {
      return _storageCache[key];
    }
    // Fallback sur localStorage
    try {
      var stored = localStorage.getItem('movix_userscript:' + key);
      if (stored !== null) {
        return JSON.parse(stored);
      }
    } catch(e) {}
    return defaultValue;
  }

  function GM_setValue(key, value) {
    _storageCache[key] = value;
    try {
      localStorage.setItem('movix_userscript:' + key, JSON.stringify(value));
    } catch(e) {}
    // Sync vers natif en arrière-plan
    sendToNative({ type: 'GM_SET_VALUE', id: generateId(), key: key, value: value });
  }

  function GM_deleteValue(key) {
    delete _storageCache[key];
    try {
      localStorage.removeItem('movix_userscript:' + key);
    } catch(e) {}
    sendToNative({ type: 'GM_DELETE_VALUE', id: generateId(), key: key });
  }

  // --- Exposition globale ---
  window.GM_xmlhttpRequest = GM_xmlhttpRequest;
  window.GM_getValue = GM_getValue;
  window.GM_setValue = GM_setValue;
  window.GM_deleteValue = GM_deleteValue;

  // GM.* API (Greasemonkey 4+ compat)
  window.GM = {
    xmlHttpRequest: GM_xmlhttpRequest,
    getValue: function(key, defaultValue) {
      return Promise.resolve(GM_getValue(key, defaultValue));
    },
    setValue: function(key, value) {
      GM_setValue(key, value);
      return Promise.resolve();
    },
    deleteValue: function(key) {
      GM_deleteValue(key);
      return Promise.resolve();
    }
  };

  // unsafeWindow = window (pas de sandboxing dans le WebView)
  window.unsafeWindow = window;

  console.log('[Movix App] Bridge runtime initialisé');
})();
true;
`;
}
