import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios, { CancelTokenSource } from 'axios';
import { useLocation } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Info, Star, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import HeroSkeleton from '../components/skeletons/HeroSkeleton';
import ContentRowSkeleton from '../components/skeletons/ContentRowSkeleton';

import TelegramPromotion from '../components/TelegramPromotion';
import HeroSlider from '../components/HeroSlider';
import EmblaCarousel from '../components/EmblaCarousel';
import EmblaCarouselPlatforms from '../components/EmblaCarouselPlatforms';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import LazySection from '../components/LazySection';
import { SquareBackground } from '../components/ui/square-background';
import { SITE_URL } from '../config/runtime';
import { getTmdbLanguage } from '../i18n';
import { getPersonalizedRecommendations, isRecommendationsEnabled, PersonalizedRecommendations } from '../services/recommendationService';
import CarouselTitle from '../components/CarouselTitle';

// Nombre de sections à charger immédiatement (les premières sont prioritaires)
const IMMEDIATE_LOAD_COUNT = 3;

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

// Cache mémoire pour les détails TMDB (movie/tv par id) — persiste entre les navigations SPA
const tmdbDetailsCache = new Map<string, { data: any; ts: number }>();
const TMDB_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const fetchTMDBDetails = async (mediaType: string, id: number, params?: any): Promise<any> => {
  const key = `${mediaType}_${id}`;
  const cached = tmdbDetailsCache.get(key);
  if (cached && Date.now() - cached.ts < TMDB_CACHE_TTL) {
    return cached.data;
  }
  const endpoint = `https://api.themoviedb.org/3/${mediaType}/${id}`;
  const response = await axios.get(endpoint, {
    params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), ...params }
  });
  tmdbDetailsCache.set(key, { data: response.data, ts: Date.now() });
  return response.data;
};

// Styles nécessaires aux EmblaCarousel rendus dans Home
const homeStyles = `
.content-row-container {
  padding-top: 5px;
  padding-bottom: 40px;
  margin-top: -30px;
  overflow: visible !important;
  position: relative;
  z-index: 1;
}

.section-title {
  font-size: 1.5rem;
  font-weight: 700;
  position: relative;
  background: linear-gradient(90deg, #ffffff, #e2e2e2);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0px 2px 4px rgba(0, 0, 0, 0.3);
  letter-spacing: 0.5px;
  padding-bottom: 0.5rem;
  text-transform: uppercase;
  display: inline-block;
  animation: homeFadeInTitle 0.8s ease-out forwards;
  transition: all 0.3s ease;
}

.section-title:hover {
  background: linear-gradient(90deg, #ff3333, #ff9999);
  -webkit-background-clip: text;
  background-clip: text;
  transform: translateY(-2px);
  text-shadow: 0px 4px 8px rgba(255, 51, 51, 0.4);
}

.section-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 40px;
  height: 3px;
  background: linear-gradient(90deg, #f11 0%, #f66 100%);
  border-radius: 3px;
  animation: homeExpandWidth 0.6s ease-out forwards 0.3s;
  transform-origin: left;
  transition: all 0.3s ease;
}

.section-title:hover::after {
  width: 100%;
  background: linear-gradient(90deg, #ff3333, #ff9999);
}

@keyframes homeFadeInTitle {
  0% { opacity: 0; transform: translateY(10px); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes homeExpandWidth {
  0% { width: 0; }
  100% { width: 40px; }
}
`;


interface Media {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  backdrop_path: string;
  overview: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  media_type: 'movie' | 'tv';
  genre_ids?: number[];
}

interface Category {
  id: string;
  title: string;
  items: Media[];
}






interface ContinueWatching {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  media_type: 'movie' | 'tv';
  progress?: number;
  lastAccessed: string; // Changed from lastWatched to lastAccessed
  overview?: string;
  backdrop_path?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  currentEpisode?: {
    season: number;
    episode: number;
  };
}

const inferHomeMediaType = (item: any): 'tv' | 'movie' =>
  item.media_type || item.mediaType || (item.first_air_date ? 'tv' : 'movie');

const normalizeHomeItem = (item: any) => ({
  ...item,
  media_type: inferHomeMediaType(item),
  poster_path: item.poster_path || item.posterPath || '',
  backdrop_path: item.backdrop_path || item.backdropPath || '',
  overview: item.overview || '',
  title: item.title || item.name || '',
});

const normalizeHomeCategory = (category: Category): Category => ({
  ...category,
  items: category.items.map(normalizeHomeItem) as any,
});

const normalizePersonalizedReco = (reco: PersonalizedRecommendations | null): PersonalizedRecommendations | null => {
  if (!reco) return reco;
  return {
    ...reco,
    becauseYouWatched: (reco.becauseYouWatched || []).map((g: any) => ({
      ...g,
      items: (g.items || []).map(normalizeHomeItem),
    })),
    topGenres: (reco.topGenres || []).map((g: any) => ({
      ...g,
      items: (g.items || []).map(normalizeHomeItem),
    })),
    usersAlsoWatched: (reco.usersAlsoWatched || []).map(normalizeHomeItem),
    trendingForYou: (reco.trendingForYou || []).map(normalizeHomeItem),
  } as any;
};

const Home: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [heroItems, setHeroItems] = useState<Media[]>([]);
  const [currentHeroIndex, setCurrentHeroIndex] = useState(0);
  const [trending, setTrending] = useState<Media[]>([]);
  const [popularMovies, setPopularMovies] = useState<Media[]>([]);
  const [topContent, setTopContent] = useState<Media[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [sagaCollections, setSagaCollections] = useState<any[]>([]);
  const [featuredSeries, setFeaturedSeries] = useState<any>(null);

  const [continueWatching, setContinueWatching] = useState<ContinueWatching[]>([]);
  const [recommendations, setRecommendations] = useState<Media[]>([]);
  const [personalizedReco, setPersonalizedReco] = useState<PersonalizedRecommendations | null>(null);
  const sliderIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const cancelTokenSourceRef = useRef<CancelTokenSource | null>(null);

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'home' },
  });





  const fetchRecommendations = async (watchHistory: ContinueWatching[]) => {
    if (!isRecommendationsEnabled()) {
      setRecommendations([]);
      setPersonalizedReco(null);
      return;
    }

    const token = localStorage.getItem('auth_token');
    const profileData = localStorage.getItem('auth');
    let profileId: string | null = null;
    if (profileData) {
      try {
        const parsed = JSON.parse(profileData);
        profileId = parsed?.selectedProfileId || parsed?.userProfile?.id || null;
      } catch {}
    }

    if (token && profileId) {
      const lang = getTmdbLanguage();
      const reco = await getPersonalizedRecommendations(profileId, lang);
      const normalizedReco = normalizePersonalizedReco(reco);
      setPersonalizedReco(normalizedReco);
      setRecommendations((normalizedReco?.trendingForYou || []) as any[]);
    } else {
      setRecommendations([]);
      setPersonalizedReco(null);
    }
  };

  const fetchData = async () => {
    if (cancelTokenSourceRef.current) {
      cancelTokenSourceRef.current.cancel("Operation canceled due to new request.");
    }
    cancelTokenSourceRef.current = axios.CancelToken.source();
    const cancelToken = cancelTokenSourceRef.current.token;

    try {
      setLoading(true);

      // Check for cached data first
      const cachedData = sessionStorage.getItem('movix_home_data');
      const cacheTimestamp = sessionStorage.getItem('movix_home_data_timestamp');

      // Use cache if it exists and is less than 15 minutes old
      if (cachedData && cacheTimestamp) {
        const isRecent = (Date.now() - parseInt(cacheTimestamp)) < 15 * 60 * 1000; // 15 minutes

        if (isRecent) {
          const parsedData = JSON.parse(cachedData);
          setHeroItems(parsedData.heroItems || []);
          setTrending(parsedData.trending || []);
          setPopularMovies(parsedData.popularMovies || []);

          // Set topContent from cache or use trending as fallback
          const cachedTopContent = parsedData.topContent || [];
          const topContentFromCache = cachedTopContent.length > 0
            ? cachedTopContent
            : (parsedData.trending || []).filter((item: Media) => item.poster_path && item.overview).slice(0, 10);
          setTopContent((topContentFromCache || []).map(normalizeHomeItem) as any);

          organizeContentByCategories(parsedData.allItems || []);
          setLoading(false);

          // Recommendations are fetched by loadContinueWatching
          return;
        }
      }

      // Split API requests into batches to prevent overwhelming the browser
      const batch1 = [
        { url: 'https://api.themoviedb.org/3/trending/all/day', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } },
        { url: 'https://api.themoviedb.org/3/movie/popular', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 } },
        { url: 'https://api.themoviedb.org/3/tv/popular', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 } },
      ];

      const batch2 = [
        { url: 'https://api.themoviedb.org/3/movie/upcoming', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 } },
        { url: 'https://api.themoviedb.org/3/movie/top_rated', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 } },
        { url: 'https://api.themoviedb.org/3/tv/top_rated', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 } },
      ];

      const batch3 = [
        { url: 'https://api.themoviedb.org/3/discover/movie', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), with_genres: '28', page: 1 } }, // Action Movies
        { url: 'https://api.themoviedb.org/3/discover/tv', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), with_genres: '10759', page: 1 } }, // Action & Adventure TV
      ];

      const batch4 = [
        { url: 'https://api.themoviedb.org/3/discover/movie', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), with_genres: '16', page: 1 } }, // Animation Movies
        { url: 'https://api.themoviedb.org/3/discover/tv', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), with_genres: '16', page: 1 } }, // Animation TV
      ];

      const batch5 = [
        { url: 'https://api.themoviedb.org/3/discover/movie', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), with_genres: '35', page: 1 } }, // Comedy Movies
        { url: 'https://api.themoviedb.org/3/discover/tv', params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), with_genres: '35', page: 1 } }, // Comedy TV
      ];

      // Helper function to process batch
      const processBatch = async (batch: { url: string; params: any }[]) => {
        try {
          if (cancelTokenSourceRef.current === null) return []; // If cancelled during processing

          const responses = await Promise.all(
            batch.map(req =>
              axios.get(req.url, { params: req.params, cancelToken })
                .catch(error => {
                  if (axios.isCancel(error)) {
                    console.log('Request canceled:', error.message);
                  } else {
                    console.error(`Error fetching ${req.url}:`, error);
                  }
                  return null;
                })
            )
          );

          return responses.filter(res => res !== null);
        } catch (error) {
          console.error('Error processing batch:', error);
          return [];
        }
      };

      // Process batches sequentially to reduce load
      const batch1Responses = await processBatch(batch1);
      if (batch1Responses.length === 0) {
        setLoading(false);
        return;
      }

      // Set initial data from first batch to improve perceived performance
      const processTMDBResponses = (responses: any[], mediaType: 'movie' | 'tv' | 'all') => {
        return responses.flatMap(response =>
          response.data.results
            .filter((item: any) =>
              item.poster_path &&
              item.overview &&
              item.overview.trim() !== ''
            )
            .map((item: any) => ({
              ...item,
              media_type: mediaType === 'all' ? item.media_type || (item.first_air_date ? 'tv' : 'movie') : mediaType
            }))
        );
      };

      const trendingItems = processTMDBResponses(batch1Responses[0] ? [batch1Responses[0]] : [], 'all');
      const popularMovies = processTMDBResponses(batch1Responses[1] ? [batch1Responses[1]] : [], 'movie');
      const popularTV = processTMDBResponses(batch1Responses[2] ? [batch1Responses[2]] : [], 'tv');

      // Update UI with initial data
      setTrending(trendingItems);
      setPopularMovies(popularMovies);
      setHeroItems(trendingItems.slice(0, 5));

      // Continue fetching remaining batches
      const [batch2Responses, batch3Responses, batch4Responses, batch5Responses] = await Promise.all([
        processBatch(batch2),
        processBatch(batch3),
        processBatch(batch4),
        processBatch(batch5)
      ]);

      // Process all responses
      const upcomingMovies = batch2Responses[0] ? processTMDBResponses([batch2Responses[0]], 'movie') : [];
      const topRatedMovies = batch2Responses[1] ? processTMDBResponses([batch2Responses[1]], 'movie') : [];
      const topRatedTV = batch2Responses[2] ? processTMDBResponses([batch2Responses[2]], 'tv') : [];

      const actionMovies = batch3Responses[0] ? processTMDBResponses([batch3Responses[0]], 'movie') : [];
      const actionTV = batch3Responses[1] ? processTMDBResponses([batch3Responses[1]], 'tv') : [];

      const animationMovies = batch4Responses[0] ? processTMDBResponses([batch4Responses[0]], 'movie') : [];
      const animationTV = batch4Responses[1] ? processTMDBResponses([batch4Responses[1]], 'tv') : [];

      const comedyMovies = batch5Responses[0] ? processTMDBResponses([batch5Responses[0]], 'movie') : [];
      const comedyTV = batch5Responses[1] ? processTMDBResponses([batch5Responses[1]], 'tv') : [];

      // Combine and deduplicate all items
      const allItems = [
        ...trendingItems,
        ...popularMovies,
        ...popularTV,
        ...upcomingMovies,
        ...topRatedMovies,
        ...topRatedTV,
        ...actionMovies,
        ...actionTV,
        ...animationMovies,
        ...animationTV,
        ...comedyMovies,
        ...comedyTV
      ];

      const uniqueItems = allItems.reduce((acc: Media[], current) => {
        const x = acc.find(item => item.id === current.id && item.media_type === current.media_type);
        if (!x) {
          acc.push(current);
        }
        return acc;
      }, [] as Media[]);

      // Filter items with overview and poster_path for categories
      const filteredItems = uniqueItems.filter((item: Media) => item.overview && item.poster_path);

      // Update state with all data
      setHeroItems(filteredItems.slice(0, 5)); // Take top 5 for hero slider
      setTrending(filteredItems.slice(5));
      setPopularMovies(popularMovies);

      // Set topContent - use upcomingMovies if available, otherwise use trending as fallback
      const topContentData = upcomingMovies.length > 0
        ? upcomingMovies.slice(0, 10)
        : trendingItems.filter((item: Media) => item.poster_path && item.overview).slice(0, 10);
      setTopContent((topContentData || []).map(normalizeHomeItem) as any);
      console.log('Top content loaded:', topContentData.length, 'items');

      // Cache the data
      const cacheData = {
        heroItems: filteredItems.slice(0, 5),
        trending: filteredItems.slice(5),
        popularMovies,
        topRatedMovies,
        topRatedTVShows: topRatedTV,
        popularTVShows: popularTV,
        topContent: upcomingMovies.length > 0
          ? upcomingMovies.slice(0, 10)
          : trendingItems.filter((item: Media) => item.poster_path && item.overview).slice(0, 10),
        allItems: filteredItems
      };

      sessionStorage.setItem('movix_home_data', JSON.stringify(cacheData));
      sessionStorage.setItem('movix_home_data_timestamp', Date.now().toString());

      // Organize content into categories
      organizeContentByCategories(filteredItems);

      // Recommendations are fetched by loadContinueWatching

    } catch (error) {
      if (axios.isCancel(error)) {
        console.log('Data fetching canceled:', error.message);
      } else {
        console.error('Error fetching data:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  // Fetch curated TMDB collections for the "Les sagas incontournables" section
  const fetchSagaCollections = async () => {
    try {
      const cacheKey = 'movix_sagas_data';
      const cacheTsKey = 'movix_sagas_data_ts';
      const cached = sessionStorage.getItem(cacheKey);
      const cachedTs = sessionStorage.getItem(cacheTsKey);
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (cached && cachedTs && (Date.now() - parseInt(cachedTs)) < oneDayMs) {
        setSagaCollections(JSON.parse(cached));
        return;
      }

      const popularCollectionIds = [
        10,      // Star Wars
        1241,    // Harry Potter
        531241,  // Spider-Man (Avengers)
        623,     // X-Men
        2344,    // The Matrix
        8091,    // Alien
        8250,    // Fast & Furious
        9485,    // The Fast and the Furious
        86311,   // The Avengers
        131295,  // Iron Man
        131296,  // Thor
        131292,  // Captain America
        748,     // The Lord of the Rings
        121938,  // The Hobbit
        1570,    // Die Hard
        528,     // The Terminator
        945,     // Jurassic Park
        295,     // Pirates of the Caribbean
        87359,   // Mission: Impossible
        8917     // Shrek
      ];

      const responses = await Promise.all(
        popularCollectionIds.map(id =>
          axios.get(`https://api.themoviedb.org/3/collection/${id}`, {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
          }).then(r => r.data).catch(() => null)
        )
      );

      const mapped = responses
        .filter(Boolean)
        .map((c: any) => {
          const poster = c.poster_path || (c.parts?.find((p: any) => p.poster_path)?.poster_path) || null;
          if (!poster) return null;
          const avg = c.parts && c.parts.length > 0
            ? Number((c.parts.reduce((s: number, m: any) => s + (m.vote_average || 0), 0) / c.parts.length).toFixed(1))
            : undefined;
          return {
            id: c.id,
            title: c.name,
            name: c.name,
            poster_path: poster,
            backdrop_path: c.backdrop_path || (c.parts?.[0]?.backdrop_path || null),
            overview: c.overview || '',
            vote_average: avg,
            media_type: 'collection'
          };
        })
        .filter(Boolean)
        .slice(0, 20);

      setSagaCollections(mapped as any[]);
      sessionStorage.setItem(cacheKey, JSON.stringify(mapped));
      sessionStorage.setItem(cacheTsKey, Date.now().toString());
    } catch (e) {
      // Fail silently; the rest of the home page still works
    }
  };

  useEffect(() => {
    fetchData();

    // Cleanup function to cancel request on component unmount
    return () => {
      if (cancelTokenSourceRef.current) {
        cancelTokenSourceRef.current.cancel("Operation canceled due to component unmount.");
        cancelTokenSourceRef.current = null;
      }
    };
  }, []); // Fetch data on initial load

  useEffect(() => {
    fetchSagaCollections();
  }, []);

  // Fetch featured series (team selection)
  useEffect(() => {
    const fetchFeaturedSeries = async () => {
      try {
        const data = await fetchTMDBDetails('tv', 82739, { append_to_response: 'content_ratings' });
        setFeaturedSeries(data);
      } catch (error) {
        console.error('Error fetching featured series:', error);
      }
    };
    fetchFeaturedSeries();
  }, []);

  useEffect(() => {
    const loadContinueWatching = async () => {
      try {
        const savedItems = localStorage.getItem('continueWatching');
        if (savedItems) {
          // Check if we need to migrate from old format to new format
          let migratedData: { movies: any[], tv: any[] };

          try {
            const parsedData = JSON.parse(savedItems);

            // Check if old format (array) vs new format (object with movies/tv properties)
            if (Array.isArray(parsedData)) {
              migratedData = { movies: [], tv: [] };
              parsedData.forEach((item: any) => {
                if (item.media_type === 'movie') {
                  migratedData.movies.push({ id: item.id, lastAccessed: new Date().toISOString() });
                } else if (item.media_type === 'tv') {
                  migratedData.tv.push({ id: item.id, currentEpisode: item.currentEpisode, lastAccessed: new Date().toISOString() });
                }
              });
              localStorage.setItem('continueWatching', JSON.stringify(migratedData));
            } else {
              migratedData = parsedData;

              // Migrate old format movies to new format
              if (migratedData.movies && Array.isArray(migratedData.movies)) {
                let needsUpdate = false;
                const updatedMovies = migratedData.movies.map((movieItem: any, index: number) => {
                  if (typeof movieItem === 'number') {
                    needsUpdate = true;
                    const now = new Date();
                    const olderTime = new Date(now.getTime() - (index * 60000));
                    return { id: movieItem, lastAccessed: olderTime.toISOString() };
                  }
                  return movieItem;
                });

                if (needsUpdate) {
                  migratedData.movies = updatedMovies;
                  localStorage.setItem('continueWatching', JSON.stringify(migratedData));
                }
              }
            }
          } catch (error) {
            console.error('Error parsing continueWatching data:', error);
            migratedData = { movies: [], tv: [] };
            localStorage.setItem('continueWatching', JSON.stringify(migratedData));
          }

          // Process with the new data structure
          const data = migratedData;
          const allItems: any[] = [];

          if (data.movies && Array.isArray(data.movies)) {
            for (const movieItem of data.movies) {
              allItems.push({ id: movieItem.id, media_type: 'movie', lastAccessed: movieItem.lastAccessed });
            }
          }

          if (data.tv && Array.isArray(data.tv)) {
            for (const tvShow of data.tv) {
              const lastAccessed = tvShow.lastAccessed || '1970-01-01T00:00:00.000Z';
              allItems.push({ id: tvShow.id, media_type: 'tv', currentEpisode: tvShow.currentEpisode, lastAccessed });
            }
          }

          // Sort by lastAccessed timestamp (most recent first)
          const ts = (d: any) => {
            const t = Date.parse(d || '');
            return Number.isFinite(t) ? t : 0;
          };
          allItems.sort((a, b) => ts(b.lastAccessed) - ts(a.lastAccessed));

          // Fetch TMDB data for each item (uses in-memory cache)
          const enrichedItems = await Promise.all(
            allItems.map(async (item: any) => {
              try {
                const tmdbData = await fetchTMDBDetails(item.media_type, item.id);

                const enrichedItem: ContinueWatching = {
                  id: item.id,
                  media_type: item.media_type,
                  title: tmdbData.title || tmdbData.name || undefined,
                  name: tmdbData.name || undefined,
                  poster_path: tmdbData.poster_path || '',
                  backdrop_path: tmdbData.backdrop_path || undefined,
                  overview: tmdbData.overview || undefined,
                  vote_average: tmdbData.vote_average || undefined,
                  release_date: tmdbData.release_date || undefined,
                  first_air_date: tmdbData.first_air_date || undefined,
                  currentEpisode: item.currentEpisode,
                  lastAccessed: item.lastAccessed
                };
                return enrichedItem;
              } catch (error) {
                console.error(`Error fetching TMDB data for ${item.media_type} ${item.id}:`, error);
                return null;
              }
            })
          );

          // Filter out failed items and items without poster_path
          const validItems = enrichedItems
            .filter((item): item is ContinueWatching => item !== null)
            .filter((item) => item.poster_path && typeof item.poster_path === 'string' && item.poster_path.trim() !== '');
          setContinueWatching((validItems || []).map(normalizeHomeItem) as any);

          if (validItems.length > 0) {
            await fetchRecommendations(validItems);
          }
        } else {
          setContinueWatching([]);
        }
      } catch (error) {
        console.error('Error loading continue watching items:', error);
        setContinueWatching([]);
      }
    };

    loadContinueWatching();
  }, [location.pathname]);

  // Auto-rotate hero items
  useEffect(() => {
    if (heroItems.length > 1) {
      // Clear any existing interval when dependencies change
      if (sliderIntervalRef.current) {
        clearInterval(sliderIntervalRef.current);
      }

      // Set new interval
      sliderIntervalRef.current = setInterval(() => {
        setCurrentHeroIndex(prevIndex =>
          prevIndex === heroItems.length - 1 ? 0 : prevIndex + 1
        );
      }, 6000);

      // Cleanup on unmount
      return () => {
        if (sliderIntervalRef.current) {
          clearInterval(sliderIntervalRef.current);
        }
      };
    }
  }, [heroItems, currentHeroIndex]);

  // Update featured content when hero index changes
  useEffect(() => {
    if (heroItems.length > 0 && currentHeroIndex < heroItems.length) {
    }
  }, [currentHeroIndex, heroItems]);



  // Organize content by genres
  const organizeContentByCategories = (items: Media[]) => {
    const categoriesMap: { [key: string]: Media[] } = {};

    // 1. Group by genre
    items.forEach(item => {
      if (item.genre_ids && item.genre_ids.length > 0) {
        item.genre_ids.forEach(genreId => {
          if (!categoriesMap[genreId]) {
            categoriesMap[genreId] = [];
          }
          // Only add if not already in the array
          if (!categoriesMap[genreId].some(media => media.id === item.id)) {
            categoriesMap[genreId].push(item);
          }
        });
      }
    });

    // 2. Convert map to Category array, filter, sort, and limit
    const newCategories: Category[] = Object.entries(categoriesMap)
      .map(([genreId, items]) => ({
        id: genreId,
        title: t(`genres.id_${genreId}`, { defaultValue: `Category ${genreId}` }),
        items: items.slice(0, 15) // Réduit de 20 à 15 items par catégorie pour de meilleures performances
      }))
      .filter(category => category.items.length >= 5) // Only keep categories with at least 5 items
      .sort((a, b) => b.items.length - a.items.length) // Sort by number of items
      .slice(0, 8); // Réduit de 10 à 8 catégories pour de meilleures performances

    // 3. Add dynamic categories (e.g., recently added, top rated)
    const recentMovies = items
      .filter(item => item.media_type === 'movie' && item.release_date)
      .sort((a, b) => {
        const dateA = a.release_date ? new Date(a.release_date).getTime() : 0;
        const dateB = b.release_date ? new Date(b.release_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    const recentTVShows = items
      .filter(item => item.media_type === 'tv' && item.first_air_date)
      .sort((a, b) => {
        const dateA = a.first_air_date ? new Date(a.first_air_date).getTime() : 0;
        const dateB = b.first_air_date ? new Date(b.first_air_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    if (recentMovies.length >= 5) {
      newCategories.unshift({
        id: 'recent-movies',
        title: t('home.recentMovies'),
        items: recentMovies
      });
    }

    if (recentTVShows.length >= 5) {
      newCategories.unshift({
        id: 'recent-tv',
        title: t('home.recentShows'),
        items: recentTVShows
      });
    }

    const topRated = [...items]
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 15); // Réduit de 20 à 15 pour de meilleures performances

    if (topRated.length >= 5) {
      newCategories.push({ id: 'top-rated', title: t('home.bestRated'), items: topRated });
    }

    // Limit total categories
    setCategories(newCategories.slice(0, 10).map(normalizeHomeCategory)); // Réduit de 12 à 10 catégories max
  };

  const removeFromContinueWatching = useCallback((itemId: number, mediaType: string, skipConfirmation = false) => {
    if (skipConfirmation || window.confirm(t('home.confirmRemoveItem'))) {
      const continueWatching = JSON.parse(localStorage.getItem('continueWatching') || '{"movies": [], "tv": []}');

      // Ensure structure exists
      if (!continueWatching.movies) continueWatching.movies = [];
      if (!continueWatching.tv) continueWatching.tv = [];

      if (mediaType === 'movie') {
        // Handle both old format (number) and new format (object)
        continueWatching.movies = continueWatching.movies.filter((item: any) => {
          const movieId = typeof item === 'number' ? item : item.id;
          return movieId !== itemId;
        });
      } else if (mediaType === 'tv') {
        continueWatching.tv = continueWatching.tv.filter((tvShow: any) => tvShow.id !== itemId);
      }

      localStorage.setItem('continueWatching', JSON.stringify(continueWatching));

      // Update the UI state
      setContinueWatching(prev => prev.filter(item => !(item.id === itemId && item.media_type === mediaType)));
    }
  }, [t]);

  const removeAllContinueWatching = useCallback(() => {
    if (window.confirm(t('home.confirmRemoveAll'))) {
      localStorage.setItem('continueWatching', JSON.stringify({ "movies": [], "tv": [] }));
      setContinueWatching([]);
    }
  }, [t]);

  useEffect(() => {
    // Simple title for homepage
    document.title = `${t('nav.home')} - Movix`;

    // Add or update structured data for a WebSite
    const structuredData = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Movix",
      "url": SITE_URL,
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${SITE_URL}/search?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      },
      "description": "Movix - Plateforme de streaming gratuite proposant des films et séries en français. Regardez en ligne sans inscription."
    };

    // Add structured data to head
    let scriptElement = document.querySelector('#home-structured-data');
    if (!scriptElement) {
      scriptElement = document.createElement('script');
      scriptElement.id = 'home-structured-data';
      (scriptElement as HTMLScriptElement).type = 'application/ld+json';
      document.head.appendChild(scriptElement);
    }
    scriptElement.textContent = JSON.stringify(structuredData);

    // Cleanup function
    return () => {
      const scriptElement = document.querySelector('#home-structured-data');
      if (scriptElement) {
        scriptElement.remove();
      }
    };
  }, []);

  // Removed the visibility change handler that was causing unnecessary logo refreshes

  // Memoized carousel titles — must be before any early return (Rules of Hooks)
  const yourHistoryTitle = useMemo(
    () => <CarouselTitle icon="⏯️" iconClass="text-blue-500" label={t('home.yourHistory')} />,
    [t]
  );

  const trendingTodayTitle = useMemo(
    () => <CarouselTitle icon="🔥" iconClass="text-red-600" label={t('home.trendingToday')} />,
    [t]
  );

  const usersAlsoWatchedTitle = useMemo(
    () => <CarouselTitle icon="👥" iconClass="text-green-500" label={t('home.usersAlsoWatched')} />,
    [t]
  );

  const becauseYouWatchedTitles = useMemo(
    () => (personalizedReco?.becauseYouWatched || []).map((group) =>
      <CarouselTitle icon="✨" iconClass="text-purple-500" label={t('home.becauseYouWatched', { title: group.title })} />
    ),
    [personalizedReco?.becauseYouWatched, t]
  );

  const topGenresTitles = useMemo(
    () => (personalizedReco?.topGenres || []).map((group) =>
      <CarouselTitle icon="🎯" iconClass="text-yellow-500" label={t('home.popularInGenre', { genre: group.genreName })} />
    ),
    [personalizedReco?.topGenres, t]
  );

  const trendingCustomTitle = useMemo(
    () => <span className="text-white relative z-20">{t('home.trending')}</span>,
    [t]
  );

  const platformsTitle = useMemo(
    () => <CarouselTitle icon="🎬" iconClass="text-white" label={t('home.streamingPlatforms')} />,
    [t]
  );

  const platformsItems = useMemo(() => [
    { id: 8, src: "https://u.cubeupload.com/mystic/8df6ce62504c1ab31aab.png", video: "https://media.tenor.com/hd7jyV_dMS8AAAPo/netflix-media-services-provider.mp4", alt: "Netflix", route: "/provider/8", label: t('home.filmsAndSeries', { count: 2817 }) },
    { id: 119, src: "https://u.cubeupload.com/mystic/b222691607d658c2fa52.png", video: "https://media.tenor.com/T7L_NCdPIvAAAAPo/prime-video.mp4", alt: "Prime Video", route: "/provider/119", label: t('home.filmsAndSeries', { count: 2799 }) },
    { id: 531, src: "https://u.cubeupload.com/mystic/35734306149c1a6eb0a9.png", video: "https://media4.giphy.com/media/qCEXQzkScYOBIRusVA/giphy.mp4", alt: "Paramount+", route: "/provider/531", label: t('home.filmsAndSeries', { count: 502 }) },
    { id: 337, src: "https://u.cubeupload.com/mystic/c40fe782c450e170eea6.png", video: "https://media.tenor.com/h6-0yzk8pbAAAAPo/disney-disney-plus.mp4", alt: "Disney+", route: "/provider/337", label: t('home.filmsAndSeries', { count: 1152 }) },
    { id: 338, src: "https://u.cubeupload.com/mystic/hUzeosd33nzE5MCNsZxC.png", video: "https://i.giphy.com/media/vBjLa5DQwwxbi/giphy.mp4", alt: "Marvel Studios", route: "/provider/338", label: t('home.filmsAndSeries', { count: 65 }) },
    { id: 350, src: "https://u.cubeupload.com/mystic/b2fb6956993e2ee5b4e3.png", video: "https://media.tenor.com/Oxl9xEn7kTEAAAPo/applo-tv.mp4", alt: "Apple TV+", route: "/provider/350", label: t('home.filmsAndSeries', { count: 138 }) },
    { id: 355, src: "https://u.cubeupload.com/mystic/ky0xOc5OrhzkZ1N6KyUx.png", video: "https://i.giphy.com/media/3o7TKt3pMpzozdUsus/giphy.mp4", alt: "Warner Bros", route: "/provider/355", label: t('home.filmsAndSeries', { count: 645 }) },
    { id: 356, src: "https://u.cubeupload.com/mystic/2Tc1P3Ac8M479naPp1kY.png", video: "https://media.tenor.com/ag74wyAzYkMAAAPo/dc-comics-dceu.mp4", alt: "DC Comics", route: "/provider/356", label: t('home.filmsAndSeries', { count: 98 }) },
    { id: 384, src: "https://imgs.search.brave.com/Vy1IBbYyWsYzAbAq1xOIIFFnQm8R8V5-RgWR3lOnJXg/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly91cGxv/YWQud2lraW1lZGlh/Lm9yZy93aWtpcGVk/aWEvY29tbW9ucy90/aHVtYi9iL2IzL0hC/T19NYXhfJTI4MjAy/NSUyOS5zdmcvMjUw/cHgtSEJPX01heF8l/MjgyMDI1JTI5LnN2/Zy5wbmc", video: "https://media.tenor.com/7xmvr-fKGLMAAAAd/hbo-max-warner-bros-pictures.gif", alt: "HBO MAX", route: "/provider/384", label: "HBO MAX" },
  ], [t]);

  if (loading) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="w-full min-h-screen bg-black text-white">
        <HeroSkeleton />
        <div className="container mx-auto px-4 py-8 space-y-8">
          <ContentRowSkeleton />
          <ContentRowSkeleton />
          <ContentRowSkeleton />
        </div>
      </SquareBackground>
    );
  }

  return (
    <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="w-full min-h-screen bg-black text-white">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full overflow-hidden content-wrapper relative z-10"
      >
        <style dangerouslySetInnerHTML={{ __html: homeStyles }} />
        {loading ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center min-h-screen"
          >
            <Loader2 className="w-12 h-12 text-red-600 animate-spin" />
          </motion.div>
        ) : (
          <>
            {heroItems.length > 0 && (
              <div className="relative w-full pt-16 md:pt-20 lg:pt-24">
                <HeroSlider items={heroItems} />
              </div>
            )}

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="w-full py-8 relative mb-6 mt-8 z-0 px-4 md:px-8"
            >
              <div className="w-full overflow-hidden">
                <EmblaCarouselPlatforms
                  title={platformsTitle}
                  items={platformsItems}
                />
              </div>
            </motion.div>

            {/* Section "Reprendre votre lecture" - Section prioritaire (index 0) */}
            {continueWatching.length > 0 && (
              <div className="content-row-container px-4 md:px-8 mb-2 mt-16">
                <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={yourHistoryTitle}
                    items={continueWatching as any[]}
                    mediaType="history"
                    isHistory={true}
                    onRemoveItem={removeFromContinueWatching}
                    onRemoveAll={removeAllContinueWatching}
                  />
                </LazySection>
              </div>
            )}

            {/* Personalized: "Because you watched X" */}
            {personalizedReco?.becauseYouWatched?.map((group, idx) => (
              <div key={`byw-${group.sourceId}`} className="content-row-container px-4 md:px-8 mb-2 mt-16">
                <LazySection index={idx + 2} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={becauseYouWatchedTitles[idx]}
                    items={group.items}
                    mediaType="mixed"
                  />
                </LazySection>
              </div>
            ))}

            {/* Personalized: "Popular in [genre]" */}
            {personalizedReco?.topGenres?.map((group, idx) => (
              <div key={`genre-${group.genreId}`} className="content-row-container px-4 md:px-8 mb-2 mt-16">
                <LazySection index={idx + 5} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={topGenresTitles[idx]}
                    items={group.items}
                    mediaType="mixed"
                  />
                </LazySection>
              </div>
            ))}

            {/* Personalized: "Users also watched" (collaborative filtering) */}
            {personalizedReco?.usersAlsoWatched && personalizedReco.usersAlsoWatched.length > 0 && (
              <div className="content-row-container px-4 md:px-8 mb-2 mt-16">
                <LazySection index={8} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={usersAlsoWatchedTitle}
                    items={personalizedReco.usersAlsoWatched}
                    mediaType="mixed"
                  />
                </LazySection>
              </div>
            )}

            {/* Section "Tendances du jour" - Section prioritaire (index 1) */}
            {topContent.length > 0 && (
              <div className="content-row-container px-4 md:px-8 mb-2 mt-16">
                <LazySection index={1} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={trendingTodayTitle}
                    items={topContent}
                    mediaType="top10"
                    showRanking={true}
                  />
                </LazySection>
              </div>
            )}

            {/* Recommandations - Section prioritaire (index 2) */}
            {!personalizedReco && recommendations.length > 0 && (
              <div className="mb-16">
                <LazySection index={2} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                  <EmblaCarousel
                    title={t('home.recommendationsForYou')}
                    items={recommendations}
                    mediaType="recommendations"
                  />
                </LazySection>
              </div>
            )}

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8 }}
              className="relative pb-16"
            >
              {!loading && (
                <div>
                  <div className="pt-8 pb-20 sm:pt-12 sm:pb-32">
                    <TelegramPromotion />
                  </div>

                  {/* Tendances - Lazy loaded (index 3) */}
                  <div className="mb-16 px-4 md:px-8">
                    <LazySection index={3} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                      <EmblaCarousel
                        title={trendingCustomTitle}
                        items={trending}
                        mediaType="trending"
                      />
                    </LazySection>
                  </div>

                  {/* Sagas - Lazy loaded (index 4) */}
                  {sagaCollections.length > 0 && (
                    <div className="mb-16 px-4 md:px-8">
                      <LazySection index={4} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                        <EmblaCarousel
                          title={t('home.legendaryCollections')}
                          items={sagaCollections as any}
                          mediaType="collections"
                        />
                      </LazySection>
                    </div>
                  )}

                  {/* Featured Series - Team Selection */}
                  {featuredSeries && (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.6 }}
                      className="w-full relative mb-16 px-4 md:px-6"
                      style={{ zIndex: 11 }}
                    >
                      <div
                        className="w-full min-h-[400px] h-[65svh] max-h-[700px] bg-cover bg-no-repeat relative rounded-3xl overflow-hidden border border-white/10 shadow-2xl"
                        style={{
                          backgroundImage: 'url("https://image.tmdb.org/t/p/original/wIeNWRuBCdEBmWoDRcKputYV414.jpg")',
                          backgroundPosition: '70% 20%'
                        }}
                      >
                        <div className="absolute inset-0 pointer-events-none z-10 bg-gradient-to-b from-black/60 via-transparent to-black/90"></div>
                        <div
                          className="absolute inset-0 z-[2] pointer-events-none"
                          style={{ backgroundImage: 'linear-gradient(to right, rgba(9, 2, 1, 0.95) 0%, rgba(9, 2, 1, 0.4) 50%, transparent 80%)' }}
                        ></div>
                        <div className="flex items-start justify-center flex-col h-full z-20 relative gap-5 px-6 md:px-12 py-10">
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-600/90 backdrop-blur-xl border border-red-500/40 text-white text-xs font-semibold uppercase tracking-wider">
                            🔥 {t('home.teamSelection')}
                          </span>
                          <span className="text-white text-4xl sm:text-5xl font-bold leading-tight">
                            {t('home.featuredSpotlightTitle')}
                          </span>
                          <div className="flex flex-row gap-2 items-center flex-wrap">
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/5 backdrop-blur-xl border border-white/20 text-white/90 text-xs font-medium">
                              12+
                            </span>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-yellow-500/15 backdrop-blur-xl border border-yellow-500/30 text-yellow-300 text-xs font-semibold">
                              <Star className="w-3 h-3 fill-current" />
                              {featuredSeries.vote_average?.toFixed(1)}/10
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/5 backdrop-blur-xl border border-white/10 text-white/80 text-xs font-medium">
                              {t('home.featuredSpotlightGenreAnimation')}
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/5 backdrop-blur-xl border border-white/10 text-white/80 text-xs font-medium">
                              {t('home.featuredSpotlightGenreComedy')}
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/5 backdrop-blur-xl border border-white/10 text-white/80 text-xs font-medium">
                              {t('home.featuredSpotlightGenreDrama')}
                            </span>
                            <span className="inline-flex items-center px-3 py-1 rounded-full bg-white/5 backdrop-blur-xl border border-white/10 text-white/80 text-xs font-medium">
                              24min / {t('home.perEpisode')}
                            </span>
                          </div>
                          <p className="text-white/80 my-0 w-full lg:w-2/3 xl:w-1/2 line-clamp-4 leading-relaxed">
                            {t('home.featuredSpotlightDescription')}
                          </p>
                          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                            <Link
                              to="/tv/4fsgG0N6KdeMTqMhnJMeHdF5RBB6IG1PMLQLR"
                              className="inline-flex items-center gap-2 bg-white hover:bg-white/90 text-black px-6 md:px-7 py-3 rounded-2xl font-semibold transition-colors shadow-lg"
                            >
                              <Info className="w-5 h-5" />
                              {t('home.viewDetails')}
                            </Link>
                          </motion.div>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Films Populaires - Lazy loaded (index 5) */}
                  <div className="mb-16 px-4 md:px-8">
                    <LazySection index={5} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                      <EmblaCarousel
                        title={t('home.popularMovies')}
                        items={popularMovies}
                        mediaType="popularMovies"
                      />
                    </LazySection>
                  </div>

                  {/* Category Genre Rows - Lazy loaded (index 6+) */}
                  {categories.map((category, catIndex) => (
                    <div key={category.id} className="mb-16 px-4 md:px-8">
                      <LazySection index={6 + catIndex} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
                        <EmblaCarousel
                          title={category.title}
                          items={category.items}
                          mediaType={category.id}
                        />
                      </LazySection>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </>
        )}
      </motion.div>
    </SquareBackground>
  );
};

export default Home;