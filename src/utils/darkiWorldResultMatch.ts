export interface DarkiWorldSearchResult {
  id: number | string;
  name?: string | null;
  tmdb_id?: number | string | null;
  type?: string | null;
  year?: number | string | null;
}

interface FindDarkiWorldTitleIdOptions {
  results: DarkiWorldSearchResult[];
  targetTmdbId: number | string;
  targetTitle: string;
  targetType: 'movie' | 'tv';
  targetYear?: number | null;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().trim();
}

function isExactTypeMatch(resultType: string | null | undefined, targetType: 'movie' | 'tv'): boolean {
  if (targetType === 'movie') return resultType !== 'series';
  return resultType === 'series' || resultType === 'animes' || resultType === 'doc';
}

function isFallbackTypeMatch(resultType: string | null | undefined, targetType: 'movie' | 'tv'): boolean {
  if (targetType === 'movie') {
    return resultType !== 'series' && resultType !== 'animes' && resultType !== 'doc';
  }
  return resultType !== 'movie';
}

export function findDarkiWorldTitleId({
  results,
  targetTmdbId,
  targetTitle,
  targetType,
  targetYear,
}: FindDarkiWorldTitleIdOptions): number | string | null {
  const exactTmdbMatch = results.find(result => (
    isExactTypeMatch(result.type, targetType)
    && result.tmdb_id != null
    && String(result.tmdb_id) === String(targetTmdbId)
  ));
  if (exactTmdbMatch) return exactTmdbMatch.id;

  const normalizedTargetTitle = normalizeTitle(targetTitle);
  if (!normalizedTargetTitle || targetYear == null || !Number.isFinite(targetYear)) return null;

  const titleAndYearMatch = results.find(result => (
    typeof result.name === 'string'
    && normalizeTitle(result.name) === normalizedTargetTitle
    && Number(result.year) === targetYear
    && isFallbackTypeMatch(result.type, targetType)
  ));

  return titleAndYearMatch?.id ?? null;
}
