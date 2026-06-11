import React, { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useBgPrefs, getBgAccentRgb } from '@/utils/bgPreferences';

type BgMode = 'combined' | 'static' | 'animated';

interface SquareBackgroundProps extends React.HTMLAttributes<HTMLDivElement> {
    squareSize?: number;
    borderColor?: string;
    mode?: BgMode;
}

interface Neighbor {
    row: number;
    col: number;
    opacity: number;
}

function parseRGB(color: string): { r: number; g: number; b: number } {
    const match = color.match(/\d+/g);
    if (!match || match.length < 3) return { r: 239, g: 68, b: 68 };
    return { r: parseInt(match[0]), g: parseInt(match[1]), b: parseInt(match[2]) };
}

const DEFAULT_SQUARE_SIZE = 48;
const STARTING_ALPHA = 100;
const FADE_PER_FRAME = 8;
const NEIGHBOR_PROB = 0.5;
const EXPLOSION_RADIUS = 4;
const EXPLOSION_PARTICLES = 20;
const OFFSCREEN_COORD = -1000;
const HALO_SIZE = 400;
const HALO_HALF_SIZE = HALO_SIZE / 2;
const HALO_HIDDEN_TRANSLATE = -1200;

export const SquareBackground: React.FC<SquareBackgroundProps> = ({
    children,
    className,
    squareSize: propSquareSize = 48,
    borderColor: propBorderColor = 'rgba(239, 68, 68, 0.15)',
    mode = 'combined',
    ...props
}) => {
    // Overrides "Forcer cette couleur / taille" depuis SettingsPage. Quand
    // l'utilisateur active les flags, on ignore les valeurs hardcodées passées
    // par les pages (Search, Collections, etc.) et on applique le réglage user.
    const prefs = useBgPrefs();
    const squareSize = prefs.forceSquareSize ? prefs.squareSize : propSquareSize;
    // Préserve l'alpha de la couleur originale (les pages utilisent 0.10/0.15…)
    // en ne remplaçant que la composante RGB.
    const borderColor = prefs.forceColor
        ? (() => {
            const rgb = getBgAccentRgb(prefs);
            const alphaMatch = propBorderColor.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)$/);
            const alpha = alphaMatch ? alphaMatch[1] : '0.15';
            return `rgba(${rgb}, ${alpha})`;
        })()
        : propBorderColor;

    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const haloRef = useRef<HTMLDivElement>(null);
    // squareSize stocké dans un ref pour être lu dans les callbacks/RAF sans
    // re-register les handlers à chaque changement de prop.
    const squareSizeRef = useRef(squareSize || DEFAULT_SQUARE_SIZE);
    squareSizeRef.current = squareSize || DEFAULT_SQUARE_SIZE;
    const stateRef = useRef({
        neighbors: [] as Neighbor[],
        currentRow: -2,
        currentCol: -2,
        mouseX: OFFSCREEN_COORD,
        mouseY: OFFSCREEN_COORD,
        animId: 0,
        isInViewport: true,
        isDocumentVisible: typeof document === 'undefined' ? true : !document.hidden,
        dirtyCells: [] as Array<{ col: number; row: number }>,
    });
    const gridCacheRef = useRef<{ canvas: HTMLCanvasElement | null; signature: string }>({
        canvas: null,
        signature: '',
    });
    const colorRef = useRef(parseRGB(borderColor));
    colorRef.current = parseRGB(borderColor);

    const showCssGrid = mode === 'static';
    // Halo : seulement quand le mode l'inclut ET que l'utilisateur ne l'a pas
    // explicitement désactivé dans Apparence → "Halo lumineux".
    const showHalo = (mode === 'static' || mode === 'combined') && prefs.haloEnabled;
    const showCanvas = mode === 'animated' || mode === 'combined';

    useEffect(() => {
        if (!showHalo) return;

        const container = containerRef.current;
        const halo = haloRef.current;
        if (!container || !halo) return;

        let rafId = 0;
        let isActive = false;
        let lastClientX = 0;
        let lastClientY = 0;

        const applyHaloPosition = () => {
            rafId = 0;

            if (!isActive) {
                halo.style.transform = `translate(${HALO_HIDDEN_TRANSLATE}px, ${HALO_HIDDEN_TRANSLATE}px)`;
                return;
            }

            const rect = container.getBoundingClientRect();
            const nextX = lastClientX - rect.left;
            const nextY = lastClientY - rect.top;
            halo.style.transform = `translate(${nextX - HALO_HALF_SIZE}px, ${nextY - HALO_HALF_SIZE}px)`;
        };

        const scheduleHaloUpdate = () => {
            if (!rafId) {
                rafId = requestAnimationFrame(applyHaloPosition);
            }
        };

        const handlePointerMove = (e: PointerEvent) => {
            lastClientX = e.clientX;
            lastClientY = e.clientY;
            isActive = true;
            scheduleHaloUpdate();
        };

        const handlePointerLeave = () => {
            isActive = false;
            scheduleHaloUpdate();
        };

        const handleViewportShift = () => {
            if (isActive) {
                scheduleHaloUpdate();
            }
        };

        container.addEventListener('pointermove', handlePointerMove, { passive: true });
        container.addEventListener('pointerleave', handlePointerLeave);
        window.addEventListener('scroll', handleViewportShift, { passive: true });
        window.addEventListener('resize', handleViewportShift);

        return () => {
            if (rafId) {
                cancelAnimationFrame(rafId);
            }
            container.removeEventListener('pointermove', handlePointerMove);
            container.removeEventListener('pointerleave', handlePointerLeave);
            window.removeEventListener('scroll', handleViewportShift);
            window.removeEventListener('resize', handleViewportShift);
        };
    }, [showHalo]);

    useEffect(() => {
        if (!showCanvas) return;
        if (window.innerWidth < 768) return;

        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const state = stateRef.current;
        const gridCache = gridCacheRef.current;

        const canRender = () => state.isInViewport && state.isDocumentVisible;

        const cancelScheduledFrame = () => {
            if (state.animId) {
                cancelAnimationFrame(state.animId);
                state.animId = 0;
            }
        };

        const syncSize = () => {
            const { width, height } = container.getBoundingClientRect();
            const nextWidth = Math.max(1, Math.round(width));
            const nextHeight = Math.max(1, Math.round(height));

            if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
                canvas.width = nextWidth;
                canvas.height = nextHeight;
                gridCache.signature = '';
                state.dirtyCells = [];
                // Paint grid once on resize so dirty-rect rendering has a clean base
                const cell = squareSizeRef.current;
                const numCols = Math.ceil(nextWidth / cell);
                const numRows = Math.ceil(nextHeight / cell);
                const gridCanvas = drawBaseGrid(nextWidth, nextHeight, cell, numCols, numRows);
                if (gridCanvas) {
                    ctx.drawImage(gridCanvas, 0, 0);
                }
            }
        };

        const getGridMetrics = () => {
            const width = canvas.width;
            const height = canvas.height;
            const cell = squareSizeRef.current;
            const numCols = Math.ceil(width / cell);
            const numRows = Math.ceil(height / cell);

            return {
                width,
                height,
                cell,
                numCols,
                numRows,
            };
        };

        const drawBaseGrid = (width: number, height: number, cell: number, numCols: number, numRows: number) => {
            const { r, g, b } = colorRef.current;
            // Signature inclut `cell` pour invalider le cache quand squareSize change.
            const signature = `${width}:${height}:${cell}:${r}:${g}:${b}`;
            if (gridCache.signature === signature && gridCache.canvas) {
                return gridCache.canvas;
            }

            if (!gridCache.canvas) {
                gridCache.canvas = document.createElement('canvas');
            }

            const gridCanvas = gridCache.canvas;
            gridCanvas.width = width;
            gridCanvas.height = height;

            const gridCtx = gridCanvas.getContext('2d');
            if (!gridCtx) return null;

            gridCtx.clearRect(0, 0, width, height);
            gridCtx.lineWidth = 1;
            gridCtx.strokeStyle = `rgba(${r},${g},${b},0.08)`;
            gridCtx.beginPath();

            for (let col = 0; col <= numCols; col++) {
                const x = col * cell;
                gridCtx.moveTo(x, 0);
                gridCtx.lineTo(x, numRows * cell);
            }

            for (let row = 0; row <= numRows; row++) {
                const y = row * cell;
                gridCtx.moveTo(0, y);
                gridCtx.lineTo(numCols * cell, y);
            }

            gridCtx.stroke();
            gridCache.signature = signature;
            return gridCanvas;
        };

        const getRandomNeighbors = (row: number, col: number, numRows: number, numCols: number): Neighbor[] => {
            const neighbors: Neighbor[] = [];

            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nextRow = row + dr;
                    const nextCol = col + dc;

                    if (
                        nextRow >= 0 &&
                        nextRow < numRows &&
                        nextCol >= 0 &&
                        nextCol < numCols &&
                        Math.random() < NEIGHBOR_PROB
                    ) {
                        neighbors.push({ row: nextRow, col: nextCol, opacity: 255 });
                    }
                }
            }

            return neighbors;
        };

        const renderFrame = () => {
            state.animId = 0;

            if (!canRender()) {
                return;
            }

            const { width, height, cell, numCols, numRows } = getGridMetrics();

            const gridCanvas = drawBaseGrid(width, height, cell, numCols, numRows);
            if (!gridCanvas) return;

            // Dirty-rect restore: paint grid only under previously drawn cells
            // instead of clearing + drawImage the full canvas each frame.
            for (const { col, row } of state.dirtyCells) {
                const x = col * cell - 1;
                const y = row * cell - 1;
                const w = cell + 2;
                const h = cell + 2;
                ctx.clearRect(x, y, w, h);
                ctx.drawImage(gridCanvas, x, y, w, h, x, y, w, h);
            }
            state.dirtyCells = [];

            const { r, g, b } = colorRef.current;
            const { mouseX, mouseY } = state;

            if (mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height) {
                const col = Math.max(0, Math.min(numCols - 1, Math.floor(mouseX / cell)));
                const row = Math.max(0, Math.min(numRows - 1, Math.floor(mouseY / cell)));

                if (row !== state.currentRow || col !== state.currentCol) {
                    state.currentRow = row;
                    state.currentCol = col;
                    state.neighbors.push(...getRandomNeighbors(row, col, numRows, numCols));
                }

                ctx.strokeStyle = `rgba(${r},${g},${b},${(STARTING_ALPHA / 255).toFixed(3)})`;
                ctx.strokeRect(col * cell, row * cell, cell, cell);
                state.dirtyCells.push({ col, row });
            }

            for (const neighbor of state.neighbors) {
                neighbor.opacity = Math.max(0, neighbor.opacity - FADE_PER_FRAME);
                if (neighbor.opacity > 0) {
                    ctx.strokeStyle = `rgba(${r},${g},${b},${(neighbor.opacity / 255).toFixed(3)})`;
                    ctx.strokeRect(neighbor.col * cell, neighbor.row * cell, cell, cell);
                    state.dirtyCells.push({ col: neighbor.col, row: neighbor.row });
                }
            }

            state.neighbors = state.neighbors.filter((neighbor) => neighbor.opacity > 0);

            if (state.neighbors.length > 0) {
                state.animId = requestAnimationFrame(renderFrame);
            }
        };

        const scheduleRender = () => {
            if (state.animId || !canRender()) return;
            state.animId = requestAnimationFrame(renderFrame);
        };

        const renderOnce = () => {
            cancelScheduledFrame();
            if (!canRender()) return;
            syncSize();
            renderFrame();
        };

        const handlePointerMove = (e: PointerEvent) => {
            const rect = container.getBoundingClientRect();
            state.mouseX = e.clientX - rect.left;
            state.mouseY = e.clientY - rect.top;
            scheduleRender();
        };

        const handlePointerLeave = () => {
            state.mouseX = OFFSCREEN_COORD;
            state.mouseY = OFFSCREEN_COORD;
            state.currentRow = -2;
            state.currentCol = -2;
            renderOnce();
        };

        const handlePointerDown = (e: PointerEvent) => {
            if (e.button !== 0) return;

            const target = e.target as HTMLElement | null;
            if (
                target &&
                target !== container &&
                target.closest(
                    'a, button, input, textarea, select, label, canvas, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [contenteditable="true"], [data-interactive]',
                )
            ) {
                return;
            }

            const rect = container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            if (mouseX < 0 || mouseX > rect.width || mouseY < 0 || mouseY > rect.height) return;

            const cell = squareSizeRef.current;
            const numCols = Math.ceil(rect.width / cell);
            const numRows = Math.ceil(rect.height / cell);
            const col = Math.max(0, Math.min(numCols - 1, Math.floor(mouseX / cell)));
            const row = Math.max(0, Math.min(numRows - 1, Math.floor(mouseY / cell)));

            for (let i = 0; i < EXPLOSION_PARTICLES; i++) {
                const angle = Math.random() * Math.PI * 2;
                const distance = Math.random() * (EXPLOSION_RADIUS - 1) + 1;
                const nextRow = Math.round(row + distance * Math.sin(angle));
                const nextCol = Math.round(col + distance * Math.cos(angle));

                if (nextRow >= 0 && nextRow < numRows && nextCol >= 0 && nextCol < numCols) {
                    state.neighbors.push({ row: nextRow, col: nextCol, opacity: 255 });
                }
            }

            state.mouseX = mouseX;
            state.mouseY = mouseY;
            scheduleRender();
        };

        const handleVisibilityChange = () => {
            state.isDocumentVisible = !document.hidden;

            if (state.isDocumentVisible) {
                renderOnce();
            } else {
                cancelScheduledFrame();
            }
        };

        const viewportObserver = typeof IntersectionObserver === 'undefined'
            ? null
            : new IntersectionObserver((entries) => {
                const entry = entries[0];
                if (!entry) return;

                state.isInViewport = entry.isIntersecting;
                if (state.isInViewport) {
                    renderOnce();
                } else {
                    cancelScheduledFrame();
                }
            }, { threshold: 0.01 });

        const resizeObserver = new ResizeObserver(() => {
            syncSize();
            renderOnce();
        });

        // Force un repaint complet de la grille au mount / quand l'effet
        // re-run (squareSize ou borderColor changés). syncSize ne repeint
        // que si les dimensions changent ; le rendu en dirty-rect ne couvre
        // que les cellules survolées. Sans ce paint forcé, un changement de
        // couleur ou de taille en live laisse l'ancienne grille à l'écran.
        const forceFullPaint = () => {
            const width = canvas.width;
            const height = canvas.height;
            if (width <= 0 || height <= 0) return;
            const cell = squareSizeRef.current;
            const numCols = Math.ceil(width / cell);
            const numRows = Math.ceil(height / cell);
            // Invalide le cache pour que drawBaseGrid utilise la nouvelle couleur.
            gridCache.signature = '';
            const gridCanvas = drawBaseGrid(width, height, cell, numCols, numRows);
            if (gridCanvas) {
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(gridCanvas, 0, 0);
            }
            state.dirtyCells = [];
        };

        syncSize();
        forceFullPaint();
        renderOnce();

        resizeObserver.observe(container);
        viewportObserver?.observe(container);
        container.addEventListener('pointermove', handlePointerMove, { passive: true });
        container.addEventListener('pointerleave', handlePointerLeave);
        container.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelScheduledFrame();
            resizeObserver.disconnect();
            viewportObserver?.disconnect();
            container.removeEventListener('pointermove', handlePointerMove);
            container.removeEventListener('pointerleave', handlePointerLeave);
            container.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [showCanvas, squareSize, borderColor]);

    return (
        <div
            ref={containerRef}
            className={cn('relative overflow-hidden bg-black', className)}
            {...props}
        >
            {showCssGrid && (
                <div
                    className="absolute inset-0 z-0 pointer-events-none"
                    style={{
                        backgroundImage: `
                            linear-gradient(${borderColor} 1px, transparent 1px),
                            linear-gradient(to right, ${borderColor} 1px, transparent 1px)
                        `,
                        backgroundSize: `${squareSize}px ${squareSize}px`,
                    }}
                />
            )}

            {showCanvas && (
                <canvas
                    ref={canvasRef}
                    className="absolute inset-0 z-0 pointer-events-none"
                    style={{ opacity: 0.3 }}
                />
            )}

            {showHalo && (
                <div
                    ref={haloRef}
                    className="square-bg-halo absolute z-[1] pointer-events-none"
                    style={{
                        top: 0,
                        left: 0,
                        width: HALO_SIZE,
                        height: HALO_SIZE,
                        transform: `translate(${HALO_HIDDEN_TRANSLATE}px, ${HALO_HIDDEN_TRANSLATE}px)`,
                        background: `radial-gradient(circle at center, ${borderColor.replace(/[\d.]+\)$/, '0.15)')} 0%, transparent 70%)`,
                        willChange: 'transform',
                    }}
                />
            )}

            <div className="relative z-10 w-full h-full">
                {children}
            </div>
        </div>
    );
};
