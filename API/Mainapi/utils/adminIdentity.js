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
const { truncateDisplayName } = require('./syncPolicy');

const DEFAULT = Object.freeze({ username: 'Admin', avatar: null });

function safeParseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * @param {string} userId
 * @param {string} authType — 'oauth', 'bip39' ou 'bip-39' (DB legacy)
 * @param {{ preferProfile?: boolean }} [options]
 *   preferProfile: utiliser le PREMIER profil Movix (profiles[0]) pour le nom +
 *   avatar avant l'identité OAuth. Utilisé par le leaderboard Greenlight et la
 *   gestion d'équipe, qui veulent le profil Movix de l'utilisateur, pas le
 *   pseudo Discord/Google.
 * @returns {Promise<{ username: string, avatar: string | null }>}
 */
async function resolveAdminIdentity(userId, authType, options = {}) {
  if (!userId) return { ...DEFAULT };

  const preferProfile = options.preferProfile === true;
  const userType = authType === 'bip-39' || authType === 'bip39' ? 'bip39' : 'oauth';

  let data;
  try {
    data = await readUserData(userType, userId);
  } catch {
    return { ...DEFAULT };
  }

  if (!data || typeof data !== 'object') return { ...DEFAULT };

  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const firstProfile = profiles[0];

  // Greenlight / team management : le PREMIER profil Movix prime sur l'identité
  // OAuth. (Le reste de la fonction garde l'ordre OAuth-d'abord par défaut.)
  if (preferProfile && firstProfile?.name) {
    return {
      username: truncateDisplayName(firstProfile.name) || DEFAULT.username,
      avatar: firstProfile.avatar ? String(firstProfile.avatar) : null,
    };
  }

  // 1) OAuth : nom + avatar du provider (Discord/Google).
  //    Tronque le username pour éviter qu'un pseudo trop long casse l'UI
  //    leaderboard (cas des données legacy stockées avant la limite serveur).
  const auth = safeParseJson(data.auth);
  if (auth?.userProfile?.username) {
    return {
      username: truncateDisplayName(auth.userProfile.username) || DEFAULT.username,
      avatar: auth.userProfile.avatar ? String(auth.userProfile.avatar) : null,
    };
  }

  // 2) BIP-39 ou OAuth sans `auth.userProfile` : profil Movix par défaut.
  const defaultProfile = profiles.find((p) => p && p.isDefault) || firstProfile;
  if (defaultProfile?.name) {
    return {
      username: truncateDisplayName(defaultProfile.name) || DEFAULT.username,
      avatar: defaultProfile.avatar ? String(defaultProfile.avatar) : null,
    };
  }

  return { ...DEFAULT };
}

module.exports = {
  resolveAdminIdentity,
};
