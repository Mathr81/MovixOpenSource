interface ProfileWithId {
  id: string;
}

interface ProfileSelectionTransactionOptions<TProfile extends ProfileWithId> {
  profile: TProfile;
  hydrateProfileData: (
    profileId: string,
    isIntentCurrent: () => boolean,
  ) => Promise<boolean>;
  persistSelectedProfileId: (profileId: string) => void;
  publishCurrentProfile: (profile: TProfile) => void;
  notifyProfileDataUpdated: () => void;
  isIntentCurrent?: () => boolean;
}

interface ProfileHydrationRequest {
  isCurrent: () => boolean;
  finish: () => void;
}

interface LatestProfileHydrationGuard {
  begin: () => ProfileHydrationRequest;
  releaseLoadingIfIdle: () => void;
}

interface ProfileIntentRequest {
  isCurrent: () => boolean;
}

interface LatestProfileIntentGuard {
  begin: () => ProfileIntentRequest;
}

interface DeletedProfileSelectionCleanupOptions {
  deletedProfileId: string;
  readSelectedProfileId: () => string | null;
  clearCurrentProfile: () => void;
  clearSelectedProfileId: () => void;
  notifyProfileDataUpdated: () => void;
}

export function clearDeletedProfileSelectionIfStillActive({
  deletedProfileId,
  readSelectedProfileId,
  clearCurrentProfile,
  clearSelectedProfileId,
  notifyProfileDataUpdated,
}: DeletedProfileSelectionCleanupOptions): boolean {
  if (readSelectedProfileId() !== deletedProfileId) return false;

  clearCurrentProfile();
  clearSelectedProfileId();
  notifyProfileDataUpdated();
  return true;
}

export function createLatestProfileIntentGuard(): LatestProfileIntentGuard {
  let latestIntentId = 0;

  return {
    begin() {
      latestIntentId += 1;
      const intentId = latestIntentId;
      return {
        isCurrent: () => intentId === latestIntentId,
      };
    },
  };
}

export function createLatestProfileHydrationGuard(
  setLoading: (loading: boolean) => void,
): LatestProfileHydrationGuard {
  let latestRequestId = 0;
  let activeRequestId: number | null = null;

  return {
    begin() {
      latestRequestId += 1;
      const requestId = latestRequestId;
      activeRequestId = requestId;
      setLoading(true);

      return {
        isCurrent: () => requestId === latestRequestId,
        finish() {
          if (requestId !== latestRequestId) return;
          activeRequestId = null;
          setLoading(false);
        },
      };
    },
    releaseLoadingIfIdle() {
      if (activeRequestId === null) {
        setLoading(false);
      }
    },
  };
}

export async function commitProfileSelection<TProfile extends ProfileWithId>({
  profile,
  hydrateProfileData,
  persistSelectedProfileId,
  publishCurrentProfile,
  notifyProfileDataUpdated,
  isIntentCurrent = () => true,
}: ProfileSelectionTransactionOptions<TProfile>): Promise<boolean> {
  const hydrated = await hydrateProfileData(profile.id, isIntentCurrent);
  if (!hydrated || !isIntentCurrent()) return false;

  persistSelectedProfileId(profile.id);
  publishCurrentProfile(profile);
  notifyProfileDataUpdated();
  return true;
}
