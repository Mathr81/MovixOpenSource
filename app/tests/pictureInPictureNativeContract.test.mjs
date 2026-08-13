import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('manifest and activity expose PiP lifecycle', async () => {
  const [manifest, activity] = await Promise.all([
    read('android/app/src/main/AndroidManifest.xml'),
    read('android/app/src/main/java/com/movix/app/MainActivity.kt'),
  ]);
  assert.match(manifest, /android:supportsPictureInPicture="true"/);
  assert.match(activity, /onUserLeaveHint\(\)/);
  assert.match(activity, /onPictureInPictureRequested\(\)/);
  assert.match(activity, /onPictureInPictureModeChanged/);
  assert.match(activity, /onPictureInPictureUiStateChanged/);
  assert.match(activity, /isTransitioningToPip/);
  assert.match(activity, /PictureInPictureController/);
});

test('application registers the bounded native module', async () => {
  const [application, module, packageSource] = await Promise.all([
    read('android/app/src/main/java/com/movix/app/MainApplication.kt'),
    read('android/app/src/main/java/com/movix/app/pip/PictureInPictureModule.kt'),
    read('android/app/src/main/java/com/movix/app/pip/PictureInPicturePackage.kt'),
  ]);
  assert.match(application, /add\(PictureInPicturePackage\(\)\)/);
  assert.match(module, /override fun getName\(\) = "PictureInPicture"/);
  assert.match(module, /fun setPlaybackActive\(active: Boolean\)/);
  assert.match(module, /MOVIX_PICTURE_IN_PICTURE/);
  assert.match(packageSource, /PictureInPictureModule\(reactContext\)/);
});

test('module clears PiP playback on the UI thread before unsubscribing', async () => {
  const module = await read('android/app/src/main/java/com/movix/app/pip/PictureInPictureModule.kt');
  assert.match(
    module,
    /override fun invalidate\(\) \{\s*val activity = currentActivity as\? MainActivity\s*activity\?\.runOnUiThread \{\s*activity\.pictureInPictureController\.setPlaybackActive\(false\)\s*finishInvalidation\(\)\s*} \?: finishInvalidation\(\)\s*}/,
  );
  assert.match(
    module,
    /private fun finishInvalidation\(\) \{\s*unsubscribe\?\.invoke\(\)\s*context\.removeLifecycleEventListener\(this\)\s*super\.invalidate\(\)\s*}/,
  );
});

test('PiP host exposes three immutable package-local actions', async () => {
  const [manifest, host] = await Promise.all([
    read('android/app/src/main/AndroidManifest.xml'),
    read('android/app/src/main/java/com/movix/app/pip/AndroidPictureInPictureHost.kt'),
  ]);
  assert.match(host, /runCatching \{ actions\(playbackPlaying\) \}/);
  assert.match(host, /let\(builder::setActions\)/);
  assert.match(host, /FLAG_IMMUTABLE/);
  assert.match(host, /PictureInPictureActionReceiver::class\.java/);
  assert.match(host, /SEEK_BACKWARD/);
  assert.match(host, /TOGGLE_PLAYBACK/);
  assert.match(host, /SEEK_FORWARD/);
  assert.match(manifest, /PictureInPictureActionReceiver/);
  assert.match(manifest, /android:exported="false"/);
});
