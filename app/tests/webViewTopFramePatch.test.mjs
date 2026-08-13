import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.basename(process.cwd()) === 'app'
  ? process.cwd()
  : path.resolve(process.cwd(), 'app');
const read = relativePath => readFile(path.join(ROOT, relativePath), 'utf8');

test('Android WebMessageListener preserves isMainFrame in the onMessage event', async () => {
  const source = await read('node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java');
  assert.match(
    source,
    /String sourceUrl = sourceOrigin\.toString\(\);[\s\S]*?isMainFrame && TextUtils\.isEmpty\(sourceUrl\)[\s\S]*?sourceUrl = view\.getUrl\(\);[\s\S]*?onMessage\(message\.getData\(\), sourceUrl, isMainFrame\)/,
  );
  assert.match(source, /void onMessage\(String message, String sourceUrl, boolean isTopFrame\)/);
  assert.match(source, /data\.putBoolean\("isTopFrame", isTopFrame\)/);
});

test('Android fallback messages are explicitly marked as non-top-frame', async () => {
  const source = await read('node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java');
  assert.match(source, /onMessage\(message, mWebView\.getUrl\(\), false\)/);
});

test('react-native-webview exposes isTopFrame on WebViewMessage source and published typings', async () => {
  const [nativeComponent, sourceTypes, publishedTypes] = await Promise.all([
    read('node_modules/react-native-webview/src/RNCWebViewNativeComponent.ts'),
    read('node_modules/react-native-webview/src/WebViewTypes.ts'),
    read('node_modules/react-native-webview/lib/WebViewTypes.d.ts'),
  ]);
  assert.match(nativeComponent, /export type WebViewMessageEvent[\s\S]*?isTopFrame: boolean;/);
  assert.match(sourceTypes, /interface WebViewMessage extends WebViewNativeEvent \{[\s\S]*?isTopFrame: boolean;/);
  assert.match(publishedTypes, /interface WebViewMessage extends WebViewNativeEvent \{[\s\S]*?isTopFrame: boolean;/);
});
