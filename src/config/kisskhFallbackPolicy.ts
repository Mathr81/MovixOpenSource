import policyJson from '../../config/kisskhFallbackPolicy.json';

export interface KisskhFallbackPolicy {
  readonly version: 1;
  readonly subtitleHosts: readonly string[];
  readonly maxSubtitleBytes: number;
}

const POLICY_KEYS = ['maxSubtitleBytes', 'subtitleHosts', 'version'] as const;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

export function validateKisskhFallbackPolicy(input: unknown): KisskhFallbackPolicy {
  if (!isRecord(input) || !hasExactKeys(input, POLICY_KEYS)) {
    throw new TypeError('Politique de fallback KissKH invalide');
  }
  if (input.version !== 1) {
    throw new TypeError('Version de politique KissKH invalide');
  }
  if (!Number.isSafeInteger(input.maxSubtitleBytes) || (input.maxSubtitleBytes as number) <= 0) {
    throw new TypeError('Limite de sous-titres KissKH invalide');
  }
  if (!Array.isArray(input.subtitleHosts) || input.subtitleHosts.length === 0) {
    throw new TypeError('Hotes de sous-titres KissKH invalides');
  }

  const hosts = input.subtitleHosts.map(host => {
    if (typeof host !== 'string' || !HOSTNAME_PATTERN.test(host) || host !== host.toLowerCase()) {
      throw new TypeError('Hote de sous-titres KissKH invalide');
    }
    return host;
  });
  const canonicalHosts = [...new Set(hosts)].sort();
  if (canonicalHosts.length !== hosts.length || canonicalHosts.some((host, index) => host !== hosts[index])) {
    throw new TypeError('Hotes de sous-titres KissKH non canoniques');
  }

  return Object.freeze({
    version: 1,
    subtitleHosts: Object.freeze(canonicalHosts),
    maxSubtitleBytes: input.maxSubtitleBytes as number,
  });
}

export const KISSKH_FALLBACK_POLICY = validateKisskhFallbackPolicy(policyJson);
