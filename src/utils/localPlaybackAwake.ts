export interface LocalPlaybackAwakeState {
  isPlaying: boolean;
  isCasting: boolean;
  hasFatalError: boolean;
  isClosed: boolean;
}

export interface LocalPlaybackAwakeLease {
  setActive(active: boolean): void;
  release(): void;
}

declare global {
  interface Window {
    MovixAndroidPlaybackAwake?: { setActive: (active: boolean) => void };
  }
}

const activeLeases = new Set<symbol>();
let aggregateActive = false;

export function shouldKeepLocalPlaybackAwake(state: LocalPlaybackAwakeState): boolean {
  return state.isPlaying && !state.isCasting && !state.hasFatalError && !state.isClosed;
}

export function setLocalPlaybackAwake(active: boolean): void {
  if (typeof window !== 'undefined') {
    window.MovixAndroidPlaybackAwake?.setActive(active);
  }
}

function reportAggregateTransition(): void {
  const nextActive = activeLeases.size > 0;
  if (nextActive === aggregateActive) return;
  aggregateActive = nextActive;
  setLocalPlaybackAwake(nextActive);
}

export function createLocalPlaybackAwakeLease(): LocalPlaybackAwakeLease {
  const leaseId = Symbol('local-playback-awake');
  let active = false;
  let released = false;

  return {
    setActive(nextActive: boolean): void {
      if (released || nextActive === active) return;
      active = nextActive;
      if (active) activeLeases.add(leaseId);
      else activeLeases.delete(leaseId);
      reportAggregateTransition();
    },
    release(): void {
      if (released) return;
      released = true;
      if (!active) return;
      active = false;
      activeLeases.delete(leaseId);
      reportAggregateTransition();
    },
  };
}
