import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { ArrowLeft, SlidersHorizontal, LayoutGrid, List, Loader2, Film, Tv } from 'lucide-react';
import SEO from '../components/SEO';
import { motion, AnimatePresence } from 'framer-motion';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import CustomDropdown from '../components/CustomDropdown';
import { SearchGridCard, SearchListCard } from '../components/SearchCard';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

const PROVIDER_NAMES: Record<number, string> = {
    8: 'Netflix', 119: 'Prime Video', 531: 'Paramount+', 337: 'Disney+',
    338: 'Marvel Studios', 350: 'Apple TV+', 355: 'Warner Bros', 356: 'DC Comics', 384: 'HBO MAX'
};

const STUDIOS: Record<number, { name: string; tmdbId: number }> = {
    338: { name: 'Marvel Studios', tmdbId: 420 },
    356: { name: 'DC Comics', tmdbId: 9993 },
    355: { name: 'Warner Bros', tmdbId: 174 }
};

interface ContentItem {
    id: number;
    title?: string;
    name?: string;
    poster_path: string;
    backdrop_path?: string;
    overview: string;
    vote_average: number;
    release_date?: string;
    first_air_date?: string;
    genre_ids?: number[];
    media_type?: 'movie' | 'tv';
}

// Pagination (same as Search/GenrePage)
const PaginationBar = ({ currentPage, maxPages, onSelect }: { currentPage: number; maxPages: number; onSelect: (n: number) => void }) => (
    <div className="flex justify-center items-center gap-1.5 flex-wrap my-8">
        <motion.button whileTap={{ scale: 0.92 }} onClick={() => onSelect(1)} disabled={currentPage <= 1}
            className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${currentPage === 1 ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'} disabled:opacity-30`}>
            1
        </motion.button>
        {currentPage > 4 && <span className="text-white/20 px-1">...</span>}
        {Array.from({ length: 5 }, (_, i) => {
            const p = Math.max(2, currentPage - 2) + i;
            return p > 1 && p < maxPages ? (
                <motion.button key={p} whileTap={{ scale: 0.92 }} onClick={() => onSelect(p)}
                    className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${p === currentPage ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'}`}>
                    {p}
                </motion.button>
            ) : null;
        })}
        {currentPage < maxPages - 3 && <span className="text-white/20 px-1">...</span>}
        {maxPages > 1 && (
            <motion.button whileTap={{ scale: 0.92 }} onClick={() => onSelect(maxPages)} disabled={currentPage >= maxPages}
                className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${currentPage === maxPages ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'} disabled:opacity-30`}>
                {maxPages}
            </motion.button>
        )}
    </div>
);

const ProviderCatalogPage: React.FC = () => {
    const { providerId, type, genreId } = useParams<{ providerId: string; type: string; genreId?: string }>();
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const { t } = useTranslation();

    const getGenreName = (id: number): string => t(`providerCatalog.genres.${id}`, { defaultValue: String(id) });

    const [content, setContent] = useState<ContentItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [initialLoad, setInitialLoad] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const pageFromUrl = parseInt(searchParams.get('page') || '1', 10);
    const [currentPage, setCurrentPage] = useState(pageFromUrl);
    const [totalPages, setTotalPages] = useState(1);
    const [totalResults, setTotalResults] = useState(0);
    const [sortBy, setSortBy] = useState('popularity.desc');
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [viewType, setViewType] = useState<'grid' | 'list'>('grid');

    const providerName = PROVIDER_NAMES[Number(providerId)] || 'Provider';
    const isMovie = type === 'movies';
    const mediaType = isMovie ? 'movie' : 'tv';
    const genreName = genreId ? getGenreName(parseInt(genreId)) : null;
    const studio = STUDIOS[Number(providerId)];

    // Responsive grid
    const [resultsPerRow, setResultsPerRow] = useState(6);
    const [screenCols, setScreenCols] = useState(6);

    useEffect(() => {
        const update = () => {
            const w = window.innerWidth;
            if (w < 640) setScreenCols(2);
            else if (w < 768) setScreenCols(3);
            else if (w < 1024) setScreenCols(4);
            else if (w < 1280) setScreenCols(6);
            else setScreenCols(10);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    const effectivePerRow = Math.min(resultsPerRow, screenCols);
    const allGridOptions = [2, 3, 4, 6, 8, 10];
    const gridOptions = allGridOptions.filter(n => n <= screenCols).map(n => ({ value: String(n), label: `${n} ${t('search.perRow')}` }));

    const getGridClasses = () => {
        switch (effectivePerRow) {
            case 2: return 'grid-cols-2';
            case 3: return 'grid-cols-2 sm:grid-cols-3';
            case 4: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4';
            case 8: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8';
            case 10: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10';
            case 6:
            default: return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6';
        }
    };

    // Memoized so CustomDropdown sees stable refs across renders.
    const sortOptions = useMemo(() => [
        { value: 'popularity.desc', label: t('genres.popularityDesc') },
        { value: 'popularity.asc', label: t('genres.popularityAsc') },
        { value: 'vote_average.desc', label: t('genres.ratingDesc') },
        { value: 'vote_average.asc', label: t('genres.ratingAsc') },
        { value: 'release_date.desc', label: t('genres.releaseDateDesc') },
        { value: 'release_date.asc', label: t('genres.releaseDateAsc') },
    ], [t]);

    // Sync page with URL
    useEffect(() => {
        const p = parseInt(searchParams.get('page') || '1', 10);
        if (p !== currentPage) setCurrentPage(p);
    }, [searchParams]);

    // Reset on route change
    useEffect(() => {
        setCurrentPage(1);
        setSearchParams({ page: '1' }, { replace: true });
        setLoading(true);
        setInitialLoad(true);
    }, [providerId, type, genreId]);

    // Fetch content
    useEffect(() => {
        const fetchContent = async () => {
            if (!providerId || !type) return;
            setLoading(true);
            try {
                const today = new Date().toISOString().split('T')[0];
                const params: Record<string, any> = {
                    api_key: TMDB_API_KEY,
                    language: getTmdbLanguage(),
                    page: currentPage,
                    sort_by: sortBy,
                    include_adult: false,
                    'vote_count.gte': 5
                };

                if (isMovie) params['primary_release_date.lte'] = today;
                else params['first_air_date.lte'] = today;
                if (genreId) params.with_genres = genreId;

                if (studio) {
                    params.with_companies = studio.tmdbId;
                } else {
                    params.with_watch_providers = providerId;
                    params.watch_region = 'FR';
                }

                const response = await axios.get(`https://api.themoviedb.org/3/discover/${mediaType}`, { params });

                const filtered = response.data.results
                    .filter((item: ContentItem) => item.overview && item.overview.trim() !== '' && item.poster_path)
                    .map((item: ContentItem) => ({ ...item, media_type: mediaType }));

                setContent(filtered);
                setTotalPages(Math.min(response.data.total_pages, 500));
                setTotalResults(response.data.total_results);
            } catch {
                setError(t('errors.contentLoadError'));
            } finally {
                setLoading(false);
                setInitialLoad(false);
            }
        };
        fetchContent();
    }, [providerId, type, genreId, currentPage, sortBy]);

    const handlePageChange = useCallback((newPage: number) => {
        if (newPage > 0 && newPage <= totalPages) {
            setSearchParams({ page: newPage.toString() });
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }, [totalPages, setSearchParams]);

    const handleSortChange = (val: string) => {
        setSortBy(val);
        setSearchParams({ page: '1' }, { replace: true });
    };

    // Memoized so SearchGridCard / SearchListCard (React.memo'd, shallow-equal
    // on `item`) actually skip re-renders when the underlying content array
    // is unchanged. The previous inline `toSearchResult(item)` call in the
    // .map allocated a fresh object every render. — perf
    const searchResults = useMemo(
        () => content.map((item: ContentItem) => ({
            id: item.id,
            title: item.title,
            name: item.name,
            media_type: mediaType as 'movie' | 'tv',
            poster_path: item.poster_path,
            backdrop_path: item.backdrop_path,
            release_date: item.release_date,
            first_air_date: item.first_air_date,
            vote_average: item.vote_average,
            overview: item.overview,
        })),
        [content, mediaType]
    );

    if (initialLoad) {
        return (
            <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
                <div className="min-h-screen flex flex-col justify-center items-center">
                    <Loader2 className="w-12 h-12 text-red-500 animate-spin mb-4" />
                    <p className="text-white/60 animate-pulse">{t('providerCatalog.loading', { provider: providerName })}</p>
                </div>
            </SquareBackground>
        );
    }

    if (error) {
        return (
            <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
                <div className="min-h-screen flex justify-center items-center">
                    <div className="text-center">
                        <h1 className="text-2xl font-bold text-red-500">{t('common.error')}</h1>
                        <p className="mt-2 text-white/60">{error}</p>
                        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => window.location.reload()}
                            className="mt-4 px-6 py-2 bg-red-600 hover:bg-red-500 rounded-full text-white font-medium transition-colors">
                            {t('common.retry')}
                        </motion.button>
                    </div>
                </div>
            </SquareBackground>
        );
    }

    return (
        <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" mode="combined">
            <motion.div className="min-h-screen pt-24 pb-16 px-4 md:px-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                <SEO
                    title={`${genreName ? genreName + ' - ' : ''}${isMovie ? t('providerCatalog.films') : t('providerCatalog.series')} ${providerName}`}
                    description={`${t('providerCatalog.discover')} ${isMovie ? t('providerCatalog.films').toLowerCase() : t('providerCatalog.series').toLowerCase()} ${providerName}`}
                />

                <div className="max-w-screen-xl mx-auto">
                    {/* Header */}
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-col gap-4">
                        <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
                            <div className="flex items-center gap-3">
                                <motion.button whileHover={{ x: -3 }} whileTap={{ scale: 0.9 }} onClick={() => navigate(`/provider/${providerId}`)}
                                    className="p-2 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/10 transition-all">
                                    <ArrowLeft className="w-5 h-5 text-white/70" />
                                </motion.button>
                                <div className="flex items-center gap-3 flex-wrap">
                                    <h1 className="text-2xl md:text-3xl font-bold">
                                        <ShinyText text={providerName} speed={4} />
                                    </h1>
                                    {genreName && (
                                        <>
                                            <span className="text-white/30">›</span>
                                            <span className="text-xl font-semibold text-white/80">{genreName}</span>
                                        </>
                                    )}
                                    <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-sm text-white/60">
                                        {isMovie ? t('providerCatalog.films') : t('providerCatalog.series')}
                                    </span>
                                </div>
                            </div>

                            {/* Type switcher */}
                            <div className="flex gap-2">
                                <Link to={`/provider/${providerId}/movies${genreId ? `/${genreId}` : ''}`}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all text-sm font-medium ${type === 'movies' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'}`}>
                                    <Film className="w-4 h-4" /> {t('providerCatalog.films')}
                                </Link>
                                <Link to={`/provider/${providerId}/tv${genreId ? `/${genreId}` : ''}`}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all text-sm font-medium ${type === 'tv' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'}`}>
                                    <Tv className="w-4 h-4" /> {t('providerCatalog.series')}
                                </Link>
                            </div>
                        </div>

                        <div className="flex items-center justify-between">
                            <p className="text-sm text-white/40">{t('providerCatalog.resultsAvailable', { count: totalResults.toLocaleString() })}</p>
                            <motion.button
                                className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl transition-all ${isFilterOpen
                                    ? 'bg-red-600 border border-red-500 hover:bg-red-500'
                                    : 'bg-white/5 backdrop-blur-md border border-white/10 hover:border-red-500/40 hover:bg-red-500/10'}`}
                                onClick={() => setIsFilterOpen(!isFilterOpen)} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                <SlidersHorizontal className="w-4 h-4" />
                                <span className="text-sm font-medium">{t('filter.title')}</span>
                            </motion.button>
                        </div>
                    </motion.div>

                    {/* Filter Panel */}
                    <AnimatePresence>
                        {isFilterOpen && (
                            <motion.div className="mb-8 p-5 rounded-2xl bg-white/5 backdrop-blur-md border border-white/10"
                                initial={{ opacity: 0, y: -20, height: 0 }} animate={{ opacity: 1, y: 0, height: 'auto' }}
                                exit={{ opacity: 0, y: -20, height: 0 }} transition={{ duration: 0.25 }}>
                                <div className="flex flex-col sm:flex-row gap-4 sm:items-end">
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="flex-1">
                                        <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('genres.sort')}</label>
                                        <CustomDropdown options={sortOptions} value={sortBy} onChange={handleSortChange} searchable={false} />
                                    </motion.div>
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="flex-1">
                                        <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">{t('genres.itemsPerRow')}</label>
                                        <CustomDropdown options={gridOptions} value={String(resultsPerRow)} onChange={(val) => setResultsPerRow(Number(val))} searchable={false} />
                                    </motion.div>
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="flex gap-2">
                                        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setViewType('grid')}
                                            className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${viewType === 'grid' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'}`}>
                                            <LayoutGrid className="w-4 h-4" /><span className="text-sm hidden sm:inline">{t('genres.grid')}</span>
                                        </motion.button>
                                        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setViewType('list')}
                                            className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${viewType === 'list' ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'}`}>
                                            <List className="w-4 h-4" /><span className="text-sm hidden sm:inline">{t('genres.listView')}</span>
                                        </motion.button>
                                    </motion.div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Content */}
                    {loading && !initialLoad ? (
                        <div className="flex justify-center py-20">
                            <Loader2 className="w-8 h-8 text-red-500 animate-spin" />
                        </div>
                    ) : content.length === 0 ? (
                        <motion.div className="text-center py-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
                            <p className="text-lg text-white/60">{t('genres.noContent')}</p>
                            <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                                className="mt-4 px-6 py-2 bg-red-600 hover:bg-red-500 rounded-full text-white font-medium transition-colors"
                                onClick={() => navigate(-1)}>
                                {t('common.back')}
                            </motion.button>
                        </motion.div>
                    ) : (
                        <>
                            {viewType === 'grid' && (
                                <div className={`grid ${getGridClasses()} gap-3`}>
                                    {searchResults.map((item, index) => (
                                        <SearchGridCard key={item.id} item={item} index={index}
                                            movieLabel={t('filter.movies')} serieLabel={t('filter.series')} />
                                    ))}
                                </div>
                            )}

                            {viewType === 'list' && (
                                <div className="flex flex-col gap-3">
                                    {searchResults.map((item, index) => (
                                        <SearchListCard key={item.id} item={item} index={index}
                                            movieLabel={t('filter.movies')} serieLabel={t('filter.series')}
                                            watchlistLabel="Watchlist" removeLabel={t('genres.remove')} noDescLabel={t('genres.noContent')} />
                                    ))}
                                </div>
                            )}

                            {totalPages > 1 && (
                                <PaginationBar currentPage={currentPage} maxPages={Math.min(totalPages, 500)} onSelect={handlePageChange} />
                            )}
                        </>
                    )}
                </div>
            </motion.div>
        </SquareBackground>
    );
};

export default ProviderCatalogPage;
