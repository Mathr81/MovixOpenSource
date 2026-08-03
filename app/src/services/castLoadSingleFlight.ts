import type { CastLoadMetadata, PreparedCastSource, PreparedCastTrack } from './cast';

const RECENT_SUCCESS_WINDOW_MS = 3_000;
const RECENT_LOGICAL_SUCCESS_WINDOW_MS = 2_000;

type Clock = () => number;

type ActiveLoad<T> = {
  identity: CastLoadIdentity;
  promise: Promise<T>;
  succeededAt?: number;
};

export type CastLoadIdentity = {
  exact: string;
  logical: string;
};

type NormalizedSource = {
  url: string;
  contentType: string | null;
  protocolVersion: 1;
  headers: readonly (readonly [string, string])[];
  tracks?: readonly NormalizedTrack[];
};

type NormalizedTrack = Omit<NormalizedSource, 'tracks'> & {
  inlineVtt: string | null;
  language: string | null;
  name: string | null;
  active: boolean | null;
};

export type CastLoadRun<T> = {
  promise: Promise<T>;
  coalesced: boolean;
};

export type CastLoadSingleFlight = {
  run<T>(identity: CastLoadIdentity, operation: () => Promise<T>): CastLoadRun<T>;
};

export function createCastLoadIdentity(
  source: PreparedCastSource,
  metadata: CastLoadMetadata,
): CastLoadIdentity {
  return {
    exact: JSON.stringify({
      source: normalizeSource(source),
      metadata: normalizeMetadata(metadata),
    }),
    logical: JSON.stringify({
      source: {
        contentType: normalizeContentType(source.contentType),
        tracks: source.tracks?.map(normalizeTrackPresentation) ?? [],
      },
      metadata: normalizeMetadata(metadata),
    }),
  };
}

function normalizeMetadata(metadata: CastLoadMetadata) {
  return {
    title: metadata.title,
    poster: metadata.poster ?? null,
  };
}

function normalizeSource(
  source: PreparedCastSource,
): NormalizedSource {
  const normalized = {
    url: source.url,
    contentType: source.contentType ?? null,
    protocolVersion: source.protocolVersion,
    headers: Object.entries(source.headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  };
  if (!('tracks' in source) || !source.tracks) return normalized;
  return {
    ...normalized,
    tracks: source.tracks.map(normalizeTrack),
  };
}

function normalizeTrack(track: PreparedCastTrack): NormalizedTrack {
  if (typeof track.inlineVtt === 'string') {
    return {
      url: '',
      inlineVtt: track.inlineVtt,
      contentType: track.contentType ?? null,
      protocolVersion: track.protocolVersion,
      headers: [],
      language: track.language ?? null,
      name: track.name ?? null,
      active: track.active ?? null,
    };
  }
  return {
    ...normalizeSource(track),
    inlineVtt: null,
    language: track.language ?? null,
    name: track.name ?? null,
    active: track.active ?? null,
  };
}

function normalizeTrackPresentation(track: PreparedCastTrack) {
  return {
    contentType: normalizeContentType(track.contentType),
    language: track.language ?? null,
    name: track.name ?? null,
    active: track.active ?? null,
  };
}

function normalizeContentType(contentType: string | undefined): string | null {
  return contentType?.trim().toLowerCase() ?? null;
}

export function createCastLoadSingleFlight(options: {
  clock?: Clock;
  recentSuccessWindowMs?: number;
  recentLogicalSuccessWindowMs?: number;
} = {}): CastLoadSingleFlight {
  const clock = options.clock ?? Date.now;
  const recentSuccessWindowMs =
    options.recentSuccessWindowMs ?? RECENT_SUCCESS_WINDOW_MS;
  const recentLogicalSuccessWindowMs =
    options.recentLogicalSuccessWindowMs ?? RECENT_LOGICAL_SUCCESS_WINDOW_MS;
  let active: ActiveLoad<unknown> | undefined;

  return {
    run<T>(identity: CastLoadIdentity, operation: () => Promise<T>): CastLoadRun<T> {
      const current = active as ActiveLoad<T> | undefined;
      if (current?.identity.exact === identity.exact) {
        if (current.succeededAt === undefined || clock() - current.succeededAt <= recentSuccessWindowMs) {
          return { promise: current.promise, coalesced: true };
        }
      } else if (
        current?.succeededAt !== undefined
        && current.identity.logical === identity.logical
        && clock() - current.succeededAt <= recentLogicalSuccessWindowMs
      ) {
        return { promise: current.promise, coalesced: true };
      }

      let promise: Promise<T>;
      try {
        promise = Promise.resolve(operation());
      } catch (error) {
        promise = Promise.reject(error);
      }
      const record: ActiveLoad<T> = { identity, promise };
      active = record;
      void promise.then(
        () => {
          if (active === record) record.succeededAt = clock();
        },
        () => {
          if (active === record) active = undefined;
        },
      );
      return { promise, coalesced: false };
    },
  };
}
