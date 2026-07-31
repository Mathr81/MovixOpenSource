import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canReusePendingApk,
  decideUpdateForegroundAction,
} from '../src/hooks/updateResume.ts';

test('continues automatically after the install permission is granted', () => {
  assert.equal(
    decideUpdateForegroundAction({
      stage: 'need_permission',
      installPermissionGranted: true,
      localBuildNumber: 10,
      targetBuildNumber: 11,
    }),
    'continue_after_permission',
  );
  assert.equal(
    decideUpdateForegroundAction({
      stage: 'need_permission',
      installPermissionGranted: false,
      localBuildNumber: 10,
      targetBuildNumber: 11,
    }),
    'none',
  );
});

test('distinguishes a completed install from an installer cancellation', () => {
  assert.equal(
    decideUpdateForegroundAction({
      stage: 'installing',
      installPermissionGranted: true,
      localBuildNumber: 11,
      targetBuildNumber: 11,
    }),
    'installed',
  );
  assert.equal(
    decideUpdateForegroundAction({
      stage: 'installing',
      installPermissionGranted: true,
      localBuildNumber: 10,
      targetBuildNumber: 11,
    }),
    'install_not_completed',
  );
});

test('only reuses a matching, verified APK download', () => {
  const validPending = {
    downloadId: 42,
    targetBuildNumber: 11,
    targetVersion: '2.5.2',
    targetSha256: 'A'.repeat(64),
    apkFilePath: 'C:\\downloads\\movix-android-11.apk',
    startedAt: '2026-07-27T12:00:00.000Z',
  };

  assert.equal(canReusePendingApk(validPending, 11), true);
  assert.equal(canReusePendingApk(validPending, 12), false);
  assert.equal(
    canReusePendingApk({ ...validPending, apkFilePath: '' }, 11),
    false,
  );
  assert.equal(
    canReusePendingApk({ ...validPending, apkFilePath: 'movix.zip' }, 11),
    false,
  );
  assert.equal(
    canReusePendingApk({ ...validPending, targetSha256: 'bad' }, 11),
    false,
  );
});
