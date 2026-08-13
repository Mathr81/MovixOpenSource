import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.basename(process.cwd()) === 'app'
  ? process.cwd()
  : path.resolve(process.cwd(), 'app');
const read = relativePath => readFile(path.join(ROOT, relativePath), 'utf8');

test('injected playback-awake shim posts one message only for active-state transitions and can force false', async () => {
  const shim = await read('src/injection/playback-awake-shim.ts');

  assert.match(shim, /MovixAndroidPlaybackAwake/);
  assert.match(shim, /PLAYBACK_AWAKE_SET/);
  assert.match(shim, /if \(active === lastActive\) return/);
  assert.match(shim, /setActive\(false\)/);
});

test('native bridge validates PLAYBACK_AWAKE_SET and updates awake and PiP eligibility together', async () => {
  const bridge = await read('src/services/bridge.ts');

  assert.match(bridge, /'PLAYBACK_AWAKE_SET'/);
  assert.match(bridge, /typeof p\.active === 'boolean'/);
  assert.match(bridge, /NativeModules\.PlaybackAwake/);
  assert.match(bridge, /setLocalPlaybackAwake\(p\.active\)/);
  assert.match(bridge, /setPictureInPicturePlaybackActive/);
  assert.match(bridge, /setPictureInPicturePlaybackActive\(p\.active\)/);
});

test('WebView and Browser lifecycle cleanup force the native awake state off', async () => {
  const [webView, browser] = await Promise.all([
    read('src/components/WebViewBrowser.tsx'),
    read('src/screens/BrowserScreen.tsx'),
  ]);

  assert.match(webView, /setLocalPlaybackAwake\(false\)/);
  assert.match(browser, /setLocalPlaybackAwake\(false\)/);
});
