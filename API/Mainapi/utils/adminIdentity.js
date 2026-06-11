/**
 * Résout l'identité affichable d'un admin/uploader (nom + avatar) à partir
 * de son `userId` + `authType` (`'oauth'` ou `'bip-39'` / `'bip39'`).
 *
 * Priorité :
 *  1) `auth.userProfile.username` + `auth.userProfile.avatar` du provider
 *     OAuth (Discord/Google) — le "vrai" nom de la personne, pas le profil
 *     Movix interne (qui est souvent "Profil" + un avatar Disney random).
 *  2) Le profil Movix `isDefault` ou le premier profil — pour les comptes
 *     BIP-39 qui n'ont pas d'identité OAuth.
 *  3) Fallback `{ username: 'Admin', avatar: null }`.
 *
 * Utilisé par les leaderboards Wishboard et Download-links pour éviter
 * d'afficher "Admin" partout au lieu des vrais noms.
 */

const { readUserData } = require('../routes/sync');

const DEFAULT = Object.freeze({ username: 'Admin', avatar: null });

function safeParseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * @param {string} userId
 * @param {string} authType — 'oauth', 'bip39' ou 'bip-39' (DB legacy)
 * @returns {Promise<{ username: string, avatar: string | null }>}
 */
async function resolveAdminIdentity(userId, authType) {
  if (!userId) return { ...DEFAULT };

  const userType = authType === 'bip-39' || authType === 'bip39' ? 'bip39' : 'oauth';

  let data;
  try {
    data = await readUserData(userType, userId);
  } catch {
    return { ...DEFAULT };
  }

  if (!data || typeof data !== 'object') return { ...DEFAULT };

  // 1) OAuth : nom + avatar du provider (Discord/Google).
  const auth = safeParseJson(data.auth);
  if (auth?.userProfile?.username) {
    return {
      username: String(auth.userProfile.username),
      avatar: auth.userProfile.avatar ? String(auth.userProfile.avatar) : null,
    };
  }

  // 2) BIP-39 ou OAuth sans `auth.userProfile` : profil Movix par défaut.
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const defaultProfile = profiles.find((p) => p && p.isDefault) || profiles[0];
  if (defaultProfile?.name) {
    return {
      username: String(defaultProfile.name),
      avatar: defaultProfile.avatar ? String(defaultProfile.avatar) : null,
    };
  }

  return { ...DEFAULT };
}

module.exports = {
  resolveAdminIdentity,
};
