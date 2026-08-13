export type SeekStreamingCandidateKind = 'cfNative' | 'source';

export interface SeekStreamingCandidate {
  kind: SeekStreamingCandidateKind;
  url: string;
}

export interface SeekStreamingResultLike {
  success?: boolean;
  hlsUrl?: string;
  url?: string;
  ip_url?: string;
  candidates?: unknown;
  hlsCandidates?: unknown;
}

export interface SeekStreamingHlsSource {
  url: string;
  label: string;
  seekKind?: SeekStreamingCandidateKind;
  seekGroupKey?: string;
  seekEmbedUrl?: string;
}

export interface SeekStreamingBulkExpected {
  type: string;
  url: string;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
    );
  } catch {
    return false;
  }
}

const MAX_CF_MASTER_DECODE_PASSES = 4;

function decodePercentLayer(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
  }
}

function isHistoricalCfMasterUrl(url: string): boolean {
  let decoded = url;
  for (let pass = 0; pass <= MAX_CF_MASTER_DECODE_PASSES; pass += 1) {
    if (/cf-master/i.test(decoded)) return true;

    const next = decodePercentLayer(decoded);
    if (next === decoded) return false;
    decoded = next;
  }
  return false;
}

function isSeekStreamingProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /\/seekstreaming-proxy\/?$/i.test(parsed.pathname)
      && parsed.searchParams.has('url')
    );
  } catch {
    return false;
  }
}

export function normalizeSeekStreamingCandidates(payload: unknown): SeekStreamingCandidate[] {
  if (!payload || typeof payload !== 'object') return [];

  const data = payload as SeekStreamingResultLike;
  const explicit = Array.isArray(data.hlsCandidates)
    ? data.hlsCandidates
    : (Array.isArray(data.candidates) ? data.candidates : []);
  const candidates: SeekStreamingCandidate[] = [];
  const seen = new Set<string>();

  const add = (kind: SeekStreamingCandidateKind, url: unknown) => {
    if (
      !isHttpUrl(url)
      || (kind === 'source' && isHistoricalCfMasterUrl(url))
      || seen.has(url)
    ) {
      return;
    }
    seen.add(url);
    candidates.push({ kind, url });
  };

  for (const candidate of explicit) {
    if (!candidate || typeof candidate !== 'object') continue;

    const item = candidate as { kind?: unknown; url?: unknown };
    if (item.kind === 'cfNative' || item.kind === 'source') {
      add(item.kind, item.url);
    }
  }

  if (candidates.length === 0) {
    add('source', data.hlsUrl);
    if (
      typeof data.url === 'string'
      && !isSeekStreamingEmbedUrl(data.url)
      && (
        !isHistoricalCfMasterUrl(data.url)
        || isSeekStreamingProxyUrl(data.url)
      )
    ) {
      add('cfNative', data.url);
    }
    add('source', data.ip_url);
  }

  return candidates;
}

export function expandSeekStreamingSources<T extends Record<string, unknown>>(
  result: SeekStreamingResultLike | null | undefined,
  base: T & { label: string },
): Array<T & SeekStreamingHlsSource> {
  const candidates = normalizeSeekStreamingCandidates(result);
  const seekEmbedUrl = typeof base.seekEmbedUrl === 'string'
    ? base.seekEmbedUrl
    : undefined;
  const seekGroupKey = seekEmbedUrl
    ? `embed:${getSeekStreamingEmbedIdentity(seekEmbedUrl)}`
    : `candidates:${JSON.stringify(
      candidates.map(candidate => [candidate.kind, candidate.url]),
    )}`;

  return candidates.map(candidate => ({
    ...base,
    url: candidate.url,
    label: 'SeekStreaming',
    seekKind: candidate.kind,
    seekGroupKey,
  }));
}

export function groupSeekStreamingSources<T extends SeekStreamingHlsSource>(
  sources: readonly T[],
): T[][] {
  const legacyGroupKey = Symbol('legacy-seekstreaming-group');
  const groups = new Map<string | symbol, T[]>();

  for (const source of sources) {
    const key = source.seekGroupKey || legacyGroupKey;
    const group = groups.get(key);
    if (group) {
      group.push(source);
    } else {
      groups.set(key, [source]);
    }
  }

  return Array.from(groups.values());
}

export function countLogicalNexusSources(
  hlsSources: readonly SeekStreamingHlsSource[],
  fileSources: readonly unknown[],
): number {
  const seekSources = hlsSources.filter(source => (
    source.seekKind === 'cfNative' || source.seekKind === 'source'
  ));
  const otherHlsSourceCount = hlsSources.length - seekSources.length;

  return (
    groupSeekStreamingSources(seekSources).length
    + otherHlsSourceCount
    + fileSources.length
  );
}

const MAX_SEEK_EMBED_DECODE_PASSES = 2;

function decodeSeekStreamingEmbedUrl(value: string): string | null {
  let decoded = value.trim();
  if (!decoded) return null;

  for (let pass = 0; pass < MAX_SEEK_EMBED_DECODE_PASSES; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded;
}

export function isSeekStreamingEmbedUrl(url: string): boolean {
  const decoded = decodeSeekStreamingEmbedUrl(url);
  if (!decoded || !isHttpUrl(decoded)) return false;

  const parsed = new URL(decoded);
  return parsed.pathname === '/' && !parsed.search && parsed.hash.length > 1;
}

function getSeekStreamingEmbedIdentity(url: string): string {
  const decoded = decodeSeekStreamingEmbedUrl(url) ?? url.trim();

  try {
    return new URL(decoded).href;
  } catch {
    return decoded;
  }
}

export function dedupeSeekStreamingEmbeds(
  embeds: readonly string[],
  hlsSources: ReadonlyArray<SeekStreamingHlsSource>,
): string[] {
  const extractedEmbedUrls = new Set(
    hlsSources
      .map(source => source.seekEmbedUrl)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)
      .map(getSeekStreamingEmbedIdentity),
  );
  const customSeekEmbedUrls = new Set(
    embeds
      .filter(isSeekStreamingEmbedUrl)
      .map(getSeekStreamingEmbedIdentity),
  );
  const extractedCustomEmbedUrls = new Set(
    [...extractedEmbedUrls].filter(identity => customSeekEmbedUrls.has(identity)),
  );
  const seenSeekEmbeds = new Set<string>();

  return embeds.filter((embedUrl) => {
    if (!isSeekStreamingEmbedUrl(embedUrl)) return true;

    const identity = getSeekStreamingEmbedIdentity(embedUrl);
    if (seenSeekEmbeds.has(identity)) return false;
    seenSeekEmbeds.add(identity);

    return (
      extractedCustomEmbedUrls.size === 0
      || extractedCustomEmbedUrls.has(identity)
    );
  });
}

function hasPlayableBulkResult(
  item: Record<string, unknown>,
  type: string,
  embedUrl: string,
): boolean {
  if (type === 'seekstreaming') {
    return normalizeSeekStreamingCandidates(item)
      .some(candidate => candidate.url !== embedUrl);
  }

  return isHttpUrl(item.hlsUrl) || isHttpUrl(item.m3u8Url);
}

export function hasCompleteBulkCoverage(
  expected: string[] | SeekStreamingBulkExpected[],
  results: unknown,
): boolean {
  if (expected.length === 0 || !Array.isArray(results) || results.length !== expected.length) {
    return false;
  }

  const expectsDescriptors = expected.every(item => (
    item
    && typeof item === 'object'
    && typeof item.url === 'string'
    && item.url.length > 0
    && typeof item.type === 'string'
    && item.type.length > 0
  ));
  const expectsUrls = expected.every(item => typeof item === 'string' && item.length > 0);
  if (!expectsDescriptors && !expectsUrls) return false;

  const expectedKeys = new Set(
    expected.map(item => (
      typeof item === 'string'
        ? item
        : JSON.stringify([item.url, item.type])
    )),
  );
  if (expectedKeys.size !== expected.length) return false;

  const covered = new Set<string>();
  for (const item of results) {
    if (
      !item
      || typeof item !== 'object'
      || Array.isArray(item)
      || (item as { success?: unknown }).success !== true
      || typeof (item as { url?: unknown }).url !== 'string'
      || typeof (item as { type?: unknown }).type !== 'string'
      || (item as { type: string }).type.length === 0
    ) {
      return false;
    }

    const row = item as Record<string, unknown> & { type: string; url: string };
    const key = expectsDescriptors
      ? JSON.stringify([row.url, row.type])
      : row.url;
    if (
      !expectedKeys.has(key)
      || covered.has(key)
      || !hasPlayableBulkResult(row, row.type, row.url)
    ) {
      return false;
    }
    covered.add(key);
  }

  return covered.size === expectedKeys.size;
}
