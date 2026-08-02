export type HlsQualityPreference = 'auto' | number;

export interface HlsLevelLike {
  height?: number;
  width?: number;
  bitrate?: number;
  averageBitrate?: number;
}

export interface HlsQualityOption {
  index: number;
  height: number;
  width: number;
  bitrate: number;
  label: string;
  sourceLevelIndices?: readonly number[];
}

export interface HlsQualityChoice {
  value: HlsQualityPreference;
  label: string;
}

export interface HlsAudioPreference {
  language: string;
  name: string;
}

function positiveFiniteNumberOrZero(value: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function buildHlsQualityOptions(levels: HlsLevelLike[]): HlsQualityOption[] {
  const byHeight = new Map<number, HlsQualityOption>();

  levels.forEach((level, index) => {
    const height = positiveFiniteNumberOrZero(level.height);
    if (height <= 0) return;

    const averageBitrate = positiveFiniteNumberOrZero(level.averageBitrate);
    const option: HlsQualityOption = {
      index,
      height,
      width: positiveFiniteNumberOrZero(level.width),
      bitrate: averageBitrate || positiveFiniteNumberOrZero(level.bitrate),
      label: `${height}p`,
      sourceLevelIndices: [index],
    };
    const current = byHeight.get(height);
    if (!current) {
      byHeight.set(height, option);
      return;
    }

    const sourceLevelIndices = [
      ...(current.sourceLevelIndices ?? [current.index]),
      index,
    ];
    byHeight.set(
      height,
      option.bitrate > current.bitrate
        ? { ...option, sourceLevelIndices }
        : { ...current, sourceLevelIndices },
    );
  });

  return [...byHeight.values()].sort(
    (left, right) => right.height - left.height || right.bitrate - left.bitrate,
  );
}

export function formatAvailableHlsQualities(
  options: ReadonlyArray<
    Pick<HlsQualityOption, 'height'>
    & Partial<Pick<HlsQualityOption, 'bitrate'>>
  >,
): string | null {
  const bitrateByHeight = new Map<number, number>();
  for (const option of options) {
    const height = positiveFiniteNumberOrZero(option.height);
    if (height <= 0) continue;

    const bitrate = positiveFiniteNumberOrZero(option.bitrate);
    bitrateByHeight.set(
      height,
      Math.max(bitrateByHeight.get(height) ?? 0, bitrate),
    );
  }
  const qualities = [...bitrateByHeight.entries()]
    .sort(([leftHeight], [rightHeight]) => leftHeight - rightHeight);

  return qualities.length > 0
    ? qualities.map(([height, bitrate]) => (
      bitrate > 0
        ? `${height}p (${Math.round(bitrate / 1000)} kbps)`
        : `${height}p`
    )).join(' · ')
    : null;
}

export function buildHlsQualityChoices(
  options: readonly HlsQualityOption[],
  autoLabel: string,
): HlsQualityChoice[] {
  const manifestChoices = options.map(option => ({
    value: option.height,
    label: option.label,
  }));

  return options.length > 1
    ? [{ value: 'auto', label: autoLabel }, ...manifestChoices]
    : manifestChoices;
}

export function selectLevelForPreference(
  options: HlsQualityOption[],
  preference: HlsQualityPreference,
  maxHeight = 1080,
): number {
  if (options.length === 0) return -1;

  const requestedHeight = preference === 'auto' ? maxHeight : preference;
  let highestEligible: HlsQualityOption | undefined;
  let lowestAvailable: HlsQualityOption | undefined;

  for (const option of options) {
    if (!lowestAvailable || option.height < lowestAvailable.height) {
      lowestAvailable = option;
    }
    if (
      option.height <= requestedHeight
      && (!highestEligible || option.height > highestEligible.height)
    ) {
      highestEligible = option;
    }
  }

  return (highestEligible ?? lowestAvailable)?.index ?? -1;
}

export function selectLowerLevelIndex(
  options: HlsQualityOption[],
  failedLevelIndex: number,
): number {
  const failed = options.find(option => (
    option.index === failedLevelIndex
    || option.sourceLevelIndices?.includes(failedLevelIndex)
  ));
  if (!failed) return -1;

  let nearestLower: HlsQualityOption | undefined;
  for (const option of options) {
    if (
      option.height < failed.height
      && (!nearestLower || option.height > nearestLower.height)
    ) {
      nearestLower = option;
    }
  }

  return nearestLower?.index ?? -1;
}

export function getFailingLevelIndex(
  data: {
    level?: number;
    frag?: { level?: number };
    context?: { level?: number };
  },
  hls: {
    currentLevel?: number;
    loadLevel?: number;
    nextLoadLevel?: number;
  },
): number {
  const indices = [
    data.level,
    data.frag?.level,
    data.context?.level,
    hls.currentLevel,
    hls.loadLevel,
    hls.nextLoadLevel,
  ];
  return indices.find(index => Number.isInteger(index) && Number(index) >= 0) ?? -1;
}

const VIDEO_FAILURE_DETAILS = new Set([
  'levelLoadError',
  'levelLoadTimeOut',
  'fragLoadError',
  'fragLoadTimeOut',
]);

export function isVideoLevelFailure(data: {
  fatal?: boolean;
  details?: string;
  level?: number;
  response?: { code?: number };
  frag?: { type?: string; level?: number };
}): boolean {
  if (!data.fatal || !VIDEO_FAILURE_DETAILS.has(String(data.details))) return false;
  if (data.frag?.type && !['main', 'video'].includes(data.frag.type)) return false;

  const status = data.response?.code;
  return status == null || [0, 403, 404].includes(status);
}

export function selectAudioTrackIndex(
  tracks: Array<{ lang?: string; language?: string; name?: string }>,
  preference: HlsAudioPreference | null,
): number {
  if (!preference) return -1;

  const language = preference.language.toLowerCase();
  if (language) {
    const byLanguage = tracks.findIndex(track => (
      [track.lang, track.language].some(
        candidate => candidate?.toLowerCase() === language,
      )
    ));
    if (byLanguage >= 0) return byLanguage;
  }

  const name = preference.name.toLowerCase();
  if (!name) return -1;
  return tracks.findIndex(track => track.name?.toLowerCase() === name);
}
