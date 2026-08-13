export interface LocalPlaybackInitPolicy {
  shouldInitialize: boolean;
  shouldAutoplay: boolean;
  shouldRestorePosition: boolean;
}

export interface LocalPlaybackInitPolicyInput {
  wasCasting: boolean;
  isCasting: boolean;
}

export interface LocalPlaybackSeekInput {
  clientX: number;
  left: number;
  width: number;
  duration: number;
}

export function normalizeLocalMediaDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function getLocalPlaybackSeekTime({
  clientX,
  left,
  width,
  duration,
}: LocalPlaybackSeekInput): number | null {
  const finiteDuration = normalizeLocalMediaDuration(duration);
  if (
    finiteDuration === 0
    || !Number.isFinite(clientX)
    || !Number.isFinite(left)
    || !Number.isFinite(width)
    || width <= 0
  ) {
    return null;
  }

  const progress = Math.max(0, Math.min(1, (clientX - left) / width));
  const seekTime = progress * finiteDuration;
  return Number.isFinite(seekTime) ? seekTime : null;
}

export function getLocalPlaybackInitPolicy({
  wasCasting,
  isCasting,
}: LocalPlaybackInitPolicyInput): LocalPlaybackInitPolicy {
  const recoveredFromCast = wasCasting && !isCasting;

  return {
    shouldInitialize: !isCasting,
    shouldAutoplay: !isCasting && !recoveredFromCast,
    shouldRestorePosition: !isCasting && !recoveredFromCast,
  };
}
