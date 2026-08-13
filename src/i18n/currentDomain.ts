export const resolveConfiguredPublicDomain = (siteUrl?: string): string => {
  const normalizedSiteUrl = siteUrl?.trim();
  if (!normalizedSiteUrl) {
    throw new Error('VITE_SITE_URL is required');
  }

  try {
    const url = new URL(
      normalizedSiteUrl.includes('://')
        ? normalizedSiteUrl
        : `https://${normalizedSiteUrl}`,
    );
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      throw new Error();
    }
    return url.hostname;
  } catch {
    throw new Error('VITE_SITE_URL must contain a valid public URL');
  }
};

export const DEFAULT_PUBLIC_DOMAIN = resolveConfiguredPublicDomain(
  import.meta.env.VITE_SITE_URL,
);

export interface LocationHostname {
  readonly hostname?: string | null;
}

export const resolveCurrentDomain = (
  locationLike?: LocationHostname,
): string => {
  const hostname = locationLike
    ? locationLike.hostname
    : typeof window !== 'undefined'
      ? window.location.hostname
      : '';

  return hostname?.trim() || DEFAULT_PUBLIC_DOMAIN;
};
