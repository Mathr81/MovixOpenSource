export type UpdateForegroundAction =
  | 'none'
  | 'continue_after_permission'
  | 'installed'
  | 'install_not_completed';

type UpdateForegroundInput = {
  stage: string;
  installPermissionGranted: boolean;
  localBuildNumber: number;
  targetBuildNumber: number;
};

type PendingApkCandidate = {
  targetBuildNumber: number;
  targetSha256: string;
  apkFilePath: string;
};

export function decideUpdateForegroundAction({
  stage,
  installPermissionGranted,
  localBuildNumber,
  targetBuildNumber,
}: UpdateForegroundInput): UpdateForegroundAction {
  if (stage === 'need_permission') {
    return installPermissionGranted && localBuildNumber < targetBuildNumber
      ? 'continue_after_permission'
      : 'none';
  }

  if (stage === 'installing') {
    return localBuildNumber >= targetBuildNumber
      ? 'installed'
      : 'install_not_completed';
  }

  return 'none';
}

export function canReusePendingApk(
  pending: PendingApkCandidate | null,
  targetBuildNumber: number,
): boolean {
  if (!pending || pending.targetBuildNumber !== targetBuildNumber) {
    return false;
  }

  return (
    /^[a-f0-9]{64}$/i.test(pending.targetSha256) &&
    /\.apk$/i.test(pending.apkFilePath.trim())
  );
}
