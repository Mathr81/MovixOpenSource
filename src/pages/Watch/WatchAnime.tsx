import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import useWatchStatus from '../../hooks/useWatchStatus';
import { searchWithFallback, getSearchNameForId, getAnimeMatcherForId, getAnimeMatchTerms } from '../../utils/searchUtils';
import { getTmdbId, encodeId } from '../../utils/idEncoder';
import HLSPlayer from '../../components/HLSPlayer';
import { useAdFreePopup } from '../../context/AdFreePopupContext';
import AdFreePlayerAds from '../../components/AdFreePlayerAds';
import { extractVidmolyM3u8, extractSibnetM3u8, extractOneUploadSources } from '../../utils/extractM3u8';
import { pickAutoSelectedLanguage, sortHostersByPriority } from '../../utils/sourceAutoSelect';
import { detectHoster } from '../../utils/hosterRegistry';
import {
  getSourcePriorityPrefs,
  subscribeToPriorityChanges,
  pinLanguage,
  unpinLanguage,
} from '../../utils/sourcePriorityPrefs';
import { PinButton } from '../../components/ui/PinButton';
import { useWrappedTracker } from '../../hooks/useWrappedTracker';
import { getTmdbLanguage } from '../../i18n';
import { useProfile } from '../../context/ProfileContext';
import { isContentAllowed, getClassificationLabel } from '../../utils/certificationUtils';

const MAIN_API = import.meta.env.VITE_MAIN_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// Interfaces
interface AnimeShow {
  name: string;
  overview: string;
  poster_path: string;
  first_air_date: string;
  vote_average: number;
  genres: { id: number; name: string }[];
  episode_run_time?: number[];
  backdrop_path?: string;
}

interface EpisodeDetails {
  name: string;
  overview: string;
  air_date: string;
  still_path?: string | null;
  vote_average: number;
  episode_number: number;
  season_number: number;
}

interface AnimeEpisode {
  name: string;
  serie_name: string;
  season_name: string;
  index: number;
  streaming_links: Array<{
    language: string;
    players: string[];
  }>;
}

interface AnimeSeason {
  name: string;
  serie_name: string;
  url: string;
  episodes: AnimeEpisode[];
}

interface AnimeData {
  name: string;
  url: string;
  seasons: AnimeSeason[];
}

interface VideoSource {
  language: string;
  quality: string;
  url: string;
  player: string;
  label: string;
  isM3u8?: boolean;
  id?: string; // Unique identifier for comparison
}

interface ContinueWatchingTvEntry {
  id: number;
  currentEpisode?: {
    season: number;
    episode: number;
  };
  lastAccessed?: string;
  [key: string]: unknown;
}

interface ContinueWatchingStore {
  movies: unknown[];
  tv: ContinueWatchingTvEntry[];
}


/**
 * Calculates similarity between two titles to avoid false positives in anime matching
 * @param title1 First title
 * @param title2 Second title
 * @returns Similarity score between 0 and 1
 */
const calculateTitleSimilarity = (title1: string, title2: string): number => {
  if (!title1 || !title2) return 0;

  const t1 = title1.toLowerCase();
  const t2 = title2.toLowerCase();

  // Normalize titles (remove accents, etc.)
  const normalize = (str: string) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const norm1 = normalize(t1);
  const norm2 = normalize(t2);

  // Exact match gets highest priority
  if (norm1 === norm2) {
    return 1.0;
  }

  // Check for inclusion (one title contains the other)
  if (norm2.includes(norm1) || norm1.includes(norm2)) {
    if (norm1.length < norm2.length && norm2.includes(norm1)) {
      const lengthRatio = norm1.length / norm2.length;
      return 0.9 * lengthRatio;
    } else if (norm2.length < norm1.length && norm1.includes(norm2)) {
      const lengthRatio = norm2.length / norm1.length;
      return 0.85 * lengthRatio;
    }
    return 0.8; // Score for partial inclusion
  }

  // Split into words and filter short words (articles, etc.)
  const filterShortWords = (words: string[]) => words.filter(w => w.length > 3);
  const words1 = filterShortWords(norm1.split(/\s+/));
  const words2 = filterShortWords(norm2.split(/\s+/));

  // If no significant words, use original words
  const finalWords1 = words1.length ? words1 : norm1.split(/\s+/);
  const finalWords2 = words2.length ? words2 : norm2.split(/\s+/);

  // Calculate percentage of matching words with higher weight for order
  let matches = 0;
  let orderBonus = 0;

  finalWords1.forEach((word, index) => {
    const matchIndex = finalWords2.findIndex(w => w === word);
    if (matchIndex !== -1) {
      matches++;
      // Bonus for words in similar positions
      if (Math.abs(index - matchIndex) <= 1) {
        orderBonus += 0.1;
      }
    }
  });

  const wordSimilarity = matches / Math.max(finalWords1.length, finalWords2.length);
  const totalSimilarity = wordSimilarity + orderBonus;

  return Math.min(totalSimilarity, 1.0);
};

const WatchAnime: React.FC = () => {
  const { id: encodedId, season, episode } = useParams<{ id: string; season: string; episode: string }>();
  const id = encodedId ? getTmdbId(encodedId) : null;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { currentProfile } = useProfile();
  const playerRef = useRef<HTMLDivElement>(null);

  // Basic state
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [contentCert, setContentCert] = useState<string>('');
  const [isBlocked, setIsBlocked] = useState(false);
  const [showDetails, setShowDetails] = useState<AnimeShow | null>(null);
  const [episodeDetails] = useState<EpisodeDetails | null>(null);

  // Anime specific state
  const [animeData, setAnimeData] = useState<AnimeData | null>(null);
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('vostfr'); // Default to VOSTFR

  // Milestone 4 — PinButton cross-UI : reflète l'id épinglé (anime.pinnedLanguage)
  // en live, sync cross-onglets via `subscribeToPriorityChanges` (storage event).
  const [pinnedLang, setPinnedLang] = useState<string | null>(() =>
    getSourcePriorityPrefs().categories.anime.pinnedLanguage?.id ?? null,
  );
  useEffect(
    () => subscribeToPriorityChanges((p) => {
      setPinnedLang(p.categories.anime.pinnedLanguage?.id ?? null);
    }),
    [],
  );

  // Video player state
  const [videoSources, setVideoSources] = useState<VideoSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<VideoSource | null>(null);

  // Loading states for extractions
  const [loadingVidmolyExtraction, setLoadingVidmolyExtraction] = useState<boolean>(false);
  const [loadingSibnetExtraction, setLoadingSibnetExtraction] = useState<boolean>(false);
  const [loadingOneUploadExtraction, setLoadingOneUploadExtraction] = useState<boolean>(false);
  const [extractionProgress, setExtractionProgress] = useState<string>('');

  // For HLS player
  const [showHLSPlayer, setShowHLSPlayer] = useState<boolean>(false);
  const [hlsPlayerSrc, setHlsPlayerSrc] = useState<string>('');


  // For iframe embed display
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [showEmbedQuality, setShowEmbedQuality] = useState(false);

  // Episode progress tracking
  const { isWatched, toggleWatched } = useWatchStatus({
    id: id ? Number(id) : 0,
    type: 'tv',
    title: showDetails?.name || '',
    poster_path: showDetails?.poster_path || '',
    episodeInfo: {
      season: Number(season),
      episode: Number(episode)
    }
  });

  // Ad-free popup context
  const {
    showPopupForPlayer
  } = useAdFreePopup();

  // État pour le menu d'épisodes
  const [showEpisodesMenu, setShowEpisodesMenu] = useState(false);
  const [displayedSeasonNumber, setDisplayedSeasonNumber] = useState(Number(season)); // State for the season shown in the menu
  const [showSeasonDropdown, setShowSeasonDropdown] = useState(false); // State for custom dropdown visibility

  // État pour suivre si c'est la première sélection automatique
  const [isInitialLoad, setIsInitialLoad] = useState<boolean>(true);

  const updateAnimeContinueWatching = useCallback(() => {
    if (localStorage.getItem('settings_disable_history') === 'true') return;

    const showIdInt = id ? parseInt(id) : NaN;
    const seasonNumber = Number(season);
    const episodeNumber = Number(episode);

    if (!Number.isFinite(showIdInt) || !Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber)) {
      return;
    }

    let continueWatching: ContinueWatchingStore;
    try {
      continueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}') as ContinueWatchingStore;
    } catch {
      continueWatching = { movies: [], tv: [] };
    }

    if (!Array.isArray(continueWatching.movies)) continueWatching.movies = [];
    if (!Array.isArray(continueWatching.tv)) continueWatching.tv = [];

    const existingShow = continueWatching.tv.find((tvShow) => tvShow.id === showIdInt);
    const updatedShow = {
      ...(existingShow || {}),
      id: showIdInt,
      currentEpisode: {
        season: seasonNumber,
        episode: episodeNumber
      },
      lastAccessed: new Date().toISOString()
    };

    continueWatching.tv = continueWatching.tv.filter((tvShow) => tvShow.id !== showIdInt);
    continueWatching.tv.unshift(updatedShow);
    continueWatching.tv = continueWatching.tv.slice(0, 20);
    localStorage.setItem('continueWatching', JSON.stringify(continueWatching));
  }, [id, season, episode]);

  // Movix Wrapped 2026 - Track anime viewing time
  useWrappedTracker({
    mode: 'viewing',
    viewingData: id ? {
      contentType: 'anime',
      contentId: id,
      seasonNumber: Number(season),
      episodeNumber: Number(episode),
    } : undefined,
    isActive: !loading && !!id,
  });

  // Load TMDB show details
  useEffect(() => {
    const fetchShowDetails = async () => {
      try {
        const response = await axios.get(`https://api.themoviedb.org/3/tv/${id}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage()
          }
        });
        setShowDetails(response.data);

        // Age restriction check
        const profileAge = currentProfile?.ageRestriction ?? 0;
        if (profileAge > 0) {
          try {
            const certResponse = await axios.get(`https://api.themoviedb.org/3/tv/${id}/content_ratings`, {
              params: { api_key: TMDB_API_KEY },
            });
            const ratings = certResponse.data.results;
            let cert = '';
            const fr = ratings.find((r: any) => r.iso_3166_1 === 'FR');
            if (fr?.rating) cert = fr.rating;
            if (!cert) {
              const us = ratings.find((r: any) => r.iso_3166_1 === 'US');
              if (us?.rating) cert = us.rating;
            }
            if (cert && !isContentAllowed(cert, profileAge)) {
              setContentCert(cert);
              setIsBlocked(true);
              return;
            }
          } catch (e) {
            console.log('Could not fetch certifications for age check');
          }
        }

      } catch (error) {
        console.error('Error fetching show details:', error);
        setError(t('watch.cannotLoadAnimeDetails'));
      }
    };

    if (id) {
      fetchShowDetails();
    }
  }, [id]);

  useEffect(() => {
    updateAnimeContinueWatching();
  }, [updateAnimeContinueWatching]);

  // Pas de fetch TMDB pour les détails d'épisode anime - le numérotage ne correspond pas

  // Load anime data with special character handling
  const loadAnimeData = useCallback(async () => {
    if (!showDetails?.name) return;

    try {
      // Use the new utility function for search name logic
      const searchName = getSearchNameForId(id || '', showDetails.name);

      // Use the new fallback search logic
      const searchFunction = async (term: string) => {
        const response = await axios.get(`${MAIN_API}/anime/search/${encodeURIComponent(term)}?includeSeasons=true&includeEpisodes=true`);
        return response.data || [];
      };

      const results = await searchWithFallback(searchFunction, searchName, 'WatchAnime');
      // --- PATCH SPECIAL ANIMES ---
      if (results.length > 0) {
        type AnimeResult = {
          name: string;
          url: string;
          seasons: Array<any>;
          alternative_names?: string[];
        };

        // Type the results properly
        const typedResults = results as AnimeResult[];
        let bestMatch;
        // Utiliser la fonction centralisée pour les cas spéciaux
        const specialMatcher = getAnimeMatcherForId(id || '');
        if (specialMatcher) {
          bestMatch = typedResults.find((anime: AnimeResult) => specialMatcher(anime));
        } else {
          const exactMatchNames = [searchName, showDetails.name]
            .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
            .map((name) => name.toLowerCase())
            .filter((name, index, arr) => arr.indexOf(name) === index);
          const alternativeMatchTerms = getAnimeMatchTerms(searchName, showDetails.name);

          // First look for exact match using the filtered search name (not the full TMDB title)
          const filteredSearchName = searchName.toLowerCase();
          bestMatch = typedResults.find((anime: AnimeResult) =>
            anime.name.toLowerCase() === filteredSearchName &&
            anime.seasons &&
            anime.seasons.length > 0
          );
          // If no exact match with filtered name, try with full name
          if (!bestMatch) {
            bestMatch = typedResults.find((anime: AnimeResult) =>
              anime.name.toLowerCase() === showDetails.name.toLowerCase() &&
              anime.seasons &&
              anime.seasons.length > 0
            );
          }
          // If still no match, look for exact or inclusion match in alternative_names
          if (!bestMatch) {
            // First try exact match
            bestMatch = typedResults.find((anime: AnimeResult) =>
              Array.isArray(anime.alternative_names) &&
              anime.alternative_names.some(
                (alt: string) => alternativeMatchTerms.includes(alt.toLowerCase())
              ) &&
              anime.seasons && anime.seasons.length > 0
            );
            // If no exact match, try inclusion match (one title contains the other)
            if (!bestMatch) {
              bestMatch = typedResults.find((anime: AnimeResult) =>
                Array.isArray(anime.alternative_names) &&
                anime.alternative_names.some(
                  (alt: string) => {
                    const altLower = alt.toLowerCase();
                    return alternativeMatchTerms.some(
                      (matchTerm) =>
                        altLower.length > 0 &&
                        (altLower.includes(matchTerm) || matchTerm.includes(altLower))
                    );
                  }
                ) &&
                anime.seasons && anime.seasons.length > 0
              );
            }
          }

          // If still no match, try with search variations in alternative_names
          if (!bestMatch) {
            bestMatch = typedResults.find((anime: AnimeResult) =>
              Array.isArray(anime.alternative_names) &&
              anime.alternative_names.some(
                (alt: string) => alternativeMatchTerms.includes(alt.toLowerCase())
              ) &&
              anime.seasons && anime.seasons.length > 0
            );
          }
          // Si toujours aucune correspondance exacte, vérifier la similarité des titres pour éviter les faux positifs
          if (!bestMatch) {
            // Calculer la similarité pour chaque résultat et prendre le meilleur
            // On compare aussi avec les alternative_names pour trouver le meilleur score
            const resultsWithSimilarity = typedResults
              .filter((anime: AnimeResult) => anime.seasons && anime.seasons.length > 0)
              .map((anime: AnimeResult) => {
                let similarity = exactMatchNames.reduce(
                  (bestSimilarity, name) => Math.max(bestSimilarity, calculateTitleSimilarity(name, anime.name)),
                  0
                );
                // Aussi vérifier la similarité avec les noms alternatifs
                if (anime.alternative_names && Array.isArray(anime.alternative_names)) {
                  for (const alt of anime.alternative_names) {
                    for (const matchTerm of alternativeMatchTerms) {
                      const altSimilarity = calculateTitleSimilarity(matchTerm, alt);
                      if (altSimilarity > similarity) {
                        similarity = altSimilarity;
                      }
                    }
                  }
                }
                return { anime, similarity };
              })
              .sort((a, b) => b.similarity - a.similarity);

            // Ne prendre que si la similarité est suffisamment élevée (au moins 0.6)
            if (resultsWithSimilarity.length > 0 && resultsWithSimilarity[0].similarity >= 0.6) {
              bestMatch = resultsWithSimilarity[0].anime;
              console.log(`Correspondance par similarité trouvée: "${bestMatch.name}" (similarité: ${resultsWithSimilarity[0].similarity})`);
            } else if (resultsWithSimilarity.length > 0) {
              console.log(`Aucune correspondance suffisante trouvée. Meilleure similarité: "${resultsWithSimilarity[0].anime.name}" (${resultsWithSimilarity[0].similarity})`);
            }
          }
        }
        // --- FIN PATCH SPECIAL ANIMES ---
        if (bestMatch && bestMatch.seasons && bestMatch.seasons.length > 0) {
          setAnimeData(bestMatch as AnimeData);
        } else {
          setError(t('watch.noAnimeSource'));
        }
      } else {
        setError(t('watch.noAnimeSource'));
      }
    } catch (error) {
      console.error('Error loading anime data:', error);
      setError(t('watch.animeDataError'));
    }
  }, [id, showDetails?.name]);

  // Load anime data when show details are available
  useEffect(() => {
    if (showDetails) {
      loadAnimeData();
    }
  }, [showDetails, loadAnimeData]);

  // Reset displayed season when URL season changes
  useEffect(() => {
    setDisplayedSeasonNumber(Number(season));
  }, [season]);

  // Reset initial load flag when episode changes
  useEffect(() => {
    setIsInitialLoad(true);
  }, [id, season, episode]);

  // Process anime data when available
  useEffect(() => {
    if (animeData && season && episode) {
      // Find the season - since seasons are named instead of numbered, we check if the index in array matches the season number
      const seasonIndex = Number(season) - 1;
      const currentSeason = seasonIndex >= 0 && seasonIndex < animeData.seasons.length
        ? animeData.seasons[seasonIndex]
        : null;

      // If no matching season by index, try to find by name (for cases where "Saison 1" might be in the name)
      let finalSeason = currentSeason;
      if (!finalSeason) {
        finalSeason = animeData.seasons.find(s =>
          s.name.toLowerCase().includes(`saison ${season}`) ||
          s.name.toLowerCase() === `saison ${season}` ||
          s.name.toLowerCase() === `season ${season}`
        ) || null;
      }

      if (finalSeason) {
        console.log(`Found season: ${finalSeason.name}`);
        // Now find the matching episode by index
        const episodeIndex = Number(episode) - 1;
        const currentEpisode = episodeIndex >= 0 && episodeIndex < finalSeason.episodes.length
          ? finalSeason.episodes[episodeIndex]
          : finalSeason.episodes.find(e => e.index === Number(episode));

        if (currentEpisode) {
          console.log(`Found episode: ${currentEpisode.name}`);
          // Get available languages
          const availLangs = currentEpisode.streaming_links.map(link => link.language);
          setAvailableLanguages(availLangs);

          // Pick selon l'ordre utilisateur (défaut : vf > vostfr > vj > va > vkr > vcn,
          // comportement historique préservé via `buildDefaults` de sourcePriorityPrefs).
          const picked = pickAutoSelectedLanguage(availLangs);
          if (picked) {
            setSelectedLanguage(picked);
          } else if (availLangs.length > 0) {
            setSelectedLanguage(availLangs[0]);
          }

          // Le traitement des sources vidéo est délégué au useEffect dédié ci-dessous
          // pour éviter un double appel qui cause des re-renders infinis
        } else {
          const maxEpisodes = finalSeason.episodes.length;
          setError(t('watch.episodeNotFoundInSeason', { episode, season, maxEpisodes }));
          setLoading(false);
        }
      } else {
        // Debug info
        console.error('Available seasons:', animeData.seasons.map(s => s.name));

        // Generate a more helpful error message with available seasons
        const availableSeasons = animeData.seasons.map(s => s.name).join(', ');
        setError(t('watch.seasonNotFound', { season, availableSeasons }));
        setLoading(false);
      }
    }
  }, [animeData, season, episode]);

  // Process video sources when language changes
  // MODIFIÉ: Ne plus traiter automatiquement les sources quand la langue change
  // L'utilisateur doit maintenant sélectionner manuellement une nouvelle source
  useEffect(() => {
    if (animeData && season && episode) {
      const seasonIndex = Number(season) - 1;
      const currentSeason = seasonIndex >= 0 && seasonIndex < animeData.seasons.length
        ? animeData.seasons[seasonIndex]
        : animeData.seasons.find(s =>
          s.name.toLowerCase().includes(`saison ${season}`) ||
          s.name.toLowerCase() === `saison ${season}` ||
          s.name.toLowerCase() === `season ${season}`
        );

      if (currentSeason) {
        const episodeIndex = Number(episode) - 1;
        const currentEpisode = episodeIndex >= 0 && episodeIndex < currentSeason.episodes.length
          ? currentSeason.episodes[episodeIndex]
          : currentSeason.episodes.find(e => e.index === Number(episode));

        if (currentEpisode) {
          // Ne traiter les sources que si c'est le chargement initial ou si aucune source n'est sélectionnée
          if (isInitialLoad || !selectedSource) {
            processVideoSources(currentEpisode);
          }
          // SUPPRIMÉ: Ne plus traiter les sources automatiquement lors du changement de langue
          // L'utilisateur doit maintenant sélectionner manuellement une nouvelle source
        }
      }
    }
  }, [animeData, season, episode, isInitialLoad, selectedSource]);

  // Check if loading is complete (including extractions)
  useEffect(() => {
    if (loading && !loadingVidmolyExtraction && !loadingSibnetExtraction && !loadingOneUploadExtraction && videoSources.length > 0) {
      setLoading(false);
    }
  }, [loading, loadingVidmolyExtraction, loadingSibnetExtraction, loadingOneUploadExtraction, videoSources.length]);

  // Process video sources from anime episode
  const processVideoSources = async (animeEpisode: AnimeEpisode) => {
    const sources: VideoSource[] = [];
    const vidmolySources: VideoSource[] = [];
    const sibnetSources: VideoSource[] = [];
    const oneUploadSources: VideoSource[] = [];

    // Traiter toutes les langues disponibles en une seule fois pour éviter les re-extractions
    for (const streamingLink of animeEpisode.streaming_links) {
      const players = streamingLink.players;

      for (const playerUrl of players) {
        const playerUrlString = typeof playerUrl === 'string' ? playerUrl : String(playerUrl);

        // Check if this is a Vidmoly URL - extract M3U8
        if (playerUrlString.includes('vidmoly.to') || playerUrlString.includes('vidmoly.net')) {
          // Use the URL as-is if it's already .net, otherwise replace .to with .net
          const vidmolyNetUrl = playerUrlString.includes('vidmoly.net')
            ? playerUrlString
            : playerUrlString.replace('vidmoly.to', 'vidmoly.net');

          const vidmolySource = {
            language: streamingLink.language,
            quality: 'Auto',
            url: vidmolyNetUrl,
            player: 'Vidmoly',
            label: `${streamingLink.language.toUpperCase()} - Vidmoly`,
            id: `vidmoly-${streamingLink.language}-${vidmolyNetUrl}`
          };

          vidmolySources.push(vidmolySource);

          // Also add as embed source for fallback
          sources.push(vidmolySource);
        }
        // Check if this is a Sibnet URL - extract M3U8
        else if (playerUrlString.includes('sibnet.ru')) {
          const sibnetSource = {
            language: streamingLink.language,
            quality: 'Auto',
            url: playerUrlString,
            player: 'Sibnet',
            label: `${streamingLink.language.toUpperCase()} - Sibnet`,
            id: `sibnet-${streamingLink.language}-${playerUrlString}`
          };

          sibnetSources.push(sibnetSource);

          // Also add as embed source for fallback
          sources.push(sibnetSource);
        }
        // Check if this is a OneUpload URL - extract M3U8
        else if (playerUrlString.includes('oneupload.to')) {
          const oneUploadSource = {
            language: streamingLink.language,
            quality: 'Auto',
            url: playerUrlString,
            player: 'OneUpload',
            label: `${streamingLink.language.toUpperCase()} - OneUpload`,
            id: `oneupload-${streamingLink.language}-${playerUrlString}`
          };

          oneUploadSources.push(oneUploadSource);

          // Also add as embed source for fallback
          sources.push(oneUploadSource);
        }
        // Skip anime-sama URLs - don't display them as players
        else if (playerUrlString.includes('anime-sama.fr') || playerUrlString.includes('anime-sama.to')) {
          console.log('Skipping anime-sama URL:', playerUrlString);
          continue;
        } else {
          // Extract domain name from URL to use as player name
          let playerName = "Unknown";
          try {
            const url = new URL(playerUrlString);
            const hostname = url.hostname;
            const domainParts = hostname.replace(/^www\./, '').split('.');
            if (domainParts.length >= 2) {
              playerName = domainParts[domainParts.length - 2];
              const domainMappings: Record<string, string> = {
                'vidmoly': 'Vidmoly',
                'sendvid': 'Sendvid',
                'vk': 'VK',
                'vkvideo': 'VKVideo',
                'oneupload': 'OneUpload',
                'smoothpre': 'SmoothPre',
                'video': 'Video'
              };
              playerName = domainMappings[playerName.toLowerCase()] || playerName.charAt(0).toUpperCase() + playerName.slice(1);
            }
          } catch (e) {
            try {
              const domainMatch = playerUrlString.match(/https?:\/\/(?:www\.)?([^\/]+)/i);
              if (domainMatch && domainMatch[1]) {
                const domain = domainMatch[1].split('.')[0];
                playerName = domain.charAt(0).toUpperCase() + domain.slice(1);
              }
            } catch (matchError) {
              console.error("Error extracting domain:", matchError);
              playerName = "Unknown";
            }
          }

          // Add source as embed
          sources.push({
            language: streamingLink.language,
            quality: 'Auto',
            url: playerUrlString,
            player: playerName,
            label: `${streamingLink.language.toUpperCase()} - ${playerName}`,
            id: `${playerName.toLowerCase()}-${streamingLink.language}-${playerUrlString}`
          });
        }
      }
    }

    // Extract M3U8 from Vidmoly sources
    if (vidmolySources.length > 0) {
      console.log('🔍 Extracting M3U8 from Vidmoly sources...');
      setLoadingVidmolyExtraction(true);
      setExtractionProgress(t('watch.extractingSources', { provider: 'Vidmoly' }));

      for (const vidmolySource of vidmolySources) {
        try {
          const extractionResult = await extractVidmolyM3u8(vidmolySource.url, MAIN_API);

          if (extractionResult && extractionResult.success && extractionResult.m3u8Url) {
            console.log('✅ Vidmoly M3U8 extracted:', extractionResult.m3u8Url);

            // Add HLS source
            sources.push({
              language: vidmolySource.language,
              quality: 'Auto',
              url: extractionResult.m3u8Url,
              player: 'Vidmoly',
              label: `${vidmolySource.language.toUpperCase()} - Vidmoly HLS`,
              isM3u8: true,
              id: `vidmoly-hls-${vidmolySource.language}-${extractionResult.m3u8Url}`
            });
          } else {
            console.log('❌ Vidmoly M3U8 extraction failed:', extractionResult?.error);
          }
        } catch (error) {
          console.error('Error extracting Vidmoly M3U8:', error);
        }
      }
      setLoadingVidmolyExtraction(false);
    }

    // Extract M3U8 from Sibnet sources
    if (sibnetSources.length > 0) {
      console.log('🔍 Extracting M3U8 from Sibnet sources...');
      setLoadingSibnetExtraction(true);
      setExtractionProgress(t('watch.extractingSources', { provider: 'Sibnet' }));

      for (const sibnetSource of sibnetSources) {
        try {
          const extractionResult = await extractSibnetM3u8(sibnetSource.url, MAIN_API);

          if (extractionResult && extractionResult.success && extractionResult.m3u8Url) {
            console.log('✅ Sibnet source extracted:', extractionResult.m3u8Url);

            // For Sibnet sources, always mark as HLS for UI consistency (even if MP4)
            // The HLSPlayer will handle MP4 detection internally
            sources.push({
              language: sibnetSource.language,
              quality: 'Auto',
              url: extractionResult.m3u8Url,
              player: 'Sibnet',
              label: `${sibnetSource.language.toUpperCase()} - Sibnet HLS`,
              isM3u8: true, // Always true for Sibnet to show HLS tag
              id: `sibnet-hls-${sibnetSource.language}-${extractionResult.m3u8Url}`
            });
          } else {
            console.log('❌ Sibnet M3U8 extraction failed:', extractionResult?.error);
          }
        } catch (error) {
          console.error('Error extracting Sibnet M3U8:', error);
        }
      }
      setLoadingSibnetExtraction(false);
    }

    // Extract M3U8 from OneUpload sources
    if (oneUploadSources.length > 0) {
      console.log('🔍 Extracting M3U8 from OneUpload sources...');
      setLoadingOneUploadExtraction(true);
      setExtractionProgress(t('watch.extractingSources', { provider: 'OneUpload' }));

      for (const oneUploadSource of oneUploadSources) {
        try {
          const extractionResult = await extractOneUploadSources(oneUploadSource.url);

          if (extractionResult && extractionResult.success && (extractionResult.hlsUrl || extractionResult.m3u8Url)) {
            const extractedUrl = extractionResult.hlsUrl || extractionResult.m3u8Url;
            if (extractedUrl) {
              console.log('✅ OneUpload source extracted:', extractedUrl);

              // Add HLS source (mark as M3U8 for UI consistency, HLSPlayer will handle MP4 detection)
              sources.push({
                language: oneUploadSource.language,
                quality: 'Auto',
                url: extractedUrl,
                player: 'OneUpload',
                label: `${oneUploadSource.language.toUpperCase()} - OneUpload HLS`,
                isM3u8: true,
                id: `oneupload-hls-${oneUploadSource.language}-${extractedUrl}`
              });
            }
          } else {
            console.log('❌ OneUpload M3U8 extraction failed:', extractionResult?.error);
          }
        } catch (error) {
          console.error('Error extracting OneUpload M3U8:', error);
        }
      }
      setLoadingOneUploadExtraction(false);
    }

    // Tri par priorité hoster selon prefs utilisateur.
    // On annote chaque source avec son `type` détecté (via detectHoster, qui utilise
    // les regex du registre + overrides user), puis on trie avec `sortHostersByPriority`
    // dans le contexte `anime` + langue courante (permet override par langue si défini).
    // Fallback legacy : Vidmoly > Sibnet > OneUpload > autres (préservé via l'ordre
    // par défaut construit dans buildDefaults si aucun override user n'est présent).
    const prefs = getSourcePriorityPrefs();
    const annotated = sources.map((s) => {
      const detected = detectHoster(s.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      });
      // Mapper le nom affiché aux ids du registre pour les hosters anime-specific
      // (Vidmoly, Sibnet, OneUpload sont détectés par regex → pas de fallback nécessaire).
      const type = detected ?? (s.player.toLowerCase() === 'vidmoly' ? 'vidmoly'
        : s.player.toLowerCase() === 'sibnet' ? 'sibnet'
        : s.player.toLowerCase() === 'oneupload' ? 'oneupload'
        : s.player.toLowerCase());
      return { source: s, type };
    });
    const sorted = sortHostersByPriority(annotated, {
      category: 'anime',
      topLevel: selectedLanguage,
    });
    const sortedSources = sorted.map((a) => a.source);

    setVideoSources(sortedSources);
    setExtractionProgress('');

    // Ne pas changer automatiquement la source sélectionnée si ce n'est pas le chargement initial
    // L'utilisateur doit maintenant sélectionner manuellement une nouvelle source dans la langue choisie
  };

  // Fonction pour sélectionner automatiquement la meilleure source
  const selectBestSource = useCallback(() => {
    if (videoSources.length === 0) return;

    // Filtrer les sources par langue sélectionnée
    const filteredSources = videoSources.filter(source =>
      source.language?.toLowerCase() === selectedLanguage.toLowerCase()
    );

    let sourceToSelect = null;

    console.log('Auto-selecting source. Available sources:', videoSources.map(s => ({
      player: s.player,
      language: s.language,
      isM3u8: s.isM3u8,
      label: s.label
    })));
    console.log('Selected language:', selectedLanguage);
    console.log('Filtered sources for language:', filteredSources.map(s => ({
      player: s.player,
      language: s.language,
      isM3u8: s.isM3u8,
      label: s.label
    })));

    // Utiliser les sources filtrées pour la sélection
    const sourcesToSearch = filteredSources.length > 0 ? filteredSources : videoSources;

    // Priority 1: Vidmoly HLS source in VF (always prioritize VF if available)
    if (!sourceToSelect) {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.player === 'Vidmoly' &&
        source.language?.toLowerCase() === 'vf'
      );
      if (sourceToSelect) {
        console.log('Selected Vidmoly VF HLS source:', sourceToSelect.label);
      }
    }

    // Priority 2: Vidmoly HLS source in current language (non-VF)
    if (!sourceToSelect && selectedLanguage && selectedLanguage !== 'vf') {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.player === 'Vidmoly' &&
        source.language?.toLowerCase() === selectedLanguage.toLowerCase()
      );
      if (sourceToSelect) {
        console.log('Selected Vidmoly HLS source in current language:', sourceToSelect.label);
      }
    }

    // Priority 3: Sibnet HLS source in VF (always prioritize VF if available)
    if (!sourceToSelect) {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.player === 'Sibnet' &&
        source.language?.toLowerCase() === 'vf'
      );
      if (sourceToSelect) {
        console.log('Selected Sibnet VF HLS source:', sourceToSelect.label);
      }
    }

    // Priority 4: Sibnet HLS source in current language (non-VF)
    if (!sourceToSelect && selectedLanguage && selectedLanguage !== 'vf') {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.player === 'Sibnet' &&
        source.language?.toLowerCase() === selectedLanguage.toLowerCase()
      );
      if (sourceToSelect) {
        console.log('Selected Sibnet HLS source in current language:', sourceToSelect.label);
      }
    }

    // Priority 5: OneUpload HLS source in VF (always prioritize VF if available)
    if (!sourceToSelect) {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.player === 'OneUpload' &&
        source.language?.toLowerCase() === 'vf'
      );
      if (sourceToSelect) {
        console.log('Selected OneUpload VF HLS source:', sourceToSelect.label);
      }
    }

    // Priority 6: OneUpload HLS source in current language (non-VF)
    if (!sourceToSelect && selectedLanguage && selectedLanguage !== 'vf') {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.player === 'OneUpload' &&
        source.language?.toLowerCase() === selectedLanguage.toLowerCase()
      );
      if (sourceToSelect) {
        console.log('Selected OneUpload HLS source in current language:', sourceToSelect.label);
      }
    }

    // Priority 7: Any HLS source in VF (always prioritize VF if available)
    if (!sourceToSelect) {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.language?.toLowerCase() === 'vf'
      );
      if (sourceToSelect) {
        console.log('Selected VF HLS source:', sourceToSelect.label);
      }
    }

    // Priority 8: Any HLS source in current language
    if (!sourceToSelect && selectedLanguage) {
      sourceToSelect = sourcesToSearch.find(source =>
        source.isM3u8 &&
        source.language?.toLowerCase() === selectedLanguage.toLowerCase()
      );
      if (sourceToSelect) {
        console.log('Selected HLS source in current language:', sourceToSelect.label);
      }
    }

    // Priority 9: Any HLS source
    if (!sourceToSelect) {
      sourceToSelect = sourcesToSearch.find(source => source.isM3u8);
      if (sourceToSelect) {
        console.log('Selected any HLS source:', sourceToSelect.label);
      }
    }

    // Priority 10: First available source in current language
    if (!sourceToSelect && selectedLanguage) {
      sourceToSelect = sourcesToSearch.find(source =>
        source.language?.toLowerCase() === selectedLanguage.toLowerCase()
      );
      if (sourceToSelect) {
        console.log('Selected first source in current language:', sourceToSelect.label);
      }
    }

    // Priority 11: First available source
    if (!sourceToSelect) {
      sourceToSelect = sourcesToSearch[0];
      console.log('Selected first available source:', sourceToSelect.label);
    }

    console.log('Final selected source:', sourceToSelect);
    setSelectedSource(sourceToSelect);

    // Trigger ad popup based on player type for auto-selected source
    const playerType = sourceToSelect.player.toLowerCase();
    if (playerType.includes('vidmoly')) {
      showPopupForPlayer('vidmoly');
    } else if (playerType.includes('sibnet')) {
      showPopupForPlayer('vidmoly'); // Sibnet is treated as vidmoly type
    } else if (playerType.includes('oneupload')) {
      showPopupForPlayer('omega'); // OneUpload is treated as omega type
    } else {
      // For other players, show generic popup
      showPopupForPlayer('adfree');
    }

    if (sourceToSelect.isM3u8) {
      // Use HLS Player for m3u8 sources (including Sibnet sources)
      setHlsPlayerSrc(sourceToSelect.url);
      setShowHLSPlayer(true);
      setEmbedUrl(null);
    } else {
      setEmbedUrl(sourceToSelect.url);
      setShowHLSPlayer(false);
      setHlsPlayerSrc('');
    }
  }, [videoSources, selectedLanguage]);

  // Sélection automatique du premier lecteur disponible (seulement au chargement initial)
  useEffect(() => {
    if (videoSources.length > 0 && isInitialLoad) {
      selectBestSource();
      // Marquer que la sélection initiale est terminée
      setIsInitialLoad(false);
    }
  }, [videoSources, isInitialLoad, selectBestSource]);

  // DÉSACTIVÉ: Ne plus sélectionner automatiquement un lecteur quand on change de langue
  // L'utilisateur doit maintenant choisir manuellement le lecteur dans la langue sélectionnée
  // useEffect(() => {
  //   if (videoSources.length > 0 && !isInitialLoad) {
  //     selectBestSource();
  //   }
  // }, [selectedLanguage, selectBestSource, isInitialLoad]);

  // Handle source selection
  const handleSelectSource = (source: VideoSource) => {
    setSelectedSource(source);

    // Trigger ad popup based on player type
    const playerType = source.player.toLowerCase();
    if (playerType.includes('vidmoly')) {
      showPopupForPlayer('vidmoly');
    } else if (playerType.includes('sibnet')) {
      showPopupForPlayer('vidmoly'); // Sibnet is treated as vidmoly type
    } else if (playerType.includes('oneupload')) {
      showPopupForPlayer('omega'); // OneUpload is treated as omega type
    } else {
      // For other players, show generic popup
      showPopupForPlayer('adfree');
    }

    if (source.isM3u8) {
      // Use HLS Player for m3u8 sources (including Sibnet sources)
      setHlsPlayerSrc(source.url);
      setShowHLSPlayer(true);
      setEmbedUrl(null);
    } else {
      // Use embed for other sources
      setEmbedUrl(source.url);
      setShowHLSPlayer(false);
      setHlsPlayerSrc('');
    }

    setShowEmbedQuality(false);

    // Progress saving functionality removed
  };

  // Listener pour l'événement showSourcesMenu (déclenché par HLSPlayer en cas d'erreur 403)
  useEffect(() => {
    const handleShowSourcesMenu = () => {
      setShowEmbedQuality(true);
    };
    window.addEventListener('showSourcesMenu', handleShowSourcesMenu);
    return () => {
      window.removeEventListener('showSourcesMenu', handleShowSourcesMenu);
    };
  }, []);

  // Watch progress functionality removed


  // Handle page unload to mark episode as watched
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!isWatched) {
        toggleWatched();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, [isWatched, toggleWatched]);

  // Handle next episode (for HLSPlayer)
  const handleNextEpisodeFromPlayer = (seasonNum: number, episodeNum: number) => {
    if (!id) return;
    window.location.href = `/watch/anime/${encodeId(id)}/season/${seasonNum}/episode/${episodeNum}`;
  };

  // Handle next episode (for buttons)
  const handleNextEpisode = () => {
    if (!animeData || !season || !episode) return;

    const currentSeasonIndex = Number(season) - 1;
    const currentEpisodeNumber = Number(episode);
    const currentSeason = animeData.seasons[currentSeasonIndex];

    let targetSeason = Number(season);
    let targetEpisode = currentEpisodeNumber + 1;

    if (currentSeason && targetEpisode > currentSeason.episodes.length) {
      // Move to the first episode of the next season if it exists
      if (currentSeasonIndex + 1 < animeData.seasons.length) {
        targetSeason = currentSeasonIndex + 2;
        targetEpisode = 1;
      } else {
        // No next episode/season
        return;
      }
    }

    // Use window.location.href for full page reload
    if (!id) return;
    window.location.href = `/watch/anime/${encodeId(id)}/season/${targetSeason}/episode/${targetEpisode}`;
  };

  // Handle previous episode
  const handlePreviousEpisode = () => {
    if (!animeData || !season || !episode || !id) return;

    const currentSeasonIndex = Number(season) - 1;
    const currentEpisodeNumber = Number(episode);

    let targetSeason = Number(season);
    let targetEpisode = currentEpisodeNumber - 1;

    if (targetEpisode < 1) {
      // Move to the last episode of the previous season if it exists
      if (currentSeasonIndex > 0) {
        const prevSeason = animeData.seasons[currentSeasonIndex - 1];
        targetSeason = currentSeasonIndex; // Season number is index + 1
        targetEpisode = prevSeason.episodes.length; // Last episode of previous season
      } else {
        // No previous episode/season
        return;
      }
    }
    // Use window.location.href for full page reload
    window.location.href = `/watch/anime/${encodeId(id)}/season/${targetSeason}/episode/${targetEpisode}`;
  };

  useEffect(() => {
    const setVh = () => {
      document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    };
    setVh();
    window.addEventListener('resize', setVh);
    return () => window.removeEventListener('resize', setVh);
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100vh';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100vh';
    return () => {
      document.body.style.overflow = '';
      document.body.style.height = '';
      document.documentElement.style.overflow = '';
      document.documentElement.style.height = '';
    };
  }, []);

  // Age restriction blocking screen
  if (isBlocked) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 bg-red-600/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">{t('details.contentBlocked')}</h2>
          <p className="text-gray-400 mb-6">
            {t('details.contentBlockedDesc', { rating: getClassificationLabel(contentCert, t), age: currentProfile?.ageRestriction ?? 0 })}
          </p>
          <button
            onClick={() => navigate(-1)}
            className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors font-medium"
          >
            {t('details.goBack')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: 'calc(var(--vh, 1vh) * 100)', overflow: 'hidden' }} className="w-full bg-gray-900 text-white overflow-hidden fixed inset-0">
      <style dangerouslySetInnerHTML={{
        __html: `
          .loading-container {
            --uib-size: 35px;
            --uib-color: white;
            --uib-speed: 1s;
            --uib-stroke: 3.5px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            width: var(--uib-size);
            height: calc(var(--uib-size) * 0.9);
          }

          .loading-bar {
            width: var(--uib-stroke);
            height: 100%;
            background-color: var(--uib-color);
            border-radius: calc(var(--uib-stroke) / 2);
            transition: background-color 0.3s ease;
          }

          .loading-bar:nth-child(1) {
            animation: grow var(--uib-speed) ease-in-out calc(var(--uib-speed) * -0.45) infinite;
          }

          .loading-bar:nth-child(2) {
            animation: grow var(--uib-speed) ease-in-out calc(var(--uib-speed) * -0.3) infinite;
          }

          .loading-bar:nth-child(3) {
            animation: grow var(--uib-speed) ease-in-out calc(var(--uib-speed) * -0.15) infinite;
          }

          .loading-bar:nth-child(4) {
            animation: grow var(--uib-speed) ease-in-out infinite;
          }

          @keyframes grow {
            0%, 100% {
              transform: scaleY(0.3);
            }
            50% {
              transform: scaleY(1);
            }
          }
        `
      }} />
      <div
        hidden
        data-premid-watch-context=""
        data-premid-title={showDetails?.name || undefined}
        data-premid-media-type="anime"
        data-premid-season={season}
        data-premid-episode={episode}
        data-premid-episode-title={episodeDetails?.name || undefined}
        data-premid-source-label={selectedSource?.player || undefined}
        data-premid-source-detail={selectedSource?.label || undefined}
      />
      {!id ? (
        <div className="flex items-center justify-center h-full">
          <div className="max-w-2xl mx-auto bg-gray-800 p-8 rounded-xl shadow-2xl">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-white mb-4">{t('watch.invalidId')}</h2>
              <p className="text-gray-300 mb-6">
                {t('watch.animeInvalidIdDesc')}
              </p>
              <button
                onClick={() => navigate('/anime')}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg transition-colors"
              >
                {t('watch.backToAnimes')}
              </button>
            </div>
          </div>
        </div>
      ) : loading ? (
        <div className="flex flex-col items-center justify-center h-full bg-black">
          <div className="loading-container">
            <div className="loading-bar"></div>
            <div className="loading-bar"></div>
            <div className="loading-bar"></div>
            <div className="loading-bar"></div>
          </div>
          <div className="text-white text-xl font-medium mt-6">{t('watch.loadingEpisode')}</div>
          {extractionProgress && (
            <div className="text-gray-300 text-sm mt-2">{extractionProgress}</div>
          )}
          {(loadingVidmolyExtraction || loadingSibnetExtraction || loadingOneUploadExtraction) && (
            <div className="mt-4 space-y-2">
              {loadingVidmolyExtraction && (
                <div className="flex items-center gap-2 text-blue-400 text-sm">
                  <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                  {t('watch.extractionPlayer', { player: 'Vidmoly' })}
                </div>
              )}
              {loadingSibnetExtraction && (
                <div className="flex items-center gap-2 text-green-400 text-sm">
                  <div className="w-3 h-3 border-2 border-green-400 border-t-transparent rounded-full animate-spin"></div>
                  {t('watch.extractionPlayer', { player: 'Sibnet' })}
                </div>
              )}
              {loadingOneUploadExtraction && (
                <div className="flex items-center gap-2 text-purple-400 text-sm">
                  <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin"></div>
                  {t('watch.extractionPlayer', { player: 'OneUpload' })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-full">
          <div className="max-w-2xl mx-auto bg-gray-800 p-8 rounded-xl shadow-2xl">
            <h2 className="text-2xl font-bold text-red-500 mb-4">{t('watch.errorTitle')}</h2>
            <p className="text-lg mb-6">{error}</p>

            {animeData && (
              <div className="mb-6">
                <h3 className="text-xl font-semibold mb-4">{t('watch.availableSeasons')}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {animeData.seasons.map((s, idx) => (
                    <div key={idx} className="bg-gray-700 p-4 rounded-lg">
                      <h4 className="text-lg font-medium mb-2">{s.name}</h4>
                      <p className="text-sm text-gray-300 mb-3">{t('watch.episodesCount', { count: s.episodes.length })}</p>
                      <div className="flex flex-wrap gap-2">
                        {[...Array(Math.min(5, s.episodes.length))].map((_, i) => (
                          <button
                            key={i}
                            className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-sm"
                            onClick={() => id && navigate(`/watch/anime/${encodeId(id)}/season/${idx + 1}/episode/${i + 1}`)}
                          >
                            Ep {i + 1}
                          </button>
                        ))}
                        {s.episodes.length > 5 && (
                          <span className="text-gray-400 self-center">...</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-4">
              <button
                className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-md"
                onClick={() => navigate(-1)}
              >
                {t('watch.back')}
              </button>
              {animeData && animeData.seasons.length > 0 && (
                <button
                  className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-md"
                  onClick={() => id && navigate(`/watch/anime/${encodeId(id)}/season/1/episode/1`)}
                >
                  {t('watch.startSeries')}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center relative">
          {/* Back to Info Button - Hidden when HLS Player is active */}
          {!showHLSPlayer && (
            <motion.button
              onClick={() => navigate(`/tv/${encodeId(id!)}`)}
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
              whileTap={{ scale: 0.95 }}
              className="absolute top-4 left-4 z-[9999] flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              {t('watch.back')}
            </motion.button>
          )}

          {/* Navigation buttons (Previous, Episodes, Next) - Hidden when HLS Player is active */}
          {animeData && !showHLSPlayer && (
            <motion.div
              className="absolute top-4 right-4 z-[9000] flex items-center gap-2"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {/* Previous Episode Button - hide if at first episode of first season */}
              {!(Number(season) === 1 && Number(episode) === 1) && (
                <motion.button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePreviousEpisode();
                  }}
                  whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
                  whileTap={{ scale: 0.95 }}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                  </svg>
                  <span>
                    {Number(episode) > 1
                      ? `S${Number(season)}:${String(Number(episode) - 1).padStart(2, '0')}`
                      : Number(season) > 1
                        ? `S${Number(season) - 1}:01`
                        : `S1:01`}
                  </span>
                </motion.button>
              )}

              {/* Episodes Button */}
              <motion.button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowEpisodesMenu(!showEpisodesMenu);
                }}
                whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
                whileTap={{ scale: 0.95 }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h7" />
                </svg>
                <span className="hidden sm:inline">{t('watch.episodes')}</span>
              </motion.button>

              {/* Next Episode Button */}
              {animeData && (
                (() => {
                  const nextSeason = animeData.seasons[Number(season) - 1] && Number(episode) < animeData.seasons[Number(season) - 1].episodes.length
                    ? Number(season)
                    : Number(season) < animeData.seasons.length
                      ? Number(season) + 1
                      : null;
                  const nextEpisodeNum = nextSeason === Number(season)
                    ? Number(episode) + 1
                    : nextSeason
                      ? 1
                      : null;

                  return nextSeason && nextEpisodeNum ? (
                    <motion.button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNextEpisode();
                      }}
                      whileHover={{ scale: 1.05, backgroundColor: "rgba(0, 0, 0, 0.9)" }}
                      whileTap={{ scale: 0.95 }}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/70 text-white shadow-lg"
                    >
                      <span>S{nextSeason}:{String(nextEpisodeNum).padStart(2, '0')}</span>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                      </svg>
                    </motion.button>
                  ) : null;
                })()
              )}
            </motion.div>
          )}

          {/* Episodes Menu */}
          <AnimatePresence>
            {/* Ensure variables like showEpisodesMenu, animeData etc. are accessible here */}
            {showEpisodesMenu && animeData && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.2 }}
                className="absolute top-14 right-4 md:right-4 left-4 md:left-auto z-[11000] bg-black/95 border border-gray-800 rounded-lg shadow-2xl md:w-96 w-auto max-h-[80vh] overflow-hidden flex flex-col"
              >
                <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                  <h3 className="text-lg font-semibold text-white">{showDetails?.name}</h3>
                  <button
                    onClick={() => setShowEpisodesMenu(false)}
                    className="text-gray-400 hover:text-white"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Custom Season Dropdown */}
                <div className="p-4 border-b border-gray-800/50">
                  <h4 className="text-sm text-gray-400 mb-2">{t('watch.seasonLabel')}</h4>
                  <div className="relative w-full">
                    <button
                      onClick={() => setShowSeasonDropdown(!showSeasonDropdown)}
                      className="w-full flex items-center justify-between bg-gray-800/50 hover:bg-gray-700/50 rounded-lg p-3 text-white transition-colors duration-200"
                    >
                      {/* Display selected season name */}
                      <span className="font-medium">{animeData.seasons[displayedSeasonNumber - 1]?.name || t('watch.seasonN', { n: displayedSeasonNumber })}</span>
                      <motion.div
                        animate={{ rotate: showSeasonDropdown ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                        </svg>
                      </motion.div>
                    </button>

                    {/* Animated Dropdown List */}
                    <AnimatePresence>
                      {showSeasonDropdown && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.2, ease: "easeInOut" }}
                          className="absolute top-full left-0 right-0 mt-1 bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl max-h-60 overflow-y-auto z-20 custom-scrollbar"
                          data-lenis-prevent
                        >
                          {animeData.seasons.map((s, index) => (
                            <button
                              key={index}
                              onClick={() => {
                                setDisplayedSeasonNumber(index + 1);
                                setShowSeasonDropdown(false); // Close dropdown on selection
                              }}
                              className={`w-full text-left px-4 py-3 text-sm transition-colors duration-150 ${displayedSeasonNumber === index + 1
                                ? 'bg-red-800/50 text-red-100 font-semibold'
                                : 'text-gray-200 hover:bg-gray-700/50'
                                }`}
                            >
                              {s.name}
                              <span className="text-xs text-gray-400 ml-1">({t('watch.episodesCount', { count: s.episodes.length })})</span>
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Current Episode (reflects URL, not menu selection) */}
                <div className="p-4 border-b border-gray-800/50">
                  <div className="text-xs text-gray-400 mb-1">
                    {animeData.seasons[Number(season) - 1]?.name} • {t('watch.episodeN', { n: episode })} ({t('watch.watching')})
                  </div>
                  <h4 className="text-white font-medium mb-1">{animeData.seasons[Number(season) - 1]?.episodes[Number(episode) - 1]?.name || t('watch.episodeN', { n: episode })}</h4>
                </div>

                {/* Episodes List (uses displayedSeasonNumber) */}
                <div className="flex-1 overflow-y-auto p-1" data-lenis-prevent>
                  <div className="grid gap-2 p-2">
                    {animeData.seasons[displayedSeasonNumber - 1]?.episodes.map((ep, index) => (
                      <button
                        key={index}
                        onClick={() => {
                          // Use window.location.href for full page reload
                          if (!id) return;
                          window.location.href = `/watch/anime/${encodeId(id)}/season/${displayedSeasonNumber}/episode/${index + 1}`;
                          setShowEpisodesMenu(false);
                        }}
                        className={`flex items-start gap-3 p-2 rounded-lg transition-colors ${Number(episode) === index + 1 && displayedSeasonNumber === Number(season) // Highlight only if season and episode match URL
                          ? 'bg-red-900/30 border border-red-800/50'
                          : 'hover:bg-gray-800/50'
                          }`}
                      >
                        <div className="w-10 h-10 bg-gray-800 rounded flex items-center justify-center">
                          <span className="text-sm font-medium">{index + 1}</span>
                        </div>
                        <div className="flex-1 text-left">
                          <h5 className="text-sm text-white font-medium line-clamp-1">{ep.name || t('watch.episodeN', { n: index + 1 })}</h5>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Change Source Button */}
          {!showHLSPlayer && (
            <button
              onClick={() => setShowEmbedQuality(true)}
              className="fixed top-16 right-4 z-[10000] flex items-center gap-2 px-4 py-2 rounded-lg bg-black/90 border border-gray-700 hover:bg-gray-800/80 text-white font-medium text-sm transition-all duration-200"
            >
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
              <span>{t('watch.sources')}</span>
            </button>
          )}

          {/* Source Selection Panel */}
          <AnimatePresence>
            {showEmbedQuality && (
              <div className="fixed inset-0 z-[10001] bg-black/50 flex justify-end pointer-events-none">
                <motion.div
                  key="embed-quality-menu"
                  initial={{ opacity: 0, x: 300 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 300 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className="bg-black/95 border-l border-gray-800 shadow-2xl w-full max-w-md h-full overflow-y-auto pointer-events-auto"
                  data-lenis-prevent
                >
                  <div className="flex justify-between items-center p-4 border-b border-gray-700/60 sticky top-0 bg-black/95 z-10">
                    <h3 className="text-white text-lg font-bold">{t('watch.sourcesAndLanguages')}</h3>
                    <button
                      onClick={() => setShowEmbedQuality(false)}
                      className="text-gray-400 hover:text-red-500 transition-colors text-2xl font-bold focus:outline-none"
                    >
                      ×
                    </button>
                  </div>

                  <div className="p-4">
                    {/* Current info */}
                    <div className="bg-gray-800/60 rounded-lg p-4 mb-6">
                      <h4 className="text-white text-md font-medium mb-1">{showDetails?.name}</h4>
                      <p className="text-gray-400 text-sm">
                        S{season} E{episode} {episodeDetails?.name ? `- ${episodeDetails.name}` : ''}
                      </p>
                    </div>

                    {/* Language Selector */}
                    {availableLanguages.length > 0 && (
                      <div className="mb-6">
                        <h4 className="text-white text-md font-semibold mb-3 flex items-center">
                          <svg className="w-5 h-5 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                          </svg>
                          {t('watch.versionLabel')}
                        </h4>
                        <div className="grid grid-cols-2 gap-2 mb-4">
                          {availableLanguages.map(lang => (
                            <div
                              key={lang}
                              className={`relative flex items-center rounded-lg transition-all duration-200 ${selectedLanguage === lang
                                ? 'bg-gray-800 border-l-4 border-red-600 pl-3 font-medium'
                                : 'bg-gray-900/60 hover:bg-gray-800/80 text-gray-200 hover:text-white'
                                }`}
                            >
                              <button
                                className="flex-1 px-3 py-2 flex items-center justify-center"
                                onClick={() => setSelectedLanguage(lang)}
                              >
                                {lang.toUpperCase()}
                                {pinnedLang === lang && (
                                  <span className="ml-2 text-xs text-amber-400 font-semibold">#1</span>
                                )}
                              </button>
                              <PinButton
                                isPinned={pinnedLang === lang}
                                onToggle={() => (pinnedLang === lang ? unpinLanguage() : pinLanguage(lang))}
                                size={12}
                                className="mr-1"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Source Selector */}
                    <div className="mb-6">
                      <h4 className="text-white text-md font-semibold mb-3 flex items-center">
                        <svg className="w-5 h-5 mr-2 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {t('watch.playersLabel')}
                      </h4>

                      {/* Current Selected Source Info */}
                      {selectedSource && (
                        <div className="bg-gray-800/60 rounded-lg p-3 mb-4 border-l-4 border-red-600">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-red-400 text-sm font-medium">{t('watch.currentSource')}</p>
                              <p className="text-white font-semibold">
                                {selectedSource.player}
                              </p>
                              <p className="text-gray-400 text-xs">
                                {selectedSource.language?.toUpperCase()} • {selectedSource.quality}
                                {selectedSource.isM3u8 && <span className="ml-1 text-green-400">• HLS</span>}
                              </p>
                            </div>
                            <div className="text-green-400">
                              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="space-y-2">
                        {videoSources
                          .filter(source => source.language?.toLowerCase() === selectedLanguage.toLowerCase())
                          .map((source, index) => (
                            <motion.button
                              key={index}
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              transition={{
                                duration: 0.3,
                                delay: index * 0.05,
                                ease: "easeOut"
                              }}
                              onClick={() => handleSelectSource(source)}
                              className={`w-full px-4 py-3 text-sm text-left hover:bg-gray-800/80 rounded-lg mb-2 flex justify-between items-center ${selectedSource?.id === source.id
                                ? 'bg-gray-800 border-l-4 border-red-600 pl-3'
                                : 'bg-gray-900/60 text-white'
                                }`}
                            >
                              <div className="flex flex-col">
                                <span className={selectedSource?.id === source.id ? 'text-red-600 font-medium' : 'text-white'}>
                                  {source.player}
                                </span>
                                <span className="text-xs text-gray-400">
                                  {source.language?.toUpperCase()} • {source.quality}
                                  {source.isM3u8 && <span className="ml-1 text-green-400">HLS</span>}
                                </span>
                              </div>
                              {selectedSource?.id === source.id && (
                                <span className="text-xs px-2 py-1 bg-red-600 text-white rounded-full">{t('watch.active')}</span>
                              )}
                            </motion.button>
                          ))}
                      </div>
                    </div>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/* HLS Player for extracted sources */}
          {showHLSPlayer && hlsPlayerSrc ? (
            <HLSPlayer
              priorityCategory="anime"
              src={hlsPlayerSrc}
              autoPlay={true}
              controls={true}
              className="w-full h-full"
              poster={showDetails?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${showDetails.backdrop_path}` : undefined}
              tvShow={{
                name: showDetails?.name || '',
                backdrop_path: showDetails?.backdrop_path
              }}
              tvShowId={id || undefined}
              seasonNumber={Number(season)}
              episodeNumber={Number(episode)}
              title={`${showDetails?.name} - S${season}E${episode}`}
              onNextEpisode={handleNextEpisodeFromPlayer}
              onPreviousEpisode={handlePreviousEpisode}
              onShowEpisodesMenu={() => setShowEpisodesMenu(!showEpisodesMenu)}
              onShowSources={() => setShowEmbedQuality(true)}
              isAnime={true}
              nextEpisode={
                animeData && Number(season) <= animeData.seasons.length && Number(episode) < animeData.seasons[Number(season) - 1]?.episodes.length
                  ? {
                    seasonNumber: Number(season),
                    episodeNumber: Number(episode) + 1,
                    name: animeData.seasons[Number(season) - 1]?.episodes[Number(episode)]?.name
                  }
                  : animeData && Number(season) < animeData.seasons.length
                    ? {
                      seasonNumber: Number(season) + 1,
                      episodeNumber: 1,
                      name: animeData.seasons[Number(season)]?.episodes[0]?.name
                    }
                    : undefined
              }
            />
          ) : null}

          {/* Video container for direct MP4 playback */}
          <div
            ref={playerRef}
            className={`w-full h-full ${!embedUrl && !showHLSPlayer ? 'block' : 'hidden'}`}
          ></div>

          {/* Iframe for embed video */}
          {embedUrl && !showHLSPlayer ? (
            <iframe
              src={embedUrl}
              className="w-full h-full border-0"
              allowFullScreen
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            ></iframe>
          ) : null}
        </div>
      )}

      {/* Ad Free Player Ads Popup */}
      <AdFreePlayerAds />
    </div>
  );
};

export default WatchAnime;
