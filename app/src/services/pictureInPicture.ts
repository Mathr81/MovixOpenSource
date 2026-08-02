import { NativeEventEmitter, NativeModules } from 'react-native';

export type PictureInPictureAction =
  | 'seek-backward'
  | 'toggle-playback'
  | 'seek-forward';

const PICTURE_IN_PICTURE_ACTIONS = new Set<PictureInPictureAction>([
  'seek-backward',
  'toggle-playback',
  'seek-forward',
]);

export type PictureInPictureEvent =
  | { kind: 'prepare' }
  | { kind: 'state'; active: boolean }
  | { kind: 'error'; code: string }
  | { kind: 'action'; action: PictureInPictureAction };

interface NativePictureInPicture {
  isSupported(): Promise<boolean>;
  setPlaybackActive(active: boolean): void;
  enter(): Promise<void>;
  exit(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const EVENT_NAME = 'MOVIX_PICTURE_IN_PICTURE';

function module(): NativePictureInPicture | undefined {
  return NativeModules.PictureInPicture as NativePictureInPicture | undefined;
}

export async function isPictureInPictureSupported(): Promise<boolean> {
  const native = module();
  return native ? native.isSupported().catch(() => false) : false;
}

export function setPictureInPicturePlaybackActive(active: boolean): void {
  module()?.setPlaybackActive(active);
}

export async function enterPictureInPicture(): Promise<void> {
  const native = module();
  if (!native) throw new Error('PIP_UNAVAILABLE');
  await native.enter();
}

export async function exitPictureInPicture(): Promise<void> {
  const native = module();
  if (!native) throw new Error('PIP_UNAVAILABLE');
  await native.exit();
}

export function parsePictureInPictureEvent(
  value: unknown,
): PictureInPictureEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'prepare') return { kind: 'prepare' };
  if (raw.kind === 'state' && typeof raw.active === 'boolean') {
    return { kind: 'state', active: raw.active };
  }
  if (
    raw.kind === 'error'
    && typeof raw.code === 'string'
    && raw.code.length > 0
    && raw.code.length <= 64
  ) {
    return { kind: 'error', code: raw.code };
  }
  if (
    raw.kind === 'action'
    && typeof raw.action === 'string'
    && PICTURE_IN_PICTURE_ACTIONS.has(raw.action as PictureInPictureAction)
  ) {
    return { kind: 'action', action: raw.action as PictureInPictureAction };
  }
  return null;
}

export function subscribePictureInPicture(
  listener: (event: PictureInPictureEvent) => void,
): () => void {
  const native = module();
  if (!native) return () => undefined;
  const subscription = new NativeEventEmitter(native).addListener(EVENT_NAME, value => {
    const event = parsePictureInPictureEvent(value);
    if (event) listener(event);
  });
  return () => subscription.remove();
}
