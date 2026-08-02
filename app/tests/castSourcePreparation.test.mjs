import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadUserscriptHarness() {
  const source = await readFile(
    new URL('../../userscript/movix.user.js', import.meta.url),
    'utf8',
  );
  const pageWindow = new EventTarget();
  pageWindow.fetch = async () => {
    throw new Error('Unexpected page fetch');
  };
  pageWindow.postMessage = () => {};
  pageWindow.location = {
    hostname: 'movix.fun',
    origin: 'https://movix.fun',
  };

  const context = vm.createContext({
    AbortController,
    ArrayBuffer,
    Blob,
    CustomEvent,
    DOMException,
    Event,
    EventTarget,
    FormData,
    Headers,
    Map,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Uint8Array,
    atob,
    btoa,
    clearTimeout: () => {},
    console: { error() {}, log() {}, warn() {} },
    document: { documentElement: { dataset: {} } },
    fetch: async () => {
      throw new Error('Unexpected native fetch');
    },
    GM_deleteValue: async () => {},
    GM_getValue: async (_key, fallback) => fallback,
    GM_setValue: async () => {},
    GM_xmlhttpRequest() {
      return { abort() {} };
    },
    location: pageWindow.location,
    queueMicrotask,
    setTimeout: () => 1,
    unsafeWindow: pageWindow,
    window: pageWindow,
  });
  vm.runInContext(source, context, { filename: 'userscript/movix.user.js' });
  pageWindow.chrome = context.chrome;
  return pageWindow;
}

test('prepares Cast source headers from matching dynamic rules using the media allow-list', async () => {
  const window = await loadUserscriptHarness();
  const resolver = window.__MOVIX_PREPARE_CAST_SOURCE__;
  const descriptor = Object.getOwnPropertyDescriptor(
    window,
    '__MOVIX_PREPARE_CAST_SOURCE__',
  );
  assert.equal(descriptor.configurable, false);
  assert.equal(
    Reflect.defineProperty(window, '__MOVIX_PREPARE_CAST_SOURCE__', {
      value: () => ({
        url: 'https://attacker.example/fake.m3u8',
        headers: { Authorization: 'Bearer fake' },
        protocolVersion: 1,
      }),
    }),
    false,
  );
  assert.equal(window.__MOVIX_PREPARE_CAST_SOURCE__, resolver);

  await window.chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: 9001,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://player.example' },
          { header: 'Referer', operation: 'set', value: 'https://player.example/watch' },
          { header: 'Accept', operation: 'set', value: 'application/vnd.apple.mpegurl' },
          { header: 'User-Agent', operation: 'set', value: 'Movix/1.0' },
          { header: 'Host', operation: 'set', value: 'cdn.example' },
          { header: 'Connection', operation: 'set', value: 'keep-alive' },
          { header: 'Cookie', operation: 'set', value: 'secret=1' },
          { header: 'Authorization', operation: 'set', value: 'Bearer secret' },
          { header: 'X-Unknown', operation: 'set', value: 'nope' },
          { header: 'Accept-Language', operation: 'set', value: 'fr\r\nX-Injected: nope' },
        ],
      },
      condition: {
        urlFilter: '*cdn.example/*',
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });

  assert.equal(typeof window.__MOVIX_PREPARE_CAST_SOURCE__, 'function');
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(window, '__MOVIX_PREPARE_CAST_SOURCE__'),
    false,
  );
  const prepared = window.__MOVIX_PREPARE_CAST_SOURCE__({
    type: 'CAST_PREPARE_SOURCE',
    url: 'https://cdn.example/master.m3u8',
    contentType: 'application/vnd.apple.mpegurl',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {
    url: 'https://cdn.example/master.m3u8',
    headers: {
      Origin: 'https://player.example',
      Referer: 'https://player.example/watch',
      Accept: 'application/vnd.apple.mpegurl',
      'User-Agent': 'Movix/1.0',
    },
    contentType: 'application/vnd.apple.mpegurl',
    protocolVersion: 1,
  });
});

test('prepares an external WebVTT descriptor independently', async () => {
  const window = await loadUserscriptHarness();
  await window.chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: 9002,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://player.example/' },
        ],
      },
      condition: {
        urlFilter: '*captions.example/*',
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });

  const prepared = window.__MOVIX_PREPARE_CAST_SOURCE__({
    type: 'CAST_PREPARE_SOURCE',
    url: 'https://captions.example/fr.vtt',
    contentType: 'text/vtt',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {
    url: 'https://captions.example/fr.vtt',
    headers: { Referer: 'https://player.example/' },
    contentType: 'text/vtt',
    protocolVersion: 1,
  });
  assert.equal('trackUrl' in prepared, false);
});

test('prepares public sources without headers when no dynamic rule matches', async () => {
  const window = await loadUserscriptHarness();
  const prepared = window.__MOVIX_PREPARE_CAST_SOURCE__({
    type: 'CAST_PREPARE_SOURCE',
    url: 'https://public.example/master.m3u8',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {
    url: 'https://public.example/master.m3u8',
    headers: {},
    protocolVersion: 1,
  });
});

test('hands an authenticated loopback media URL to the native Cast resolver', async () => {
  const window = await loadUserscriptHarness();
  const localUrl =
    'http://127.0.0.1:36375/p/process-token/session-token/resource-token';
  const prepared = window.__MOVIX_PREPARE_CAST_SOURCE__({
    type: 'CAST_PREPARE_SOURCE',
    url: localUrl,
    contentType: 'application/vnd.apple.mpegurl',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {
    url: localUrl,
    headers: {},
    contentType: 'application/vnd.apple.mpegurl',
    protocolVersion: 1,
  });
});

test('rejects non-HTTPS and oversized source inputs and drops oversized headers', async () => {
  const window = await loadUserscriptHarness();
  await window.chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: 9003,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Accept', operation: 'set', value: 'x'.repeat(8193) },
        ],
      },
      condition: {
        urlFilter: '*bounded.example/*',
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });

  assert.equal(
    window.__MOVIX_PREPARE_CAST_SOURCE__({
      type: 'CAST_PREPARE_SOURCE',
      url: 'http://bounded.example/master.m3u8',
    }),
    null,
  );
  assert.equal(
    window.__MOVIX_PREPARE_CAST_SOURCE__({
      type: 'CAST_PREPARE_SOURCE',
      url: `https://bounded.example/${'x'.repeat(16384)}`,
    }),
    null,
  );
  const prepared = window.__MOVIX_PREPARE_CAST_SOURCE__({
    type: 'CAST_PREPARE_SOURCE',
    url: 'https://bounded.example/master.m3u8',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.headers)), {});
});
