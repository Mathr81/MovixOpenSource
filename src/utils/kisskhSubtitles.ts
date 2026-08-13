import type { KisskhCipher, KisskhErrorCode, KisskhSubtitleFormat } from '../types/kisskh';

const KISSKH_SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TIMESTAMP_PATTERN = /^(\d{2,}):([0-5]\d):([0-5]\d)(?:,|\.)(\d{3})$/;
const CONTROL_BLOCK_PATTERN = /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/;

type SupportedSubtitleErrorCode = Extract<
  KisskhErrorCode,
  'subtitle_unsupported' | 'subtitle_decrypt_failed'
>;

export interface SrtCue {
  start: string;
  end: string;
  text: string;
}

interface ParsedTimestamp {
  milliseconds: number;
  webVtt: string;
}

type AesKisskhCipher = Extract<KisskhCipher, { mode: 'aes-128-cbc' }>;

export class KisskhSubtitleError extends Error {
  readonly code: SupportedSubtitleErrorCode;

  constructor(code: SupportedSubtitleErrorCode) {
    super(code === 'subtitle_unsupported'
      ? 'Sous-titre KissKH non pris en charge'
      : 'Sous-titre KissKH illisible');
    this.name = 'KisskhSubtitleError';
    this.code = code;
  }
}

function failDecrypt(): never {
  throw new KisskhSubtitleError('subtitle_decrypt_failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseTimestamp(value: string): ParsedTimestamp | null {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (!Number.isSafeInteger(hours) || hours > 9999) return null;
  const total = (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
  if (!Number.isSafeInteger(total)) return null;
  return {
    milliseconds: total,
    webVtt: `${String(hours).padStart(2, '0')}:${match[2]}:${match[3]}.${match[4]}`,
  };
}

export function parseSrtCues(input: string): SrtCue[] {
  if (typeof input !== 'string') return [];
  const normalized = input
    .replace(/^\uFEFF/, '')
    .split('\u0000').join('')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];

  const cues: SrtCue[] = [];
  for (const block of normalized.split(/\n[ \t]*\n+/)) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() ?? '') && lines.length > 1) lines.shift();
    const timingLine = lines.shift()?.trim();
    if (!timingLine) continue;
    const timing = /^(\S+)\s+-->\s+(\S+)$/.exec(timingLine);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (!start || !end || end.milliseconds <= start.milliseconds) continue;
    const text = lines.join('\n').split('\u0000').join('').trimEnd();
    if (!text) continue;
    cues.push({ start: start.webVtt, end: end.webVtt, text });
  }
  return cues;
}

function decodeBase64(value: string): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !BASE64_PATTERN.test(value)
  ) {
    failDecrypt();
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    failDecrypt();
  }
  if (btoa(decoded) !== value) failDecrypt();
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function validateAesCipher(cipher: unknown): AesKisskhCipher {
  if (
    !isRecord(cipher)
    || !hasExactKeys(cipher, ['ivBase64', 'keyBase64', 'mode', 'padding', 'payloadEncoding'])
    || cipher.mode !== 'aes-128-cbc'
    || cipher.payloadEncoding !== 'base64-per-cue'
    || cipher.padding !== 'pkcs7'
    || typeof cipher.keyBase64 !== 'string'
    || typeof cipher.ivBase64 !== 'string'
  ) {
    failDecrypt();
  }
  return cipher as unknown as AesKisskhCipher;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function decryptKisskhCue(
  payload: string,
  cipherInput: AesKisskhCipher,
): Promise<string> {
  try {
    const cipher = validateAesCipher(cipherInput);
    const keyBytes = decodeBase64(cipher.keyBase64);
    const ivBytes = decodeBase64(cipher.ivBase64);
    const cueBytes = decodeBase64(payload);
    if (keyBytes.byteLength !== 16 || ivBytes.byteLength !== 16) failDecrypt();
    if (cueBytes.byteLength === 0 || cueBytes.byteLength % 16 !== 0) failDecrypt();

    const key = await crypto.subtle.importKey(
      'raw',
      copyToArrayBuffer(keyBytes),
      { name: 'AES-CBC' },
      false,
      ['decrypt'],
    );
    const clear = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: copyToArrayBuffer(ivBytes) },
      key,
      copyToArrayBuffer(cueBytes),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(clear).split('\u0000').join('');
  } catch (error) {
    if (error instanceof KisskhSubtitleError) throw error;
    failDecrypt();
  }
}

function toBytes(raw: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  failDecrypt();
}

function validateTrackPair(format: unknown, cipher: unknown): {
  format: 'srt';
  cipher: { mode: 'none' };
} | {
  format: 'txt' | 'txt2';
  cipher: AesKisskhCipher;
} {
  if (format === 'srt' && isRecord(cipher) && hasExactKeys(cipher, ['mode']) && cipher.mode === 'none') {
    return { format, cipher: { mode: 'none' } };
  }
  if (format === 'txt' || format === 'txt2') {
    try {
      return { format, cipher: validateAesCipher(cipher) };
    } catch {
      throw new KisskhSubtitleError('subtitle_unsupported');
    }
  }
  throw new KisskhSubtitleError('subtitle_unsupported');
}

function decodeRawText(raw: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\u0000').join('');
  } catch {
    failDecrypt();
  }
}

function escapeWebVttText(text: string): string {
  return text
    .split('\u0000').join('')
    .split('\n')
    .map(line => CONTROL_BLOCK_PATTERN.test(line) ? `\u200B${line}` : line)
    .join('\n');
}

function renderWebVtt(cues: readonly SrtCue[]): string {
  const body = cues.map(cue => (
    `${cue.start} --> ${cue.end}\n${escapeWebVttText(cue.text)}`
  )).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export async function kisskhTrackToVtt(
  rawInput: ArrayBuffer | ArrayBufferView,
  options: { format: KisskhSubtitleFormat; cipher: KisskhCipher },
): Promise<string> {
  const pair = validateTrackPair(options?.format, options?.cipher);
  const raw = toBytes(rawInput);
  if (raw.byteLength > KISSKH_SUBTITLE_MAX_BYTES) failDecrypt();
  const parsed = parseSrtCues(decodeRawText(raw));
  if (parsed.length === 0) failDecrypt();

  if (pair.format === 'srt') return renderWebVtt(parsed);

  const decrypted: SrtCue[] = [];
  for (const cue of parsed) {
    if (cue.text.includes('\n')) continue;
    try {
      const text = await decryptKisskhCue(cue.text.trim(), pair.cipher);
      if (text.length > 0) decrypted.push({ ...cue, text });
    } catch {
      // A broken cue must not discard other independently encrypted cues.
    }
  }
  if (decrypted.length === 0) failDecrypt();
  return renderWebVtt(decrypted);
}

export function createVttBlobUrl(vtt: string): { url: string; revoke: () => void } {
  const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt;charset=utf-8' }));
  let revoked = false;
  return {
    url,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    },
  };
}
