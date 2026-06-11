-- Migration : passage du fichier `data/oauth-clients.json` à 3 tables MySQL.
--   - oauth_clients     : config des apps (remplace le JSON)
--   - oauth_app_stats   : compteur d'appels par app + type d'event
--   - oauth_vip_grants  : historique des grants VIP émis par chaque app
--
-- Idempotent grâce à `CREATE TABLE IF NOT EXISTS`.
-- Lance avec : `mysql -u <user> -p movix < add_oauth_apps_tables.sql`
--           ou via le script `routes/admin.js` au démarrage (auto-migrate).

CREATE TABLE IF NOT EXISTS oauth_clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Identifiant public visible dans le query OAuth (?client_id=...).
  client_id VARCHAR(128) NOT NULL UNIQUE,

  -- Nom affiché sur la page d'autorisation et dans le panel admin.
  client_name VARCHAR(200) NOT NULL,

  description TEXT NULL,
  homepage_url VARCHAR(500) NULL,

  -- JSON arrays — sérialisation gérée côté Node.
  redirect_uris JSON NOT NULL,
  allowed_scopes JSON NOT NULL,

  -- Type de client : public (PKCE obligatoire, pas de secret) ou
  -- confidentiel (client_secret nécessaire).
  public_client TINYINT(1) NOT NULL DEFAULT 1,
  require_pkce TINYINT(1) NOT NULL DEFAULT 1,
  -- Secret en clair (uniquement si publicClient = 0).
  client_secret VARCHAR(256) NULL,

  -- Nom de fichier de l'icône (relatif à `public/oauth-icons/`).
  -- Ex : "movix-mcp-1234567890.png". NULL = pas d'icône custom.
  icon_filename VARCHAR(200) NULL,

  -- Compteur de jours VIP que l'app peut distribuer via /api/oauth/vip/grant.
  -- Décrément à chaque grant ; admin peut alimenter via le panel.
  vip_days_balance INT NOT NULL DEFAULT 0,

  -- Désactivation soft (cache l'app de la list mais garde l'historique).
  is_active TINYINT(1) NOT NULL DEFAULT 1,

  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,

  PRIMARY KEY (id),
  KEY idx_client_id (client_id),
  KEY idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stats : un event = une ligne. Permet de grapher l'usage par app.
-- Cleanup périodique : `DELETE FROM oauth_app_stats WHERE created_at < (now - 90j)`.
CREATE TABLE IF NOT EXISTS oauth_app_stats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Référence vers oauth_clients.client_id (pas la PK numérique, pour
  -- survivre à une suppression).
  client_id VARCHAR(128) NOT NULL,

  -- Type d'event : 'authorize' (page d'auth affichée), 'authorize_granted'
  -- (user a cliqué Autoriser), 'authorize_denied', 'token' (échange code →
  -- token), 'api_call' (toute requête OAuth authentifiée), 'vip_grant'.
  event_type VARCHAR(32) NOT NULL,

  -- User concerné (si applicable). Format `userType:userId`.
  user_id VARCHAR(160) NULL,

  -- Métadonnées libres (path, status, scope demandé, etc.) en JSON.
  metadata JSON NULL,

  created_at BIGINT UNSIGNED NOT NULL,

  PRIMARY KEY (id),
  KEY idx_client_event (client_id, event_type, created_at),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historique des grants VIP. Chaque ligne = un grant fait par une app
-- à un user. Sert d'audit + sert à recréer une access_key si l'user
-- perd la sienne.
CREATE TABLE IF NOT EXISTS oauth_vip_grants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  client_id VARCHAR(128) NOT NULL,

  -- User qui reçoit le VIP. Format `userType:userId`.
  user_id VARCHAR(160) NOT NULL,
  user_type VARCHAR(16) NOT NULL,
  user_id_only VARCHAR(128) NOT NULL,

  -- Jours grantés (décrémenté de oauth_clients.vip_days_balance).
  days_granted INT UNSIGNED NOT NULL,

  -- Access key générée (référence vers access_keys.key_value).
  access_key_value VARCHAR(128) NOT NULL,

  -- Date de validité de la clé
  expires_at DATETIME NOT NULL,

  -- Audit
  granted_at BIGINT UNSIGNED NOT NULL,

  -- Si l'admin révoque le grant : on flag (mais on n'efface pas la clé
  -- automatiquement — l'admin doit le faire séparément).
  revoked_at BIGINT UNSIGNED NULL,

  PRIMARY KEY (id),
  KEY idx_client_id (client_id, granted_at),
  KEY idx_user_id (user_id, granted_at),
  KEY idx_access_key (access_key_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
