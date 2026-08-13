import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const shim = await readFile(
  new URL('../src/injection/cast-shim.ts', import.meta.url),
  'utf8',
);
const bridge = await readFile(
  new URL('../src/services/bridge.ts', import.meta.url),
  'utf8',
);
const cast = await readFile(
  new URL('../src/services/cast.ts', import.meta.url),
  'utf8',
);

test('relay disclosure settings use dedicated versioned bridge commands', () => {
  for (const command of [
    'CASTSHIM_GET_RELAY_DISCLOSURE_PREFERENCE',
    'CASTSHIM_SET_RELAY_DISCLOSURE_SUPPRESSED',
    'CASTSHIM_OPEN_BATTERY_SETTINGS',
    'CASTSHIM_REQUEST_NOTIFICATION_PERMISSION',
  ]) {
    assert.match(shim, new RegExp(command));
    assert.match(bridge, new RegExp(command));
  }
  assert.match(cast, /getRelayDisclosurePreference/);
  assert.match(cast, /setRelayDisclosureSuppressed/);
  assert.match(cast, /openCastBatterySettings/);
  assert.match(cast, /requestCastRelayNotificationPermission/);
});

test('notification permission is optional and never gates a Cast attempt', () => {
  assert.match(
    shim,
    /requestRelayNotificationPermission[\s\S]*?callNative\('CASTSHIM_REQUEST_NOTIFICATION_PERMISSION'\)\.catch/,
  );
  assert.match(
    bridge,
    /CASTSHIM_REQUEST_NOTIFICATION_PERMISSION[\s\S]*?requestCastRelayNotificationPermission\(\)[\s\S]*?sendShimResponse/,
  );
});
