// Fonction pour obtenir l'URL de redirection de manière dynamique
const getRedirectUri = () => {
  // Utiliser le domaine actuel du site dans tous les cas
  return `${window.location.origin}/auth`;
};

export const DISCORD_CONFIG = {
  CLIENT_ID: '1517232036425895996',
  GUILD_ID: '1183496423535288401',
  // Liste des IDs de rôle pour l'accès admin
  ADMIN_ROLE_IDS: [
    '1350397422613958747',
    '1346870904621367397',
    '1253434514861068368',
    '1249659447434018827'
  ],
  get REDIRECT_URI() {
    return getRedirectUri();
  },
  SCOPES: ['identify', 'guilds', 'guilds.members.read'],
  API_ENDPOINT: 'https://discord.com/api/v10',
  CACHE_DURATION: 40 // Durée du cache en secondes (temps du rate limit entre les requêtes Discord)
}; 
