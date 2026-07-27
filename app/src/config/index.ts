export const CONFIG = {
  SITE_URL: 'https://movix.tax',
  DNS_PRIMARY: '1.1.1.1',
  DNS_SECONDARY: '1.0.0.1',
  DNS_DOH_URL: 'https://cloudflare-dns.com/dns-query',
  APP_NAME: 'Movix',
  USER_AGENT:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  USER_AGENT_IOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

export const UPDATE_CHECK = {
  RENTRY_URL: 'https://rentry.co/movix',
  MANIFEST_PATH: '/app/version.json',
  GITHUB_VERSION_RAW_PATH: '/raw/refs/heads/main/app/version.json',
  TIMEOUT_MS: 5000,
  PENDING_DOWNLOAD_KEY: 'update:pendingDownload',
};

export const FALLBACK_CONFIG = {
  PRIMARY_URL: 'https://movix.tax',
  GITHUB_URL: 'https://github.com/Movix-STMG/MovixOpenSource',
  TELEGRAM_URL: 'https://t.me/movix_site',
};
