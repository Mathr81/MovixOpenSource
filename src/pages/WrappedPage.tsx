import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { ChevronLeft, ChevronRight, Share2, X, Sparkles, Calendar, Trophy, BarChart3, Clock, Flame, Music, ShieldOff, Settings, ImageIcon, Download, Copy, FileText, Loader2, LogIn, UserPlus } from 'lucide-react';
import { fetchWrappedData, WrappedData, WrappedProgress, WrappedSlide, WrappedTopContent } from '../services/wrappedService';
import { SquareBackground } from '../components/ui/square-background';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import ShinyText from '../components/ui/shiny-text';
import axios from 'axios';
import { getTmdbLanguage } from '../i18n';
import { buildApiProxyUrl } from '../config/runtime';
import { toast } from 'sonner';
import { areSoundEffectsEnabled, SOUND_EFFECTS_CHANGED_EVENT } from '../utils/soundSettings';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// ==========================================
// TMDB DATA INTERFACE
// ==========================================
interface TMDBData {
    id: number;
    title?: string;
    name?: string;
    poster_path: string | null;
    backdrop_path?: string | null;
    vote_average?: number;
    release_date?: string;
    first_air_date?: string;
    genres?: { id: number; name: string }[];
    trailerKey?: string | null;
}



// ==========================================
// DURATION FORMATTING HELPERS
// ==========================================
/** Shows "Xh" if >= 60 min, else "Xmin" */
function formatDurationShort(minutes: number): string {
    if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
    return `${minutes}min`;
}

function formatCompactDuration(minutes: number, t: (key: string, options?: Record<string, unknown>) => string): string {
    const safeMinutes = Math.max(0, Math.round(minutes));

    if (safeMinutes >= 60) {
        const hours = Math.floor(safeMinutes / 60);
        const remainingMinutes = safeMinutes % 60;

        if (remainingMinutes === 0) {
            return `${hours}${t('wrapped.hoursShort')}`;
        }

        return `${hours}${t('wrapped.hoursShort')} ${remainingMinutes}${t('wrapped.minutesShort')}`;
    }

    return `${safeMinutes}${t('wrapped.minutesShort')}`;
}

function formatWrappedTypeLabel(
    type: WrappedTopContent['type'] | string,
    t: (key: string, options?: Record<string, unknown>) => string
): string {
    if (type === 'movie') return t('wrapped.movieType');
    if (type === 'tv') return t('wrapped.seriesSingular');
    if (type === 'anime') return t('wrapped.animeType');
    return t('wrapped.tvType');
}

const WRAPPED_SHARE_IMAGE_WIDTH = 1080;
const WRAPPED_SHARE_IMAGE_HEIGHT = 1920;

function drawRoundedRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + width - safeRadius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    ctx.lineTo(x + width, y + height - safeRadius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    ctx.lineTo(x + safeRadius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    ctx.lineTo(x, y + safeRadius);
    ctx.quadraticCurveTo(x, y, x + safeRadius, y);
    ctx.closePath();
}

function drawPopcornSticker(
    ctx: CanvasRenderingContext2D,
    {
        x,
        y,
        scale = 1,
        rotation = 0,
        opacity = 0.5,
        accent = '#f6c453', // Unused but kept for signature
    }: {
        x: number;
        y: number;
        scale?: number;
        rotation?: number;
        opacity?: number;
        accent?: string;
        fillLevel?: number;
    }
) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    // Adjusted scale down drastically because original SVG is 512x512
    ctx.scale(scale * 0.05, scale * 0.05); 
    // Shift so it rotates somewhat around its center (256, 256)
    ctx.translate(-256, -256);
    ctx.globalAlpha = opacity;
    
    // SVG Path for Popcorn
    const combinedPath = new Path2D(
        "M415.08,147.991c-0.582-0.661-1.27-1.201-2.025-1.618c-2.051-13.744-8.438-27.651-20.957-27.856 c-1.149-2.05-2.159-7.502-2.786-10.891c-0.847-4.574-1.723-9.304-3.418-13.119c-4.147-9.33-11.46-9.194-14.405-8.702 c-4.744,0.791-9.651-2.179-10.522-3.816c0.228-0.314,0.77-0.892,1.831-1.599c5.878-3.918,8.79-8.526,8.654-13.697 c-0.247-9.384-9.945-15.137-22.223-22.421c-1.595-0.946-3.232-1.917-4.884-2.919c-13.683-8.292-24.607-3.13-32.584,0.64 c-3.66,1.729-6.869,3.246-9.73,3.352c-0.035-0.649-0.057-1.374-0.075-1.991c-0.212-7.208-0.568-19.271-14.256-31.474 C274.131-0.211,262.42-0.939,254.984,0.582c-10.465,2.138-19.319,9.884-24.931,21.809c-2.617,5.561-4.708,9.396-6.41,10.034 c-2.405,0.901-8.666-0.019-17.332-1.293l-2.647-0.388c-4.139-0.602-7.984,2.263-8.588,6.402s2.262,7.984,6.402,8.588l2.63,0.386 c12.116,1.78,18.791,2.761,24.852,0.49c7.258-2.721,10.712-9.081,14.8-17.77c3.475-7.385,8.671-12.276,14.255-13.417 c7.32-1.495,14.702,3.398,19.604,7.767c8.819,7.861,9.018,14.634,9.194,20.61c0.149,5.083,0.461,15.658,13.134,16.633 c7.087,0.541,13.038-2.264,18.284-4.742c7.585-3.582,11.841-5.272,18.261-1.382c1.694,1.027,3.372,2.022,5.007,2.992 c4.807,2.852,11.761,6.977,14.196,9.523c-0.315,0.265-0.738,0.588-1.301,0.962c-7.601,5.068-10.446,12.378-7.608,19.555 c3.417,8.64,14.778,14.601,25.421,13.633c0.875,2.2,1.688,6.589,2.21,9.409c1.755,9.477,4.404,23.786,17.302,23.281 c1.706-0.07,4.236,5.117,5.72,11.755h-274.7c-0.115-0.071-0.225-0.146-0.345-0.212c-1.163-0.638-4.7-3.277-5.188-5.688 c-0.075-0.369-0.302-1.491,1.425-3.672c2.923-3.692,5.246-4.908,7.937-6.315c6.07-3.177,10.867-6.586,12.796-18.929 c1.208-7.729,4.202-10.008,11.438-15.514c3.905-2.972,8.767-6.67,14.206-12.111c2.958-2.958,2.958-7.754,0-10.711 c-2.958-2.958-7.754-2.958-10.711,0c-4.716,4.716-8.941,7.932-12.668,10.767c-8.093,6.158-15.082,11.477-17.231,25.23 c-0.903,5.779-1.506,6.095-4.851,7.846c-3.32,1.738-7.869,4.117-12.791,10.335c-5.035,6.361-5.169,12.256-4.395,16.08 c0.205,1.015,0.509,1.972,0.86,2.894h-0.614c-2.177,0-4.249,0.937-5.687,2.571c-1.438,1.635-2.104,3.808-1.826,5.967l7.52,58.553 c0.532,4.148,4.326,7.074,8.477,6.547c4.149-0.533,7.08-4.328,6.548-8.477l-6.423-50.014h17.445l43.185,336.283H154.4 l-27.572-214.71c-0.533-4.149-4.328-7.082-8.477-6.548c-4.149,0.533-7.08,4.328-6.548,8.477l28.422,221.32 c0.485,3.779,3.702,6.61,7.512,6.61h32.688c0.007,0,0.014,0.001,0.021,0.001c0.005,0,0.01-0.001,0.015-0.001h38.037 c0.003,0,0.007,0,0.01,0c0.005,0,0.009,0,0.014,0h81.925c0.005,0,0.009,0,0.014,0c0.003,0,0.007,0,0.01,0h38.037 c0.005,0,0.01,0.001,0.015,0.001c0.007,0,0.014-0.001,0.021-0.001h25.718c3.81,0,7.027-2.831,7.512-6.61l45.13-351.431 C417.182,151.8,416.518,149.626,415.08,147.991z M187.118,496.851l-43.185-336.283h42.594l23.857,336.283H187.118z M251.857,496.851h-26.285l-23.858-336.283h50.143V496.851z M293.397,496.851h-26.393V160.568h50.25L293.397,496.851z M331.851,496.851h-23.267l23.858-336.283h42.594L331.851,496.851z M357.599,496.851h-10.476l43.185-336.283h10.476 L357.599,496.851z " +
        "M296.654,97.087c-1.495-3.907-5.874-5.862-9.781-4.367c-10.043,3.844-12.895,2.129-19.785-2.013 c-3.833-2.305-8.605-5.173-15.305-7.342c-21.151-6.856-34.389,9.688-40.75,17.636c-0.555,0.694-1.076,1.346-1.567,1.939 c-1.149,1.389-1.668,1.682-1.659,1.682c-0.363,0.102-1.676,0.084-2.73,0.069c-2.714-0.038-6.431-0.091-11.781,0.853 c-17.312,3.055-22.505,22.439-22.718,23.263c-1.039,4.033,1.379,8.127,5.405,9.193c0.645,0.171,1.293,0.253,1.93,0.253 c3.344,0,6.409-2.241,7.323-5.617c0.029-0.108,3.014-10.818,10.693-12.174c3.937-0.695,6.592-0.655,8.934-0.624 c5.941,0.09,10.601-0.385,16.272-7.24c0.539-0.651,1.114-1.368,1.725-2.132c7.145-8.927,13.902-16.041,24.256-12.691 c5.049,1.636,8.669,3.811,12.169,5.915c7.901,4.748,16.071,9.657,33.002,3.176C296.194,105.373,298.148,100.993,296.654,97.087z"
    );

    ctx.fillStyle = accent;
    ctx.fill(combinedPath);
    ctx.restore();
}

function drawClapperSticker(
    ctx: CanvasRenderingContext2D,
    {
        x,
        y,
        scale = 1,
        rotation = 0,
        opacity = 0.5,
        accent = '#4ecdc4',
    }: {
        x: number;
        y: number;
        scale?: number;
        rotation?: number;
        opacity?: number;
        accent?: string;
    }
) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);
    ctx.translate(-12, -12); // Center a 24x24 viewBox
    ctx.globalAlpha = opacity;

    // SVG Path for Clapperboard
    const combinedPath = new Path2D(
        "M4 11H16C17.8856 11 18.8284 11 19.4142 11.5858C20 12.1716 20 13.1144 20 15V16C20 18.8284 20 20.2426 19.1213 21.1213C18.2426 22 16.8284 22 14 22H10C7.17157 22 5.75736 22 4.87868 21.1213C4 20.2426 4 18.8284 4 16V11Z " +
        "M4.00128 10.9997C3.51749 9.19412 3.27559 8.29135 3.48364 7.51489C3.61994 7.00622 3.88773 6.5424 4.2601 6.17003C4.82851 5.60162 5.73128 5.35973 7.53682 4.87593L14.5398 2.99949C15.213 2.8191 15.5496 2.72891 15.8445 2.70958C17.0553 2.63022 18.1946 3.28804 18.7313 4.37629C18.862 4.64129 18.9522 4.97791 19.1326 5.65114C19.1927 5.87556 19.2228 5.98776 19.2292 6.08604C19.2557 6.48964 19.0364 6.86943 18.6736 7.04832C18.5853 7.09188 18.4731 7.12195 18.2487 7.18208L4.00128 10.9997Z " +
        "M14.7004 2.94135L14.0627 8.28861 " +
        "M8.42209 4.62396L7.78433 9.97123"
    );

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke(combinedPath);
    ctx.restore();
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    if (!text) return [''];

    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let currentLine = '';

    words.forEach((word) => {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(candidate).width <= maxWidth) {
            currentLine = candidate;
        } else {
            if (currentLine) {
                lines.push(currentLine);
            }
            currentLine = word;
        }
    });

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [text];
}

async function loadCanvasImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const image = new Image();
        const resolvedSrc = src.startsWith('http') ? buildApiProxyUrl(src) : src;
        if (!resolvedSrc.startsWith(window.location.origin)) {
            image.crossOrigin = 'anonymous';
        }
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = resolvedSrc;
    });
}

function downloadBlob(blob: Blob, filename: string) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
}

async function copyTextToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

function isShareAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

// ==========================================
// ANIMATED COUNTER
// ==========================================
const AnimatedCounter: React.FC<{ value: number; suffix?: string; className?: string; duration?: number }> = ({ value, suffix = '', className = '', duration = 2 }) => {
    const [count, setCount] = useState(0);

    useEffect(() => {
        const step = value / (duration * 60);
        let current = 0;
        const timer = setInterval(() => {
            current += step;
            if (current >= value) {
                setCount(value);
                clearInterval(timer);
            } else {
                setCount(Math.floor(current));
            }
        }, 1000 / 60);
        return () => clearInterval(timer);
    }, [value, duration]);

    return <span className={className}>{count.toLocaleString(i18n.language)}{suffix}</span>;
};

// ==========================================
// CASCADING TIME COUNTER - Shows time in different units
// ==========================================
type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

const timeUnits: { unit: TimeUnit; labelKey: string; labelPluralKey: string; divider: number }[] = [
    { unit: 'seconds', labelKey: 'wrapped.timeUnitSecondSingular', labelPluralKey: 'wrapped.timeUnitSecondPlural', divider: 1 },
    { unit: 'minutes', labelKey: 'wrapped.timeUnitMinuteSingular', labelPluralKey: 'wrapped.timeUnitMinutePlural', divider: 60 },
    { unit: 'hours', labelKey: 'wrapped.timeUnitHourSingular', labelPluralKey: 'wrapped.timeUnitHourPlural', divider: 3600 },
    { unit: 'days', labelKey: 'wrapped.timeUnitDaySingular', labelPluralKey: 'wrapped.timeUnitDayPlural', divider: 86400 },
    { unit: 'weeks', labelKey: 'wrapped.timeUnitWeekSingular', labelPluralKey: 'wrapped.timeUnitWeekPlural', divider: 604800 },
    { unit: 'months', labelKey: 'wrapped.timeUnitMonthSingular', labelPluralKey: 'wrapped.timeUnitMonthPlural', divider: 2592000 },
];

const CascadingTimeCounter: React.FC<{ totalMinutes: number; className?: string }> = ({ totalMinutes, className = '' }) => {
    const totalSeconds = totalMinutes * 60;
    const [currentUnitIndex, setCurrentUnitIndex] = useState(0);
    const [displayValue, setDisplayValue] = useState(0);
    const [isAnimating, setIsAnimating] = useState(true);

    // Determine the final unit based on the total time
    const getFinalUnitIndex = () => {
        const days = totalSeconds / 86400;
        if (days >= 30) return 5; // months
        if (days >= 7) return 4; // weeks
        return 3; // days
    };

    const finalUnitIndex = getFinalUnitIndex();

    useEffect(() => {
        const currentUnit = timeUnits[currentUnitIndex];
        const targetValue = totalSeconds / currentUnit.divider;
        const duration = currentUnitIndex === 0 ? 1500 : 1000; // Slower for seconds
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Easing function for smooth animation
            const eased = 1 - Math.pow(1 - progress, 3);
            const currentValue = targetValue * eased;

            setDisplayValue(currentValue);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Animation complete, move to next unit after a delay
                if (currentUnitIndex < finalUnitIndex) {
                    setTimeout(() => {
                        setCurrentUnitIndex(prev => prev + 1);
                    }, 800);
                } else {
                    setIsAnimating(false);
                }
            }
        };

        setIsAnimating(true);
        requestAnimationFrame(animate);
    }, [currentUnitIndex, totalSeconds, finalUnitIndex]);

    const currentUnit = timeUnits[currentUnitIndex];
    const formattedValue = currentUnitIndex >= 3
        ? displayValue.toFixed(1)
        : Math.floor(displayValue).toLocaleString(i18n.language);
    const label = displayValue === 1 ? i18n.t(currentUnit.labelKey) : i18n.t(currentUnit.labelPluralKey);

    return (
        <div className={`relative ${className}`}>
            <AnimatePresence mode="wait">
                <motion.div
                    key={currentUnitIndex}
                    initial={{ opacity: 0, y: 30, scale: 0.8 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -30, scale: 0.8 }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className="flex flex-col items-center"
                >
                    <motion.span 
                        className="text-5xl md:text-7xl font-black tabular-nums"
                        animate={isAnimating ? { scale: [1, 1.02, 1] } : {}}
                        transition={{ duration: 0.1, repeat: isAnimating ? Infinity : 0 }}
                    >
                        {formattedValue}
                    </motion.span>
                    <motion.span 
                        className="text-2xl md:text-3xl text-white/70 font-medium mt-2"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.2 }}
                    >
                        {label}
                    </motion.span>
                </motion.div>
            </AnimatePresence>
            
            {/* Progress dots */}
            <div className="flex justify-center gap-2 mt-6">
                {timeUnits.slice(0, finalUnitIndex + 1).map((_, idx) => (
                    <motion.div
                        key={idx}
                        className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                            idx <= currentUnitIndex ? 'bg-purple-400' : 'bg-white/20'
                        }`}
                        animate={idx === currentUnitIndex ? { scale: [1, 1.3, 1] } : {}}
                        transition={{ duration: 0.5, repeat: idx === currentUnitIndex ? Infinity : 0 }}
                    />
                ))}
            </div>
        </div>
    );
};

const wrappedSlideViewportStyle: React.CSSProperties = {
    paddingTop: 'max(6rem, calc(env(safe-area-inset-top) + 5rem))',
    paddingBottom: 'max(8rem, calc(env(safe-area-inset-bottom) + 7rem))',
};

const wrappedTopBarStyle: React.CSSProperties = {
    paddingTop: 'max(0.75rem, calc(env(safe-area-inset-top) + 0.75rem))',
};

const wrappedProgressBarStyle: React.CSSProperties = {
    top: 'max(4rem, calc(env(safe-area-inset-top) + 3.75rem))',
};

const wrappedNavigationStyle: React.CSSProperties = {
    bottom: 'max(1rem, calc(env(safe-area-inset-bottom) + 1rem))',
};

const wrappedHintStyle: React.CSSProperties = {
    bottom: 'max(4.75rem, calc(env(safe-area-inset-bottom) + 4.5rem))',
};

const wrappedStandaloneViewportStyle: React.CSSProperties = {
    paddingTop: 'max(1rem, calc(env(safe-area-inset-top) + 1rem))',
    paddingBottom: 'max(1.5rem, calc(env(safe-area-inset-bottom) + 1.5rem))',
};

const WrappedCenteredSlide: React.FC<{
    children: React.ReactNode;
    className?: string;
    contentClassName?: string;
}> = ({ children, className = '', contentClassName = '' }) => (
    <div
        className={`h-full w-full overflow-y-auto overscroll-y-contain px-4 sm:px-6 ${className}`}
        style={wrappedSlideViewportStyle}
        data-lenis-prevent
        onWheel={(e) => e.stopPropagation()}
    >
        <div
            className={`mx-auto flex min-h-full w-full flex-col items-center justify-start text-center lg:justify-center ${contentClassName}`}
        >
            {children}
        </div>
    </div>
);

const WrappedStandaloneShell: React.FC<{
    mode: React.ComponentProps<typeof SquareBackground>['mode'];
    children: React.ReactNode;
}> = ({ mode, children }) => (
    <SquareBackground mode={mode} borderColor="rgba(168, 85, 247, 0.15)" className="fixed inset-0 z-50 bg-black">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_24%,rgba(168,85,247,0.18),transparent_52%)]" />
        <div
            className="relative z-10 h-full overflow-y-auto overscroll-y-contain px-4 sm:px-6"
            style={wrappedStandaloneViewportStyle}
            data-lenis-prevent
            onWheel={(e) => e.stopPropagation()}
        >
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
                {children}
            </div>
        </div>
    </SquareBackground>
);

// ==========================================
// SLIDE COMPONENTS - New Design
// ==========================================

const SlideIntro: React.FC<{ slide: WrappedSlide; stats: WrappedData['stats'] }> = ({ slide, stats }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
            className="mb-5 sm:mb-6"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(168, 85, 247, 0.45) 0%, transparent 70%)' }}
                />
                <span className="relative text-7xl md:text-8xl">🎬</span>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
        >
            <h1 className="mb-3 px-2 text-3xl font-black leading-tight sm:text-4xl md:text-5xl">
                <ShinyText text={slide.title} speed={2} color="#ffffff" shineColor="#a855f7" className="max-w-full" />
            </h1>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="mb-5 max-w-2xl text-base font-medium text-purple-300 sm:text-lg md:text-xl"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="w-full max-w-xl"
        >
            <AnimatedBorderCard
                highlightColor="168 85 247"
                backgroundColor="0 0 0"
                className="p-4 sm:p-6 md:p-8 backdrop-blur-md"
            >
                <p className="mb-5 text-sm leading-relaxed text-white/90 sm:text-base md:text-lg">
                    {i18n.t('wrapped.spentOnMovix')}
                </p>
                
                {/* Cascading Time Counter */}
                <CascadingTimeCounter 
                    totalMinutes={stats.totalMinutes} 
                    className="mb-4"
                />
                
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 8 }}
                    className="mt-4 text-xs text-purple-400/80 sm:text-sm"
                >
                    {i18n.t('wrapped.hopeYouHadSnacks')}
                </motion.p>
            </AnimatedBorderCard>
        </motion.div>
    </WrappedCenteredSlide>
);

const SlideTop1: React.FC<{ slide: WrappedSlide; topItem?: WrappedTopContent; tmdbData: Map<number, TMDBData> }> = ({ slide, topItem, tmdbData }) => {
    const tmdb = topItem?.tmdbId ? tmdbData.get(topItem.tmdbId) : null;
    const posterUrl = tmdb?.poster_path 
        ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}` 
        : topItem?.poster_path 
            ? `${TMDB_IMAGE_BASE}${topItem.poster_path}`
            : null;
    
    return (
        <WrappedCenteredSlide className="relative" contentClassName="max-w-3xl">
            {/* Content */}
            <div className="relative z-10 flex flex-col items-center">
                <motion.div
                    initial={{ scale: 0, rotate: -180 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', duration: 0.8 }}
                    className="mb-4 sm:mb-6"
                >
                    <div className="relative">
                        <div
                            className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                            style={{ background: 'radial-gradient(circle, rgba(245, 158, 11, 0.60) 0%, transparent 70%)' }}
                        />
                        {posterUrl ? (
                            <div className="relative h-36 w-24 overflow-hidden rounded-2xl shadow-2xl ring-4 ring-amber-400/50 sm:h-44 sm:w-32 md:h-56 md:w-40">
                                <img 
                                    src={posterUrl} 
                                    alt={topItem?.title || i18n.t('wrapped.topContentFallbackAlt')}
                                    className="w-full h-full object-cover"
                                />
                                {/* Trophy badge */}
                                <div className="absolute -right-2 -top-2 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 shadow-lg sm:-right-3 sm:-top-3 sm:h-12 sm:w-12">
                                    <Trophy className="h-5 w-5 text-white sm:h-6 sm:w-6" />
                                </div>
                            </div>
                        ) : (
                            <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 shadow-2xl sm:h-32 sm:w-32 md:h-40 md:w-40">
                                <Trophy className="h-12 w-12 text-white sm:h-16 sm:w-16 md:h-20 md:w-20" />
                            </div>
                        )}
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                >
                    <h2 className="mb-2 px-2 text-2xl font-black leading-tight sm:text-3xl md:text-4xl">
                        <ShinyText text={tmdb?.title || tmdb?.name || slide.title} speed={2} color="#fbbf24" shineColor="#ffffff" className="max-w-full" />
                    </h2>
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="mb-5 text-base font-semibold text-amber-300 sm:text-lg md:text-xl"
                >
                    {slide.subtitle}
                </motion.p>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.7 }}
                    className="w-full max-w-xl"
                >
                    <AnimatedBorderCard
                        highlightColor="251 191 36"
                        backgroundColor="0 0 0"
                        className="p-4 sm:p-6 backdrop-blur-md"
                    >
                        <p className="text-sm leading-relaxed text-white/90 sm:text-base md:text-lg">
                            {slide.text}
                        </p>
                        {slide.subtext && (
                            <p className="mt-3 text-xs italic text-amber-400/80 sm:text-sm">{slide.subtext}</p>
                        )}
                    </AnimatedBorderCard>
                </motion.div>
            </div>
        </WrappedCenteredSlide>
    );
};

const SlideTopFocus: React.FC<{
    slide: WrappedSlide;
    item?: WrappedTopContent;
    tmdbData: Map<number, TMDBData>;
    rank: 2 | 3;
    hideBackdropImage?: boolean;
}> = ({ slide, item, tmdbData, rank, hideBackdropImage = false }) => {
    const tmdb = item?.tmdbId ? tmdbData.get(item.tmdbId) : null;
    const posterUrl = tmdb?.poster_path
        ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}`
        : item?.poster_path
            ? `${TMDB_IMAGE_BASE}${item.poster_path}`
            : null;
    const backdropUrl = tmdb?.backdrop_path ? `${TMDB_IMAGE_BASE}${tmdb.backdrop_path}` : posterUrl;

    const accent = rank === 2
        ? {
            color: '#cbd5e1',
            soft: 'text-slate-300',
            glow: 'bg-slate-300/20',
            badge: 'from-slate-200 via-slate-300 to-slate-500 text-slate-900',
            ring: 'ring-slate-200/50',
            card: '203 213 225',
        }
        : {
            color: '#fb923c',
            soft: 'text-orange-300',
            glow: 'bg-orange-400/25',
            badge: 'from-orange-300 via-amber-500 to-orange-700 text-white',
            ring: 'ring-orange-300/50',
            card: '251 146 60',
        };

    return (
        <div className="relative h-full w-full overflow-hidden">
            {backdropUrl && !hideBackdropImage && (
                <div className="absolute inset-0">
                    <img
                        src={backdropUrl}
                        alt={item?.title || slide.title}
                        className="w-full h-full object-cover scale-110"
                    />
                    <div className="absolute inset-0 bg-black/65" />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/75 via-black/35 to-black/85" />
                </div>
            )}

            <WrappedCenteredSlide className="relative z-10" contentClassName="max-w-3xl">
                <motion.div
                    initial={{ scale: 0.86, opacity: 0, y: 24 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ type: 'spring', duration: 0.7 }}
                    className="mb-4 sm:mb-6"
                >
                    <div className="relative">
                        <div className={`absolute inset-0 blur-3xl rounded-full scale-150 ${accent.glow}`} />
                        {posterUrl ? (
                            <div className={`relative h-36 w-24 overflow-hidden rounded-2xl shadow-2xl ring-4 sm:h-44 sm:w-32 md:h-56 md:w-40 ${accent.ring}`}>
                                <img
                                    src={posterUrl}
                                    alt={item?.title || slide.title}
                                    className="w-full h-full object-cover"
                                />
                                <div className={`absolute -right-2 -top-2 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br text-base font-black shadow-xl sm:-right-3 sm:-top-3 sm:h-12 sm:w-12 sm:text-lg ${accent.badge}`}>
                                    {rank}
                                </div>
                            </div>
                        ) : (
                            <div className={`relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br text-4xl font-black shadow-2xl sm:h-32 sm:w-32 sm:text-5xl md:h-40 md:w-40 ${accent.badge}`}>
                                {rank}
                            </div>
                        )}
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                >
                    <h2 className="mb-2 px-2 text-2xl font-black leading-tight sm:text-3xl md:text-4xl">
                        <ShinyText text={tmdb?.title || tmdb?.name || item?.title || slide.title} speed={2} color={accent.color} shineColor="#ffffff" className="max-w-full" />
                    </h2>
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.35 }}
                    className={`mb-4 text-base font-semibold sm:text-lg md:text-xl ${accent.soft}`}
                >
                    {slide.subtitle}
                </motion.p>

                <motion.div
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.45 }}
                    className="mb-4 w-full max-w-xl sm:mb-5"
                >
                    <AnimatedBorderCard
                        highlightColor={accent.card}
                        backgroundColor="0 0 0"
                        className="p-4 sm:p-6 backdrop-blur-md"
                    >
                        <p className="text-sm leading-relaxed text-white/90 sm:text-base md:text-lg">
                            {slide.text}
                        </p>
                        {slide.subtext && (
                            <p className={`mt-3 text-xs italic sm:text-sm ${accent.soft}`}>
                                {slide.subtext}
                            </p>
                        )}
                    </AnimatedBorderCard>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.6 }}
                    className="flex max-w-xl flex-wrap items-center justify-center gap-2 sm:gap-3"
                >
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/85 sm:px-4 sm:py-2 sm:text-sm">
                        {item ? formatWrappedTypeLabel(item.type, (key, options) => i18n.t(key, options)) : i18n.t('wrapped.movieType')}
                    </span>
                    {item?.durationLabel && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/85 sm:px-4 sm:py-2 sm:text-sm">
                            {item.durationLabel}
                        </span>
                    )}
                    {tmdb?.vote_average && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/85 sm:px-4 sm:py-2 sm:text-sm">
                            {i18n.t('wrapped.ratingLabel', { rating: tmdb.vote_average.toFixed(1) })}
                        </span>
                    )}
                </motion.div>
            </WrappedCenteredSlide>
        </div>
    );
};

const SlideTop5: React.FC<{ slide: WrappedSlide; topContent: WrappedData['topContent']; tmdbData: Map<number, TMDBData> }> = ({ slide, topContent, tmdbData }) => (
    <div 
        className="relative z-10 flex h-full w-full flex-col items-center overflow-y-auto px-4 text-center scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent sm:px-6"
        style={wrappedSlideViewportStyle}
        data-lenis-prevent
        onWheel={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 flex-shrink-0"
        >
            <h2 className="text-3xl md:text-5xl font-black mb-2">
                <ShinyText text={slide.title} speed={2} color="#fbbf24" shineColor="#ffffff" className="" />
            </h2>
            <p className="text-lg text-amber-200/80 font-medium">{slide.subtitle}</p>
        </motion.div>

        {/* List */}
        <div className="w-full max-w-lg flex flex-col gap-3 flex-1 pb-4">
            {topContent.slice(0, 5).map((item, index) => {
                const tmdb = item.tmdbId ? tmdbData.get(item.tmdbId) : null;
                const posterUrl = tmdb?.poster_path  
                    ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}` 
                    : item.poster_path 
                        ? `${TMDB_IMAGE_BASE}${item.poster_path}`
                        : null;
                
                const year = tmdb?.release_date ? new Date(tmdb.release_date).getFullYear() : 
                             tmdb?.first_air_date ? new Date(tmdb.first_air_date).getFullYear() : null;
                
                const genres = tmdb?.genres?.slice(0, 2).map(g => g.name).join(' • ');

                return (
                    <motion.div 
                        key={index}
                        initial={{ opacity: 0, x: -30 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.2 + index * 0.1 }}
                        className="w-full"
                    >
                        <AnimatedBorderCard
                            highlightColor={index === 0 ? "255 193 7" : index === 1 ? "148 163 184" : index === 2 ? "180 83 9" : "255 255 255"}
                            backgroundColor="0 0 0" 
                            className={`flex items-center gap-4 p-3 bg-white/5 backdrop-blur-md w-full border border-white/5 transition-transform hover:scale-[1.02] ${index === 0 ? 'bg-amber-500/10 border-amber-500/30' : ''}`}
                        >
                             {/* Rank & Poster Container */}
                             <div className="relative">
                                <div className={`absolute -top-2 -left-2 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shadow-lg z-10 ${
                                    index === 0 ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-black border-2 border-amber-200' :
                                    index === 1 ? 'bg-gradient-to-br from-slate-200 to-slate-400 text-slate-800 border-2 border-slate-100' :
                                    index === 2 ? 'bg-gradient-to-br from-amber-600 to-amber-800 text-white border-2 border-amber-500' :
                                    'bg-white/10 text-white border border-white/20'
                                }`}>
                                    {index + 1}
                                </div>
                                <div className={`relative w-16 h-24 rounded-lg overflow-hidden flex-shrink-0 shadow-xl ${index === 0 ? 'w-20 h-28' : ''}`}>
                                    {posterUrl ? (
                                        <img 
                                            src={posterUrl} 
                                            alt={item.title}
                                            className="w-full h-full object-cover"
                                            loading="lazy"
                                        />
                                    ) : (
                                        <div className="w-full h-full bg-white/5 flex items-center justify-center text-lg">
                                            {item.type === 'anime' ? '⛩️' : item.type === 'movie' ? '🎬' : item.type === 'tv' ? '📺' : '📡'}
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            {/* Metadata */}
                            <div className="flex-1 text-left min-w-0 flex flex-col justify-center h-full">
                                {/* Title */}
                                <p className={`font-bold text-white leading-tight truncate pr-2 ${index === 0 ? 'text-lg text-amber-100' : 'text-base'}`}>
                                    {tmdb?.title || tmdb?.name || item.title}
                                </p>
                                
                                {/* Sub-info line 1: Type + Year */}
                                <div className="flex items-center gap-2 mt-1 text-xs text-white/50">
                                    <span className="uppercase tracking-wider font-medium text-[10px] bg-white/10 px-1.5 py-0.5 rounded">
                                        {item.type === 'movie' ? i18n.t('wrapped.filmType') : item.type === 'tv' ? i18n.t('wrapped.seriesType') : item.type === 'anime' ? i18n.t('wrapped.animeType') : i18n.t('wrapped.tvType')}
                                    </span>
                                    {year && <span>{year}</span>}
                                </div>

                                {/* Sub-info line 2: Genres or Rating */}
                                <div className="flex items-center gap-3 mt-1.5 h-4">
                                    {genres && (
                                        <p className="text-xs text-white/40 truncate max-w-[120px]">
                                            {genres}
                                        </p>
                                    )}
                                    {tmdb?.vote_average && (
                                        <div className="flex items-center gap-1 text-amber-400 text-xs font-medium ml-auto">
                                            <span>★</span>
                                            <span>{tmdb.vote_average.toFixed(1)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Hours Watched Badge */}
                            <div className="flex flex-col items-end justify-center pl-2 border-l border-white/5 min-w-[60px]">
                                <span className={`text-xl font-black ${index === 0 ? 'text-amber-400' : 'text-teal-400'}`}>
                                    {item.durationLabel || formatDurationShort(item.minutes)}
                                </span>
                            </div>
                        </AnimatedBorderCard>
                    </motion.div>
                );
            })}
        </div>
        
        {slide.highlight && (
            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8 }}
                className="mt-4 text-teal-400 font-medium text-sm"
            >
                {slide.highlight}
            </motion.p>
        )}
    </div>
);

const SlidePersona: React.FC<{ slide: WrappedSlide; persona: WrappedData['persona'] }> = ({ slide, persona }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', duration: 1 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                    style={{ background: `radial-gradient(circle, ${persona.color}66 0%, transparent 70%)` }}
                />
                <div
                    className="relative w-36 h-36 md:w-44 md:h-44 rounded-full flex items-center justify-center text-7xl md:text-8xl"
                    style={{
                        background: `linear-gradient(135deg, ${persona.color}40, ${persona.color}20)`,
                        border: `3px solid ${persona.color}80`,
                    }}
                >
                    {persona.emoji}
                </div>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
        >
            <h2 className="text-3xl md:text-5xl font-black mb-3">
                <ShinyText text={persona.title} speed={2} color={persona.color} shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="text-xl md:text-2xl mb-8 font-medium"
            style={{ color: persona.color }}
        >
            {persona.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
        >
            <AnimatedBorderCard
                highlightColor={persona.color.replace('#', '').match(/.{2}/g)?.map(hex => parseInt(hex, 16)).join(' ') || "255 152 0"}
                backgroundColor="0 0 0"
                className="p-8 max-w-xl backdrop-blur-md"
            >
                <p className="text-lg md:text-xl text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                <p className="mt-4 text-white/60 italic">{persona.description}</p>
            </AnimatedBorderCard>
        </motion.div>
    </WrappedCenteredSlide>
);

const SlidePeakMonth: React.FC<{ slide: WrappedSlide; peakMonth: WrappedData['peakMonth'] }> = ({ slide }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(99, 102, 241, 0.60) 0%, transparent 70%)' }}
                />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 flex items-center justify-center shadow-2xl rotate-3">
                    <Calendar className="w-14 h-14 md:w-16 md:h-16 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
        >
            <h2 className="text-4xl md:text-6xl font-black mb-3">
                <ShinyText text={slide.title} speed={2} color="#818cf8" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-xl md:text-2xl text-indigo-300 mb-8 font-semibold"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
        >
            <AnimatedBorderCard
                highlightColor="129 140 248"
                backgroundColor="0 0 0"
                className="p-8 max-w-xl backdrop-blur-md"
            >
                <p className="text-lg md:text-xl text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                {slide.subtext && (
                    <p className="mt-4 text-indigo-400/80 italic">{slide.subtext}</p>
                )}
            </AnimatedBorderCard>
        </motion.div>
    </WrappedCenteredSlide>
);

// ==========================================
// SLIDE: TOP GENRES
// ==========================================
const SlideTopGenres: React.FC<{ slide: WrappedSlide; topGenres?: WrappedData['topGenres'] }> = ({ slide, topGenres }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ scale: 0, rotate: 20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(244, 63, 94, 0.45) 0%, transparent 70%)' }}
                />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-rose-500 via-pink-500 to-fuchsia-600 flex items-center justify-center shadow-2xl -rotate-3">
                    <Music className="w-14 h-14 md:w-16 md:h-16 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <h2 className="text-3xl md:text-5xl font-black mb-3">
                <ShinyText text={slide.title} speed={2} color="#f43f5e" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-lg md:text-xl text-rose-300 mb-6 font-medium">
            {slide.subtitle}
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="w-full max-w-md">
            {topGenres && topGenres.length > 0 && (
                <div className="space-y-3 mb-6">
                    {topGenres.slice(0, 5).map((genre, i) => (
                        <motion.div
                            key={genre.name}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.6 + i * 0.1 }}
                            className="flex items-center gap-3"
                        >
                            <span className="text-sm text-white/60 w-8 text-right font-mono">{genre.percent}%</span>
                            <div className="flex-1 h-8 bg-white/5 rounded-lg overflow-hidden relative">
                                <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: `${genre.percent}%` }}
                                    transition={{ duration: 1, delay: 0.7 + i * 0.1 }}
                                    className="h-full bg-gradient-to-r from-rose-500 to-pink-400 rounded-lg"
                                />
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white text-sm font-medium">{genre.name}</span>
                            </div>
                        </motion.div>
                    ))}
                </div>
            )}
        </motion.div>

        {/* Only show subtext if it mentions genres not already displayed in the bars (top 5) */}
        {slide.subtext && topGenres && topGenres.length > 5 && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }} className="text-rose-400/60 text-sm italic">
                {i18n.t('wrapped.andAlso')}{topGenres.slice(5).map(g => g.name).join(', ')}
            </motion.p>
        )}
    </WrappedCenteredSlide>
);

// ==========================================
// SLIDE: LISTENING CLOCK
// ==========================================
const SlideListeningClock: React.FC<{ slide: WrappedSlide; listeningClock?: WrappedData['listeningClock']; peakHour?: number }> = ({ slide, listeningClock, peakHour }) => {
    const maxMinutes = listeningClock ? Math.max(...listeningClock.map(h => h.minutes)) : 1;
    const hourMarkers = [0, 6, 12, 18, 23];
    
    return (
        <WrappedCenteredSlide contentClassName="max-w-4xl">
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', duration: 0.8 }}
                className="mb-6"
            >
                <div className="relative">
                    <div
                        className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                        style={{ background: 'radial-gradient(circle, rgba(14, 165, 233, 0.45) 0%, transparent 70%)' }}
                    />
                    <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-full bg-gradient-to-br from-sky-500 via-blue-500 to-indigo-600 flex items-center justify-center shadow-2xl">
                        <Clock className="w-14 h-14 md:w-16 md:h-16 text-white" />
                    </div>
                </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                <h2 className="text-3xl md:text-5xl font-black mb-2">
                    <ShinyText text={slide.title} speed={2} color="#38bdf8" shineColor="#ffffff" className="" />
                </h2>
            </motion.div>

            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-lg text-sky-300 mb-6 font-medium">
                {slide.subtitle}
            </motion.p>

            {/* Clock visualization - 24h bar chart */}
            {listeningClock && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="w-full max-w-md"
                >
                    <div className="flex items-end justify-center gap-[2px] h-32 mb-2">
                        {listeningClock.map((h, i) => {
                            const hasActivity = h.minutes > 0;
                            const heightPercent = hasActivity ? Math.max(8, (h.minutes / maxMinutes) * 100) : 0;
                            const isPeak = i === peakHour && hasActivity;
                            const isHigh = h.minutes > maxMinutes * 0.5;
                            const isMedium = h.minutes > maxMinutes * 0.2;
                            
                            return (
                                <motion.div
                                    key={i}
                                    initial={{ height: 0 }}
                                    animate={{ height: hasActivity ? `${heightPercent}%` : '2px' }}
                                    transition={{ duration: 0.6, delay: 0.6 + i * 0.03, type: 'spring', bounce: 0.2 }}
                                    className={`w-2.5 md:w-3 rounded-t-sm transition-colors ${
                                        isPeak 
                                            ? 'bg-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.6)]' 
                                            : isHigh 
                                                ? 'bg-sky-500/80' 
                                                : isMedium
                                                    ? 'bg-sky-500/50'
                                                    : hasActivity
                                                        ? 'bg-sky-500/30'
                                                        : 'bg-white/5'
                                    }`}
                                    title={`${i}${i18n.t('wrapped.hoursShort')}: ${Math.round(h.minutes)}${i18n.t('wrapped.minutesShort')}`}
                                />
                            );
                        })}
                    </div>
                    <div className="flex justify-between text-[10px] text-white/40 px-1 font-mono">
                        {hourMarkers.map((hour) => (
                            <span key={hour}>{hour}{i18n.t('wrapped.hoursShort')}</span>
                        ))}
                    </div>
                </motion.div>
            )}

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2 }} className="mt-4">
                <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="0 0 0" className="p-4 max-w-md backdrop-blur-md">
                    <p className="text-sm md:text-base text-white/80">{slide.text}</p>
                </AnimatedBorderCard>
            </motion.div>
        </WrappedCenteredSlide>
    );
};

// ==========================================
// SLIDE: STREAK
// ==========================================
const SlideStreak: React.FC<{ slide: WrappedSlide; stats: WrappedData['stats'] }> = ({ slide, stats }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ scale: 0, y: -50 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: 'spring', duration: 0.8, bounce: 0.4 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(249, 115, 22, 0.60) 0%, transparent 70%)' }}
                />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-orange-400 via-red-500 to-rose-600 flex items-center justify-center shadow-2xl">
                    <Flame className="w-16 h-16 md:w-20 md:h-20 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <h2 className="text-3xl md:text-5xl font-black mb-2">
                <ShinyText text={slide.title} speed={2} color="#f97316" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="text-lg md:text-xl text-orange-300 mb-6 font-medium">
            {slide.subtitle}
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }}>
            <AnimatedBorderCard highlightColor="249 115 22" backgroundColor="0 0 0" className="p-6 max-w-xl backdrop-blur-md">
                <p className="text-base md:text-lg text-white/90 leading-relaxed">{slide.text}</p>
                {slide.subtext && <p className="mt-3 text-orange-400/70 text-sm italic">{slide.subtext}</p>}
            </AnimatedBorderCard>
        </motion.div>

        {/* Mini stats row */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="mt-6 flex flex-wrap justify-center gap-4 sm:gap-6 md:gap-8"
        >
            {stats.longestStreak && (
                <div className="text-center">
                    <p className="text-2xl font-black text-orange-400">{stats.longestStreak}</p>
                    <p className="text-[10px] text-white/40 uppercase">{i18n.t('wrapped.bestStreak')}</p>
                </div>
            )}
            {stats.totalActiveDays && (
                <div className="text-center">
                    <p className="text-2xl font-black text-white">{stats.totalActiveDays}</p>
                    <p className="text-[10px] text-white/40 uppercase">{i18n.t('wrapped.activeDays')}</p>
                </div>
            )}
            {stats.percentile && (
                <div className="text-center">
                    <p className="text-2xl font-black text-amber-400">Top {100 - stats.percentile}%</p>
                    <p className="text-[10px] text-white/40 uppercase">{i18n.t('wrapped.ofViewers')}</p>
                </div>
            )}
        </motion.div>
    </WrappedCenteredSlide>
);

const SlideFunFact: React.FC<{ slide: WrappedSlide }> = ({ slide }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ rotate: -20, scale: 0 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(16, 185, 129, 0.45) 0%, transparent 70%)' }}
                />
                <span className="relative text-8xl md:text-9xl">{slide.highlight || '💡'}</span>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
        >
            <h2 className="text-3xl md:text-5xl font-black mb-4">
                <ShinyText text={slide.title} speed={2} color="#34d399" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
        >
            <AnimatedBorderCard
                highlightColor="52 211 153"
                backgroundColor="0 0 0"
                className="p-8 max-w-xl backdrop-blur-md"
            >
                <p className="text-lg md:text-xl text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                {slide.subtext && (
                    <p className="mt-4 text-emerald-400/80 italic">{slide.subtext}</p>
                )}
            </AnimatedBorderCard>
        </motion.div>
    </WrappedCenteredSlide>
);

const SlideClosing: React.FC<{
    slide: WrappedSlide;
    stats: WrappedData['stats'];
    onShareImage: () => void;
    onDownloadImage: () => void;
    onShareText: () => void;
    onCopyText: () => void;
    isPreparingImage: boolean;
}> = ({
    slide,
    stats,
    onShareImage,
    onDownloadImage,
    onShareText,
    onCopyText,
    isPreparingImage
}) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-6"
        >
            <motion.div
                animate={{ boxShadow: ['0 0 30px #e879f9', '0 0 60px #e879f9', '0 0 30px #e879f9'] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="relative w-28 h-28 md:w-36 md:h-36 rounded-full bg-gradient-to-br from-fuchsia-500 via-purple-500 to-violet-600 flex items-center justify-center"
            >
                <span className="text-5xl md:text-6xl">{slide.highlight || '💜'}</span>
            </motion.div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
        >
            <h2 className="text-3xl md:text-5xl font-black mb-2">
                <ShinyText text={slide.title} speed={2} color="#e879f9" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-xl md:text-2xl text-fuchsia-300 mb-4 font-semibold"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
        >
            <AnimatedBorderCard
                highlightColor="232 121 249"
                backgroundColor="0 0 0"
                className="p-6 max-w-xl backdrop-blur-md"
            >
                <p className="text-base md:text-lg text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                {slide.subtext && (
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1 }}
                        className="mt-4 text-lg text-fuchsia-400 font-medium"
                    >
                        {slide.subtext}
                    </motion.p>
                )}
            </AnimatedBorderCard>
        </motion.div>

        {/* Stats summary */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="mt-6 flex flex-wrap justify-center gap-4 sm:gap-6 md:gap-8"
        >
            {[
                { value: stats.totalHours > 0 ? stats.totalHours : stats.totalMinutes, label: stats.totalHours > 0 ? i18n.t('wrapped.statHours') : i18n.t('wrapped.statMinutes') },
                { value: stats.uniqueTitles, label: i18n.t('wrapped.statTitles') },
                { value: stats.totalSessions, label: i18n.t('wrapped.statSessions') }
            ].map((stat, i) => (
                <motion.div
                    key={stat.label}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 1.2 + i * 0.1 }}
                    className="text-center"
                >
                    <p className="text-2xl md:text-3xl font-black text-white">
                        <AnimatedCounter value={stat.value} duration={1.5} />
                    </p>
                    <p className="text-fuchsia-400 text-xs">{stat.label}</p>
                </motion.div>
            ))}
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.5 }}
            className="mt-6 w-full max-w-xl"
        >
            <AnimatedBorderCard
                highlightColor="232 121 249"
                backgroundColor="0 0 0"
                className="p-4 md:p-5 backdrop-blur-md"
            >
                <div className="flex items-center justify-center gap-2 mb-2">
                    <Share2 className="w-4 h-4 text-fuchsia-300" />
                    <p className="text-sm md:text-base font-semibold text-white">
                        {i18n.t('wrapped.shareOptionsTitle')}
                    </p>
                </div>
                <p className="text-sm text-white/60 mb-4">
                    {i18n.t('wrapped.shareOptionsDesc')}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={onShareImage}
                        disabled={isPreparingImage}
                        className="flex items-center justify-center gap-2 rounded-2xl border border-fuchsia-400/25 bg-gradient-to-r from-fuchsia-500/20 to-purple-500/20 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
                    >
                        {isPreparingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                        {isPreparingImage ? i18n.t('wrapped.generatingImage') : i18n.t('wrapped.shareAsImage')}
                    </motion.button>

                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={onDownloadImage}
                        disabled={isPreparingImage}
                        className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/90 disabled:opacity-60"
                    >
                        <Download className="w-4 h-4" />
                        {i18n.t('wrapped.downloadImage')}
                    </motion.button>

                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={onShareText}
                        className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/90"
                    >
                        <FileText className="w-4 h-4" />
                        {i18n.t('wrapped.shareAsText')}
                    </motion.button>

                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={onCopyText}
                        className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/90"
                    >
                        <Copy className="w-4 h-4" />
                        {i18n.t('wrapped.copyText')}
                    </motion.button>
                </div>
            </AnimatedBorderCard>
        </motion.div>
    </WrappedCenteredSlide>
);

// ==========================================
// SLIDE DETAILED STATS (Slide 8)
// ==========================================
const SlideDetailedStats: React.FC<{ 
    slide: WrappedSlide; 
    data: WrappedData;
    tmdbData: Map<number, TMDBData>;
}> = ({ slide, data, tmdbData }) => (
    <div 
        className="relative z-10 flex h-full w-full flex-col items-center overflow-y-auto px-4 text-center scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent sm:px-6"
        style={wrappedSlideViewportStyle}
        data-lenis-prevent
        onWheel={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 flex-shrink-0"
        >
            <div className="flex items-center justify-center gap-3 mb-2">
                <BarChart3 className="w-8 h-8 text-cyan-400" />
                <h2 className="text-2xl md:text-3xl font-black">
                    <ShinyText text={slide.title} speed={2} color="#22d3ee" shineColor="#ffffff" className="" />
                </h2>
            </div>
            <p className="text-cyan-300/70">{slide.subtitle}</p>
        </motion.div>

        {/* Time Stats Grid */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="w-full max-w-lg mb-4"
        >
            <div className="grid grid-cols-4 gap-2">
                {[
                    { value: data.stats.totalMinutes.toLocaleString(i18n.language), label: i18n.t('wrapped.minutes') },
                    { value: data.stats.totalHours > 0 ? data.stats.totalHours.toLocaleString(i18n.language) : data.stats.totalMinutes.toLocaleString(i18n.language), label: data.stats.totalHours > 0 ? i18n.t('wrapped.hours') : i18n.t('wrapped.minutes') },
                    { value: data.stats.totalDays.toFixed(1), label: i18n.t('wrapped.days') },
                    { value: (data.stats.totalDays / 7).toFixed(1), label: i18n.t('wrapped.weeks') },
                ].map((stat, i) => (
                    <motion.div
                        key={stat.label}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.2 + i * 0.05 }}
                        className="bg-white/10 rounded-xl p-2"
                    >
                        <p className="text-lg md:text-xl font-black text-white">{stat.value}</p>
                        <p className="text-[10px] text-cyan-400">{stat.label}</p>
                    </motion.div>
                ))}
            </div>
        </motion.div>

        {/* Content Type Breakdown */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="w-full max-w-lg mb-4"
        >
            <h3 className="text-sm font-semibold text-cyan-400 mb-2 text-left">📊 {i18n.t('wrapped.byType')}</h3>
            <div className="space-y-2">
                {data.byType.map((item, i) => (
                    <motion.div
                        key={item.type}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.3 + i * 0.05 }}
                        className="bg-white/10 rounded-lg p-2"
                    >
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-white text-sm font-medium flex items-center gap-1.5">
                                {item.type === 'movie' && '🎬'}
                                {item.type === 'tv' && '📺'}
                                {item.type === 'anime' && '⛩️'}
                                {item.type === 'live-tv' && '📡'}
                                {item.type === 'movie' ? i18n.t('wrapped.moviesLabel') :
                                 item.type === 'tv' ? i18n.t('wrapped.seriesPlural') :
                                   item.type === 'anime' ? i18n.t('wrapped.animeType') : i18n.t('wrapped.liveTVLabel')}
                            </span>
                            <span className="text-white/50 text-xs">{item.count} • {Math.round(item.minutes / 60)}h</span>
                        </div>
                        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${item.percent}%` }}
                                transition={{ duration: 1, delay: 0.4 + i * 0.1 }}
                                className="h-full bg-gradient-to-r from-cyan-500 to-teal-400"
                            />
                        </div>
                    </motion.div>
                ))}
            </div>
        </motion.div>

        {/* Top Content with TMDB Posters */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="w-full max-w-lg mb-4"
        >
            <h3 className="text-sm font-semibold text-cyan-400 mb-2 text-left">🏆 {i18n.t('wrapped.topContents')}</h3>
            <div className="space-y-2">
                {data.topContent.slice(0, 5).map((item, index) => {
                    const tmdb = item.tmdbId ? tmdbData.get(item.tmdbId) : null;
                    const posterUrl = tmdb?.poster_path 
                        ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}` 
                        : item.poster_path 
                            ? `${TMDB_IMAGE_BASE}${item.poster_path}`
                            : null;
                    
                    return (
                        <motion.div
                            key={index}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.5 + index * 0.05 }}
                            className="flex items-center gap-3 bg-white/10 rounded-xl p-2"
                        >
                            {/* Poster */}
                            <div className="relative w-12 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-white/10">
                                {posterUrl ? (
                                    <img 
                                        src={posterUrl} 
                                        alt={item.title}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-2xl">
                                        {item.type === 'movie' ? '🎬' : item.type === 'tv' ? '📺' : item.type === 'anime' ? '⛩️' : '📡'}
                                    </div>
                                )}
                                {/* Rank Badge */}
                                <div className={`absolute -top-1 -left-1 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                                    index === 0 ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-white' :
                                    index === 1 ? 'bg-gradient-to-br from-slate-300 to-slate-400 text-slate-800' :
                                    index === 2 ? 'bg-gradient-to-br from-amber-600 to-amber-700 text-white' :
                                    'bg-white/20 text-white/60'
                                }`}>
                                    {index + 1}
                                </div>
                            </div>
                            
                            {/* Info */}
                            <div className="flex-1 min-w-0 text-left">
                                <p className="font-semibold text-white text-sm truncate">
                                    {tmdb?.title || tmdb?.name || item.title}
                                </p>
                                <div className="flex items-center gap-2 text-xs text-white/40">
                                    <span>
                                        {item.type === 'movie' ? i18n.t('wrapped.movieType') :
                                         item.type === 'tv' ? i18n.t('wrapped.seriesSingular') :
                                         item.type === 'anime' ? i18n.t('wrapped.animeType') : i18n.t('wrapped.tvType')}
                                    </span>
                                    {tmdb?.vote_average && (
                                        <span className="flex items-center gap-0.5">
                                            ⭐ {tmdb.vote_average.toFixed(1)}
                                        </span>
                                    )}
                                </div>
                            </div>
                            
                            {/* Hours */}
                            <div className="text-right">
                                <p className="text-cyan-400 font-bold">{item.durationLabel || formatDurationShort(item.minutes)}</p>
                            </div>
                        </motion.div>
                    );
                })}
            </div>
        </motion.div>

        {/* Bottom Stats */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="w-full max-w-lg grid grid-cols-2 gap-2"
        >
            <div className="bg-white/10 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-white">{data.stats.uniqueTitles}</p>
                <p className="text-xs text-cyan-400">{i18n.t('wrapped.uniqueTitlesLabel')}</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-white">{data.stats.totalSessions}</p>
                <p className="text-xs text-cyan-400">{i18n.t('wrapped.sessionsLabel')}</p>
            </div>
        </motion.div>

        {/* Peak Month */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="w-full max-w-lg mt-4"
        >
            <div className="bg-gradient-to-r from-cyan-500/20 to-teal-500/20 rounded-xl p-3 text-center">
                <p className="text-white/60 text-xs mb-1">{i18n.t('wrapped.mostActiveMonth')}</p>
                <p className="text-xl font-black text-white">{data.peakMonth.name}</p>
                <p className="text-cyan-400 text-sm">{Math.round(data.peakMonth.minutes / 60)} {i18n.t('wrapped.peakMonthHours')}</p>
            </div>
        </motion.div>
    </div>
);

const SlideSessionSummary: React.FC<{
    slide: WrappedSlide;
    stats: WrappedData['stats'];
}> = ({ slide, stats }) => (
    <WrappedCenteredSlide contentClassName="max-w-4xl">
        <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', duration: 0.7 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                    style={{ background: 'radial-gradient(circle, rgba(6, 182, 212, 0.38) 0%, transparent 70%)' }}
                />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-cyan-500 via-sky-500 to-blue-600 flex items-center justify-center shadow-2xl">
                    <Clock className="w-14 h-14 md:w-16 md:h-16 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-3xl md:text-5xl font-black mb-3"
        >
            <ShinyText text={slide.title} speed={2} color="#22d3ee" shineColor="#ffffff" className="" />
        </motion.h2>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.35 }}
            className="text-lg md:text-xl text-cyan-300 mb-6 font-medium"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            className="w-full max-w-3xl grid grid-cols-2 gap-3 md:grid-cols-4"
        >
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-2xl md:text-3xl font-black text-white">
                    {stats.avgSessionMinutes ? formatCompactDuration(stats.avgSessionMinutes, (key, options) => i18n.t(key, options)) : '-'}
                </p>
                <p className="mt-1 text-xs text-cyan-300/80">{i18n.t('wrapped.avgSessionLabel')}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-2xl md:text-3xl font-black text-white">{stats.totalSessions.toLocaleString(i18n.language)}</p>
                <p className="mt-1 text-xs text-cyan-300/80">{i18n.t('wrapped.statSessions')}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-2xl md:text-3xl font-black text-white">{(stats.totalActiveDays || 0).toLocaleString(i18n.language)}</p>
                <p className="mt-1 text-xs text-cyan-300/80">{i18n.t('wrapped.activeDaysLabel')}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-2xl md:text-3xl font-black text-white">
                    {stats.percentile ? i18n.t('wrapped.percentileValue', { percent: Math.max(1, 100 - stats.percentile) }) : '-'}
                </p>
                <p className="mt-1 text-xs text-cyan-300/80">{i18n.t('wrapped.percentileLabel')}</p>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.65 }}
            className="w-full max-w-xl mt-5"
        >
            <AnimatedBorderCard
                highlightColor="34 211 238"
                backgroundColor="0 0 0"
                className="p-6 backdrop-blur-md"
            >
                <p className="text-base md:text-lg text-white/90 leading-relaxed">{slide.text}</p>
            </AnimatedBorderCard>
        </motion.div>
    </WrappedCenteredSlide>
);

const SlideWatchBookends: React.FC<{
    slide: WrappedSlide;
    firstWatch?: WrappedData['firstWatch'];
    lastWatch?: WrappedData['lastWatch'];
}> = ({ slide, firstWatch, lastWatch }) => {
    const formatDateLabel = (date?: string | null) => {
        if (!date) return i18n.t('wrapped.unknownDate');

        try {
            return new Date(date).toLocaleDateString(i18n.language, {
                day: 'numeric',
                month: 'long',
            });
        } catch {
            return i18n.t('wrapped.unknownDate');
        }
    };

    const items = [
        {
            key: 'first',
            label: i18n.t('wrapped.firstWatchLabel'),
            title: firstWatch?.title || i18n.t('wrapped.unknownContent'),
            date: formatDateLabel(firstWatch?.date),
            accent: 'from-emerald-500/25 to-teal-500/10',
        },
        {
            key: 'last',
            label: i18n.t('wrapped.lastWatchLabel'),
            title: lastWatch?.title || i18n.t('wrapped.unknownContent'),
            date: formatDateLabel(lastWatch?.date),
            accent: 'from-fuchsia-500/25 to-purple-500/10',
        },
    ];

    return (
        <WrappedCenteredSlide contentClassName="max-w-4xl">
            <motion.div
                initial={{ scale: 0.82, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', duration: 0.7 }}
                className="mb-8"
            >
                <div className="relative">
                    <div
                        className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                        style={{ background: 'radial-gradient(circle, rgba(16, 185, 129, 0.38) 0%, transparent 70%)' }}
                    />
                    <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-fuchsia-500 flex items-center justify-center shadow-2xl">
                        <Calendar className="w-14 h-14 md:w-16 md:h-16 text-white" />
                    </div>
                </div>
            </motion.div>

            <motion.h2
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-3xl md:text-5xl font-black mb-3"
            >
                <ShinyText text={slide.title} speed={2} color="#34d399" shineColor="#ffffff" className="" />
            </motion.h2>

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 }}
                className="text-lg md:text-xl text-emerald-300 mb-6 font-medium"
            >
                {slide.subtitle}
            </motion.p>

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45 }}
                className="w-full max-w-3xl grid gap-3 md:grid-cols-2"
            >
                {items.map((item, index) => (
                    <motion.div
                        key={item.key}
                        initial={{ opacity: 0, x: index === 0 ? -20 : 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.55 + index * 0.1 }}
                        className={`rounded-3xl border border-white/10 bg-gradient-to-br ${item.accent} p-5 text-left backdrop-blur-md`}
                    >
                        <p className="text-[11px] uppercase tracking-[0.18em] text-white/45 mb-3">{item.label}</p>
                        <p className="text-xl md:text-2xl font-black text-white leading-tight mb-2">{item.title}</p>
                        <p className="text-sm text-white/65">{item.date}</p>
                    </motion.div>
                ))}
            </motion.div>

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 }}
                className="w-full max-w-xl mt-5"
            >
                <AnimatedBorderCard
                    highlightColor="52 211 153"
                    backgroundColor="0 0 0"
                    className="p-6 backdrop-blur-md"
                >
                    <p className="text-base md:text-lg text-white/90 leading-relaxed">{slide.text}</p>
                </AnimatedBorderCard>
            </motion.div>
        </WrappedCenteredSlide>
    );
};

// ==========================================
// SLIDE BACKGROUNDS
// ==========================================
const slideBackgrounds: Record<string, { color: string; gradient: string }> = {
    intro: { color: 'rgba(168, 85, 247, 0.15)', gradient: 'from-purple-500/20 via-transparent to-transparent' },
    top1: { color: 'rgba(251, 191, 36, 0.15)', gradient: 'from-amber-500/20 via-transparent to-transparent' },
    'top2-focus': { color: 'rgba(203, 213, 225, 0.15)', gradient: 'from-slate-300/20 via-transparent to-transparent' },
    'top3-focus': { color: 'rgba(251, 146, 60, 0.15)', gradient: 'from-orange-400/20 via-transparent to-transparent' },
    top5: { color: 'rgba(45, 212, 191, 0.15)', gradient: 'from-teal-500/20 via-transparent to-transparent' },
    persona: { color: 'rgba(255, 152, 0, 0.15)', gradient: 'from-orange-500/20 via-transparent to-transparent' },
    'peak-month': { color: 'rgba(129, 140, 248, 0.15)', gradient: 'from-indigo-500/20 via-transparent to-transparent' },
    'top-genres': { color: 'rgba(244, 63, 94, 0.15)', gradient: 'from-rose-500/20 via-transparent to-transparent' },
    'listening-clock': { color: 'rgba(56, 189, 248, 0.15)', gradient: 'from-sky-500/20 via-transparent to-transparent' },
    'streak': { color: 'rgba(249, 115, 22, 0.15)', gradient: 'from-orange-500/20 via-transparent to-transparent' },
    'fun-fact': { color: 'rgba(52, 211, 153, 0.15)', gradient: 'from-emerald-500/20 via-transparent to-transparent' },
    'session-summary': { color: 'rgba(34, 211, 238, 0.15)', gradient: 'from-cyan-500/20 via-transparent to-transparent' },
    'watch-bookends': { color: 'rgba(52, 211, 153, 0.15)', gradient: 'from-emerald-500/20 via-transparent to-transparent' },
    closing: { color: 'rgba(232, 121, 249, 0.15)', gradient: 'from-fuchsia-500/20 via-transparent to-transparent' },
    'detailed-stats': { color: 'rgba(34, 211, 238, 0.15)', gradient: 'from-cyan-500/20 via-transparent to-transparent' },
};

// ==========================================
// MAIN WRAPPED PAGE COMPONENT
// ==========================================
const WrappedPage: React.FC = () => {
    const navigate = useNavigate();
    const { year: yearParam } = useParams<{ year?: string }>();
    const { t } = useTranslation();
    const [wrappedData, setWrappedData] = useState<WrappedData | null>(null);
    const [loading, setLoading] = useState(true);
    const [currentSlide, setCurrentSlide] = useState(0);
    const [direction, setDirection] = useState(0);
    const [tmdbData, setTmdbData] = useState<Map<number, TMDBData>>(new Map());
    const [noData, setNoData] = useState(false);
    const [wrappedProgress, setWrappedProgress] = useState<WrappedProgress | null>(null);
    const [isPreparingShareImage, setIsPreparingShareImage] = useState(false);
    const [isPodiumTrailerLoaded, setIsPodiumTrailerLoaded] = useState(false);
    const bgMode = (localStorage.getItem('settings_bg_mode') as 'combined' | 'static' | 'animated') || 'combined';
    const hasWrappedAccount = Boolean(localStorage.getItem('auth_token'));
    const dataCollectionEnabled = localStorage.getItem('privacy_data_collection') !== 'false';

    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();
    const topWrappedItem = wrappedData?.topContent[0];
    const topWrappedGenre = wrappedData?.topGenres?.[0];
    const formattedShareWatchTime = wrappedData ? formatCompactDuration(wrappedData.stats.totalMinutes, t) : '';
    const [soundEffectsEnabled, setSoundEffectsEnabled] = useState(() => areSoundEffectsEnabled());
    const [hasWrappedInteraction, setHasWrappedInteraction] = useState(false);

    const wrappedShareText = useMemo(() => {
        if (!wrappedData) return '';

        return [
            t('wrapped.shareTitle', { year }),
            t('wrapped.shareSummaryLine', { watchTime: formattedShareWatchTime }),
            t('wrapped.shareTitlesLine', { count: wrappedData.stats.uniqueTitles }),
            topWrappedItem ? t('wrapped.shareTopContentLine', { title: topWrappedItem.title }) : null,
            topWrappedGenre ? t('wrapped.shareTopGenreLine', { genre: topWrappedGenre.name }) : null,
            wrappedData.persona?.title ? t('wrapped.sharePersonaLine', { persona: wrappedData.persona.title }) : null,
            t('wrapped.shareHashtag')
        ].filter(Boolean).join('\n');
    }, [formattedShareWatchTime, topWrappedGenre, topWrappedItem, wrappedData, t, year]);

    useEffect(() => {
        const syncSoundSetting = () => setSoundEffectsEnabled(areSoundEffectsEnabled());

        window.addEventListener(SOUND_EFFECTS_CHANGED_EVENT, syncSoundSetting as EventListener);
        window.addEventListener('storage', syncSoundSetting);

        return () => {
            window.removeEventListener(SOUND_EFFECTS_CHANGED_EVENT, syncSoundSetting as EventListener);
            window.removeEventListener('storage', syncSoundSetting);
        };
    }, []);

    useEffect(() => {
        if (hasWrappedInteraction) return;

        const markInteraction = () => setHasWrappedInteraction(true);

        window.addEventListener('pointerdown', markInteraction, { passive: true });
        window.addEventListener('keydown', markInteraction);

        return () => {
            window.removeEventListener('pointerdown', markInteraction);
            window.removeEventListener('keydown', markInteraction);
        };
    }, [hasWrappedInteraction]);

    // Wrapped needs an authenticated account to load personalized data.
    if (!hasWrappedAccount) {
        return (
            <WrappedStandaloneShell mode={bgMode}>
                <div className="mb-5 flex justify-start sm:mb-8">
                    <button
                        onClick={() => navigate(-1)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 backdrop-blur-lg transition-colors hover:bg-white/10"
                    >
                        <X className="w-5 h-5 text-white" />
                    </button>
                </div>

                <div className="flex flex-1 flex-col items-center justify-start pb-6 text-center md:justify-center">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', duration: 0.8 }}
                        className="mb-6 scale-75 sm:mb-8 sm:scale-100"
                    >
                        <div className="relative">
                            <div
                                className="absolute inset-0 scale-150 rounded-full pointer-events-none"
                                style={{ background: 'radial-gradient(circle, rgba(139, 92, 246, 0.38) 0%, transparent 70%)' }}
                            />
                            <LogIn className="relative h-16 w-16 text-violet-300 sm:h-20 sm:w-20" />
                        </div>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                        className="mb-4 max-w-2xl text-2xl font-black text-white sm:text-3xl md:text-4xl"
                    >
                        {t('wrapped.loginRequired')}
                    </motion.h1>

                    <motion.p
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4 }}
                        className="mb-8 max-w-lg text-sm leading-relaxed text-gray-400 sm:text-base md:text-lg"
                    >
                        {t('wrapped.loginRequiredDesc')}
                    </motion.p>

                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6 }}
                        className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center"
                    >
                        <button
                            onClick={() => navigate('/login-bip39')}
                            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-white transition-colors hover:bg-purple-500 sm:min-w-[180px] sm:w-auto"
                        >
                            <LogIn className="w-4 h-4" />
                            {t('wrapped.loginAction')}
                        </button>

                        <button
                            onClick={() => navigate('/create-account')}
                            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 py-3 text-white transition-colors hover:bg-white/10 sm:min-w-[180px] sm:w-auto"
                        >
                            <UserPlus className="w-4 h-4" />
                            {t('wrapped.createAccountAction')}
                        </button>
                    </motion.div>
                </div>
            </WrappedStandaloneShell>
        );
    }

    // Block access if data collection is disabled
    if (!dataCollectionEnabled) {
        return (
            <WrappedStandaloneShell mode={bgMode}>
                <div className="mb-5 flex justify-start sm:mb-8">
                    <button
                        onClick={() => navigate(-1)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 backdrop-blur-lg transition-colors hover:bg-white/10"
                    >
                        <X className="w-5 h-5 text-white" />
                    </button>
                </div>

                <div className="flex flex-1 flex-col items-center justify-start pb-6 text-center md:justify-center">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', duration: 0.8 }}
                        className="mb-6 scale-75 sm:mb-8 sm:scale-100"
                    >
                        <div className="relative">
                            <div
                                className="absolute inset-0 scale-150 rounded-full pointer-events-none"
                                style={{ background: 'radial-gradient(circle, rgba(239, 68, 68, 0.30) 0%, transparent 70%)' }}
                            />
                            <ShieldOff className="relative h-16 w-16 text-red-400 sm:h-20 sm:w-20" />
                        </div>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                        className="mb-4 max-w-2xl text-2xl font-black text-white sm:text-3xl md:text-4xl"
                    >
                        {t('wrapped.dataCollectionDisabled')}
                    </motion.h1>

                    <motion.p
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4 }}
                        className="mb-8 max-w-lg text-sm leading-relaxed text-gray-400 sm:text-base md:text-lg"
                    >
                        {t('wrapped.dataCollectionDisabledDesc')}
                    </motion.p>

                    <motion.button
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6 }}
                        onClick={() => navigate('/settings')}
                        className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-white transition-colors hover:bg-purple-500 sm:w-auto"
                    >
                        <Settings className="w-4 h-4" />
                        {t('wrapped.goToSettings')}
                    </motion.button>
                </div>
            </WrappedStandaloneShell>
        );
    }

    // Fetch TMDB data for top content
    const fetchTMDBData = useCallback(async (topContent: WrappedTopContent[]) => {
        const newTmdbData = new Map<number, TMDBData>();
        
        const fetchPromises = topContent.map(async (item, index) => {
            if (!item.tmdbId) return;
            
            try {
                const mediaType = item.type === 'tv' || item.type === 'anime' ? 'tv' : 'movie';
                const response = await axios.get(
                    `https://api.themoviedb.org/3/${mediaType}/${item.tmdbId}`,
                    { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } }
                );
                const data: TMDBData = response.data;

                // Fetch trailer for the podium items so the background video can follow top 1, 2 and 3.
                if (index < 3) {
                    try {
                        const videosRes = await axios.get(
                            `https://api.themoviedb.org/3/${mediaType}/${item.tmdbId}/videos`,
                            { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } }
                        );
                        let trailer = videosRes.data.results?.find(
                            (v: any) => v.site === 'YouTube' && v.type === 'Trailer'
                        );
                        // Fallback: try English trailers
                        if (!trailer) {
                            const videosResEN = await axios.get(
                                `https://api.themoviedb.org/3/${mediaType}/${item.tmdbId}/videos`,
                                { params: { api_key: TMDB_API_KEY, language: 'en-US' } }
                            );
                            trailer = videosResEN.data.results?.find(
                                (v: any) => v.site === 'YouTube' && v.type === 'Trailer'
                            );
                            // Last fallback: any YouTube video (teaser, clip, etc.)
                            if (!trailer) {
                                trailer = videosResEN.data.results?.find(
                                    (v: any) => v.site === 'YouTube'
                                );
                            }
                        }
                        data.trailerKey = trailer?.key || null;
                    } catch {
                        data.trailerKey = null;
                    }
                }

                newTmdbData.set(item.tmdbId, data);
            } catch (error) {
                console.error(`[Wrapped] Error fetching TMDB data for ${item.tmdbId}:`, error);
            }
        });

        await Promise.all(fetchPromises);
        setTmdbData(newTmdbData);
    }, []);

    useEffect(() => {
        const loadWrapped = async () => {
            setLoading(true);

            const response = await fetchWrappedData(year);

            if (response.success && response.wrapped) {
                // Hotfix: Ensure detailed-stats slide exists if backend doesn't send it yet
                const hasStats = response.wrapped.slides.some((s: WrappedSlide) => s.type === 'detailed-stats');
                if (!hasStats) {
                    const closingIndex = response.wrapped.slides.findIndex((s: WrappedSlide) => s.type === 'closing');
                    const statsSlide: WrappedSlide = {
                        type: "detailed-stats",
                        title: t('wrapped.yourStatistics'),
                        subtitle: t('wrapped.inDetail'),
                        text: t('wrapped.yearSummary'),
                        highlight: "📊",
                        subtext: ""
                    };
                    
                    if (closingIndex !== -1) {
                        response.wrapped.slides.splice(closingIndex, 0, statsSlide);
                    } else {
                        response.wrapped.slides.push(statsSlide);
                    }
                }

                const top1Index = response.wrapped.slides.findIndex((s: WrappedSlide) => s.type === 'top1');
                const hasTop2Focus = response.wrapped.slides.some((s: WrappedSlide) => s.type === 'top2-focus');
                const hasTop3Focus = response.wrapped.slides.some((s: WrappedSlide) => s.type === 'top3-focus');
                const podiumSlides: WrappedSlide[] = [];

                if (!hasTop3Focus && response.wrapped.topContent[2]) {
                    const item = response.wrapped.topContent[2];
                    podiumSlides.push({
                        type: 'top3-focus',
                        title: item.title,
                        subtitle: t('wrapped.top3FocusSubtitle'),
                        text: t('wrapped.podiumFocusText', {
                            watchTime: formatCompactDuration(item.minutes, t),
                            type: formatWrappedTypeLabel(item.type, t),
                        }),
                        subtext: t('wrapped.top3FocusSubtext'),
                    });
                }

                if (!hasTop2Focus && response.wrapped.topContent[1]) {
                    const item = response.wrapped.topContent[1];
                    podiumSlides.push({
                        type: 'top2-focus',
                        title: item.title,
                        subtitle: t('wrapped.top2FocusSubtitle'),
                        text: t('wrapped.podiumFocusText', {
                            watchTime: formatCompactDuration(item.minutes, t),
                            type: formatWrappedTypeLabel(item.type, t),
                        }),
                        subtext: t('wrapped.top2FocusSubtext'),
                    });
                }

                if (podiumSlides.length > 0 && top1Index !== -1) {
                    response.wrapped.slides.splice(top1Index, 0, ...podiumSlides);
                }

                const bonusSlides: WrappedSlide[] = [];
                const hasSessionSummary = response.wrapped.slides.some((s: WrappedSlide) => s.type === 'session-summary');
                const hasWatchBookends = response.wrapped.slides.some((s: WrappedSlide) => s.type === 'watch-bookends');

                if (!hasSessionSummary) {
                    bonusSlides.push({
                        type: 'session-summary',
                        title: t('wrapped.sessionSummaryTitle'),
                        subtitle: t('wrapped.sessionSummarySubtitle'),
                        text: t('wrapped.sessionSummaryText', {
                            average: formatCompactDuration(response.wrapped.stats.avgSessionMinutes || 0, t),
                            activeDays: (response.wrapped.stats.totalActiveDays || 0).toLocaleString(i18n.language),
                        }),
                    });
                }

                if (!hasWatchBookends && (response.wrapped.firstWatch || response.wrapped.lastWatch)) {
                    bonusSlides.push({
                        type: 'watch-bookends',
                        title: t('wrapped.watchBookendsTitle'),
                        subtitle: t('wrapped.watchBookendsSubtitle'),
                        text: t('wrapped.watchBookendsText', {
                            first: response.wrapped.firstWatch?.title || t('wrapped.unknownContent'),
                            last: response.wrapped.lastWatch?.title || t('wrapped.unknownContent'),
                        }),
                    });
                }

                if (bonusSlides.length > 0) {
                    const top5Index = response.wrapped.slides.findIndex((s: WrappedSlide) => s.type === 'top5');
                    const insertIndex = top5Index !== -1
                        ? top5Index + 1
                        : response.wrapped.slides.findIndex((s: WrappedSlide) => s.type === 'persona');

                    if (insertIndex !== -1) {
                        response.wrapped.slides.splice(insertIndex, 0, ...bonusSlides);
                    } else {
                        response.wrapped.slides.push(...bonusSlides);
                    }
                }

                setWrappedData(response.wrapped);
                setWrappedProgress(response.progress ?? null);
                setNoData(false);
                // Fetch TMDB data for posters
                fetchTMDBData(response.wrapped.topContent);
            } else {
                // No data available for this user/year
                setWrappedData(null);
                setWrappedProgress(response.progress ?? null);
                setNoData(true);
            }

            setLoading(false);
        };

        loadWrapped();
    }, [year, fetchTMDBData]);

    const goToSlide = useCallback((index: number) => {
        if (!wrappedData) return;
        const newIndex = Math.max(0, Math.min(index, wrappedData.slides.length - 1));
        setDirection(newIndex > currentSlide ? 1 : -1);
        setCurrentSlide(newIndex);
    }, [currentSlide, wrappedData]);

    const nextSlide = useCallback(() => {
        if (!wrappedData) return;
        if (currentSlide < wrappedData.slides.length - 1) {
            setDirection(1);
            setCurrentSlide(prev => prev + 1);
        }
    }, [currentSlide, wrappedData]);

    const prevSlide = useCallback(() => {
        if (currentSlide > 0) {
            setDirection(-1);
            setCurrentSlide(prev => prev - 1);
        }
    }, [currentSlide]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowRight' || e.key === ' ') {
                e.preventDefault();
                nextSlide();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                prevSlide();
            } else if (e.key === 'Escape') {
                navigate(-1);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [nextSlide, prevSlide, navigate]);

    const handleDragEnd = (_: any, info: PanInfo) => {
        const threshold = 50;
        if (info.offset.x < -threshold) nextSlide();
        else if (info.offset.x > threshold) prevSlide();
    };

    const generateWrappedShareImage = useCallback(async (): Promise<Blob | null> => {
        if (!wrappedData) return null;

        const canvas = document.createElement('canvas');
        canvas.width = WRAPPED_SHARE_IMAGE_WIDTH;
        canvas.height = WRAPPED_SHARE_IMAGE_HEIGHT;

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        const width = canvas.width;
        const height = canvas.height;

        const exportTopItems = wrappedData.topContent.slice(0, 3);
        const exportTopAssets = await Promise.all(exportTopItems.map(async (item) => {
            const tmdb = item.tmdbId ? tmdbData.get(item.tmdbId) : null;
            const posterSource = tmdb?.poster_path
                ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}`
                : item.poster_path
                    ? `${TMDB_IMAGE_BASE}${item.poster_path}`
                    : null;
            const backdropSource = tmdb?.backdrop_path
                ? `${TMDB_IMAGE_BASE}${tmdb.backdrop_path}`
                : null;

            return {
                item,
                tmdb,
                posterImage: posterSource ? await loadCanvasImage(posterSource) : null,
                backdropImage: backdropSource ? await loadCanvasImage(backdropSource) : null,
            };
        }));

        const topAsset = exportTopAssets[0] ?? null;
        const topItem = topAsset?.item || topWrappedItem;
        const posterImage = topAsset?.posterImage || null;
        const backdropImage = topAsset?.backdropImage || null;
        const topTypeLabel = topItem ? formatWrappedTypeLabel(topItem.type, t) : t('wrapped.movieType');

        const getTypeInitial = (type?: WrappedTopContent['type']) => {
            if (type === 'tv') return t('wrapped.seriesSingular').charAt(0).toUpperCase();
            if (type === 'anime') return t('wrapped.animeType').charAt(0).toUpperCase();
            return t('wrapped.movieType').charAt(0).toUpperCase();
        };

        const fillCenteredText = (text: string, y: number) => {
            ctx.fillText(text, (width - ctx.measureText(text).width) / 2, y);
        };

        const fillTextCenteredInArea = (text: string, x: number, areaWidth: number, y: number) => {
            ctx.fillText(text, x + (areaWidth - ctx.measureText(text).width) / 2, y);
        };

        const drawPill = (
            x: number,
            y: number,
            text: string,
            {
                fill,
                textColor,
                paddingX = 22,
                height: pillHeight = 42,
                font = '800 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                stroke,
            }: {
                fill: string | CanvasGradient;
                textColor: string | CanvasGradient;
                paddingX?: number;
                height?: number;
                font?: string;
                stroke?: string;
            }
        ) => {
            ctx.save();
            ctx.font = font;
            const pillWidth = Math.ceil(ctx.measureText(text).width + paddingX * 2);
            drawRoundedRectPath(ctx, x, y, pillWidth, pillHeight, pillHeight / 2);
            ctx.fillStyle = fill;
            ctx.fill();
            if (stroke) {
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            ctx.fillStyle = textColor;
            ctx.fillText(text, x + paddingX, y + pillHeight - 13);
            ctx.restore();
            return pillWidth;
        };

        const drawPosterCard = ({
            x,
            y,
            w,
            h,
            rotation,
            image,
            fallbackLabel,
            rank,
            borderColor,
            chipFill,
            chipTextColor,
            withMeta,
        }: {
            x: number;
            y: number;
            w: number;
            h: number;
            rotation: number;
            image: HTMLImageElement | null;
            fallbackLabel: string;
            rank: string;
            borderColor: string;
            chipFill: string;
            chipTextColor: string;
            withMeta?: boolean;
        }) => {
            ctx.save();
            ctx.translate(x + w / 2, y + h / 2);
            ctx.rotate(rotation);

            ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
            ctx.shadowBlur = 48;
            ctx.shadowOffsetY = 24;
            drawRoundedRectPath(ctx, -w / 2, -h / 2, w, h, 34);
            ctx.fillStyle = 'rgba(14, 14, 18, 0.94)';
            ctx.fill();

            ctx.shadowColor = 'transparent';
            drawRoundedRectPath(ctx, -w / 2, -h / 2, w, h, 34);
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 3;
            ctx.stroke();

            if (image) {
                ctx.save();
                drawRoundedRectPath(ctx, -w / 2 + 10, -h / 2 + 10, w - 20, h - 20, 26);
                ctx.clip();
                ctx.drawImage(image, -w / 2 + 10, -h / 2 + 10, w - 20, h - 20);
                ctx.restore();

                const overlayGradient = ctx.createLinearGradient(0, h / 2 - 140, 0, h / 2);
                overlayGradient.addColorStop(0, 'rgba(0,0,0,0)');
                overlayGradient.addColorStop(1, 'rgba(0,0,0,0.85)');
                drawRoundedRectPath(ctx, -w / 2 + 10, -h / 2 + 10, w - 20, h - 20, 26);
                ctx.fillStyle = overlayGradient;
                ctx.fill();
            } else {
                const fallbackGradient = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
                fallbackGradient.addColorStop(0, 'rgba(255, 93, 93, 0.55)');
                fallbackGradient.addColorStop(0.5, 'rgba(255, 159, 67, 0.35)');
                fallbackGradient.addColorStop(1, 'rgba(78, 205, 196, 0.3)');
                drawRoundedRectPath(ctx, -w / 2 + 10, -h / 2 + 10, w - 20, h - 20, 26);
                ctx.fillStyle = fallbackGradient;
                ctx.fill();

                ctx.fillStyle = '#ffffff';
                ctx.font = `${withMeta ? '900 118px' : '900 68px'} system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
                const letterWidth = ctx.measureText(fallbackLabel).width;
                ctx.fillText(fallbackLabel, -letterWidth / 2, withMeta ? 34 : 24);
            }

            drawRoundedRectPath(ctx, -w / 2 + 18, -h / 2 + 18, 82, 42, 21);
            ctx.fillStyle = chipFill;
            ctx.fill();
            ctx.fillStyle = chipTextColor;
            ctx.font = '900 24px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            ctx.fillText(rank, -w / 2 + 44, -h / 2 + 46);

            if (withMeta) {
                drawRoundedRectPath(ctx, -w / 2 + 20, h / 2 - 126, w - 40, 94, 24);
                ctx.fillStyle = 'rgba(10, 10, 12, 0.86)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.08)';
                ctx.lineWidth = 1.5;
                ctx.stroke();

                ctx.fillStyle = 'rgba(255,255,255,0.82)';
                ctx.font = '700 20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                fillTextCenteredInArea(topTypeLabel, -w / 2 + 20, w - 40, h / 2 - 88);

                ctx.fillStyle = '#ffffff';
                ctx.font = '900 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                fillTextCenteredInArea(topItem ? formatCompactDuration(topItem.minutes, t) : formattedShareWatchTime, -w / 2 + 20, w - 40, h / 2 - 46);
            }

            ctx.restore();
        };

        const accentGradient = ctx.createLinearGradient(0, 0, width, 0);
        accentGradient.addColorStop(0, '#ff5f56');
        accentGradient.addColorStop(0.5, '#ff7a59');
        accentGradient.addColorStop(1, '#f6c453');

        const titleGradient = ctx.createLinearGradient(100, 0, width - 100, 0);
        titleGradient.addColorStop(0, '#ffffff');
        titleGradient.addColorStop(0.35, '#ffd7d1');
        titleGradient.addColorStop(1, '#ff7a59');

        ctx.fillStyle = '#060606';
        ctx.fillRect(0, 0, width, height);

        if (backdropImage) {
            const targetHeight = 1100;
            const scale = Math.max(width / backdropImage.width, targetHeight / backdropImage.height);
            const drawWidth = backdropImage.width * scale;
            const drawHeight = backdropImage.height * scale;
            const drawX = (width - drawWidth) / 2;
            const drawY = 120;
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.drawImage(backdropImage, drawX, drawY, drawWidth, drawHeight);
            ctx.restore();
        }

        const baseGradient = ctx.createLinearGradient(0, 0, width, height);
        baseGradient.addColorStop(0, '#0a0a0a');
        baseGradient.addColorStop(0.42, '#111112');
        baseGradient.addColorStop(1, '#090909');
        ctx.fillStyle = baseGradient;
        ctx.fillRect(0, 0, width, height);

        const topGlow = ctx.createRadialGradient(width * 0.5, 240, 20, width * 0.5, 240, 460);
        topGlow.addColorStop(0, 'rgba(255, 95, 86, 0.28)');
        topGlow.addColorStop(0.55, 'rgba(255, 95, 86, 0.12)');
        topGlow.addColorStop(1, 'rgba(255, 95, 86, 0)');
        ctx.fillStyle = topGlow;
        ctx.fillRect(0, 0, width, height);

        const sideGlow = ctx.createRadialGradient(width * 0.82, height * 0.78, 40, width * 0.82, height * 0.78, 440);
        sideGlow.addColorStop(0, 'rgba(78, 205, 196, 0.18)');
        sideGlow.addColorStop(1, 'rgba(78, 205, 196, 0)');
        ctx.fillStyle = sideGlow;
        ctx.fillRect(0, 0, width, height);

        const lowerGlow = ctx.createRadialGradient(width * 0.2, height * 0.82, 20, width * 0.2, height * 0.82, 360);
        lowerGlow.addColorStop(0, 'rgba(246, 196, 83, 0.14)');
        lowerGlow.addColorStop(1, 'rgba(246, 196, 83, 0)');
        ctx.fillStyle = lowerGlow;
        ctx.fillRect(0, 0, width, height);

        for (let i = 0; i < 7; i += 1) {
            const y = 214 + i * 196;
            ctx.strokeStyle = 'rgba(255,255,255,0.035)';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(90, y);
            ctx.lineTo(width - 90, y);
            ctx.stroke();
        }

        for (let i = 0; i < 26; i += 1) {
            const dotX = 40 + ((i * 149) % (width - 80));
            const dotY = 60 + ((i * 211) % (height - 120));
            ctx.fillStyle = `rgba(255,255,255,${i % 5 === 0 ? 0.1 : 0.05})`;
            ctx.beginPath();
            ctx.arc(dotX, dotY, i % 4 === 0 ? 2 : 1.1, 0, Math.PI * 2);
            ctx.fill();
        }

        for (let i = 0; i < 40; i++) {
            const isPopcorn = Math.random() > 0.5;
            const x = Math.random() * 1080;
            const y = Math.random() * 1920;
            const scale = 1.0 + Math.random() * 1.5;
            const rotation = Math.random() * Math.PI * 2;
            const opacity = 0.05 + Math.random() * 0.15;
            const colors = ['#4ecdc4', '#ff7a59', '#f6c453', '#ff5f56'];
            const accent = colors[Math.floor(Math.random() * colors.length)];
            
            if (isPopcorn) {
                drawPopcornSticker(ctx, {
                    x, y, scale, rotation, opacity,
                    fillLevel: 0.3 + Math.random() * 0.7,
                    accent
                });
            } else {
                drawClapperSticker(ctx, {
                    x, y, scale, rotation, opacity,
                    accent
                });
            }
        }

        const brandIconX = 280;
        const brandIconY = 86;
        ctx.strokeStyle = '#ff5f56';
        ctx.lineWidth = 7;
        drawRoundedRectPath(ctx, brandIconX, brandIconY, 54, 38, 12);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(297, brandIconY);
        ctx.lineTo(307, brandIconY - 10);
        ctx.moveTo(319, brandIconY);
        ctx.lineTo(307, brandIconY - 10);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = '900 54px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText('MOVIX', 356, 122);
        ctx.fillStyle = accentGradient;
        ctx.fillText('Wrapped', 557, 122);

        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 3;
        ctx.font = '900 184px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.strokeText(String(year), (width - ctx.measureText(String(year)).width) / 2, 268);
        ctx.restore();

        ctx.fillStyle = 'rgba(255,255,255,0.52)';
        ctx.font = '800 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        fillCenteredText(`MOVIX WRAPPED ${year}`, 188);

        ctx.fillStyle = '#ffffff';
        ctx.font = '900 68px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        fillCenteredText(`Ton top ${year}`, 284);

        ctx.fillStyle = titleGradient;
        ctx.font = '900 88px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const mainTitleLines = wrapCanvasText(ctx, topItem?.title || t('wrapped.title'), 860).slice(0, 2);
        mainTitleLines.forEach((line, index) => {
            fillCenteredText(line, 386 + index * 92);
        });

        const chips = [
            { text: topItem ? formatCompactDuration(topItem.minutes, t) : formattedShareWatchTime, fill: 'rgba(255,95,86,0.18)', textColor: '#ff9e94', stroke: 'rgba(255,95,86,0.35)' },
            { text: topTypeLabel, fill: 'rgba(255,255,255,0.08)', textColor: '#ffffff', stroke: 'rgba(255,255,255,0.12)' },
            { text: '#1', fill: 'rgba(246,196,83,0.2)', textColor: '#f6c453', stroke: 'rgba(246,196,83,0.35)' },
        ];

        ctx.font = '800 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const chipWidths = chips.map(({ text }) => Math.ceil(ctx.measureText(text).width + 44));
        const totalChipWidth = chipWidths.reduce((sum, item) => sum + item, 0) + (chips.length - 1) * 14;
        let chipX = (width - totalChipWidth) / 2;
        const chipY = 468;
        chips.forEach((chip, index) => {
            const usedWidth = drawPill(chipX, chipY, chip.text, {
                fill: chip.fill,
                textColor: chip.textColor,
                stroke: chip.stroke,
            });
            chipX += usedWidth + (index < chips.length - 1 ? 14 : 0);
        });

        drawPosterCard({
            x: 212,
            y: 694,
            w: 224,
            h: 334,
            rotation: -0.14,
            image: exportTopAssets[1]?.posterImage || null,
            fallbackLabel: getTypeInitial(exportTopAssets[1]?.item.type),
            rank: '#2',
            borderColor: 'rgba(246,196,83,0.8)',
            chipFill: '#f6c453',
            chipTextColor: '#181818',
        });

        drawPosterCard({
            x: 634,
            y: 694,
            w: 224,
            h: 334,
            rotation: 0.14,
            image: exportTopAssets[2]?.posterImage || null,
            fallbackLabel: getTypeInitial(exportTopAssets[2]?.item.type),
            rank: '#3',
            borderColor: 'rgba(78,205,196,0.78)',
            chipFill: '#4ecdc4',
            chipTextColor: '#0f1212',
        });

        drawPosterCard({
            x: 334,
            y: 556,
            w: 412,
            h: 612,
            rotation: -0.035,
            image: posterImage,
            fallbackLabel: getTypeInitial(topItem?.type),
            rank: '#1',
            borderColor: 'rgba(255,122,89,0.96)',
            chipFill: '#ff7a59',
            chipTextColor: '#190d0b',
            withMeta: true,
        });

        ctx.fillStyle = 'rgba(255,255,255,0.74)';
        ctx.font = '700 22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        fillCenteredText(t('wrapped.top3FocusSubtitle'), 1234);

        const statsBoxes = [
            {
                label: wrappedData.stats.totalHours > 0 ? t('wrapped.statHours') : t('wrapped.statMinutes'),
                value: wrappedData.stats.totalHours > 0 ? wrappedData.stats.totalHours.toLocaleString(i18n.language) : wrappedData.stats.totalMinutes.toLocaleString(i18n.language),
                accent: '#ff7a59',
            },
            { label: t('wrapped.statTitles'), value: wrappedData.stats.uniqueTitles.toLocaleString(i18n.language), accent: '#f6c453' },
            { label: t('wrapped.statSessions'), value: wrappedData.stats.totalSessions.toLocaleString(i18n.language), accent: '#4ecdc4' }
        ];

        statsBoxes.forEach((stat, index) => {
            const boxWidth = 286;
            const gap = 31;
            const x = 80 + index * (boxWidth + gap);
            const y = 1268;
            drawRoundedRectPath(ctx, x, y, boxWidth, 154, 30);
            ctx.fillStyle = 'rgba(17, 17, 20, 0.92)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.lineWidth = 2;
            ctx.stroke();

            drawRoundedRectPath(ctx, x + 20, y + 18, 60, 8, 4);
            ctx.fillStyle = stat.accent;
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = '900 58px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            ctx.fillText(stat.value, x + 24, y + 86);

            ctx.fillStyle = 'rgba(255,255,255,0.52)';
            ctx.font = '800 18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            ctx.fillText(stat.label.toUpperCase(), x + 24, y + 124);
        });

        ctx.fillStyle = '#ffffff';
        ctx.font = '800 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(t('wrapped.shareSnapshotTitle'), 78, 1496);

        const snapshotTiles = [
            { label: t('wrapped.sharePersonaLabel'), value: wrappedData.persona.title, accent: '#ff7a59' },
            { label: t('wrapped.shareGenreLabel'), value: topWrappedGenre?.name || t('wrapped.shareGenreFallback'), accent: '#f6c453' },
            { label: t('wrapped.sharePeakMonthLabel'), value: wrappedData.peakMonth.name, accent: '#4ecdc4' },
            { label: t('wrapped.shareWatchTimeLabel'), value: formattedShareWatchTime, accent: '#ffffff' }
        ];

        const snapshotTileStartY = 1528;
        const snapshotTileHeight = 136;
        const snapshotTileGapY = 28;
        const snapshotBottomY = snapshotTileStartY + snapshotTileHeight * 2 + snapshotTileGapY;
        const footerDividerY = snapshotBottomY + 32;
        const footerTextY = footerDividerY + 42;

        snapshotTiles.forEach((tile, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const tileX = 78 + col * 462;
            const tileY = snapshotTileStartY + row * (snapshotTileHeight + snapshotTileGapY);
            const tileWidth = 384;
            const tileHeight = snapshotTileHeight;

            drawRoundedRectPath(ctx, tileX, tileY, tileWidth, tileHeight, 28);
            ctx.fillStyle = 'rgba(16,16,18,0.92)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.lineWidth = 2;
            ctx.stroke();

            drawRoundedRectPath(ctx, tileX + 20, tileY + 20, 70, 8, 4);
            ctx.fillStyle = tile.accent;
            ctx.fill();

            ctx.fillStyle = 'rgba(255,255,255,0.48)';
            ctx.font = '800 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            ctx.fillText(tile.label.toUpperCase(), tileX + 20, tileY + 56);

            ctx.fillStyle = '#ffffff';
            ctx.font = '800 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            const tileLines = wrapCanvasText(ctx, tile.value, tileWidth - 40).slice(0, 2);
            tileLines.forEach((line, lineIndex) => {
                ctx.fillText(line, tileX + 20, tileY + 96 + lineIndex * 34);
            });
        });

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(78, footerDividerY);
        ctx.lineTo(width - 78, footerDividerY);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.76)';
        ctx.font = '800 26px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(t('wrapped.shareFooterTag'), 78, footerTextY);

        ctx.fillStyle = 'rgba(255,255,255,0.36)';
        ctx.font = '600 26px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const domainLabel = 'movix.tax';
        ctx.fillText(domainLabel, width - 78 - ctx.measureText(domainLabel).width, footerTextY);

        return new Promise((resolve) => {
            canvas.toBlob((blob) => resolve(blob), 'image/png');
        });
    }, [formattedShareWatchTime, t, tmdbData, topWrappedGenre?.name, topWrappedItem, wrappedData, year]);

    const handleDownloadShareImage = useCallback(async () => {
        if (!wrappedData) return;

        setIsPreparingShareImage(true);
        try {
            const blob = await generateWrappedShareImage();
            if (!blob) {
                toast.error(t('wrapped.shareError'));
                return;
            }

            downloadBlob(blob, `movix-wrapped-${year}.png`);
            toast.success(t('wrapped.imageDownloaded'));
        } catch (error) {
            console.error('[Wrapped] Unable to download share image:', error);
            toast.error(t('wrapped.shareError'));
        } finally {
            setIsPreparingShareImage(false);
        }
    }, [generateWrappedShareImage, t, wrappedData, year]);

    const handleShareImage = useCallback(async () => {
        if (!wrappedData) return;

        setIsPreparingShareImage(true);
        try {
            const blob = await generateWrappedShareImage();
            if (!blob) {
                toast.error(t('wrapped.shareError'));
                return;
            }

            const file = new File([blob], `movix-wrapped-${year}.png`, { type: 'image/png' });
            if (navigator.share && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: t('wrapped.shareTitle', { year }),
                    text: wrappedShareText,
                    files: [file],
                });
                return;
            }

            downloadBlob(blob, `movix-wrapped-${year}.png`);
            toast.success(t('wrapped.imageShareFallback'));
        } catch (error) {
            if (!isShareAbortError(error)) {
                console.error('[Wrapped] Unable to share image:', error);
                toast.error(t('wrapped.shareError'));
            }
        } finally {
            setIsPreparingShareImage(false);
        }
    }, [generateWrappedShareImage, t, wrappedData, wrappedShareText, year]);

    const handleCopyShareText = useCallback(async () => {
        try {
            await copyTextToClipboard(wrappedShareText);
            toast.success(t('wrapped.textCopied'));
        } catch (error) {
            console.error('[Wrapped] Unable to copy share text:', error);
            toast.error(t('wrapped.shareError'));
        }
    }, [t, wrappedShareText]);

    const handleShareText = useCallback(async () => {
        if (!wrappedData) return;

        try {
            if (navigator.share) {
                await navigator.share({
                    title: t('wrapped.shareTitle', { year }),
                    text: wrappedShareText,
                });
                return;
            }

            await copyTextToClipboard(wrappedShareText);
            toast.success(t('wrapped.textCopied'));
        } catch (error) {
            if (!isShareAbortError(error)) {
                console.error('[Wrapped] Unable to share text:', error);
                toast.error(t('wrapped.shareError'));
            }
        }
    }, [t, wrappedData, wrappedShareText, year]);

    const renderSlideContent = (slide: WrappedSlide) => {
        if (!wrappedData) return null;

        switch (slide.type) {
            case 'intro': return <SlideIntro slide={slide} stats={wrappedData.stats} />;
            case 'top1': return <SlideTop1 slide={slide} topItem={wrappedData.topContent[0]} tmdbData={tmdbData} />;
            case 'top2-focus': return <SlideTopFocus slide={slide} item={wrappedData.topContent[1]} tmdbData={tmdbData} rank={2} />;
            case 'top3-focus': return <SlideTopFocus slide={slide} item={wrappedData.topContent[2]} tmdbData={tmdbData} rank={3} />;
            case 'top5': return <SlideTop5 slide={slide} topContent={wrappedData.topContent} tmdbData={tmdbData} />;
            case 'persona': return <SlidePersona slide={slide} persona={wrappedData.persona} />;
            case 'peak-month': return <SlidePeakMonth slide={slide} peakMonth={wrappedData.peakMonth} />;
            case 'top-genres': return <SlideTopGenres slide={slide} topGenres={wrappedData.topGenres} />;
            case 'listening-clock': return <SlideListeningClock slide={slide} listeningClock={wrappedData.listeningClock} peakHour={wrappedData.peakHour} />;
            case 'streak': return <SlideStreak slide={slide} stats={wrappedData.stats} />;
            case 'fun-fact': return <SlideFunFact slide={slide} />;
            case 'session-summary': return <SlideSessionSummary slide={slide} stats={wrappedData.stats} />;
            case 'watch-bookends': return <SlideWatchBookends slide={slide} firstWatch={wrappedData.firstWatch} lastWatch={wrappedData.lastWatch} />;
            case 'closing': return (
                <SlideClosing
                    slide={slide}
                    stats={wrappedData.stats}
                    onShareImage={handleShareImage}
                    onDownloadImage={handleDownloadShareImage}
                    onShareText={handleShareText}
                    onCopyText={handleCopyShareText}
                    isPreparingImage={isPreparingShareImage}
                />
            );
            case 'detailed-stats': return <SlideDetailedStats slide={slide} data={wrappedData} tmdbData={tmdbData} />;
            default: return null;
        }
    };

    const wrappedRequirementCards = wrappedProgress ? [
        {
            key: 'minutes',
            label: t('wrapped.requirementWatchTime'),
            current: formatCompactDuration(wrappedProgress.current.minutes, t),
            required: formatCompactDuration(wrappedProgress.requirements.minutes, t)
        },
        {
            key: 'uniqueTitles',
            label: t('wrapped.requirementTitles'),
            current: wrappedProgress.current.uniqueTitles.toLocaleString(i18n.language),
            required: wrappedProgress.requirements.uniqueTitles.toLocaleString(i18n.language)
        },
        {
            key: 'sessions',
            label: t('wrapped.requirementSessions'),
            current: wrappedProgress.current.sessions.toLocaleString(i18n.language),
            required: wrappedProgress.requirements.sessions.toLocaleString(i18n.language)
        },
        {
            key: 'activeDays',
            label: t('wrapped.requirementActiveDays'),
            current: wrappedProgress.current.activeDays.toLocaleString(i18n.language),
            required: wrappedProgress.requirements.activeDays.toLocaleString(i18n.language)
        }
    ] : [];

    const wrappedMissingItems = wrappedProgress ? [
        wrappedProgress.missing.minutes > 0
            ? t('wrapped.missingWatchTime', { value: formatCompactDuration(wrappedProgress.missing.minutes, t) })
            : null,
        wrappedProgress.missing.uniqueTitles > 0
            ? t('wrapped.missingTitles', { count: wrappedProgress.missing.uniqueTitles })
            : null,
        wrappedProgress.missing.sessions > 0
            ? t('wrapped.missingSessions', { count: wrappedProgress.missing.sessions })
            : null,
        wrappedProgress.missing.activeDays > 0
            ? t('wrapped.missingActiveDays', { count: wrappedProgress.missing.activeDays })
            : null
    ].filter(Boolean) as string[] : [];

    const currentSlideData = wrappedData?.slides[currentSlide];
    const bg = slideBackgrounds[currentSlideData?.type ?? 'intro'] || slideBackgrounds.intro;
    const podiumSlideIndex = currentSlideData?.type === 'top1'
        ? 0
        : currentSlideData?.type === 'top2-focus'
            ? 1
            : currentSlideData?.type === 'top3-focus'
                ? 2
                : -1;
    const isPodiumSlide = podiumSlideIndex !== -1;
    const shouldPlayWrappedTrailerSound = soundEffectsEnabled && hasWrappedInteraction && isPodiumSlide;

    // Get trailer key for the current podium content (used as full-page background on top1/top2/top3 slides)
    const podiumItem = isPodiumSlide && wrappedData ? wrappedData.topContent[podiumSlideIndex] : undefined;
    const podiumTmdb = podiumItem?.tmdbId ? tmdbData.get(podiumItem.tmdbId) : null;
    const fallbackTrailerKey = topWrappedItem?.tmdbId ? tmdbData.get(topWrappedItem.tmdbId)?.trailerKey : null;
    const trailerKey = podiumTmdb?.trailerKey || fallbackTrailerKey;

    useEffect(() => {
        setIsPodiumTrailerLoaded(false);
    }, [trailerKey, currentSlide]);

    // Loading state
    if (loading) {
        return (
            <SquareBackground mode={bgMode} borderColor="rgba(168, 85, 247, 0.15)" className="fixed inset-0 z-50 bg-black flex items-center justify-center">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(168,85,247,0.2),transparent_50%)]" />
                <div className="flex flex-col items-center justify-center w-full h-full">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center relative z-10"
                    >
                        <motion.div
                            animate={{ rotate: 360 }}
                            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                            className="w-20 h-20 mx-auto mb-6 rounded-full border-4 border-purple-500/30 border-t-purple-400"
                        />
                        <h2 className="text-2xl font-bold text-white mb-2">{t('wrapped.preparingWrapped')}</h2>
                        <p className="text-purple-400">{t('wrapped.analyzingYear')}</p>
                    </motion.div>
                </div>
            </SquareBackground>
        );
    }

    // No data state — show a cool message
    if (!wrappedData || noData) {
        return (
            <WrappedStandaloneShell mode={bgMode}>
                <div className="mb-5 flex justify-start sm:mb-8">
                    <button
                        onClick={() => navigate(-1)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 backdrop-blur-lg transition-colors hover:bg-white/10"
                    >
                        <X className="w-5 h-5 text-white" />
                    </button>
                </div>

                <div className="flex flex-1 flex-col items-center justify-start pb-6 text-center md:justify-center">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', duration: 0.8 }}
                        className="mb-6 sm:mb-8"
                    >
                        <div className="relative">
                            <div
                                className="absolute inset-0 rounded-full scale-150 pointer-events-none"
                                style={{ background: 'radial-gradient(circle, rgba(168, 85, 247, 0.30) 0%, transparent 70%)' }}
                            />
                            <span className="relative text-8xl md:text-9xl">🍿</span>
                        </div>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                        className="mb-4 text-3xl font-black sm:text-4xl md:text-5xl"
                    >
                        <ShinyText text={`Wrapped ${year}`} speed={2} color="#a855f7" shineColor="#ffffff" className="" />
                    </motion.h1>

                    <motion.p
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4 }}
                        className="mb-3 max-w-xl text-lg font-semibold text-purple-300 sm:text-xl md:text-2xl"
                    >
                        {t('wrapped.notEnoughDataYet')}
                    </motion.p>

                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6 }}
                        className="w-full max-w-3xl"
                    >
                        <AnimatedBorderCard
                            highlightColor="168 85 247"
                            backgroundColor="0 0 0"
                            className="w-full p-4 text-left backdrop-blur-md sm:p-6 md:p-8"
                        >
                            <p className="mb-4 text-sm leading-relaxed text-white/80 sm:text-base md:text-lg">
                                {t('wrapped.notEnoughDataForYear', { year })}
                            </p>
                            {wrappedProgress && (
                                <div className="mb-6 rounded-[1.5rem] border border-white/10 bg-white/5 p-4 sm:p-5">
                                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-white">{t('wrapped.unlockRequirementsTitle')}</p>
                                            <p className="mt-1 text-xs leading-relaxed text-white/60 sm:text-sm">
                                                {t('wrapped.unlockRequirementsDesc', {
                                                    time: formatCompactDuration(wrappedProgress.requirements.minutes, t),
                                                    titles: wrappedProgress.requirements.uniqueTitles,
                                                    sessions: wrappedProgress.requirements.sessions,
                                                    days: wrappedProgress.requirements.activeDays
                                                })}
                                            </p>
                                        </div>
                                        <div className="inline-flex self-start rounded-full border border-purple-400/20 bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-200">
                                            {t('wrapped.progressPercent', { percent: wrappedProgress.completionPercent })}
                                        </div>
                                    </div>

                                    <div className="mb-4 grid gap-3 sm:grid-cols-2">
                                        {wrappedRequirementCards.map((item) => (
                                            <div key={item.key} className="rounded-xl border border-white/8 bg-black/20 p-3 sm:p-4">
                                                <p className="mb-1 text-[11px] uppercase tracking-[0.18em] text-white/40">{item.label}</p>
                                                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base font-bold text-white sm:text-lg">
                                                    <span>{item.current}</span>
                                                    <span className="text-sm font-medium text-white/45">/ {item.required}</span>
                                                </p>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="rounded-xl border border-amber-400/15 bg-amber-500/5 p-3 sm:p-4">
                                        <p className="mb-2 text-sm font-medium text-amber-200">
                                            {t('wrapped.missingSummaryTitle', { count: wrappedProgress.missingCriteriaCount })}
                                        </p>
                                        <p className="mb-3 text-xs leading-relaxed text-white/65 sm:text-sm">
                                            {t('wrapped.missingTimeInfo', {
                                                current: formatCompactDuration(wrappedProgress.current.minutes, t),
                                                required: formatCompactDuration(wrappedProgress.requirements.minutes, t),
                                                remaining: formatCompactDuration(wrappedProgress.missing.minutes, t)
                                            })}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                            {wrappedMissingItems.map((item) => (
                                                <span
                                                    key={item}
                                                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/75"
                                                >
                                                    {item}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                            <p className="mb-6 text-sm leading-relaxed text-white/60 sm:text-base">
                                {t('wrapped.keepWatching')}
                            </p>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => navigate('/')}
                                className="w-full rounded-full bg-gradient-to-r from-purple-500 to-fuchsia-500 px-6 py-3.5 text-sm font-bold text-white transition-shadow hover:shadow-lg hover:shadow-purple-500/25 sm:w-auto"
                            >
                                {t('wrapped.backToHome')}
                            </motion.button>
                        </AnimatedBorderCard>
                    </motion.div>

                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1 }}
                        className="mt-6 text-xs text-white/30 sm:mt-8 sm:text-sm"
                    >
                        {t('wrapped.wrappedWaiting')}
                    </motion.p>
                </div>
            </WrappedStandaloneShell>
        );
    }

    if (!currentSlideData) {
        return null;
    }

    return (
        <div className="fixed inset-0 z-50 bg-black text-white">
            {/* Full-screen trailer background for podium slides */}
            {trailerKey && isPodiumSlide && (
                <div 
                    className="absolute inset-0 z-0 pointer-events-none overflow-hidden transition-opacity duration-700"
                    style={{ opacity: 1 }}
                >
                    <iframe
                        src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&mute=${shouldPlayWrappedTrailerSound ? 0 : 1}&controls=0&showinfo=0&rel=0&loop=1&playlist=${trailerKey}&modestbranding=1&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&cc_load_policy=0&start=10&origin=${window.location.origin}`}
                        title="Trailer background"
                        allow="autoplay; encrypted-media"
                        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                        style={{ border: 'none', width: '300vw', height: '300vh' }}
                        tabIndex={-1}
                        onLoad={() => setIsPodiumTrailerLoaded(true)}
                    />
                    {/* Dark overlays */}
                    <div className="absolute inset-0 bg-black/50" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-black/50" />
                    <div className="absolute top-0 left-0 right-0 h-28 bg-gradient-to-b from-black to-transparent" />
                    <div className="absolute bottom-0 left-0 right-0 h-28 bg-gradient-to-t from-black to-transparent" />
                </div>
            )}

            {/* SquareBackground + gradients — hidden when trailer is playing on a podium slide */}
            <div 
                className="absolute inset-0 z-0 transition-opacity duration-700"
                style={{ opacity: isPodiumSlide && trailerKey && isPodiumTrailerLoaded ? 0 : 1 }}
            >
                <SquareBackground
                    mode={bgMode}
                    borderColor={bg.color}
                    className="absolute inset-0"
                />
            {/* Dynamic gradient based on slide */}
            <AnimatePresence mode="wait">
                <motion.div
                    key={currentSlide}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className={`absolute inset-0 bg-gradient-to-b ${bg.gradient}`}
                />
            </AnimatePresence>

            {/* Ambient glow — déjà un radial-gradient, on supprime juste le
                blur-[120px] qui s'appliquait par-dessus (double coût GPU pour
                aucun gain visuel — le gradient produit déjà la diffusion). */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] opacity-30 pointer-events-none"
                style={{ background: `radial-gradient(circle, ${bg.color.replace('0.15', '0.4')}, transparent)` }}
            />
            </div>

            {/* Top bar */}
            <div
                className="absolute left-0 right-0 top-0 z-20 flex items-center gap-2 px-3 sm:px-4"
                style={wrappedTopBarStyle}
            >
                <button
                    onClick={() => navigate(-1)}
                    className="shrink-0 rounded-full border border-white/10 bg-white/5 p-2.5 backdrop-blur-lg transition-colors hover:bg-white/10 sm:p-3"
                >
                    <X className="w-5 h-5 text-white" />
                </button>

                <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 sm:gap-2 sm:px-4">
                    <Sparkles className="hidden h-5 w-5 text-amber-400 sm:block" />
                    <ShinyText
                        text={t('wrapped.shareTitle', { year })}
                        speed={3}
                        color="#fbbf24"
                        shineColor="#ffffff"
                        className="max-w-full truncate text-sm font-bold sm:text-base"
                    />
                </div>

                <button
                    onClick={handleShareText}
                    className="shrink-0 rounded-full border border-white/10 bg-white/5 p-2.5 backdrop-blur-lg transition-colors hover:bg-white/10 sm:p-3"
                >
                    <Share2 className="w-5 h-5 text-white" />
                </button>
            </div>

            {/* Progress indicators */}
            <div
                className="absolute left-3 right-3 z-20 flex gap-1 sm:left-4 sm:right-4"
                style={wrappedProgressBarStyle}
            >
                {wrappedData.slides.map((_, index) => (
                    <button
                        key={index}
                        onClick={() => goToSlide(index)}
                        className="h-1 flex-1 overflow-hidden rounded-full bg-white/10 transition-colors hover:bg-white/20 sm:h-1.5"
                    >
                        <motion.div
                            initial={false}
                            animate={{ width: index <= currentSlide ? '100%' : '0%' }}
                            transition={{ duration: 0.3 }}
                            className="h-full bg-white"
                        />
                    </button>
                ))}
            </div>

            {/* Slide Content */}
            <div className="absolute inset-0" onClick={nextSlide}>
                <AnimatePresence mode="wait" custom={direction}>
                    <motion.div
                        key={currentSlide}
                        custom={direction}
                        initial={{ opacity: 0, x: direction * 100 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -direction * 100 }}
                        transition={{ duration: 0.3 }}
                        drag="x" // Enable drag for all slides
                        dragConstraints={{ left: 0, right: 0 }}
                        dragElastic={0.2}
                        onDragEnd={handleDragEnd}
                        className="absolute inset-0 flex items-stretch justify-center overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {currentSlideData.type === 'top2-focus' ? (
                            <SlideTopFocus
                                slide={currentSlideData}
                                item={wrappedData.topContent[1]}
                                tmdbData={tmdbData}
                                rank={2}
                                hideBackdropImage={isPodiumSlide && !!trailerKey && isPodiumTrailerLoaded}
                            />
                        ) : currentSlideData.type === 'top3-focus' ? (
                            <SlideTopFocus
                                slide={currentSlideData}
                                item={wrappedData.topContent[2]}
                                tmdbData={tmdbData}
                                rank={3}
                                hideBackdropImage={isPodiumSlide && !!trailerKey && isPodiumTrailerLoaded}
                            />
                        ) : (
                            renderSlideContent(currentSlideData)
                        )}
                    </motion.div>
                </AnimatePresence>
            </div>

            {/* Navigation arrows */}
            <div
                className="absolute left-3 right-3 z-20 flex items-center justify-between pointer-events-none sm:left-4 sm:right-4"
                style={wrappedNavigationStyle}
            >
                <button
                    onClick={(e) => { e.stopPropagation(); prevSlide(); }}
                    disabled={currentSlide === 0}
                    className={`pointer-events-auto rounded-full border border-white/10 bg-white/5 p-3 backdrop-blur-lg transition-all hover:bg-white/10 sm:p-4 ${
                        currentSlide === 0 ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                >
                    <ChevronLeft className="h-5 w-5 text-white sm:h-6 sm:w-6" />
                </button>

                <div className="flex items-center gap-2 text-xs text-white/40 sm:text-sm">
                    <span>{currentSlide + 1}</span>
                    <span>/</span>
                    <span>{wrappedData.slides.length}</span>
                </div>

                <button
                    onClick={(e) => { e.stopPropagation(); nextSlide(); }}
                    disabled={currentSlide === wrappedData.slides.length - 1}
                    className={`pointer-events-auto rounded-full border border-white/10 bg-white/5 p-3 backdrop-blur-lg transition-all hover:bg-white/10 sm:p-4 ${
                        currentSlide === wrappedData.slides.length - 1 ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                >
                    <ChevronRight className="h-5 w-5 text-white sm:h-6 sm:w-6" />
                </button>
            </div>

            {/* Tap hint */}
            <motion.div
                initial={{ opacity: 0.6 }}
                animate={{ opacity: 0 }}
                transition={{ delay: 3, duration: 1 }}
                className="pointer-events-none absolute left-0 right-0 text-center text-xs text-white/30 sm:text-sm"
                style={wrappedHintStyle}
            >
                {t('wrapped.tapOrSwipe')}
            </motion.div>
        </div>
    );
};

export default WrappedPage;
