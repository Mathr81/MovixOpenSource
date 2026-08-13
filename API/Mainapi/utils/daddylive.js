// API/Mainapi/utils/daddylive.js
// Pure logic for the Daddylive (dlhd.pk) live-TV source. No network / no I/O.

const cheerio = require('cheerio');

const DADDYLIVE_BASE_URL = 'https://dlhd.pk';
const DADDYLIVE_REFERER = 'https://dlhd.pk/';
const DADDYLIVE_ORIGIN = 'https://dlhd.pk';
const DADDYLIVE_CHANNELS_PATH = '/24-7-channels.php';
const DADDYLIVE_PLAYER_PREFIXES = ['stream', 'cast', 'watch', 'plus', 'casting', 'player'];
// Cards carry no logo; empty poster -> frontend renders the channel name placeholder.
const DADDYLIVE_PLACEHOLDER_POSTER = '';

// Keyed by ISO 3166-1 alpha-2 (lowercase) so the frontend can render a flag via
// the react-country-flag module. `arabic`/`africa`/`other` are non-ISO buckets
// (no single flag) and get an emoji fallback on the frontend.
// Ordered: France first (French platform), big markets, then the rest, buckets last.
const DADDYLIVE_COUNTRIES = {
  fr: { name: 'France' },
  us: { name: 'États-Unis' },
  gb: { name: 'Royaume-Uni' },
  es: { name: 'Espagne' },
  it: { name: 'Italie' },
  de: { name: 'Allemagne' },
  pt: { name: 'Portugal' },
  pl: { name: 'Pologne' },
  nl: { name: 'Pays-Bas' },
  gr: { name: 'Grèce' },
  tr: { name: 'Turquie' },
  br: { name: 'Brésil' },
  ar: { name: 'Argentine' },
  mx: { name: 'Mexique' },
  ca: { name: 'Canada' },
  au: { name: 'Australie' },
  nz: { name: 'Nouvelle-Zélande' },
  ro: { name: 'Roumanie' },
  bg: { name: 'Bulgarie' },
  rs: { name: 'Serbie' },
  hr: { name: 'Croatie' },
  ba: { name: 'Bosnie' },
  cz: { name: 'République tchèque' },
  sk: { name: 'Slovaquie' },
  dk: { name: 'Danemark' },
  se: { name: 'Suède' },
  ru: { name: 'Russie' },
  in: { name: 'Inde' },
  pk: { name: 'Pakistan' },
  my: { name: 'Malaisie' },
  il: { name: 'Israël' },
  ae: { name: 'Émirats arabes unis' },
  qa: { name: 'Qatar' },
  sa: { name: 'Arabie saoudite' },
  ie: { name: 'Irlande' },
  cy: { name: 'Chypre' },
  hu: { name: 'Hongrie' },
  bd: { name: 'Bangladesh' },
  uy: { name: 'Uruguay' },
  cl: { name: 'Chili' },
  co: { name: 'Colombie' },
  arabic: { name: 'Arabe / MENA' },
  africa: { name: 'Afrique' },
  other: { name: 'International' },
};

// US networks that carry NO country token in their name.
const US_NETWORK_ALLOWLIST = [
  'cartoon network', 'adult swim', 'animal planet', 'boomerang', 'comedy central',
  'discovery channel', 'discovery family', 'discovery life', 'discovery turbo',
  'disney channel', 'disney xd', 'disney jr', 'nick', 'nicktoons', 'teennick',
  'universal kids', 'national geographic', 'nat geo', 'science channel',
  'smithsonian', 'travel channel', 'tlc', 'investigation discovery', 'hgtv',
  'magnolia network', 'msnbc', 'telemundo', 'univision', 'unimas',
  'game show network', 'tennis channel', 'cooking channel', 'food network',
  'hallmark', 'oxygen', 'syfy', 'freeform', 'paramount network', 'bravo',
  'lifetime', 'fuse', 'vice tv', 'we tv', 'wetv', 'ion', 'reelz', 'tv one',
];

// Ordered rules: first match wins. Values are ISO alpha-2 (or a bucket key).
// Full country words match anywhere; ambiguous 2-letter codes are END-anchored.
const COUNTRY_RULES = [
  // --- specific disambiguation first ---
  [/\bmena\b/, 'arabic'],
  [/\bbih\b/, 'ba'],
  [/abu dhabi|dubai/, 'ae'],
  [/\balkass\b/, 'qa'],
  [/\bssc\b/, 'sa'],
  [/movistar|laliga|la liga/, 'es'],
  // --- full country words (match anywhere) ---
  [/\busa\b|\bus\b|\bny\b|cbsny|foxny|nbcny/, 'us'],
  [/\bfrance\b|fran[cç]aise|\bfrench\b/, 'fr'],
  [/\bspain\b|espa[nñ]a/, 'es'],
  [/\bitaly\b|\bitalia\b/, 'it'],
  [/\bgermany\b|deutschland|fernsehen/, 'de'],
  [/\bportugal\b/, 'pt'],
  [/\bpoland\b/, 'pl'],
  [/netherland/, 'nl'],
  [/\bgreece\b/, 'gr'],
  [/\bturkey\b|turkish/, 'tr'],
  [/\bbrasil\b|\bbrazil\b/, 'br'],
  [/\bargentina\b/, 'ar'],
  [/\bmexico\b/, 'mx'],
  [/\bcanada\b/, 'ca'],
  [/\baustralia\b/, 'au'],
  [/new zealand|\btvnz\b/, 'nz'],
  [/\bromania\b/, 'ro'],
  [/\bbulgaria\b/, 'bg'],
  [/\bserbia\b/, 'rs'],
  [/\bcroatia\b/, 'hr'],
  [/\bbosnia\b/, 'ba'],
  [/\bczech\b/, 'cz'],
  [/\bslovakia\b|\bšport\b/, 'sk'],
  [/\bdenmark\b/, 'dk'],
  [/\bsweden\b/, 'se'],
  [/\brussia\b/, 'ru'],
  [/\bindia\b/, 'in'],
  [/\bpakistan\b/, 'pk'],
  [/\bmalaysia\b/, 'my'],
  [/\bisrael\b/, 'il'],
  [/\buae\b/, 'ae'],
  [/\bqatar\b/, 'qa'],
  [/\bsaudi\b/, 'sa'],
  [/\bireland\b/, 'ie'],
  [/\bcyprus\b/, 'cy'],
  [/\bhungary\b/, 'hu'],
  [/bangladesh/, 'bd'],
  [/\buruguay\b/, 'uy'],
  [/\bchile\b/, 'cl'],
  [/colombia|columbia/, 'co'],
  [/\barabic\b/, 'arabic'],
  [/afrique|africa/, 'africa'],
  // --- ambiguous 2-letter codes: END-anchored only ---
  [/\buk$/, 'gb'],
  [/\bde$/, 'de'],
  [/\bpt$/, 'pt'],
  [/\bnl$/, 'nl'],
  [/\btr$/, 'tr'],
  [/\bes$/, 'es'],
  [/\bmx$/, 'mx'],
  [/\bca$/, 'ca'],
  [/\bau$/, 'au'],
  [/\bnz$/, 'nz'],
  [/\bro$/, 'ro'],
  [/\bcz$/, 'cz'],
  [/\bsk$/, 'sk'],
  [/\bin$/, 'in'],
  [/\bpk$/, 'pk'],
  [/\bbd$/, 'bd'],
];

function detectCountry(rawName) {
  const name = String(rawName || '').toLowerCase().trim();
  if (!name) return 'other';
  for (const [re, code] of COUNTRY_RULES) {
    if (re.test(name)) return code;
  }
  for (const needle of US_NETWORK_ALLOWLIST) {
    if (name.includes(needle)) return 'us';
  }
  return 'other';
}

function isAdultChannel(rawId, name) {
  const idNum = Number.parseInt(rawId, 10);
  if (Number.isInteger(idNum) && idNum >= 501 && idNum <= 520) return true;
  return /^\s*18\+/.test(String(name || ''));
}

// Parse the /24-7-channels.php grid into [{ rawId, name, country }], 18+ removed.
function parseChannelsHtml(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a.card').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]id=(\d+)/);
    if (!m) return;
    const rawId = m[1];
    const name = ($(el).find('.card__title').first().text() || '').trim();
    if (!name) return;
    if (isAdultChannel(rawId, name)) return;
    if (seen.has(rawId)) return;
    seen.add(rawId);
    out.push({ rawId, name, country: detectCountry(name) });
  });
  return out;
}

// Parse #playerBtns -> [{ title, dataUrl }].
function parsePlayersHtml(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = [];
  $('#playerBtns button[data-url]').each((i, el) => {
    const dataUrl = $(el).attr('data-url');
    if (!dataUrl) return;
    const text = ($(el).text() || '').trim();
    out.push({ title: text || `Player ${i + 1}`, dataUrl });
  });
  return out;
}

// Fallback when watch.php cannot be parsed: the 6 deterministic player paths.
function buildDeterministicPlayers(rawId) {
  return DADDYLIVE_PLAYER_PREFIXES.map((prefix, i) => ({
    title: `Player ${i + 1}`,
    dataUrl: `${DADDYLIVE_BASE_URL}/${prefix}/stream-${rawId}.php`,
  }));
}

function decodeBase64(b64) {
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function isM3u8Url(s) {
  return /^https?:\/\//i.test(s) && s.toLowerCase().includes('m3u8');
}

// Server-side fetch => the obfuscated anti-adblock JS does not run, so the
// Clappr `source: window.atob('<b64>')` literal is present verbatim. Decode it.
function extractM3u8FromPlayerHtml(html) {
  if (!html) return null;
  const direct = html.match(/source\s*:\s*window\.atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/i);
  if (direct) {
    const decoded = decodeBase64(direct[1]);
    if (isM3u8Url(decoded)) return decoded;
  }
  // Fallback: scan every loose base64 literal for a decoded m3u8 URL.
  const re = /['"]([A-Za-z0-9+/=]{24,})['"]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const decoded = decodeBase64(m[1]);
    if (isM3u8Url(decoded)) return decoded;
  }
  return null;
}

// Extract the first <iframe src>, absolutized against the page URL.
function extractIframeSrc(html, baseUrl) {
  if (!html) return null;
  const m = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl || DADDYLIVE_BASE_URL).href;
  } catch {
    return m[1];
  }
}

module.exports = {
  DADDYLIVE_BASE_URL,
  DADDYLIVE_REFERER,
  DADDYLIVE_ORIGIN,
  DADDYLIVE_CHANNELS_PATH,
  DADDYLIVE_PLAYER_PREFIXES,
  DADDYLIVE_PLACEHOLDER_POSTER,
  DADDYLIVE_COUNTRIES,
  detectCountry,
  isAdultChannel,
  parseChannelsHtml,
  parsePlayersHtml,
  buildDeterministicPlayers,
  extractM3u8FromPlayerHtml,
  extractIframeSrc,
};
