import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const AES_KEY = 'kiemtienmua911ca';
const AES_IV = '1234567890oiuytr';

test('mobile embedded userscript is generated exactly from the web source', async () => {
  const source = await readFile(
    new URL('../../userscript/movix.user.js', import.meta.url),
    'utf8',
  );
  const generated = await readFile(
    new URL('../src/injection/userscript-source.ts', import.meta.url),
    'utf8',
  );
  const body = source.replace(
    /\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/,
    '',
  );
  const escaped = body
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  const expected = `/**
 * Source du userscript Movix.
 *
 * AUTO-GÉNÉRÉ par scripts/build-userscript.js
 * Ne pas modifier manuellement.
 *
 * Pour régénérer : node scripts/build-userscript.js
 */

export const USERSCRIPT_SOURCE = \`${escaped}\`;
`;
  assert.equal(generated, expected);
});

async function encryptSeekPayload(value) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(AES_KEY),
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const encrypted = await webcrypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new TextEncoder().encode(AES_IV) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Buffer.from(encrypted).toString('hex');
}

async function loadEmbeddedUserscript() {
  const sourceUrl = new URL(
    '../src/injection/userscript-source.ts',
    import.meta.url,
  );
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  });
  const module = { exports: {} };
  vm.runInNewContext(transpiled.outputText, {
    exports: module.exports,
    module,
  });
  return module.exports.USERSCRIPT_SOURCE;
}

function exposeSeekExtractor(source) {
  const end = source.lastIndexOf('})();');
  assert.notEqual(end, -1, 'embedded userscript IIFE terminator');
  return `${source.slice(0, end)}
  globalThis.__embeddedSeekExtractor = Extractors.extractSeekStreaming;
${source.slice(end)}`;
}

test('mobile embedded userscript orders normal Seek before its IP fallback', async () => {
  const normalUrl = 'https://legacy.synthetic.test/cf-native';
  const sourceUrl = 'https://cdn.synthetic.test/video/master.m3u8';
  const encrypted = await encryptSeekPayload({
    cf: 'https://legacy.synthetic.test/cf',
    cfNative: normalUrl,
    source: sourceUrl,
    master: 'https://cdn.synthetic.test/video/fallback-master.m3u8',
    masterUrl: 'https://cdn.synthetic.test/video/fallback-master-url.m3u8',
  });
  const requests = [];
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
    Buffer,
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
    crypto: webcrypto,
    document: { documentElement: { dataset: {} } },
    fetch: async () => {
      throw new Error('Unexpected native fetch');
    },
    GM_deleteValue: async () => {},
    GM_getValue: async (_key, fallback) => fallback,
    GM_setValue: async () => {},
    GM_xmlhttpRequest(details) {
      requests.push({
        url: String(details.url),
        headers: JSON.parse(JSON.stringify(details.headers)),
      });
      queueMicrotask(() => {
        const response = Buffer.from(encrypted);
        details.onload({
          status: 200,
          statusText: 'OK',
          response: response.buffer.slice(
            response.byteOffset,
            response.byteOffset + response.byteLength,
          ),
          responseHeaders: 'content-type: text/plain',
          finalUrl: details.url,
        });
      });
      return { abort() {} };
    },
    location: pageWindow.location,
    queueMicrotask,
    setTimeout: () => 1,
    unsafeWindow: pageWindow,
    window: pageWindow,
  });
  const embedded = await loadEmbeddedUserscript();
  vm.runInContext(exposeSeekExtractor(embedded), context, {
    filename: 'app/src/injection/userscript-source.ts',
  });

  const result = await context.__embeddedSeekExtractor(
    'https://movix1.embedseek.com/#ug3i',
  );

  assert.equal(
    result.success,
    true,
    JSON.stringify({ result, requests }),
  );
  assert.equal(requests.length, 1);
  assert.equal(result.hlsUrl, normalUrl);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.hlsCandidates)),
    [
      { kind: 'cfNative', url: normalUrl },
      { kind: 'source', url: sourceUrl },
    ],
  );
  assert.equal(result.origin, 'https://movix1.embedseek.com');
  assert.equal(result.referer, 'https://movix1.embedseek.com/');
});
