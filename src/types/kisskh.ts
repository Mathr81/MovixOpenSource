export type KisskhCipher =
  | { mode: 'none' }
  | {
      mode: 'aes-128-cbc';
      keyBase64: string;
      ivBase64: string;
      payloadEncoding: 'base64-per-cue';
      padding: 'pkcs7';
    }
  | { mode: 'unsupported'; scheme: 'a2' | 'a3' };

export type KisskhSubtitleFormat = 'srt' | 'txt' | 'txt1' | 'txt2';

export type KisskhErrorCode =
  | 'retrieval_in_progress'
  | 'not_found'
  | 'episode_missing'
  | 'provider_rate_limited'
  | 'provider_changed'
  | 'proxy_unavailable'
  | 'subtitle_unsupported'
  | 'subtitle_decrypt_failed'
  | 'upstream_unavailable';

export interface KisskhSource {
  id: string;
  label: string;
  type: 'hls' | 'mp4';
  url: string;
  fallbackToken: string;
}

export interface KisskhSubtitleTrack {
  id: string;
  lang: string;
  label: string;
  format: KisskhSubtitleFormat;
  sourceUrl: string;
  proxyUrl: string;
  cipher: KisskhCipher;
}

export interface KisskhMatch {
  tmdbId: number;
  kisskhDramaId: number;
  episodeId: number;
  season: number;
  episode: number;
}

export interface KisskhResolution {
  match: KisskhMatch;
  sources: KisskhSource[];
  subtitles: KisskhSubtitleTrack[];
}

export interface ResolveKisskhOptions {
  signal?: AbortSignal;
}

export type KisskhFallbackRequest =
  | { kind: 'subtitle'; sourceUrl: string }
  | { kind: 'media'; fallbackToken: string };

export type KisskhFallbackResult =
  | {
      success: true;
      kind: 'subtitle';
      status: number;
      contentType: string;
      bodyBase64: string;
    }
  | {
      success: true;
      kind: 'media';
      url: string;
      expiresAt: number;
      headersApplied: boolean;
    }
  | { success: false; code: string };

export type KisskhFallbackTransport = (
  request: KisskhFallbackRequest,
) => Promise<KisskhFallbackResult>;

declare global {
  interface Window {
    movixKisskhFallback?: KisskhFallbackTransport;
  }
}
