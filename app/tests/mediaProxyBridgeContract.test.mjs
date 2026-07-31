import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('TypeScript bridge exposes the GM_OPEN_MEDIA_PROXY native contract', async () => {
  const bridge = await read('src/services/bridge.ts');

  assert.match(bridge, /GM_OPEN_MEDIA_PROXY/);
  assert.match(bridge, /NativeModules\.MediaProxy/);
  assert.match(bridge, /\.open\s*\(\s*req\.url/);
  assert.match(bridge, /case\s+['"]GM_FETCH['"]/);
});

test('Android registers the MediaProxy native package', async () => {
  const application = await read(
    'android/app/src/main/java/com/movix/app/MainApplication.kt',
  );
  const packageSource = await read(
    'android/app/src/main/java/com/movix/app/proxy/MediaProxyPackage.kt',
  );
  const moduleSource = await read(
    'android/app/src/main/java/com/movix/app/proxy/MediaProxyModule.kt',
  );

  assert.match(application, /add\(MediaProxyPackage\(\)\)/);
  assert.match(packageSource, /MediaProxyModule\(reactContext\)/);
  assert.match(moduleSource, /override fun getName\(\)\s*=\s*"MediaProxy"/);
  assert.match(moduleSource, /fun open\(/);
  assert.match(moduleSource, /server\.open\(/);
});
