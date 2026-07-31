/**
 * Stockage DB des clients OAuth + stats + grants VIP. Remplace le fichier
 * `data/oauth-clients.json` (déprécié — migration auto au boot).
 *
 * Les autres modules continuent d'appeler `loadOAuthClients()` (sync) de
 * `oauthClients.js`, qui lit depuis le cache pré-warmé par les fonctions
 * async ci-dessous.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool } = require('../mysqlPool');
const { redis } = require('../config/redis');

const SCHEMA_PATH = path.join(__dirname, '..', 'exportscripts', 'add_oauth_apps_tables.sql');
const LEGACY_JSON_PATH = path.join(__dirname, '..', 'data', 'oauth-clients.json');
const ICON_DIR = path.join(__dirname, '..', 'public', 'oauth-icons');

// Cache en mémoire : refresh par invalidate() ou refresh périodique.
let memCache = {
  loadedAt: 0,
  clients: [],
};

const KNOWN_OAUTH_SCOPES_SET = new Set([
  'profile.read',
  'profile.list',
  'profile.manage',
  'vip.read',
  'vip.manage',
  'vip.grant',
  'favorites.read',
  'favorites.add',
  'favorites.remove',
  'lists.read',
  'lists.create',
  'lists.rename',
  'lists.delete',
  'lists.add-item',
  'lists.remove-item',
  'watchlist.read',
  'watchlist.add',
  'watchlist.remove',
  'history.read',
  'history.add',
  'history.remove',
  'continue-watching.read',
  'alerts.read',
  'alerts.manage',
  'ratings.read',
  'ratings.manage',
]);

/** Strip les commentaires `-- …` ligne par ligne avant le split.
 *  Note : ne gère pas `/* … *\/` mais le schéma n'en utilise pas. */
function stripSqlLineComments(sqlText) {
  return sqlText
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/** Crée les tables si elles n'existent pas (idempotent). */
async function ensureTables() {
  const pool = getPool();
  if (!pool) throw new Error('MySQL pool not ready');
  if (!fs.existsSync(SCHEMA_PATH)) return;
  // On strip d'abord TOUS les commentaires ligne `-- …` puis on split sur `;`.
  // Sans le strip, le premier statement embarquait le header de commentaires
  // du fichier et était filtré par `!startsWith('--')` → aucune table créée
  // et le INSERT migrate plantait sur "Table 'oauth_clients' doesn't exist".
  const sql = stripSqlLineComments(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  // Crée aussi le dossier oauth-icons s'il n'existe pas.
  if (!fs.existsSync(ICON_DIR)) {
    fs.mkdirSync(ICON_DIR, { recursive: true, mode: 0o755 });
  }
}

/** Import unique du JSON legacy vers DB. Idempotent : skip si déjà importé. */
async function migrateLegacyJsonIfNeeded() {
  const pool = getPool();
  if (!pool) return;
  if (!fs.existsSync(LEGACY_JSON_PATH)) return;

  const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM oauth_clients');
  const existing = Number(rows[0]?.n || 0);
  if (existing > 0) {
    // Migration déjà faite : on archive le JSON et on continue.
    try {
      const archivePath = LEGACY_JSON_PATH + '.migrated';
      if (!fs.existsSync(archivePath)) {
        fs.renameSync(LEGACY_JSON_PATH, archivePath);
        console.log('[OAuth Clients DB] Archived legacy JSON to', archivePath);
      }
    } catch (err) {
      console.warn('[OAuth Clients DB] Could not archive legacy JSON:', err.message);
    }
    return;
  }

  try {
    const content = fs.readFileSync(LEGACY_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const clientId = String(entry.clientId || '').trim();
      const clientName = String(entry.clientName || '').trim();
      if (!clientId || !clientName) continue;
      const redirectUris = Array.isArray(entry.redirectUris) ? entry.redirectUris : [];
      const allowedScopes = Array.isArray(entry.allowedScopes) ? entry.allowedScopes : [];
      const description = entry.description ? String(entry.description) : null;
      const homepageUrl = entry.homepageUrl ? String(entry.homepageUrl) : null;
      const publicClient = entry.publicClient === false ? 0 : 1;
      const requirePkce = entry.requirePkce === false ? 0 : 1;
      const clientSecret = entry.clientSecret ? String(entry.clientSecret) : null;
      await pool.execute(
        `INSERT INTO oauth_clients
           (client_id, client_name, description, homepage_url, redirect_uris,
            allowed_scopes, public_client, require_pkce, client_secret,
            is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
        [
          clientId,
          clientName,
          description,
          homepageUrl,
          JSON.stringify(redirectUris),
          JSON.stringify(allowedScopes),
          publicClient,
          requirePkce,
          clientSecret,
          now,
          now,
        ],
      );
    }
    console.log('[OAuth Clients DB] Migrated', parsed.length, 'client(s) from JSON to MySQL');
    // Archive le JSON
    try {
      fs.renameSync(LEGACY_JSON_PATH, LEGACY_JSON_PATH + '.migrated');
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.error('[OAuth Clients DB] Legacy migration failed:', err.message);
  }
}

function safeParseJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return Array.isArray(raw) ? raw : fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function rowToClient(row) {
  return {
    id: Number(row.id),
    clientId: row.client_id,
    clientName: row.client_name,
    description: row.description || null,
    homepageUrl: row.homepage_url || null,
    redirectUris: safeParseJson(row.redirect_uris, []).filter((u) => typeof u === 'string'),
    allowedScopes: safeParseJson(row.allowed_scopes, []).filter((s) => typeof s === 'string' && KNOWN_OAUTH_SCOPES_SET.has(s)),
    publicClient: row.public_client === 1 || row.public_client === true,
    requirePkce: row.require_pkce === 1 || row.require_pkce === true,
    clientSecret: row.client_secret || null,
    iconFilename: row.icon_filename || null,
    vipDaysBalance: Number(row.vip_days_balance || 0),
    isActive: row.is_active === 1 || row.is_active === true,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

/** Charge tous les clients actifs depuis la DB. À appeler au boot + après chaque modif. */
async function reloadCache() {
  const pool = getPool();
  if (!pool) return;
  const [rows] = await pool.execute('SELECT * FROM oauth_clients WHERE is_active = 1 ORDER BY id ASC');
  memCache = {
    loadedAt: Date.now(),
    clients: rows.map(rowToClient),
  };
}

function getCachedClients() {
  return memCache.clients;
}

function invalidateCache() {
  memCache = { loadedAt: 0, clients: [] };
}

// ─── Cross-worker cache invalidation (Redis pub/sub) ─────────────────────
// Movix runs in Node cluster mode (server.js): each worker has its own
// in-process `memCache`. A DB mutation only reloads the worker that handled
// it — other workers keep serving stale OAuth clients until they reboot.
// After every mutation we publish on a Redis channel so all workers reload.
// Without this, a redirect_uri added to a client after boot is rejected
// intermittently, depending on which worker the request is routed to.

const CLIENTS_CHANGED_CHANNEL = 'oauth:clients:changed';
let cacheSubscriber = null;

/** Notify every cluster worker that the oauth_clients table changed. */
async function publishClientsChanged() {
  try {
    await redis.publish(CLIENTS_CHANGED_CHANNEL, String(process.pid));
  } catch (err) {
    // The local reloadCache() already ran; cross-worker propagation is
    // best-effort and self-heals at the next mutation or worker restart.
    console.warn('[OAuth Clients DB] publishClientsChanged failed:', err.message);
  }
}

/** Reload this worker's cache, then broadcast so every other worker reloads. */
async function reloadCacheAndBroadcast() {
  await reloadCache();
  await publishClientsChanged();
}

/**
 * Start the per-worker cache subscriber. Call once per worker at boot.
 * Uses a dedicated connection — in ioredis a connection in subscriber mode
 * cannot run normal commands. ioredis auto-reconnects and re-subscribes.
 */
function startClientsCacheSubscriber() {
  if (cacheSubscriber) return;
  cacheSubscriber = redis.duplicate();
  cacheSubscriber.on('error', (err) => {
    console.error('[OAuth Clients DB] cache subscriber error:', err.message);
  });
  cacheSubscriber.on('message', (channel, message) => {
    if (channel !== CLIENTS_CHANGED_CHANNEL) return;
    reloadCache()
      .then(() => console.log(`[OAuth Clients DB] cache reloaded (pub/sub from pid ${message})`))
      .catch((err) => console.error('[OAuth Clients DB] reloadCache after pub/sub failed:', err.message));
  });
  cacheSubscriber.subscribe(CLIENTS_CHANGED_CHANNEL, (err) => {
    if (err) {
      console.error('[OAuth Clients DB] subscribe failed:', err.message);
      return;
    }
    console.log('[OAuth Clients DB] cache subscriber ready on', CLIENTS_CHANGED_CHANNEL);
  });
}

// ─── Stats helpers ───────────────────────────────────────────────────────

async function recordEvent(clientId, eventType, userId, metadata) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(
      `INSERT INTO oauth_app_stats (client_id, event_type, user_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(clientId),
        String(eventType).slice(0, 32),
        userId ? String(userId).slice(0, 160) : null,
        metadata ? JSON.stringify(metadata) : null,
        Date.now(),
      ],
    );
  } catch (err) {
    console.warn('[OAuth stats] recordEvent failed:', err.message);
  }
}

async function getStats(clientId, sinceMs) {
  const pool = getPool();
  if (!pool) return null;
  const since = Number(sinceMs) || Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [byType] = await pool.execute(
    `SELECT event_type, COUNT(*) AS n
       FROM oauth_app_stats
      WHERE client_id = ? AND created_at >= ?
      GROUP BY event_type`,
    [clientId, since],
  );
  const [byDay] = await pool.execute(
    `SELECT FROM_UNIXTIME(FLOOR(created_at/1000), '%Y-%m-%d') AS day,
            COUNT(*) AS n
       FROM oauth_app_stats
      WHERE client_id = ? AND created_at >= ?
      GROUP BY day
      ORDER BY day ASC`,
    [clientId, since],
  );
  const [uniqueUsers] = await pool.execute(
    `SELECT COUNT(DISTINCT user_id) AS n
       FROM oauth_app_stats
      WHERE client_id = ? AND created_at >= ? AND user_id IS NOT NULL`,
    [clientId, since],
  );
  return {
    sinceMs: since,
    byType,
    byDay,
    uniqueUsers: Number(uniqueUsers[0]?.n || 0),
  };
}

// ─── VIP grants helpers ──────────────────────────────────────────────────

function generateAccessKeyValue() {
  // 32 chars base32-like uppercase (lisible).
  return crypto.randomBytes(20).toString('hex').toUpperCase();
}

/**
 * Décrémente atomiquement le balance et émet une access_key valide N jours.
 * Throw si balance insuffisant.
 */
async function grantVip({ clientId, userType, userId, days }) {
  if (!clientId || !userType || !userId || !Number.isInteger(days) || days <= 0 || days > 365) {
    throw new Error('Paramètres grant invalides');
  }
  const pool = getPool();
  if (!pool) throw new Error('DB indisponible');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock + check balance
    const [rows] = await conn.execute(
      'SELECT id, vip_days_balance FROM oauth_clients WHERE client_id = ? FOR UPDATE',
      [clientId],
    );
    if (rows.length === 0) throw new Error('Client OAuth introuvable');
    const balance = Number(rows[0].vip_days_balance || 0);
    if (balance < days) {
      throw new Error(`Solde VIP insuffisant : ${balance} jour(s) disponible(s), ${days} demandé(s)`);
    }
    // Décrément
    await conn.execute(
      'UPDATE oauth_clients SET vip_days_balance = vip_days_balance - ?, updated_at = ? WHERE id = ?',
      [days, Date.now(), rows[0].id],
    );
    // Génère access_key
    const keyValue = generateAccessKeyValue();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const expiresAtSql = expiresAt.toISOString().slice(0, 19).replace('T', ' ');
    await conn.execute(
      `INSERT INTO access_keys (key_value, active, expires_at, duree_validite)
       VALUES (?, 1, ?, ?)`,
      [keyValue, expiresAtSql, `${days}d`],
    );
    // Audit
    const userIdComposite = `${userType}:${userId}`;
    await conn.execute(
      `INSERT INTO oauth_vip_grants
         (client_id, user_id, user_type, user_id_only, days_granted,
          access_key_value, expires_at, granted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientId, userIdComposite, userType, userId, days, keyValue, expiresAtSql, Date.now()],
    );
    await conn.commit();
    return {
      accessKey: keyValue,
      expiresAt: expiresAt.toISOString(),
      daysGranted: days,
      remainingBalance: balance - days,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureTables,
  migrateLegacyJsonIfNeeded,
  reloadCache,
  reloadCacheAndBroadcast,
  publishClientsChanged,
  startClientsCacheSubscriber,
  getCachedClients,
  invalidateCache,
  recordEvent,
  getStats,
  grantVip,
  ICON_DIR,
  KNOWN_OAUTH_SCOPES_SET,
};
