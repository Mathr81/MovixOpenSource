/**
 * Shared canvas helpers for Movix Wrapped share cards.
 * No React dependencies — pure canvas / DOM utilities.
 */
import inter800Url from '@fontsource/inter/files/inter-latin-800-normal.woff2?url';
import inter900Url from '@fontsource/inter/files/inter-latin-900-normal.woff2?url';
import archivoBlackUrl from '@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2?url';

export const FONT_STACK = 'Inter, system-ui, sans-serif';
export const DISPLAY_FONT = '"Archivo Black", Inter, system-ui, sans-serif';

let fontsLoaded = false;
/** Charge les fontes des share-cards (rendu identique sur tous les OS). Fallback silencieux. */
export async function ensureShareFonts(): Promise<void> {
    if (fontsLoaded || typeof FontFace === 'undefined') return;
    try {
        const faces = [
            new FontFace('Inter', `url(${inter800Url})`, { weight: '800' }),
            new FontFace('Inter', `url(${inter900Url})`, { weight: '900' }),
            new FontFace('Archivo Black', `url(${archivoBlackUrl})`, { weight: '400' }),
        ];
        const loaded = await Promise.all(faces.map(f => f.load()));
        loaded.forEach(f => document.fonts.add(f));
        fontsLoaded = true;
    } catch { /* system-ui fallback */ }
}

/** PRNG déterministe (positions stickers reproductibles). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Charge une image pour canvas via fetch→blob (requête CORS propre, pas de collision de cache <img>). */
export async function loadCanvasImage(src: string): Promise<HTMLImageElement | null> {
    // Clé d'URL dédiée au canvas : le service worker (public/sw.js) sert image.tmdb.org
    // en cache-first par URL, et son cache contient des réponses OPAQUES (stockées par les
    // <img> no-cors du site) — inutilisables ici (status 0 → throw, et le fallback
    // crossOrigin échoue pareil faute d'en-têtes ACAO). Un param `?cors=1` change la clé
    // de cache → vraie requête réseau CORS, mise en cache séparément ensuite.
    const corsSrc = src.includes('?') ? `${src}&cors=1` : `${src}?cors=1`;
    try {
        const res = await fetch(corsSrc, { mode: 'cors' });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const img = await new Promise<HTMLImageElement | null>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = url;
        });
        if (img) setTimeout(() => URL.revokeObjectURL(url), 60000);
        else URL.revokeObjectURL(url);
        return img;
    } catch {
        // Fallback : ancienne méthode crossOrigin
        return new Promise((resolve) => {
            const image = new Image();
            if (!corsSrc.startsWith(window.location.origin)) image.crossOrigin = 'anonymous';
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = corsSrc;
        });
    }
}

export function drawRoundedRectPath(
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

export function drawPopcornSticker(
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

export function drawClapperSticker(
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
    ctx.lineWidth = 2;
    ctx.stroke(combinedPath);
    ctx.restore();
}

export function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
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

/** Dessine les stickers popcorn/clap en positions seedées. */
export function drawSeededStickers(ctx: CanvasRenderingContext2D, width: number, height: number, seed: number, count = 40): void {
    const rand = mulberry32(seed);
    const colors = ['#4ecdc4', '#ff7a59', '#f6c453', '#ff5f56'];
    for (let i = 0; i < count; i++) {
        const isPopcorn = rand() > 0.5;
        const x = rand() * width;
        const y = rand() * height;
        const scale = 1.0 + rand() * 1.5;
        const rotation = rand() * Math.PI * 2;
        const opacity = 0.1 + rand() * 0.2;
        const accent = colors[Math.floor(rand() * colors.length)];
        if (isPopcorn) {
            drawPopcornSticker(ctx, { x, y, scale, rotation, opacity, fillLevel: 0.3 + rand() * 0.7, accent });
        } else {
            drawClapperSticker(ctx, { x, y, scale: scale * 1.4, rotation, opacity, accent });
        }
    }
}
