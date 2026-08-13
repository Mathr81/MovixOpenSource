/**
 * Détection heuristique "est-ce vraiment un anime ?" à partir des signaux TMDB.
 *
 * Remplace le test naïf `genres.some(g => g.name === 'Animation')` qui classait à tort
 * Stranger Things: Chroniques de 1985, Les Simpson, Arcane, Rick et Morty, etc.
 */

export interface TmdbTvDetail {
  origin_country?: string[];
  original_language?: string;
  production_companies?: Array<{ name?: string }>;
  genres?: Array<{ name?: string }>;
}

export interface TmdbKeywordsResponse {
  results?: Array<{ name?: string }>;
}

const JAPANESE_STUDIOS: ReadonlySet<string> = new Set([
  'toei animation', 'madhouse', 'studio pierrot', 'mappa', 'bones',
  'wit studio', 'kyoto animation', 'a-1 pictures', 'ufotable', 'cloverworks',
  'trigger', 'sunrise', 'production i.g', 'shaft', 'j.c.staff', 'gainax',
  'studio ghibli', 'tatsunoko', 'xebec', 'david production', 'lerche',
  'doga kobo', 'gonzo', 'shin-ei animation', 'tms entertainment',
  'white fox', 'p.a. works', 'orange', 'science saru', 'lay-duce',
  'silver link', 'satelight', 'kinema citrus', 'lidenfilms', 'passione',
  'feel.', 'feel', 'seven arcs', 'zero-g', 'encourage films',
]);

export interface AnimeSignalResult {
  score: number;
  reasons: string[];
}

export function scoreAnimeSignals(
  detail: TmdbTvDetail | null | undefined,
  keywords: TmdbKeywordsResponse | null | undefined,
): AnimeSignalResult {
  if (!detail) return { score: 0, reasons: [] };

  let score = 0;
  const reasons: string[] = [];

  const origin = detail.origin_country || [];
  const lang = detail.original_language || '';
  const isJpLike = origin.includes('JP') || lang === 'ja';
  // Donghua = animation chinoise (CN/TW/HK, langue zh). anime-sama en héberge une partie.
  const isCnLike =
    origin.includes('CN') || origin.includes('TW') || origin.includes('HK') || lang === 'zh';

  if (origin.includes('JP')) {
    score += 40;
    reasons.push('origin=JP');
  }
  if (lang === 'ja') {
    score += 40;
    reasons.push('lang=ja');
  }

  const companies = detail.production_companies || [];
  for (const company of companies) {
    const name = (company?.name || '').toLowerCase();
    if (!name) continue;
    let hit = false;
    for (const js of JAPANESE_STUDIOS) {
      if (name.includes(js)) { hit = true; break; }
    }
    if (hit) {
      score += 30;
      reasons.push(`studio-jp=${name}`);
      break;
    }
  }

  const keywordSet = new Set<string>();
  for (const k of keywords?.results || []) {
    if (k?.name) keywordSet.add(k.name.toLowerCase());
  }
  // Le keyword "anime" existe aussi sur Rick and Morty: The Anime (US). On exige JP/ja en plus.
  if (keywordSet.has('anime') && isJpLike) {
    score += 30;
    reasons.push('kw=anime+jp');
  }
  if ((keywordSet.has('manga') || keywordSet.has('based on manga')) && isJpLike) {
    score += 20;
    reasons.push('kw=manga+jp');
  }

  const genreNames = (detail.genres || []).map((g) => g?.name || '');
  const hasAnimationGenre =
    genreNames.includes('Animation') || genreNames.includes('Animation & SF');

  // Donghua : origine/langue chinoise + contexte animation = signal fort (+40).
  // On exige le genre Animation (ou le keyword donghua) pour ne PAS classer les
  // dramas live-action chinois (énorme catalogue) en anime.
  if (isCnLike && hasAnimationGenre) {
    score += 40;
    reasons.push('donghua=CN+animation');
  }
  if (keywordSet.has('donghua')) {
    score += 30;
    reasons.push('kw=donghua');
  }

  if (hasAnimationGenre) {
    score += 10;
    reasons.push('genre=Animation');
  }

  return { score, reasons };
}

/**
 * Seuil par défaut = 40 : il faut au moins un signal fort (JP, ja, studio JP, kw+JP,
 * donghua CN+animation, kw donghua). Le genre "Animation" seul (+10) ne suffit plus.
 */
export function isLikelyAnime(
  detail: TmdbTvDetail | null | undefined,
  keywords: TmdbKeywordsResponse | null | undefined,
  threshold: number = 40,
): boolean {
  return scoreAnimeSignals(detail, keywords).score >= threshold;
}
