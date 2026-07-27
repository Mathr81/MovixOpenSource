export interface MediaProxyCandidate {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  responseType?: string;
}

export const MEDIA_ENTRY_PATH_SOURCE =
  String.raw`\.(?:m3u8|mp4|m4v|m4s|mpd|ts|aac|m4a|vtt|srt)(?:$|[?#])`;

const MEDIA_ENTRY_PATH = new RegExp(MEDIA_ENTRY_PATH_SOURCE, 'i');

export function isLocalMediaProxyCandidate(
  details: MediaProxyCandidate,
): boolean {
  const method = String(details.method || 'GET').toUpperCase();
  const url = String(details.url || '').trim();

  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!/^https:\/\//i.test(url)) return false;
  if (/^https:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(url)) {
    return false;
  }
  if (!MEDIA_ENTRY_PATH.test(url)) return false;

  return Object.keys(details.headers || {}).some(key =>
    /^(?:origin|referer|range)$/i.test(key),
  );
}
