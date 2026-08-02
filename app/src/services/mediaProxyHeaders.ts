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

  if (hostname !== 'fsvid.lol' && !hostname.endsWith('.fsvid.lol')) {
    return headers;
  }

  const origin = hostname === 'fsvid.lol'
    ? 'https://fs13.lol'
    : 'https://fsvid.lol';
  setCanonicalHeader(headers, 'Origin', origin);
  setCanonicalHeader(headers, 'Referer', `${origin}/`);
  return headers;
}
