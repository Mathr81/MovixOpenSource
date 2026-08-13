import { NativeModules } from 'react-native';

interface PlaybackAwakeNativeModule {
  setLocalPlaybackAwake: (active: boolean) => void;
}

export function setLocalPlaybackAwake(active: boolean): void {
  const module = NativeModules.PlaybackAwake as PlaybackAwakeNativeModule | undefined;
  module?.setLocalPlaybackAwake(active);
}
