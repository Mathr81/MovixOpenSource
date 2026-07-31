/**
 * Formats alternatifs de la share-card Wrapped : Affiche de film & Billet de ciné.
 * Données primitives en entrée (pas de dépendance aux types de page).
 */
import { drawRoundedRectPath, wrapCanvasText, loadCanvasImage, ensureShareFonts, drawSeededStickers, mulberry32, FONT_STACK, DISPLAY_FONT } from './wrappedCanvas';

export interface WrappedShareCardData {
    year: number;
    totalHours: number;
    totalMinutes: number;
    uniqueTitles: number;
    totalSessions: number;
    longestStreak: number;
    peakHour: number | null;
    peakMonthName: string;
    peakMonthIndex: number;
    personaTitle: string;
    personaEmoji: string;
    personaColor: string;
    topTitles: string[];           // top 5
    topGenreName: string | null;
    watchTimeLabel: string;        // ex. "23h 14min"
    topPosterUrl: string | null;
    topBackdropUrl: string | null;
    posterUrls: (string | null)[]; // top 3
    seed: number;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

// ────────────────────────────────────────────────────────────────────────────
// FORMAT B — AFFICHE DE FILM (1080×1620, ratio 2:3)
// ────────────────────────────────────────────────────────────────────────────
export async function generatePosterShareImage(data: WrappedShareCardData): Promise<Blob | null> {
    await ensureShareFonts();
    const width = 1080, height = 1620;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const center = (text: string, y: number) => ctx.fillText(text, (width - ctx.measureText(text).width) / 2, y);

    // Fond : backdrop plein cadre + voile sombre + vignette
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, width, height);
    const backdrop = data.topBackdropUrl ? await loadCanvasImage(data.topBackdropUrl) : null;
    if (backdrop) {
        const scale = Math.max(width / backdrop.width, height / backdrop.height);
        const dw = backdrop.width * scale, dh = backdrop.height * scale;
        ctx.save();
        ctx.globalAlpha = 0.42;
        ctx.drawImage(backdrop, (width - dw) / 2, (height - dh) / 2, dw, dh);
        ctx.restore();
    }
    const veil = ctx.createLinearGradient(0, 0, 0, height);
    veil.addColorStop(0, 'rgba(8,8,10,0.82)');
    veil.addColorStop(0.42, 'rgba(8,8,10,0.45)');
    veil.addColorStop(1, 'rgba(8,8,10,0.94)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, width, height);
    const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    // Grain léger (déterministe)
    const rand = mulberry32(data.seed);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let i = 0; i < 220; i++) {
        ctx.fillRect(rand() * width, rand() * height, 1.4, 1.4);
    }

    // Lauriers + sélection officielle
    ctx.fillStyle = 'rgba(246,196,83,0.92)';
    ctx.font = `800 26px ${FONT_STACK}`;
    center(`🏆  SÉLECTION OFFICIELLE ${data.year}  🏆`, 138);

    // MOVIX PRÉSENTE
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `800 30px ${FONT_STACK}`;
    center('M O V I X   P R É S E N T E', 252);

    // Titre principal
    ctx.fillStyle = '#ffffff';
    ctx.font = `400 64px ${DISPLAY_FONT}`;
    center('UNE ANNÉE DE', 392);
    const big = data.totalHours > 0 ? `${data.totalHours} HEURES` : `${data.totalMinutes} MINUTES`;
    const grad = ctx.createLinearGradient(140, 0, width - 140, 0);
    grad.addColorStop(0, '#ffd7d1');
    grad.addColorStop(0.5, '#ff7a59');
    grad.addColorStop(1, '#f6c453');
    ctx.fillStyle = grad;
    ctx.font = `400 116px ${DISPLAY_FONT}`;
    center(big, 516);

    // Persona
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `800 34px ${FONT_STACK}`;
    center(`${data.personaEmoji}  ${data.personaTitle}`, 596);

    // Bandeau posters top 3
    const posters = await Promise.all(data.posterUrls.slice(0, 3).map(u => (u ? loadCanvasImage(u) : Promise.resolve(null))));
    const pw = 218, ph = 326, gap = 36;
    const totalW = pw * 3 + gap * 2;
    let px = (width - totalW) / 2;
    const py = 668;
    posters.forEach((img, i) => {
        ctx.save();
        drawRoundedRectPath(ctx, px, py, pw, ph, 22);
        ctx.fillStyle = 'rgba(20,20,24,0.9)';
        ctx.fill();
        ctx.strokeStyle = i === 0 ? 'rgba(255,122,89,0.9)' : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 3;
        ctx.stroke();
        if (img) {
            drawRoundedRectPath(ctx, px + 7, py + 7, pw - 14, ph - 14, 17);
            ctx.clip();
            ctx.drawImage(img, px + 7, py + 7, pw - 14, ph - 14);
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = `900 64px ${FONT_STACK}`;
            ctx.fillText('🎬', px + pw / 2 - 32, py + ph / 2 + 20);
        }
        ctx.restore();
        // Badge rang
        drawRoundedRectPath(ctx, px + 12, py + 12, 56, 34, 17);
        ctx.fillStyle = i === 0 ? '#ff7a59' : 'rgba(10,10,12,0.85)';
        ctx.fill();
        ctx.fillStyle = i === 0 ? '#190d0b' : '#ffffff';
        ctx.font = `900 20px ${FONT_STACK}`;
        ctx.fillText(`#${i + 1}`, px + 26, py + 36);
        px += pw + gap;
    });

    // Bloc crédits façon affiche
    let cy = 1108;
    const creditLine = (label: string, value: string, valueSize = 26) => {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = `800 17px ${FONT_STACK}`;
        center(label, cy);
        cy += 34;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `800 ${valueSize}px ${FONT_STACK}`;
        const lines = wrapCanvasText(ctx, value, width - 220).slice(0, 2);
        lines.forEach((line) => { center(line, cy); cy += valueSize + 8; });
        cy += 18;
    };

    creditLine('AVEC', data.topTitles.slice(0, 5).join(' · ').toUpperCase(), 24);
    creditLine('GENRE DE L\'ANNÉE', (data.topGenreName || '—').toUpperCase());
    creditLine('UN FILM DE', 'TOI');

    // Pied : stats + domaine
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `700 22px ${FONT_STACK}`;
    center(`${data.uniqueTitles} TITRES  ·  ${data.totalSessions} SESSIONS  ·  ${data.watchTimeLabel}`, 1492);
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.font = `600 24px ${FONT_STACK}`;
    center('movix.date', 1556);

    return toBlob(canvas);
}

// ────────────────────────────────────────────────────────────────────────────
// FORMAT C — BILLET DE CINÉ (1080×1920, ticket centré)
// ────────────────────────────────────────────────────────────────────────────
export async function generateTicketShareImage(data: WrappedShareCardData): Promise<Blob | null> {
    await ensureShareFonts();
    const width = 1080, height = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Fond sombre + glows + stickers (cohérent avec le format story)
    ctx.fillStyle = '#070708';
    ctx.fillRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width / 2, 320, 30, width / 2, 320, 560);
    glow.addColorStop(0, 'rgba(255, 95, 86, 0.22)');
    glow.addColorStop(1, 'rgba(255, 95, 86, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    const glow2 = ctx.createRadialGradient(width * 0.8, height * 0.85, 30, width * 0.8, height * 0.85, 480);
    glow2.addColorStop(0, 'rgba(78, 205, 196, 0.16)');
    glow2.addColorStop(1, 'rgba(78, 205, 196, 0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, width, height);
    drawSeededStickers(ctx, width, height, data.seed, 28);

    // Ticket papier
    const tx = 130, ty = 290, tw = width - 260, th = 1340;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 26;
    drawRoundedRectPath(ctx, tx, ty, tw, th, 36);
    ctx.fillStyle = '#f5efe2';
    ctx.fill();
    ctx.restore();

    // Perforations latérales (cercles couleur fond)
    ctx.fillStyle = '#070708';
    for (let y = ty + 60; y < ty + th - 40; y += 64) {
        ctx.beginPath(); ctx.arc(tx, y, 11, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(tx + tw, y, 11, 0, Math.PI * 2); ctx.fill();
    }

    const ink = '#1d1a16';
    const inkSoft = 'rgba(29,26,22,0.55)';
    const centerInTicket = (text: string, y: number) => ctx.fillText(text, tx + (tw - ctx.measureText(text).width) / 2, y);

    // En-tête ticket
    ctx.fillStyle = ink;
    ctx.font = `400 58px ${DISPLAY_FONT}`;
    centerInTicket(`MOVIX WRAPPED`, ty + 116);
    ctx.font = `400 100px ${DISPLAY_FONT}`;
    centerInTicket(String(data.year), ty + 226);
    ctx.fillStyle = inkSoft;
    ctx.font = `800 24px ${FONT_STACK}`;
    centerInTicket('★  A D M I T   O N E  ★', ty + 286);

    // Ligne déchirure
    ctx.strokeStyle = 'rgba(29,26,22,0.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(tx + 40, ty + 330);
    ctx.lineTo(tx + tw - 40, ty + 330);
    ctx.stroke();
    ctx.setLineDash([]);

    // Champs du billet
    let fy = ty + 412;
    const field = (label: string, value: string, big = false) => {
        ctx.fillStyle = inkSoft;
        ctx.font = `800 19px ${FONT_STACK}`;
        centerInTicket(label, fy);
        fy += big ? 56 : 46;
        ctx.fillStyle = ink;
        ctx.font = big ? `900 44px ${FONT_STACK}` : `900 34px ${FONT_STACK}`;
        const lines = wrapCanvasText(ctx, value, tw - 120).slice(0, 2);
        lines.forEach((line) => { centerInTicket(line, fy); fy += big ? 52 : 42; });
        fy += 30;
    };

    field('FILM / SÉRIE DE L\'ANNÉE', data.topTitles[0] ? `« ${data.topTitles[0]} »` : '—', true);
    field('DURÉE TOTALE', data.watchTimeLabel);

    // Rangée SALLE / SIÈGE / SÉANCE
    const cols = [
        { label: 'SALLE', value: String(data.peakMonthIndex).padStart(2, '0') },
        { label: 'SIÈGE', value: `${data.longestStreak}J` },
        { label: 'SÉANCE', value: data.peakHour != null ? `${data.peakHour}H` : '—' },
    ];
    const colW = (tw - 160) / 3;
    cols.forEach((c, i) => {
        const cx = tx + 80 + i * colW;
        ctx.fillStyle = inkSoft;
        ctx.font = `800 19px ${FONT_STACK}`;
        ctx.fillText(c.label, cx + (colW - ctx.measureText(c.label).width) / 2, fy);
        ctx.fillStyle = ink;
        ctx.font = `900 46px ${FONT_STACK}`;
        ctx.fillText(c.value, cx + (colW - ctx.measureText(c.value).width) / 2, fy + 58);
    });
    fy += 130;

    field('GENRE', (data.topGenreName || '—').toUpperCase());

    // Rangée TITRES / SESSIONS (comble l'espace mort avant le code-barres)
    const cols2 = [
        { label: 'TITRES', value: String(data.uniqueTitles) },
        { label: 'SESSIONS', value: String(data.totalSessions) },
    ];
    const col2W = (tw - 160) / 2;
    cols2.forEach((c, i) => {
        const cx = tx + 80 + i * col2W;
        ctx.fillStyle = inkSoft;
        ctx.font = `800 19px ${FONT_STACK}`;
        ctx.fillText(c.label, cx + (col2W - ctx.measureText(c.label).width) / 2, fy);
        ctx.fillStyle = ink;
        ctx.font = `900 46px ${FONT_STACK}`;
        ctx.fillText(c.value, cx + (col2W - ctx.measureText(c.value).width) / 2, fy + 58);
    });
    fy += 130;

    // Persona
    ctx.fillStyle = ink;
    ctx.font = `800 30px ${FONT_STACK}`;
    centerInTicket(`${data.personaEmoji}  ${data.personaTitle}`, fy);

    // Code-barres (seedé — barre garantie à chaque pas, gap borné : pas de gros trous)
    const rand = mulberry32(data.seed + 7);
    const barAreaW = tw - 240;
    let bx = tx + 120;
    const barY = ty + th - 196;
    ctx.fillStyle = ink;
    while (bx < tx + 120 + barAreaW) {
        const bw = 2 + Math.floor(rand() * 8);
        ctx.fillRect(bx, barY, bw, 86);
        bx += bw + 4 + Math.floor(rand() * 6);
    }
    ctx.fillStyle = inkSoft;
    ctx.font = `700 24px ${FONT_STACK}`;
    centerInTicket('movix.date', ty + th - 66);

    return toBlob(canvas);
}
