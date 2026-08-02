export interface LocalPlaybackInitPolicy {
  shouldInitialize: boolean;
  shouldAutoplay: boolean;
  shouldRestorePosition: boolean;
}

export interface LocalPlaybackInitPolicyInput {
  wasCasting: boolean;
  isCasting: boolean;
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
