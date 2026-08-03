export interface SubtitleCueLike {
  startTime: number;
  endTime: number;
  text: string;
}

export interface CastSubtitleCandidate {
  id: string;
  label: string;
  language: string;
  active: boolean;
  url?: string;
  vtt?: string;
  contentType?: string;
}

export interface PreparedCastSubtitleTrack {
  url?: string;
  inlineVtt?: string;
  contentType: string;
  language: string;
  name: string;
  active: boolean;
}

interface MutableSubtitleTrack {
  mode: string;
}

interface PrepareCastSubtitleOptions {
  readText: (url: string) => Promise<string>;
  maxTracks?: number;
}

const WEBVTT_CONTROL_LINE = /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/;
const WEBVTT_CUE = /(?:^|\n)\s*\d{2,}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2}\.\d{3}(?:\s|$)/;
const MAX_INLINE_VTT_BYTES = 2 * 1024 * 1024;

function formatTimestamp(secondsInput: number): string {
  const milliseconds = Math.max(0, Math.round(secondsInput * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function safeCueText(text: string): string {
  return String(text || '')
    .split('\u0000').join('')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => WEBVTT_CONTROL_LINE.test(line) ? `\u200B${line}` : line)
    .join('\n');
}

export function cuesToWebVtt(
  cues: readonly SubtitleCueLike[],
  delaySeconds = 0,
): string {
  const delay = Number.isFinite(delaySeconds) ? delaySeconds : 0;
  const blocks: string[] = [];
  for (const cue of cues) {
    if (
      !Number.isFinite(cue.startTime)
      || !Number.isFinite(cue.endTime)
      || cue.endTime <= cue.startTime
      || typeof cue.text !== 'string'
      || cue.text.length === 0
    ) continue;
    const start = Math.max(0, cue.startTime + delay);
    const end = Math.max(0, cue.endTime + delay);
    if (end <= start) continue;
    blocks.push(
      `${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${safeCueText(cue.text)}`,
    );
  }
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;
}

export function subtitleTextToWebVtt(input: string): string {
  const normalized = String(input || '')
    .replace(/^\uFEFF/, '')
    .split('\u0000').join('')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (/^WEBVTT(?:[ \t]|$)/.test(normalized)) return `${normalized}\n`;

  const blocks: string[] = [];
  for (const rawBlock of normalized.split(/\n[ \t]*\n+/)) {
    const lines = rawBlock.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() || '')) lines.shift();
    const timing = lines.shift()?.trim().replace(
      /(\d{2,}:\d{2}:\d{2}),(\d{3})/g,
      '$1.$2',
    );
    if (!timing || !/^\d{2,}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2}\.\d{3}$/.test(timing)) {
      continue;
    }
    const text = safeCueText(lines.join('\n').trimEnd());
    if (text) blocks.push(`${timing}\n${text}`);
  }
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;
}

export function resolveSelectedSubtitleTrack<T extends MutableSubtitleTrack>(
  tracks: readonly T[],
  selectionId: string,
): T | null {
  const match = /^internal:(0|[1-9]\d*)$/.exec(selectionId);
  if (match) return tracks[Number(match[1])] ?? null;
  return tracks.find(track => track.mode === 'hidden' || track.mode === 'showing') ?? null;
}

export function isolateSubtitleTrack<T extends MutableSubtitleTrack>(
  tracks: readonly T[],
  selected: T,
): void {
  for (const track of tracks) {
    const mode = track === selected ? 'showing' : 'disabled';
    if (track.mode !== mode) track.mode = mode;
  }
}

function sourceKey(candidate: CastSubtitleCandidate): string {
  return candidate.vtt !== undefined
    ? `vtt:${candidate.vtt}`
    : candidate.url
      ? `url:${candidate.url}`
      : `id:${candidate.id}`;
}

function isNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveCastSubtitleSource(
  value: string,
): { url: string; contentType: string } | null {
  if (!isNetworkUrl(value)) return null;
  try {
    const url = new URL(value);
    const nestedUrl = url.searchParams.get('url');
    const pathname = nestedUrl && isNetworkUrl(nestedUrl)
      ? new URL(nestedUrl).pathname.toLowerCase()
      : url.pathname.toLowerCase();
    if (pathname.endsWith('.vtt')) {
      url.searchParams.delete('vttwrap');
      return { url: url.toString(), contentType: 'text/vtt' };
    }
    if (pathname.endsWith('.srt') || pathname.endsWith('.txt')) {
      url.searchParams.delete('vttwrap');
      return { url: url.toString(), contentType: 'application/x-subrip' };
    }
    return null;
  } catch {
    return null;
  }
}

function prepareInlineVtt(value: string): string {
  const vtt = subtitleTextToWebVtt(value);
  if (
    new TextEncoder().encode(vtt).byteLength > MAX_INLINE_VTT_BYTES
    || !WEBVTT_CUE.test(vtt)
  ) {
    throw new Error('Inline WebVTT unavailable');
  }
  return vtt;
}

async function prepareCandidate(
  candidate: CastSubtitleCandidate,
  options: PrepareCastSubtitleOptions,
): Promise<PreparedCastSubtitleTrack> {
  let url: string | undefined;
  let inlineVtt: string | undefined;
  let contentType = candidate.contentType || 'text/vtt';
  if (candidate.vtt !== undefined) {
    inlineVtt = prepareInlineVtt(candidate.vtt);
    contentType = 'text/vtt';
  } else if (candidate.url && isNetworkUrl(candidate.url)) {
    const path = new URL(candidate.url).pathname.toLowerCase();
    const needsMaterialization = contentType === 'application/x-subrip'
      || path.endsWith('.srt')
      || path.endsWith('.txt');
    if (needsMaterialization) {
      inlineVtt = prepareInlineVtt(await options.readText(candidate.url));
      contentType = 'text/vtt';
    } else {
      url = candidate.url;
    }
  } else if (candidate.url) {
    inlineVtt = prepareInlineVtt(await options.readText(candidate.url));
    contentType = 'text/vtt';
  } else {
    throw new Error('Subtitle source unavailable');
  }
  if (!inlineVtt && (!url || !isNetworkUrl(url))) {
    throw new Error('Cast subtitle source unavailable');
  }
  return {
    ...(url ? { url } : {}),
    ...(inlineVtt ? { inlineVtt } : {}),
    contentType,
    language: candidate.language || 'und',
    name: candidate.label || candidate.language || 'Sous-titres',
    active: candidate.active === true,
  };
}

export async function prepareCastSubtitleTracks(
  candidates: readonly CastSubtitleCandidate[],
  options: PrepareCastSubtitleOptions,
): Promise<PreparedCastSubtitleTrack[]> {
  const maxTracks = Math.max(0, Math.min(16, options.maxTracks ?? 16));
  const unique: CastSubtitleCandidate[] = [];
  const seen = new Map<string, number>();
  for (const candidate of candidates) {
    const key = sourceKey(candidate);
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (candidate.active && !unique[existingIndex].active) {
        unique[existingIndex] = { ...unique[existingIndex], active: true };
      }
      continue;
    }
    seen.set(key, unique.length);
    unique.push(candidate);
  }

  const settled = await Promise.all(unique.map(async candidate => {
    try {
      return await prepareCandidate(candidate, options);
    } catch {
      return null;
    }
  }));
  const prepared = settled.filter((track): track is PreparedCastSubtitleTrack => track !== null)
    .slice(0, maxTracks);
  let activeSeen = false;
  return prepared.map(track => {
    const active = track.active && !activeSeen;
    if (active) activeSeen = true;
    return active === track.active ? track : { ...track, active };
  });
}
