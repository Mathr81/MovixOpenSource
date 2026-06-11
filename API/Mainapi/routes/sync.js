/**
 * Sync routes.
 * Extracted from server.js -- user data sync endpoints and graceful shutdown logic.
 * Mount point: app.use('/api', router)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const { getAuthIfValid } = require('../middleware/auth');
const { getPool, withMysqlAdvisoryLock } = require('../mysqlPool');
const { safeWriteJsonFile } = require('../utils/safeFile');
const { logSyncErrorToDiscord } = require('../utils/discord');
const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');
const {
  ALLOWED_SYNC_USER_TYPES,
  SYNC_LIMITS,
  SyncPolicyError,
  assertUserDataSize,
  ensureSafeProfileId,
  ensureSafeUserId,
  ensureValidUserType,
  getOwnedProfile,
  getProfileFilePath,
  getUserDataFilePath,
  getUtf8ByteLength,
  sanitizeLegacySyncData,
  sanitizeProfileData,
  validateAndNormalizeOps
} = require('../utils/syncPolicy');

// === Data directories ===
const USER_DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTS_DIR = path.join(USER_DATA_DIR, 'guests');
const USERS_DIR = path.join(USER_DATA_DIR, 'users');

// Ensure directories exist
(async () => {
  for (const dir of [USER_DATA_DIR, GUESTS_DIR, USERS_DIR]) {
    try {
      await fsp.access(dir);
    } catch {
      await fsp.mkdir(dir, { recursive: true });
    }
  }
})();

const syncRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:sync:post:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Trop de synchronisations en peu de temps. Reessayez dans une minute.'
  },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false }
});

const statsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:sync:stats:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Trop de requetes de statistiques. Reessayez dans une minute.'
  },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false }
});

// === Graceful Shutdown ===
let isShuttingDown = false;
let activeOperations = 0;

function startOperation() {
  if (isShuttingDown) throw new Error('Server is shutting down');
  activeOperations++;
}

function endOperation() {
  if (activeOperations > 0) {
    activeOperations--;
  }

  if (isShuttingDown && activeOperations === 0) {
    console.log('All operations completed, server can shutdown safely');
    process.exit(0);
  }
}

function waitForOperations() {
  return new Promise((resolve) => {
    if (activeOperations === 0) {
      resolve();
      return;
    }

    const checkInterval = setInterval(() => {
      if (activeOperations === 0) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
  });
}

// Graceful shutdown est gere par server.js (cluster worker).
process.on('message', (msg) => {
  if (msg === 'shutdown') {
    isShuttingDown = true;
  }
});

function normalizeStoredProfiles(data) {
  if (data.profiles && Array.isArray(data.profiles)) {
    data.profiles.forEach((profile) => {
      if (profile.avatar && !profile.avatar.startsWith('/avatars/') && profile.avatar !== '') {
        profile.avatar = '/avatars/disney/disney_avatar_1.png';
      }
    });
  }

  return data;
}

function safeParseStoredValue(rawValue, fallback) {
  if (typeof rawValue !== 'string') return fallback;
  try {
    return JSON.parse(rawValue);
  } catch {
    return fallback;
  }
}

function getArrayItemIdentity(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  if (typeof item.shareCode === 'string' && item.shareCode) {
    return `shareCode:${item.shareCode}`;
  }

  if (typeof item.key === 'string' && item.key) {
    return `key:${item.key}`;
  }

  const parts = [];

  if ((typeof item.type === 'string' || typeof item.type === 'number') && item.type !== '') {
    parts.push(`type:${String(item.type)}`);
  }

  if ((typeof item.id === 'string' || typeof item.id === 'number') && item.id !== '') {
    parts.push(`id:${String(item.id)}`);
  }

  if (item.episodeInfo && typeof item.episodeInfo === 'object') {
    const { season, episode } = item.episodeInfo;
    if (typeof season === 'number' || typeof season === 'string') {
      parts.push(`season:${String(season)}`);
    }
    if (typeof episode === 'number' || typeof episode === 'string') {
      parts.push(`episode:${String(episode)}`);
    }
  }

  return parts.length ? parts.join('|') : null;
}

function buildSyncLockName(userType, userId, profileId) {
  const digest = crypto
    .createHash('sha1')
    .update(`${userType}:${userId}:${profileId}`)
    .digest('hex');
  return `mainapi:sync:${digest}`;
}

async function withProfileSyncLock(userType, userId, profileId, task) {
  const pool = getPool();
  if (!pool) {
    throw new Error('MySQL pool not ready for sync lock');
  }

  return withMysqlAdvisoryLock(
    pool,
    buildSyncLockName(userType, userId, profileId),
    task,
    { timeoutSeconds: 30 }
  );
}

function createSyncStatsResponse(profileId, profileStats, legacyStats) {
  return {
    profileId,
    profileBytes: profileStats.bytes,
    profileKeyCount: profileStats.keyCount,
    profileQuotaBytes: SYNC_LIMITS.maxProfileBytes,
    legacySyncBytes: legacyStats.bytes,
    legacySyncKeyCount: legacyStats.keyCount,
    totalSyncBytes: profileStats.bytes + legacyStats.bytes
  };
}

function applySyncOperation(serverData, op) {
  const key = op.key;
  const currentRaw = serverData[key];

  switch (op.op) {
    case 'set':
      serverData[key] = op.value;
      break;

    case 'remove':
      delete serverData[key];
      break;

    case 'arrayAdd': {
      const arr = safeParseStoredValue(currentRaw, []);
      if (!Array.isArray(arr)) {
        serverData[key] = JSON.stringify([op.value]);
        break;
      }

      let next = arr.slice();
      const targetIdentity = getArrayItemIdentity(op.value);
      const exists = (item) => {
        const itemIdentity = getArrayItemIdentity(item);
        if (targetIdentity && itemIdentity) {
          return itemIdentity === targetIdentity;
        }

        return JSON.stringify(item) === JSON.stringify(op.value);
      };

      if (!next.some(exists)) {
        next.push(op.value);
      }

      serverData[key] = JSON.stringify(next);
      break;
    }

    case 'arrayRemove': {
      const arr = safeParseStoredValue(currentRaw, []);
      if (!Array.isArray(arr)) {
        serverData[key] = '[]';
        break;
      }

      const targetIdentity = getArrayItemIdentity(op.value);
      const next = arr.filter((item) => {
        const itemIdentity = getArrayItemIdentity(item);
        if (targetIdentity && itemIdentity) {
          return itemIdentity !== targetIdentity;
        }

        return JSON.stringify(item) !== JSON.stringify(op.value);
      });

      serverData[key] = JSON.stringify(next);
      break;
    }

    case 'arrayClear':
      serverData[key] = '[]';
      break;

    case 'objPatch': {
      const obj = safeParseStoredValue(currentRaw, {});
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        serverData[key] = JSON.stringify({});
        break;
      }

      const next = { ...obj };
      const sets = op.delta?.set || {};
      const removes = op.delta?.remove || [];

      for (const [entryKey, entryValue] of Object.entries(sets)) {
        if (entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue) && entryValue.__arrayPatch) {
          const patch = entryValue.__arrayPatch;
          const currentArrayValue = Array.isArray(next[entryKey])
            ? next[entryKey]
            : safeParseStoredValue(next[entryKey], []);
          const currentArray = Array.isArray(currentArrayValue) ? currentArrayValue : [];
          const byId = new Map();

          currentArray.forEach((item) => {
            const identity = getArrayItemIdentity(item);
            if (identity) {
              byId.set(identity, item);
            }
          });

          (patch.add || []).forEach((item) => {
            const identity = getArrayItemIdentity(item);
            if (identity) {
              byId.set(identity, item);
            }
          });

          (patch.update || []).forEach((item) => {
            const identity = getArrayItemIdentity(item);
            if (identity) {
              byId.set(identity, item);
            }
          });

          (patch.remove || []).forEach((item) => {
            const identity = getArrayItemIdentity(item);
            if (identity) {
              byId.delete(identity);
            }
          });

          (patch.removeIds || []).forEach((id) => {
            byId.delete(id);
          });

          next[entryKey] = Array.from(byId.values());
        } else {
          next[entryKey] = entryValue;
        }
      }

      removes.forEach((entryKey) => {
        delete next[entryKey];
      });

      serverData[key] = JSON.stringify(next);
      break;
    }
  }

  return serverData;
}

function buildSyncLogContext(context) {
  return {
    userType: context.userType || null,
    userId: context.userId || null,
    profileId: context.profileId || null,
    opsCount: context.opsCount || 0,
    requestBytes: context.requestBytes || 0,
    error: context.error || null
  };
}

function normalizeLastUpdated(rawValue) {
  if (typeof rawValue === 'string') {
    const parsed = new Date(rawValue).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }

  return 0;
}

async function readUserData(userType, userId) {
  const filePath = getUserDataFilePath({ usersDir: USERS_DIR, guestsDir: GUESTS_DIR }, userType, userId);

  try {
    const fileContent = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(fileContent);
    return normalizeStoredProfiles(data && typeof data === 'object' ? data : {});
  } catch (error) {
    if (error.code === 'ENOENT') return {};

    console.error(`Erreur lors de la lecture des donnees utilisateur ${userType}:${userId}:`, error.message);
    return {};
  }
}

async function writeUserData(userType, userId, data) {
  try {
    const filePath = getUserDataFilePath({ usersDir: USERS_DIR, guestsDir: GUESTS_DIR }, userType, userId);

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SyncPolicyError('Donnees utilisateur invalides', 400, 'INVALID_USER_DATA');
    }

    assertUserDataSize(data);

    const success = await safeWriteJsonFile(filePath, data);
    if (!success) {
      console.error(`Erreur de sauvegarde atomique pour ${userType}:${userId}`);
    }

    return success;
  } catch (error) {
    console.error(`Erreur de sauvegarde pour ${userType}:${userId}:`, error.message);
    return false;
  }
}

async function readProfileData(userType, userId, profileId) {
  const profilePath = getProfileFilePath(USERS_DIR, userType, userId, profileId);

  try {
    const fileContent = await fsp.readFile(profilePath, 'utf8');
    const parsed = JSON.parse(fileContent);
    const { data, changed } = sanitizeProfileData(parsed);

    if (changed) {
      safeWriteJsonFile(profilePath, data).catch((writeError) => {
        console.error(`Erreur lors du nettoyage du profil ${profileId}:`, writeError.message);
      });
    }

    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyncPolicyError) throw error;

    console.error(`Erreur lors de la lecture des donnees de profil ${userType}:${userId}:${profileId}:`, error.message);
    return {};
  }
}

async function writeProfileData(userType, userId, profileId, data) {
  try {
    const profilePath = getProfileFilePath(USERS_DIR, userType, userId, profileId);

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SyncPolicyError('Donnees de profil invalides', 400, 'INVALID_PROFILE_DATA');
    }

    const { data: sanitizedData } = sanitizeProfileData(data);
    const success = await safeWriteJsonFile(profilePath, sanitizedData);

    if (!success) {
      console.error(`Erreur de sauvegarde atomique pour le profil ${profileId}`);
    }

    return success;
  } catch (error) {
    console.error(`Erreur de sauvegarde du profil ${profileId}:`, error.message);
    return false;
  }
}

// === Routes ===

// POST /sync
router.post('/sync', syncRateLimit, async (req, res) => {
  let operationStarted = false;
  const syncContext = {
    userType: null,
    userId: null,
    profileId: null,
    opsCount: 0,
    requestBytes: 0
  };

  try {
    if (isShuttingDown) return res.status(503).json({ error: 'Server is shutting down' });
    startOperation();
    operationStarted = true;

    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > SYNC_LIMITS.maxRequestBytes) {
      return res.status(413).json({ success: false, error: 'Requete de synchronisation trop volumineuse' });
    }

    syncContext.requestBytes = getUtf8ByteLength(req.body || {});
    if (syncContext.requestBytes > SYNC_LIMITS.maxRequestBytes) {
      return res.status(413).json({ success: false, error: 'Requete de synchronisation trop volumineuse' });
    }

    const auth = await getAuthIfValid(req);
    if (!auth || !ALLOWED_SYNC_USER_TYPES.includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userType = ensureValidUserType(req.body?.userType || auth.userType);
    if (auth.userType !== userType) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const finalUserId = ensureSafeUserId(auth.userId);
    if (req.body?.userId && String(req.body.userId) !== finalUserId) {
      return res.status(401).json({ error: 'UserId mismatch' });
    }

    const profileId = ensureSafeProfileId(req.body?.profileId);
    const ops = validateAndNormalizeOps(req.body?.ops);

    syncContext.userType = userType;
    syncContext.userId = finalUserId;
    syncContext.profileId = profileId;
    syncContext.opsCount = ops.length;

    const syncResult = await withProfileSyncLock(userType, finalUserId, profileId, async () => {
      const userData = await readUserData(userType, finalUserId);
      getOwnedProfile(userData, profileId);

      const serverData = await readProfileData(userType, finalUserId, profileId);
      ops.forEach((op) => applySyncOperation(serverData, op));

      const { data: nextProfileData, stats: profileStats } = sanitizeProfileData(serverData);

      if (ops.length > 0) {
        const writeSuccess = await writeProfileData(userType, finalUserId, profileId, nextProfileData);
        if (!writeSuccess) {
          console.error(`[SYNC] Echec de l'ecriture pour ${userType}:${finalUserId}:${profileId}`);
          await logSyncErrorToDiscord('Echec de l\'ecriture des donnees de sync', buildSyncLogContext(syncContext));
          throw new Error('Failed to save data');
        }
      }

      return profileStats;
    });

    return res.status(200).json({
      success: true,
      stats: {
        profileBytes: syncResult.bytes,
        profileKeyCount: syncResult.keyCount,
        profileQuotaBytes: SYNC_LIMITS.maxProfileBytes
      }
    });
  } catch (error) {
    if (error instanceof SyncPolicyError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    }

    console.error('Erreur de synchronisation:', error);
    await logSyncErrorToDiscord('Exception lors de la synchronisation', buildSyncLogContext({
      ...syncContext,
      error: error.message
    }));
    return res.status(500).json({ error: 'Failed to sync data' });
  } finally {
    if (operationStarted) {
      endOperation();
    }
  }
});

// GET /sync/stats/:profileId
router.get('/sync/stats/:profileId', statsRateLimit, async (req, res) => {
  let operationStarted = false;

  try {
    if (isShuttingDown) return res.status(503).json({ error: 'Server is shutting down' });
    startOperation();
    operationStarted = true;

    const auth = await getAuthIfValid(req);
    if (!auth || !ALLOWED_SYNC_USER_TYPES.includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userType = ensureValidUserType(auth.userType);
    const userId = ensureSafeUserId(auth.userId);
    const profileId = ensureSafeProfileId(req.params.profileId);

    const userData = await readUserData(userType, userId);
    getOwnedProfile(userData, profileId);

    const profileData = await readProfileData(userType, userId, profileId);
    const profileStats = sanitizeProfileData(profileData).stats;
    const legacyStats = sanitizeLegacySyncData(userData).stats;

    return res.status(200).json({
      success: true,
      stats: createSyncStatsResponse(profileId, profileStats, legacyStats)
    });
  } catch (error) {
    if (error instanceof SyncPolicyError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    }

    console.error('Erreur de lecture des stats de sync:', error);
    return res.status(500).json({ error: 'Failed to retrieve sync stats' });
  } finally {
    if (operationStarted) {
      endOperation();
    }
  }
});

// GET /sync/:userType/:userId/:profileId?
router.get('/sync/:userType/:userId/:profileId?', async (req, res) => {
  let operationStarted = false;

  try {
    if (isShuttingDown) return res.status(503).json({ error: 'Server is shutting down' });
    startOperation();
    operationStarted = true;

    const userType = ensureValidUserType(req.params.userType);
    const userId = ensureSafeUserId(req.params.userId);
    const profileId = req.params.profileId ? ensureSafeProfileId(req.params.profileId) : null;

    const auth = await getAuthIfValid(req);
    if (!auth || auth.userType !== userType || auth.userId !== userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userData = await readUserData(userType, userId);
    const hasProfiles = Array.isArray(userData?.profiles) && userData.profiles.length > 0;
    let data = {};
    let lastUpdated = 0;

    if (!profileId && hasProfiles) {
      const defaultProfile = userData.profiles.find((profile) => profile && profile.isDefault) || userData.profiles[0] || null;
      return res.status(400).json({
        success: false,
        error: 'ProfileId required for accounts with profiles',
        code: 'PROFILE_ID_REQUIRED',
        defaultProfileId: defaultProfile?.id || null
      });
    }

    if (profileId) {
      getOwnedProfile(userData, profileId);
      data = await readProfileData(userType, userId, profileId);
    } else {
      data = sanitizeLegacySyncData(userData).data;
      lastUpdated = normalizeLastUpdated(userData?.lastUpdated);
    }

    return res.status(200).json({
      success: true,
      data: {
        ...data,
        lastUpdated
      }
    });
  } catch (error) {
    if (error instanceof SyncPolicyError) {
      return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    }

    console.error('Erreur de lecture:', error);
    return res.status(500).json({ error: 'Failed to retrieve data' });
  } finally {
    if (operationStarted) {
      endOperation();
    }
  }
});

// GET /guest/uuid
router.get('/guest/uuid', (req, res) => {
  const uuid = uuidv4();
  res.status(200).json({ uuid });
});

module.exports = router;
module.exports.isShuttingDown = () => isShuttingDown;
module.exports.startOperation = startOperation;
module.exports.endOperation = endOperation;
module.exports.waitForOperations = waitForOperations;
module.exports.readUserData = readUserData;
module.exports.writeUserData = writeUserData;
module.exports.readProfileData = readProfileData;
module.exports.writeProfileData = writeProfileData;
module.exports.withProfileSyncLock = withProfileSyncLock;
module.exports.USERS_DIR = USERS_DIR;
