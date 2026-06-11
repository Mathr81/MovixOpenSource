/**
 * Source de vérité = la table `oauth_clients` (cache en mémoire alimenté
 * au boot par `oauthClientsDb.reloadCache()`). On garde l'API synchrone
 * historique (`loadOAuthClients()`, `getOAuthClient()`) pour ne pas avoir
 * à toucher aux 30+ call sites.
 *
 * L'env `MOVIX_OAUTH_CLIENTS_JSON` reste supportée en surcouche (dev local
 * uniquement) ; le fichier `data/oauth-clients.json` n'est plus lu une fois
 * la migration vers DB effectuée (il est archivé en `.migrated`).
 */

const { getCachedClients } = require('./oauthClientsDb');

const OAUTH_CLIENTS_ENV = 'MOVIX_OAUTH_CLIENTS_JSON';
const KNOWN_OAUTH_SCOPES = [
  // Compte / profils
  'profile.read',
  'profile.list',
  'profile.manage',
  // VIP
  'vip.read',
  'vip.manage',
  // Émission de jours VIP par l'app (depuis son balance admin-alimenté).
  'vip.grant',
  // Favoris (1 read + 2 write granulaires)
  'favorites.read',
  'favorites.add',
  'favorites.remove',
  // Listes personnalisées (1 read + 5 write granulaires)
  'lists.read',
  'lists.create',
  'lists.rename',
  'lists.delete',
  'lists.add-item',
  'lists.remove-item',
  // Watchlist (1 read + 2 write granulaires)
  'watchlist.read',
  'watchlist.add',
  'watchlist.remove',
  // Historique (films/séries marqués comme vus)
  'history.read',
  'history.add',
  'history.remove',
  // Continue watching (reprise en cours)
  'continue-watching.read',
  // Notifications / alertes nouvelles saisons
  'alerts.read',
  'alerts.manage',
  // Notes personnelles (1-10) + texte facultatif
  'ratings.read',
  'ratings.manage',
];
const DEFAULT_SCOPE = 'profile.read';
const OAUTH_DEBUG_ENABLED = process.env.MOVIX_OAUTH_DEBUG === 'true';

// Préfixe public servant les icônes d'apps (relatif à l'API : `/oauth-icons/<filename>`).
// Si tu sers via un CDN, set OAUTH_ICON_PUBLIC_BASE_URL.
const OAUTH_ICON_PUBLIC_BASE_URL = (
  process.env.OAUTH_ICON_PUBLIC_BASE_URL || '/oauth-icons'
).replace(/\/+$/, '');

function safeJsonParse(rawValue, fallback) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    console.error('[OAuth Clients] Invalid JSON payload:', error.message || error);
    return fallback;
  }
}

function normalizeHttpUrl(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  try {
    const parsed = new URL(rawValue.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const normalizedHostname = String(hostname || '').toLowerCase();
  return normalizedHostname === 'localhost'
    || normalizedHostname === '127.0.0.1'
    || normalizedHostname === '::1'
    || normalizedHostname === '[::1]'
    || normalizedHostname.endsWith('.localhost');
}

function normalizeRedirectUri(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  try {
    const parsed = new URL(rawValue.trim());
    const isLoopbackHost = isLoopbackHostname(parsed.hostname);

    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost)) {
      return null;
    }

    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizePathname(pathname) {
  const normalizedPathname = String(pathname || '/').trim() || '/';
  return normalizedPathname.replace(/\/+$/g, '') || '/';
}

function getLoopbackRedirectPaths(client) {
  if (!client || !Array.isArray(client.redirectUris)) {
    return [];
  }

  return uniqueStrings(
    client.redirectUris
      .map((redirectUri) => {
        try {
          const parsed = new URL(redirectUri);
          return isLoopbackHostname(parsed.hostname) ? normalizePathname(parsed.pathname) : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function logOauthDebug(message, payload) {
  if (!OAUTH_DEBUG_ENABLED) {
    return;
  }

  if (typeof payload === 'undefined') {
    console.log(`[OAuth Debug] ${message}`);
    return;
  }

  console.log(`[OAuth Debug] ${message}`, payload);
}

function normalizeScopes(rawScopes) {
  const sourceValues = Array.isArray(rawScopes)
    ? rawScopes
    : typeof rawScopes === 'string'
      ? rawScopes.split(/\s+/)
      : [];

  return uniqueStrings(
    sourceValues
      .map((scope) => String(scope || '').trim())
      .filter((scope) => KNOWN_OAUTH_SCOPES.includes(scope))
  );
}

function buildIconUrl(iconFilename) {
  if (typeof iconFilename !== 'string' || !iconFilename.trim()) {
    return null;
  }
  // L'iconFilename est juste le basename — pas de path traversal possible
  // (validé au moment du upload côté route admin).
  const safeName = iconFilename.trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeName) return null;
  return `${OAUTH_ICON_PUBLIC_BASE_URL}/${safeName}`;
}

function normalizeClient(rawClient) {
  if (!rawClient || typeof rawClient !== 'object' || Array.isArray(rawClient)) {
    return null;
  }

  const clientId = String(rawClient.clientId || '').trim();
  const clientName = String(rawClient.clientName || '').trim();
  const redirectUris = uniqueStrings(
    (Array.isArray(rawClient.redirectUris) ? rawClient.redirectUris : [])
      .map(normalizeRedirectUri)
      .filter(Boolean)
  );

  if (!clientId || !clientName || redirectUris.length === 0) {
    return null;
  }

  const clientSecret = typeof rawClient.clientSecret === 'string' && rawClient.clientSecret.trim()
    ? rawClient.clientSecret.trim()
    : null;
  const publicClient = rawClient.publicClient === true || !clientSecret;
  const requirePkce = rawClient.requirePkce === true || publicClient;
  const allowedScopes = normalizeScopes(rawClient.allowedScopes);
  const homepageUrl = normalizeHttpUrl(rawClient.homepageUrl);
  // Compat ascendante : l'ancien JSON avait `logoUrl` (URL absolue), la
  // nouvelle DB a `iconFilename` (basename). On expose les deux.
  const logoUrl = normalizeHttpUrl(rawClient.logoUrl);
  const iconUrl = buildIconUrl(rawClient.iconFilename) || logoUrl;
  const description = typeof rawClient.description === 'string' && rawClient.description.trim()
    ? rawClient.description.trim()
    : null;

  return {
    clientId,
    clientName,
    clientSecret,
    publicClient,
    requirePkce,
    redirectUris,
    allowedScopes: allowedScopes.length > 0 ? allowedScopes : [DEFAULT_SCOPE],
    homepageUrl,
    logoUrl,
    iconUrl,
    iconFilename: typeof rawClient.iconFilename === 'string' ? rawClient.iconFilename : null,
    description,
    vipDaysBalance: Number.isFinite(rawClient.vipDaysBalance) ? Number(rawClient.vipDaysBalance) : 0,
  };
}

function loadOAuthClients() {
  // Source 1: env var (override dev/test).
  const envRaw = process.env[OAUTH_CLIENTS_ENV] || '';
  const fromEnv = envRaw ? safeJsonParse(envRaw, []) : [];

  // Source 2: DB cache (source de vérité prod).
  const fromDb = getCachedClients() || [];

  const byClientId = new Map();
  // L'env override la DB (utile pour les tests E2E qui injectent un client éphémère).
  [...(Array.isArray(fromDb) ? fromDb : []), ...(Array.isArray(fromEnv) ? fromEnv : [])].forEach((entry) => {
    const normalized = normalizeClient(entry);
    if (!normalized) return;
    byClientId.set(normalized.clientId, normalized);
  });

  return Array.from(byClientId.values());
}

function getOAuthClient(clientId) {
  const normalizedClientId = String(clientId || '').trim();
  if (!normalizedClientId) {
    return null;
  }

  return loadOAuthClients().find((client) => client.clientId === normalizedClientId) || null;
}

function getOAuthClientPublicMetadata(client) {
  if (!client) {
    return null;
  }

  return {
    clientId: client.clientId,
    clientName: client.clientName,
    description: client.description,
    homepageUrl: client.homepageUrl,
    logoUrl: client.logoUrl,
    iconUrl: client.iconUrl,
    publicClient: client.publicClient,
    requirePkce: client.requirePkce,
    allowedScopes: [...client.allowedScopes],
    redirectOrigins: uniqueStrings(
      client.redirectUris
        .map((redirectUri) => {
          try {
            return new URL(redirectUri).origin;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    ),
  };
}

function resolveClientRedirectUri(client, requestedRedirectUri) {
  if (!client) {
    const error = new Error('Client OAuth introuvable');
    error.statusCode = 400;
    error.oauthError = 'invalid_client';
    throw error;
  }

  if (!requestedRedirectUri) {
    if (client.redirectUris.length === 1) {
      logOauthDebug('redirect_uri absent, using the only registered redirect URI', {
        clientId: client.clientId,
        redirectUri: client.redirectUris[0],
      });
      return client.redirectUris[0];
    }

    const loopbackPaths = getLoopbackRedirectPaths(client);
    const allLoopback = client.redirectUris.every((uri) => {
      try {
        return isLoopbackHostname(new URL(uri).hostname);
      } catch {
        return false;
      }
    });

    if (allLoopback && loopbackPaths.length === 1) {
      logOauthDebug('redirect_uri absent, all registered URIs are loopback with same path, using first', {
        clientId: client.clientId,
        redirectUri: client.redirectUris[0],
        loopbackPath: loopbackPaths[0],
      });
      return client.redirectUris[0];
    }
  }

  const normalizedRedirectUri = normalizeRedirectUri(requestedRedirectUri);
  logOauthDebug('Validating redirect_uri', {
    clientId: client.clientId,
    requestedRedirectUri,
    normalizedRedirectUri,
    registeredRedirectUris: client.redirectUris,
    loopbackRedirectPaths: getLoopbackRedirectPaths(client),
  });

  if (!normalizedRedirectUri) {
    logOauthDebug('redirect_uri rejected because normalization failed', {
      clientId: client.clientId,
      requestedRedirectUri,
    });
    const error = new Error('redirect_uri non autorisée');
    error.statusCode = 400;
    error.oauthError = 'invalid_request';
    throw error;
  }

  if (client.redirectUris.includes(normalizedRedirectUri)) {
    logOauthDebug('redirect_uri matched an exact registered URI', {
      clientId: client.clientId,
      normalizedRedirectUri,
    });
    return normalizedRedirectUri;
  }

  let isLoopbackPathAllowed = false;
  try {
    const parsedRequestedRedirectUri = new URL(normalizedRedirectUri);
    if (isLoopbackHostname(parsedRequestedRedirectUri.hostname)) {
      const requestedPathname = normalizePathname(parsedRequestedRedirectUri.pathname);
      const loopbackRedirectPaths = getLoopbackRedirectPaths(client);

      if (loopbackRedirectPaths.includes(requestedPathname)) {
        isLoopbackPathAllowed = true;
        logOauthDebug('redirect_uri accepted via loopback path match', {
          clientId: client.clientId,
          requestedRedirectUri: normalizedRedirectUri,
          requestedPathname,
          loopbackRedirectPaths,
        });
      }
    }
  } catch {
    // Ignore malformed URLs already rejected above.
  }

  if (isLoopbackPathAllowed) {
    return normalizedRedirectUri;
  }

  if (!client.redirectUris.includes(normalizedRedirectUri)) {
    logOauthDebug('redirect_uri rejected after validation', {
      clientId: client.clientId,
      requestedRedirectUri: normalizedRedirectUri,
      registeredRedirectUris: client.redirectUris,
    });
    const error = new Error('redirect_uri non autorisée');
    error.statusCode = 400;
    error.oauthError = 'invalid_request';
    throw error;
  }

  return normalizedRedirectUri;
}

function normalizeRequestedScopes(requestedScopes, client) {
  if (!client) {
    const error = new Error('Client OAuth introuvable');
    error.statusCode = 400;
    error.oauthError = 'invalid_client';
    throw error;
  }

  const scopes = normalizeScopes(requestedScopes);
  const normalizedScopes = scopes.length > 0
    ? scopes
    : client.allowedScopes.includes(DEFAULT_SCOPE)
      ? [DEFAULT_SCOPE]
      : client.allowedScopes.slice(0, 1);

  if (normalizedScopes.length === 0) {
    const error = new Error('Aucune permission OAuth disponible pour ce client');
    error.statusCode = 400;
    error.oauthError = 'invalid_scope';
    throw error;
  }

  const invalidScopes = normalizedScopes.filter((scope) => !client.allowedScopes.includes(scope));
  if (invalidScopes.length > 0) {
    const error = new Error(`Scopes non autorisées: ${invalidScopes.join(', ')}`);
    error.statusCode = 400;
    error.oauthError = 'invalid_scope';
    throw error;
  }

  return normalizedScopes;
}

function getOAuthAllowedCorsOrigins() {
  const origins = new Set();

  loadOAuthClients().forEach((client) => {
    client.redirectUris.forEach((redirectUri) => {
      try {
        origins.add(new URL(redirectUri).origin);
      } catch {
        // Ignore malformed values already filtered during normalization.
      }
    });
  });

  return Array.from(origins);
}

module.exports = {
  KNOWN_OAUTH_SCOPES,
  DEFAULT_SCOPE,
  loadOAuthClients,
  getOAuthClient,
  getOAuthClientPublicMetadata,
  resolveClientRedirectUri,
  normalizeRequestedScopes,
  getOAuthAllowedCorsOrigins,
};
