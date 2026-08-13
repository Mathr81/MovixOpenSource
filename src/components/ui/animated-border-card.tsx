import React, { CSSProperties, memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLightMode } from '../../context/LightModeContext';

interface AnimatedBorderCardProps extends React.HTMLAttributes<HTMLDivElement> {
    children: React.ReactNode;
    className?: string;
    highlightColor?: string;
    backgroundColor?: string;
    animated?: boolean;
    animationSpeed?: number;
}

const RGB_CHANNELS_PATTERN = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s*\/\s*(\d*\.?\d+))?\s*$/;

const normalizeCssColor = (color: string | undefined, fallback: string) => {
    if (!color) {
        return fallback;
    }

    const trimmed = color.trim();
    if (!trimmed) {
        return fallback;
    }

    return RGB_CHANNELS_PATTERN.test(trimmed) ? `rgb(${trimmed})` : trimmed;
};

const buildSoftHighlightColor = (color: string | undefined, fallback: string) => {
    if (!color) {
        return fallback;
    }

    const trimmed = color.trim();
    const match = trimmed.match(RGB_CHANNELS_PATTERN);

    if (match) {
        return `rgb(${match[1]} ${match[2]} ${match[3]} / 0.5)`;
    }

    return `color-mix(in srgb, ${normalizeCssColor(trimmed, fallback)} 50%, transparent)`;
};

let sharedObserver: IntersectionObserver | null = null;
let visibilityListenerRegistered = false;
const observedCards = new Map<HTMLElement, boolean>();

const syncCardAnimationState = (card: HTMLElement) => {
    const isDocumentVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const isInViewport = observedCards.get(card) ?? true;
    card.style.setProperty('--border-play-state', isDocumentVisible && isInViewport ? 'running' : 'paused');
};

const syncAllCardAnimationStates = () => {
    observedCards.forEach((_, card) => {
        syncCardAnimationState(card);
    });
};

const ensureVisibilityListener = () => {
    if (visibilityListenerRegistered || typeof document === 'undefined') {
        return;
    }

    document.addEventListener('visibilitychange', syncAllCardAnimationStates);
    visibilityListenerRegistered = true;
};

const cleanupVisibilityListener = () => {
    if (!visibilityListenerRegistered || typeof document === 'undefined' || observedCards.size > 0) {
        return;
    }

    document.removeEventListener('visibilitychange', syncAllCardAnimationStates);
    visibilityListenerRegistered = false;
};

const ensureSharedObserver = () => {
    if (sharedObserver || typeof IntersectionObserver === 'undefined') {
        return sharedObserver;
    }

    sharedObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const card = entry.target as HTMLElement;
            observedCards.set(card, entry.isIntersecting);
            syncCardAnimationState(card);
        }
    }, {
        rootMargin: '180px',
    });

    return sharedObserver;
};

const observeAnimatedCard = (card: HTMLElement) => {
    ensureVisibilityListener();
    observedCards.set(card, true);
    ensureSharedObserver()?.observe(card);
    syncCardAnimationState(card);

    return () => {
        sharedObserver?.unobserve(card);
        observedCards.delete(card);
        card.style.removeProperty('--border-play-state');
        cleanupVisibilityListener();
    };
};

const syncCardBorderOrbitSize = (card: HTMLElement, width: number, height: number) => {
    const largestSide = Math.max(width, height);

    if (!Number.isFinite(largestSide) || largestSide <= 0) {
        card.style.removeProperty('--border-orbit-size');
        card.style.setProperty('--border-visibility', '0');
        return false;
    }

    card.style.setProperty('--border-orbit-size', `${Math.ceil(largestSide * 2)}px`);
    card.style.setProperty('--border-visibility', '1');
    return true;
};

const shallowEqualStyle = (
    previousStyle?: React.CSSProperties,
    nextStyle?: React.CSSProperties
) => {
    if (previousStyle === nextStyle) {
        return true;
    }

    if (!previousStyle || !nextStyle) {
        return !previousStyle && !nextStyle;
    }

    const previousKeys = Object.keys(previousStyle);
    const nextKeys = Object.keys(nextStyle);

    if (previousKeys.length !== nextKeys.length) {
        return false;
    }

    for (const key of previousKeys) {
        if (previousStyle[key as keyof React.CSSProperties] !== nextStyle[key as keyof React.CSSProperties]) {
            return false;
        }
    }

    return true;
};

const arePropsEqual = (prev: AnimatedBorderCardProps, next: AnimatedBorderCardProps) => {
    const prevKeys = Object.keys(prev) as Array<keyof AnimatedBorderCardProps>;
    const nextKeys = Object.keys(next) as Array<keyof AnimatedBorderCardProps>;

    if (prevKeys.length !== nextKeys.length) {
        return false;
    }

    for (const key of prevKeys) {
        if (!(key in next)) {
            return false;
        }

        if (key === 'style') {
            if (!shallowEqualStyle(prev.style, next.style)) {
                return false;
            }
            continue;
        }

        if (prev[key] !== next[key]) {
            return false;
        }
    }

    return true;
};

const AnimatedBorderCardComponent = ({
    children,
    className = "",
    highlightColor = "251 191 36",
    backgroundColor = "0 0 0",
    animated = true,
    animationSpeed = 1,
    style,
    ...props
}: AnimatedBorderCardProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lightModeContext = useLightMode();
    const animationsDisabled = !lightModeContext?.effectivePrefs?.transitions;
    const shouldAnimate = animated && animationSpeed > 0 && !animationsDisabled;
    const animationDuration = `${Math.max(0.25, 6 / Math.max(animationSpeed, 0.01))}s`;
    const solidHighlight = useMemo(
        () => normalizeCssColor(highlightColor, 'rgb(251 191 36)'),
        [highlightColor]
    );
    const softHighlight = useMemo(
        () => buildSoftHighlightColor(highlightColor, 'rgb(251 191 36 / 0.5)'),
        [highlightColor]
    );
    const surfaceColor = useMemo(
        () => normalizeCssColor(backgroundColor, 'rgb(0 0 0)'),
        [backgroundColor]
    );

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        if (!shouldAnimate) {
            container.style.setProperty('--border-play-state', 'paused');
            return;
        }

        return observeAnimatedCard(container);
    }, [shouldAnimate]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const syncCurrentSize = () => {
            const { width, height } = container.getBoundingClientRect();
            syncCardBorderOrbitSize(container, width, height);
        };

        syncCurrentSize();

        const rafId = requestAnimationFrame(syncCurrentSize);

        if (typeof ResizeObserver === 'undefined') {
            return () => {
                cancelAnimationFrame(rafId);
                container.style.removeProperty('--border-orbit-size');
                container.style.removeProperty('--border-visibility');
            };
        }

        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target !== container) {
                    continue;
                }

                syncCardBorderOrbitSize(container, entry.contentRect.width, entry.contentRect.height);
            }
        });

        resizeObserver.observe(container);

        return () => {
            cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
            container.style.removeProperty('--border-orbit-size');
            container.style.removeProperty('--border-visibility');
        };
    }, []);

    const mergedStyle = useMemo(() => {
        return {
            '--card-surface': surfaceColor,
            '--highlight-solid': solidHighlight,
            '--highlight-soft': softHighlight,
            '--border-duration': animationDuration,
            '--border-play-state': shouldAnimate ? 'running' : 'paused',
            '--border-color': !shouldAnimate ? solidHighlight : undefined,
            ...style,
        } as CSSProperties;
    }, [animationDuration, shouldAnimate, softHighlight, solidHighlight, style, surfaceColor]);

    return (
        <div
            ref={containerRef}
            style={mergedStyle}
            className={`animated-border-card ${shouldAnimate ? 'animated-border-card--animated' : ''} ${className}`}
            {...props}
        >
            {children}
        </div>
    );
};

const AnimatedBorderCard = memo(AnimatedBorderCardComponent, arePropsEqual);

export default AnimatedBorderCard;
