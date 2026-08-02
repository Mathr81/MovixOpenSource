import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bridge = await readFile(
  new URL('../src/services/bridge.ts', import.meta.url),
  'utf8',
);
const cast = await readFile(
  new URL('../src/services/cast.ts', import.meta.url),
  'utf8',
);
const browser = await readFile(
  new URL('../src/screens/BrowserScreen.tsx', import.meta.url),
  'utf8',
);
const webView = await readFile(
  new URL('../src/components/WebViewBrowser.tsx', import.meta.url),
  'utf8',
);
const shim = await readFile(
  new URL('../src/injection/cast-shim.ts', import.meta.url),
  'utf8',
);

test('bridge consumes structured prepared source and resolves from native load result', () => {
  assert.match(
    bridge,
    /CASTSHIM_LOAD_MEDIA[\s\S]*?source:\s*PreparedCastSource[\s\S]*?metadata:\s*CastLoadMetadata/,
  );
  assert.match(bridge, /loadCastMedia\(source,\s*nativeMetadata,\s*currentTime\)/);
  assert.doesNotMatch(bridge, /pendingLoadMediaIds/);
  assert.doesNotMatch(bridge, /case\s+'CAST_SESSION_STARTED'/);
});

test('native status is allow-listed before one redacted status event is injected', () => {
  assert.match(cast, /normalizeNativeCastStatus/);
  assert.match(cast, /CAST_MEDIA_STATUS/);
  assert.match(bridge, /kind:\s*'STATUS_EVENT'/);
  assert.match(bridge, /sendShimStatusEvent/);
  const statusForwarder = bridge.match(
    /function sendShimStatusEvent[\s\S]*?\n}\r?\n/,
  )?.[0] ?? '';
  assert.doesNotMatch(statusForwarder, /(?:url|headers|token|receiverIp)/i);
});

test('resume refreshes authoritative status before injecting it', () => {
  assert.match(browser, /AppState\.addEventListener\(\s*'change'/);
  assert.match(browser, /nextState\s*===\s*'active'[\s\S]*?refreshCastShimStatus/);
  assert.match(bridge, /refreshCastShimStatus[\s\S]*?getCastStatus\(true\)/);
});

test('sensitive playback-awake and Cast messages require trusted source provenance', () => {
  assert.match(bridge, /isTrustedMovixBridgeUrl/);
  assert.match(bridge, /PLAYBACK_AWAKE_SET[\s\S]*?MOVIX_PLAYBACK_AWAKE_V1/);
  assert.match(bridge, /CASTSHIM_[\s\S]*?trusted/i);
});

test('Cast commands require an unguessable per-injection capability', () => {
  assert.match(shim, /crypto\.getRandomValues/);
  assert.match(shim, /postMessage\.bind\(nativeWebView\)/);
  assert.match(shim, /CASTSHIM_REGISTER_CAPABILITY/);
  assert.match(shim, /capability:\s*castCapability/);
  assert.match(bridge, /new WeakMap<object,\s*string>/);
  assert.match(
    bridge,
    /CASTSHIM_REGISTER_CAPABILITY[\s\S]*?!castShimCapabilities\.has\(webViewRef\)/,
  );
  assert.match(
    bridge,
    /p\.capability !== castShimCapabilities\.get\(webViewRef\)/,
  );
  assert.match(webView, /clearBridgeCapabilities\(webViewRef\)/);
});

test('top-frame navigation and reload clear the previous document capability', () => {
  assert.match(
    webView,
    /reload:\s*\(\)\s*=>\s*\{[\s\S]*?clearBridgeCapabilities\(webViewRef\)[\s\S]*?\.reload\(\)/,
  );
  assert.match(
    webView,
    /onShouldStartLoadWithRequest=\{\(request\)\s*=>\s*\{[\s\S]*?request\.isTopFrame !== false[\s\S]*?clearBridgeCapabilities\(webViewRef\)/,
  );
  assert.match(
    webView,
    /React\.useEffect\(\(\)\s*=>\s*\{[\s\S]*?return\s*\(\)\s*=>\s*\{[\s\S]*?clearBridgeCapabilities\(webViewRef\)/,
  );
  assert.doesNotMatch(webView, /onLoadStart=\{[^}]*clearBridgeCapabilities/);
});
