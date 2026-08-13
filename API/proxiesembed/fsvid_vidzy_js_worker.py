"""One-shot QuickJS worker. It must never import application code."""

from __future__ import annotations

import json
import sys

MAX_REQUEST_BYTES = 800 * 1024
MAX_RESPONSE_BYTES = 128 * 1024
MEMORY_LIMIT_BYTES = 16 * 1024 * 1024
STACK_LIMIT_BYTES = 512 * 1024
TIME_LIMIT_SECONDS = 0.75


BOOTSTRAP = r"""
(() => {
  'use strict';
  const candidates = [];
  const seen = new WeakSet();

  function capture(value, depth) {
    if (candidates.length >= 16 || depth > 5 || value == null) return;
    if (typeof value === 'string') {
      if (value.length <= 16384 && value.toLowerCase().includes('.m3u8')) {
        candidates.push(value);
      }
      return;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
    seen.add(value);
    let keys = [];
    try { keys = Object.keys(value).slice(0, 64); } catch (_) { return; }
    for (const key of keys) {
      try { capture(value[key], depth + 1); } catch (_) {}
    }
  }

  const chainTarget = function () {};
  const chain = new Proxy(chainTarget, {
    apply(_target, _thisArg, args) {
      for (const arg of args) capture(arg, 0);
      return chain;
    },
    construct(_target, args) {
      for (const arg of args) capture(arg, 0);
      return chain;
    },
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => '';
      return chain;
    },
    set() { return true; },
  });

  function playerFactory(...args) {
    for (const arg of args) capture(arg, 0);
    return chain;
  }
  playerFactory.addLanguage = function (...args) {
    for (const arg of args) capture(arg, 0);
  };
  playerFactory.getPlayers = () => ({});

  function decodeBase64(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = String(input).replace(/[\t\n\f\r ]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (clean.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(clean)) throw new Error('InvalidCharacterError');
    let output = '';
    let bits = 0;
    let bitCount = 0;
    for (let index = 0; index < clean.length; index++) {
      const character = clean[index];
      if (character === '=') break;
      const value = alphabet.indexOf(character);
      if (value < 0) throw new Error('InvalidCharacterError');
      bits = (bits << 6) | value;
      bitCount += 6;
      if (bitCount >= 8) {
        bitCount -= 8;
        output += String.fromCharCode((bits >> bitCount) & 255);
      }
    }
    return output;
  }

  function encodeBase64(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const text = String(input);
    let output = '';
    for (let index = 0; index < text.length; index += 3) {
      const a = text.charCodeAt(index);
      const b = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      const c = index + 2 < text.length ? text.charCodeAt(index + 2) : 0;
      if (a > 255 || b > 255 || c > 255) throw new Error('InvalidCharacterError');
      const triplet = (a << 16) | (b << 8) | c;
      output += alphabet[(triplet >> 18) & 63];
      output += alphabet[(triplet >> 12) & 63];
      output += index + 1 < text.length ? alphabet[(triplet >> 6) & 63] : '=';
      output += index + 2 < text.length ? alphabet[triplet & 63] : '=';
    }
    return output;
  }

  const looseObject = new Proxy(function () {}, {
    apply() { return looseObject; },
    construct() { return looseObject; },
    get(_target, property) {
      if (property === 'canPlayType') return function (type) { return type && (type.includes('hls') || type.includes('mpegURL') || type.includes('mp4')) ? 'probably' : 'maybe'; };
      if (property === 'getAttribute') return function (attr) { return attr === 'src' ? '' : 'true'; };
      if (property === 'hasAttribute') return function () { return true; };
      if (property === 'referrer') return globalThis.location ? globalThis.location.origin || '' : '';
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => '';
      return looseObject;
    },
    set() { return true; },
  });

  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.navigator = { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0' };
  globalThis.location = { protocol: 'https:', host: '', hostname: '', href: '' };
  globalThis.document = looseObject;
  globalThis.videojs = playerFactory;
  globalThis.player = playerFactory;
  globalThis.jwplayer = playerFactory;
  globalThis.atob = decodeBase64;
  globalThis.btoa = encodeBase64;
  globalThis.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  globalThis.setTimeout = function (callback) {
    if (typeof callback === 'function') {
      try { callback(); } catch (_) {}
    }
    return 0;
  };
  globalThis.clearTimeout = function () {};
  globalThis.setInterval = function () { return 0; };
  globalThis.clearInterval = function () {};
  globalThis.requestAnimationFrame = function () { return 0; };
  globalThis.cancelAnimationFrame = function () {};
  globalThis.fetch = undefined;
  globalThis.XMLHttpRequest = undefined;
  globalThis.WebSocket = undefined;
  globalThis.EventSource = undefined;
  globalThis.Worker = undefined;
  globalThis.SharedWorker = undefined;
  globalThis.importScripts = undefined;
  globalThis.RTCPeerConnection = undefined;

  const nativeEval = eval;
  globalThis.__movixRunPlayerScript = function (source) {
    try {
      nativeEval(String(source));
      return null;
    } catch (error) {
      return String(error && error.name ? error.name : 'runtime_error');
    }
  };
  globalThis.__movixCandidatesJson = function () {
    return JSON.stringify(candidates.slice(0, 16));
  };
})();
"""


def emit(payload: dict[str, object], exit_code: int = 0) -> None:
    def encode(candidate_payload: dict[str, object]) -> bytes:
        return json.dumps(candidate_payload, separators=(",", ":")).encode("utf-8")

    encoded = encode(payload)
    if len(encoded) > MAX_RESPONSE_BYTES:
        raw_candidates = payload.get("candidates")
        bounded_candidates: list[object] = []
        if isinstance(raw_candidates, list):
            for candidate in raw_candidates:
                bounded_payload = {**payload, "candidates": [*bounded_candidates, candidate]}
                bounded_encoded = encode(bounded_payload)
                if len(bounded_encoded) <= MAX_RESPONSE_BYTES:
                    bounded_candidates.append(candidate)
                    encoded = bounded_encoded

        if not bounded_candidates:
            encoded = encode(
                {"candidates": [], "error": "sandbox_output_too_large"}
            )

    sys.stdout.buffer.write(encoded)
    raise SystemExit(exit_code)


def main() -> None:
    raw_request = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw_request) > MAX_REQUEST_BYTES:
        emit({"candidates": [], "error": "sandbox_request_too_large"}, 2)

    try:
        request = json.loads(raw_request.decode("utf-8"))
    except json.JSONDecodeError:
        emit({"candidates": [], "error": "sandbox_invalid_json"}, 2)

    if not isinstance(request, dict):
        emit({"candidates": [], "error": "sandbox_invalid_request"}, 2)

    scripts = request.get("scripts")
    if not isinstance(scripts, list) or not scripts:
        emit({"candidates": [], "error": "no_player_script"}, 2)
    if any(not isinstance(script, str) for script in scripts):
        emit({"candidates": [], "error": "sandbox_invalid_request"}, 2)

    try:
        import quickjs
    except (ImportError, OSError):
        emit({"candidates": [], "error": "sandbox_unavailable"}, 1)

    try:
        import urllib.parse
        context = quickjs.Context()
        context.set_memory_limit(MEMORY_LIMIT_BYTES)
        context.set_max_stack_size(STACK_LIMIT_BYTES)
        context.set_time_limit(TIME_LIMIT_SECONDS)
        context.eval(BOOTSTRAP)
        embed_url = request.get("embedUrl") if isinstance(request, dict) else ""
        if isinstance(embed_url, str) and embed_url:
            try:
                parsed = urllib.parse.urlparse(embed_url)
                origin_str = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
                loc_js = f"""
                globalThis.location = {{
                    href: {json.dumps(parsed.geturl())},
                    origin: {json.dumps(origin_str)},
                    protocol: {json.dumps(f"{parsed.scheme}:" if parsed.scheme else "https:")},
                    host: {json.dumps(parsed.netloc or "")},
                    hostname: {json.dumps(parsed.hostname or "")},
                    pathname: {json.dumps(parsed.path or "")},
                    search: {json.dumps(f"?{parsed.query}" if parsed.query else "")},
                    hash: {json.dumps(f"#{parsed.fragment}" if parsed.fragment else "")},
                    port: {json.dumps(str(parsed.port) if parsed.port else "")},
                    ancestorOrigins: [{json.dumps(origin_str)}]
                }};
                try {{ globalThis.document.referrer = {json.dumps(origin_str)}; }} catch (_) {{}}
                """
                context.eval(loc_js)
            except Exception:
                pass
        run_script = context.get("__movixRunPlayerScript")
        runtime_error = None
        for script in scripts:
            error = run_script(script)
            if error:
                runtime_error = str(error)
        candidates_json = context.get("__movixCandidatesJson")()
        candidates = json.loads(candidates_json)
    except Exception as error:
        error_text = str(error).lower()
        reason = "sandbox_timeout" if "interrupted" in error_text else "sandbox_runtime_error"
        emit({"candidates": [], "error": reason}, 1)

    emit(
        {
            "candidates": candidates if isinstance(candidates, list) else [],
            "error": None if candidates else (runtime_error or "no_valid_candidate"),
        }
    )


if __name__ == "__main__":
    main()
