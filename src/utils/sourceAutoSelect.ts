// src/utils/sourceAutoSelect.ts
import { getSourcePriorityPrefs } from './sourcePriorityPrefs';
import { getRememberLastPlayer, getLastPlayer } from './lastPlayerPref';
import type {
  TopLevelSourceId, HosterId, LanguageId, PriorityCategory,
} from '../types/sourcePriority';

export interface SourceAvailability {
  id: TopLevelSourceId;
  hasData: boolean;
}

/**
 * Retourne la première source top-level activée et disponible selon l'ordre utilisateur.
 * `null` si aucune source dispo n'est activée.
 *
 * Priorité (M11) : si l'option "se souvenir du dernier lecteur" est activée
 * ET qu'un dernier lecteur est sauvé ET qu'il est disponible dans la liste,
 * il l'emporte sur le tri user. Fallback sur l'ordre user sinon.
 */
export function pickAutoSelectedSource(
  availability: SourceAvailability[],
): TopLevelSourceId | null {
  // Fix N2 — Map pour O(1) lookup au lieu de array.find() O(n) par itération.
  const availMap = new Map(availability.map((a) => [a.id, a.hasData]));

  if (getRememberLastPlayer()) {
    const last = getLastPlayer();
    if (last && availMap.get(last)) return last;
  }

  const { sourceOrder } = getSourcePriorityPrefs().categories.moviesTv;
  for (const { id, enabled } of sourceOrder) {
    if (!enabled) continue;
    if (availMap.get(id)) return id;
  }
  return null;
}

/**
 * Retourne la première langue activée et disponible selon l'ordre utilisateur.
 */
export function pickAutoSelectedLanguage(
  availableLangs: LanguageId[],
): LanguageId | null {
  const { languageOrder } = getSourcePriorityPrefs().categories.anime;
  const availSet = new Set(availableLangs);
  for (const { id, enabled } of languageOrder) {
    if (!enabled) continue;
    if (availSet.has(id)) return id;
  }
  return null;
}

/**
 * Trie une liste d'embeds par priorité utilisateur.
 *
 * Tri à 2 niveaux :
 *   1. **Langue** (si les items exposent `language` ou `category`) — ordre
 *      défini par `prefs.categories[category].languageOrder`. Seules les
 *      langues `enabled: true` sont gardées à leur rang ; les autres sont
 *      placées à la fin.
 *   2. **Hoster** — ordre défini par `overrides[topLevel]` si présent, sinon
 *      `hosterOrder` global.
 *
 * Les items sans champ langue (ou dont la valeur ne match aucune langue
 * activée) sont classés après ceux avec une langue activée. C'est ce qui
 * permet à un user "VF > VOSTFR" de voir ses items VF en premier, puis
 * VOSTFR, puis les items sans langue explicite.
 *
 * Le `context` est REQUIS : sans lui, impossible de savoir si on doit appliquer
 * un override par top-level (ex. ordre hoster spécifique pour fstream) ou le tri
 * global de la catégorie.
 */
export function sortHostersByPriority<
  T extends { type: HosterId; language?: string; category?: string },
>(
  items: T[],
  context: { category: PriorityCategory; topLevel?: TopLevelSourceId | LanguageId },
): T[] {
  const prefs = getSourcePriorityPrefs();
  const cat = prefs.categories[context.category];
  const tl = context.topLevel;

  // Hoster rank
  const overrideOrder = tl ? (cat.overrides as Record<string, HosterId[]>)[tl] : undefined;
  const hosterList = overrideOrder ?? cat.hosterOrder;
  const hosterRank = (type: HosterId) => {
    const idx = hosterList.indexOf(type);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  // Langue rank — uniquement pour items qui exposent `language` ou `category`.
  // Les langues désactivées sont shiftées à la fin (MAX_SAFE_INTEGER).
  const langOrderEnabled = cat.languageOrder
    .filter((e) => e.enabled)
    .map((e) => String(e.id).toLowerCase());
  // Fstream renvoie les catégories françaises sous forme `VFF` (Vraie VF) et
  // `VFQ` (VF Québécoise) — variantes de `vf`. Sans normalisation, ces items
  // tombent à MAX_SAFE_INTEGER et VOSTFR gagne par défaut.
  const normalizeLang = (raw: string) => {
    const v = raw.toLowerCase();
    if (v === 'vff' || v === 'vfq') return 'vf';
    return v;
  };
  const langRank = (item: T) => {
    const raw = item.language ?? item.category;
    if (!raw) return Number.MAX_SAFE_INTEGER - 1; // sans langue explicite = juste après toutes les activées
    const normalized = normalizeLang(String(raw));
    const idx = langOrderEnabled.indexOf(normalized);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  return [...items].sort((a, b) => {
    const langDiff = langRank(a) - langRank(b);
    if (langDiff !== 0) return langDiff;
    return hosterRank(a.type) - hosterRank(b.type);
  });
}
