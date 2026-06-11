import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

export type CastSessionState = 'idle' | 'starting' | 'connected' | 'ending';

type CastModuleType = {
  isSupported(): Promise<boolean>;
  showPicker(): Promise<boolean>;
  loadMedia(
    url: string,
    title: string,
    poster: string | null,
    currentTimeSec: number,
  ): Promise<boolean>;
  stop(): Promise<boolean>;
  getCurrentDeviceName(): Promise<string | null>;
  getCurrentPositionSec(): Promise<number>;
  getSessionState(): Promise<CastSessionState>;
};

const { CastModule } = NativeModules as { CastModule?: CastModuleType };

function ensureModule(): CastModuleType {
  if (!CastModule) {
    throw new Error(
      '[cast] CastModule not registered — check MainApplication.getPackages()',
    );
  }
  return CastModule;
}

export async function isCastSupported(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    return await ensureModule().isSupported();
  } catch (err) {
    console.warn('[cast] isSupported failed', err);
    return false;
  }
}

export async function loadCastMedia(
  url: string,
  title: string,
  poster: string | null,
  currentTimeSec: number,
): Promise<boolean> {
  return ensureModule().loadMedia(url, title, poster, currentTimeSec);
}

export async function stopCast(): Promise<boolean> {
  return ensureModule().stop();
}

export async function getCurrentDeviceName(): Promise<string | null> {
  try {
    return await ensureModule().getCurrentDeviceName();
  } catch (err) {
    console.warn('[cast] getCurrentDeviceName failed', err);
    return null;
  }
}

export async function getCurrentPositionSec(): Promise<number> {
  try {
    return await ensureModule().getCurrentPositionSec();
  } catch (err) {
    console.warn('[cast] getCurrentPositionSec failed', err);
    return 0;
  }
}

export async function getSessionState(): Promise<CastSessionState> {
  try {
    return await ensureModule().getSessionState();
  } catch (err) {
    console.warn('[cast] getSessionState failed', err);
    return 'idle';
  }
}

export type CastSessionEvent =
  | { type: 'CAST_SESSION_STARTED'; deviceName: string; durationSec: number }
  | { type: 'CAST_SESSION_RESUMED'; deviceName: string; durationSec: number }
  | { type: 'CAST_SESSION_ENDED'; error: number }
  | { type: 'CAST_SESSION_FAILED'; error: number }
  | { type: 'CAST_PICKER_DISMISSED' };

export function subscribeCastSessionEvents(
  cb: (event: CastSessionEvent) => void,
): () => void {
  const started = DeviceEventEmitter.addListener(
    'CAST_SESSION_STARTED',
    (params?: { deviceName?: string; durationSec?: number }) => {
      cb({
        type: 'CAST_SESSION_STARTED',
        deviceName: params?.deviceName ?? '',
        durationSec: params?.durationSec ?? 0,
      });
    },
  );
  const resumed = DeviceEventEmitter.addListener(
    'CAST_SESSION_RESUMED',
    (params?: { deviceName?: string; durationSec?: number }) => {
      cb({
        type: 'CAST_SESSION_RESUMED',
        deviceName: params?.deviceName ?? '',
        durationSec: params?.durationSec ?? 0,
      });
    },
  );
  const ended = DeviceEventEmitter.addListener(
    'CAST_SESSION_ENDED',
    (params?: { error?: number }) => {
      cb({ type: 'CAST_SESSION_ENDED', error: params?.error ?? 0 });
    },
  );
  const failed = DeviceEventEmitter.addListener(
    'CAST_SESSION_FAILED',
    (params?: { error?: number }) => {
      cb({ type: 'CAST_SESSION_FAILED', error: params?.error ?? 0 });
    },
  );
  const dismissed = DeviceEventEmitter.addListener(
    'CAST_PICKER_DISMISSED',
    () => {
      cb({ type: 'CAST_PICKER_DISMISSED' });
    },
  );
  return () => {
    started.remove();
    resumed.remove();
    ended.remove();
    failed.remove();
    dismissed.remove();
  };
}
