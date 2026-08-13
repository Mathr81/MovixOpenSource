const PROVIDER_SIGNED_USER_AGENT = 'Mozilla/5.0 Chrome/140.0.0.0';

function setCanonicalHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      delete headers[existing];
    }
  }
  headers[name] = value;
}

export function applyMediaProxyHeaderRules(
  url: string,
  input: Record<string, string>,
): Record<string, string> {
  const headers = { ...input };
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return headers;
  }

  const isFsvidHost = hostname === 'fsvid.lol' || hostname.endsWith('.fsvid.lol');
  const isVidzyHost =
    hostname === 'vidzy.org'
    || hostname.endsWith('.vidzy.org')
    || hostname === 'vidzy.cc'
    || hostname.endsWith('.vidzy.cc');
  if (!isFsvidHost && !isVidzyHost) {
    return headers;
  }

  if (isFsvidHost) {
    const origin = hostname === 'fsvid.lol'
      ? 'https://fs13.lol'
      : 'https://fsvid.lol';
    setCanonicalHeader(headers, 'Origin', origin);
    setCanonicalHeader(headers, 'Referer', `${origin}/`);
  }
  setCanonicalHeader(headers, 'Sec-Fetch-Site', 'cross-site');
  setCanonicalHeader(headers, 'Sec-Fetch-Mode', 'cors');
  setCanonicalHeader(headers, 'Sec-Fetch-Dest', 'empty');
  setCanonicalHeader(headers, 'User-Agent', PROVIDER_SIGNED_USER_AGENT);
  return headers;
}
