import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useWebHaptics } from 'web-haptics/react';
import { useTranslation } from 'react-i18next';
import { useIntro } from '../context/IntroContext';

interface IntroAnimationProps {
  onAnimationComplete: () => void;
}

/* ============================================================
   Title card façon Breaking Bad :
   brume teal + fumée turbulente (feTurbulence) → formules 3D
   qui passent devant la caméra → fragment réel du tableau
   périodique (périodes 4-6) → ignition en cascade de
   Mo (42) · V (23) · I (53) · Xe (54) — les 4 vrais éléments
   qui épellent MOVIX — le reste se dissout → glissé FLIP des
   4 tuiles vers le wordmark → glint spéculaire → tagline →
   fumée qui avale l'écran.
   ============================================================ */

type El = [symbol: string, number: number];

const P4: El[] = [['Ti', 22], ['V', 23], ['Cr', 24], ['Mn', 25], ['Fe', 26], ['Co', 27], ['Ni', 28], ['Cu', 29], ['Zn', 30], ['Ga', 31], ['Ge', 32], ['As', 33], ['Se', 34], ['Br', 35], ['Kr', 36]];
const P5: El[] = [['Zr', 40], ['Nb', 41], ['Mo', 42], ['Tc', 43], ['Ru', 44], ['Rh', 45], ['Pd', 46], ['Ag', 47], ['Cd', 48], ['In', 49], ['Sn', 50], ['Sb', 51], ['Te', 52], ['I', 53], ['Xe', 54]];
const P6: El[] = [['Hf', 72], ['Ta', 73], ['W', 74], ['Re', 75], ['Os', 76], ['Ir', 77], ['Pt', 78], ['Au', 79], ['Hg', 80], ['Tl', 81], ['Pb', 82], ['Bi', 83], ['Po', 84], ['At', 85], ['Rn', 86]];
const ROWS: El[][] = [P4, P5, P6];

// Ignition en cascade dans l'ordre de lecture
const IGNITE_DELAY: Record<string, string> = { Mo: '0s', V: '0.14s', I: '0.28s', Xe: '0.42s' };

// Tuiles du wordmark : délais de glissé (--gld) et de glint (--gt)
const TILES = [
  { sym: 'Mo', num: 42, gld: '0s', gt: '0s' },
  { sym: 'V', num: 23, gld: '0.07s', gt: '0.1s' },
  { sym: 'I', num: 53, gld: '0.14s', gt: '0.2s' },
  { sym: 'Xe', num: 54, gld: '0.21s', gt: '0.3s' },
] as const;

// Délais de dissolution pseudo-aléatoires stables (pas de Math.random au render)
const DISSOLVE_DELAYS = Array.from({ length: 45 }, (_, i) => ((i * 37 + 11) % 29) / 100);

// [layer, taille vmin, left %, top %, rgb, opacité, variante, durée s, délai s, caché mobile]
const SMOKES: readonly [string, number, number, number, string, number, 'A' | 'B', number, number, boolean][] = [
  ['back', 74, -14, 44, '44,108,78', 0.17, 'A', 17, 0, false],
  ['back', 58, 62, -16, '36,94,66', 0.14, 'B', 21, -6, true],
  ['back', 68, 68, 56, '48,116,84', 0.15, 'A', 19, -11, false],
  ['back', 52, 16, 66, '56,128,96', 0.13, 'B', 15, -3, true],
  ['back', 46, 36, 6, '42,102,74', 0.12, 'A', 23, -9, false],
  ['front', 48, 4, 10, '96,172,130', 0.12, 'B', 13, -2, false],
  ['front', 56, 64, 28, '88,162,122', 0.105, 'A', 16, -7, false],
  ['front', 46, 28, 68, '104,182,138', 0.115, 'B', 12, -5, false],
];

// [texte, formule ?, left %, top %, taille px, délai s, durée s, opacité, sx, sy, ex, ey, z0 px, z1 px, caché mobile]
const FORMULAS: readonly [string, boolean, number, number, number, number, number, number, string, string, string, string, number, number, boolean][] = [
  ['CH3', true, 18, 24, 26, 0.2, 2.2, 0.8, '3vw', '2vh', '-12vw', '-6vh', -430, 430, false],
  ['C2H5OH', true, 66, 18, 21, 0.5, 2.3, 0.7, '-3vw', '3vh', '11vw', '-8vh', -380, 460, false],
  ['H2O', true, 36, 68, 24, 0.35, 2.0, 0.75, '2vw', '-2vh', '-8vw', '10vh', -460, 400, false],
  ['CO2', true, 80, 60, 17, 0.85, 2.2, 0.6, '-2vw', '-3vh', '9vw', '8vh', -350, 480, true],
  ['C8H10N4O2', true, 22, 44, 19, 1.0, 2.4, 0.65, '3vw', '2vh', '-12vw', '4vh', -400, 420, false],
  ['CH3NH2', true, 58, 12, 18, 1.15, 2.1, 0.6, '1vw', '3vh', '7vw', '-9vh', -420, 440, true],
  ['95.95', false, 56, 76, 15, 1.25, 2.0, 0.55, '1vw', '2vh', '7vw', '9vh', -320, 380, false],
  ['50.942', false, 12, 34, 14, 1.4, 1.9, 0.5, '2vw', '1vh', '-6vw', '5vh', -360, 360, true],
  ['126.90', false, 84, 36, 14, 1.05, 2.0, 0.5, '-2vw', '1vh', '6vw', '-5vh', -340, 380, true],
  ['NaCl', false, 8, 58, 16, 1.5, 2.0, 0.5, '2vw', '1vh', '-7vw', '7vh', -380, 400, false],
  ['C6H12O6', true, 72, 42, 22, 1.4, 2.3, 0.65, '-4vw', '0vh', '12vw', '-4vh', -440, 430, false],
  ['O2', true, 30, 12, 14, 1.65, 1.9, 0.5, '2vw', '3vh', '-5vw', '-9vh', -300, 420, false],
  ['N2', true, 46, 84, 15, 1.75, 1.8, 0.5, '1vw', '-2vh', '5vw', '8vh', -340, 400, true],
  ['CH4', true, 88, 78, 18, 1.6, 2.0, 0.55, '-3vw', '-2vh', '8vw', '6vh', -400, 440, false],
  ['C12H22O11', true, 40, 32, 16, 1.85, 2.1, 0.55, '2vw', '2vh', '-9vw', '-3vh', -420, 400, false],
];

// [opacité max, délai s, taille vmax, left %, top %, rgb, texturé]
const PUFFS: readonly [number, number, number, number, number, string, boolean][] = [
  [0.68, 0, 120, 74, 88, '214,240,222', false],
  [0.60, 0.1, 96, 88, 66, '188,226,200', false],
  [0.52, 0.14, 80, 70, 92, '206,238,218', true],
  [0.64, 0.18, 110, 60, 100, '200,232,210', false],
  [0.50, 0.24, 66, 90, 78, '196,230,208', true],
  [0.55, 0.28, 84, 96, 88, '170,214,186', false],
  [0.66, 0.36, 130, 80, 110, '206,236,216', false],
];

// "C8H10N4O2" -> C<sub>8</sub>H<sub>10</sub>… (uniquement pour les formules)
const fmtFormula = (s: string, isFormula: boolean): React.ReactNode =>
  isFormula
    ? s.split(/(\d+)/).map((seg, i) => (/^\d+$/.test(seg) ? <sub key={i}>{seg}</sub> : seg))
    : s;

const IntroAnimation: React.FC<IntroAnimationProps> = ({ onAnimationComplete }) => {
  const { t } = useTranslation();
  const { skipIntro } = useIntro();
  const { trigger: haptic } = useWebHaptics();

  // -1 ambiance | 1 tableau | 2 ignition | 3 dissolution | 4 glide |
  // 5 posé + glint | 6 tagline | 7 wisp | 8 fumée | 9 fondu sortie
  const [step, setStep] = useState(-1);

  const reduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const gridRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const finish = useCallback(() => {
    document.body.style.overflow = '';
    onAnimationComplete();
  }, [onAnimationComplete]);

  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const vibe = useCallback((pattern: number[], strength: 'medium' | 'heavy') => {
    if (canVibrate) navigator.vibrate(pattern);
    else haptic(strength as never);
  }, [canVibrate, haptic]);

  // Verrouillage du scroll pendant l'intro
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Timeline
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };

    if (reduced) {
      // Version statique : wordmark + tagline, sortie rapide
      at(50, () => setStep(6));
      at(2400, finish);
      return () => timers.forEach(clearTimeout);
    }

    at(2600, () => setStep(1));
    at(3400, () => { setStep(2); vibe([25, 80, 25, 80, 25, 80, 25], 'medium'); });
    at(3900, () => setStep(3));
    at(4700, () => setStep(4));
    at(5650, () => { setStep(5); vibe([90, 40, 130], 'heavy'); });
    at(6150, () => { setStep(6); vibe([30], 'medium'); });
    at(6900, () => setStep(7));
    at(7300, () => setStep(8));
    at(7950, () => setStep(9));
    at(8700, finish);

    return () => timers.forEach(clearTimeout);
  }, [finish, vibe, reduced]);

  // FLIP : mesure des cases de la grille -> variables CSS des tuiles du logo.
  // Posé avant le premier paint du step 4, bbTileGlide lit --dx/--dy/--s.
  useLayoutEffect(() => {
    if (step !== 4 || reduced) return;
    TILES.forEach(({ sym }) => {
      const from = gridRefs.current[sym];
      const to = tileRefs.current[sym];
      if (!from || !to) return;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      to.style.setProperty('--dx', `${a.left - b.left}px`);
      to.style.setProperty('--dy', `${a.top - b.top}px`);
      to.style.setProperty('--s', String(a.width / b.width));
    });
  }, [step, reduced]);

  return (
    <div
      className={`fixed inset-0 z-[99999] overflow-hidden transition-opacity duration-700 ease-out
        ${step >= 9 ? 'opacity-0 pointer-events-none' : 'opacity-100'}
        ${reduced ? 'bb-rm' : ''}`}
      style={{
        background: '#010806',
        height: '100dvh',
        touchAction: 'none',
        WebkitTapHighlightColor: 'transparent',
        '--cell': 'clamp(17px, 4.6vw, 44px)',
        '--tile': 'clamp(52px, 12vw, 104px)',
        '--bb-hi': '#0b7a44',
        '--bb': '#026635',
        '--bb-lo': '#014b27',
      } as React.CSSProperties}
    >
      <style>{KEYFRAMES}</style>

      {/* Filtres de turbulence pour la fumée volumétrique */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <filter id="bbTurbA" x="-35%" y="-35%" width="170%" height="170%">
            <feTurbulence type="fractalNoise" baseFrequency="0.011 0.016" numOctaves="3" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="110" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="bbTurbB" x="-35%" y="-35%" width="170%" height="170%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02 0.028" numOctaves="2" seed="3" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="70" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      <div className="bb-scene">
        {/* Brume de fond — grade teal */}
        <div className="bb-haze" />

        {/* Fumée turbulente (2 couches) */}
        {SMOKES.map(([layer, size, l, tp, rgb, op, anim, dur, delay, mHide], i) => (
          <div
            key={i}
            className={`bb-smoke ${layer}${mHide ? ' bb-m-hide' : ''}`}
            style={{
              width: `${size}vmin`,
              height: `${size}vmin`,
              left: `${l}%`,
              top: `${tp}%`,
              background: `radial-gradient(circle, rgba(${rgb},${op}) 0%, rgba(${rgb},${op * 0.55}) 38%, transparent 68%)`,
              animation: `bbSmoke${anim} ${dur}s ease-in-out ${delay}s infinite alternate`,
            }}
          />
        ))}

        {/* Formules chimiques en 3D vers la caméra */}
        {!reduced && (
          <div className="bb-formulas">
            {FORMULAS.map(([txt, isF, l, tp, size, delay, dur, op, sx, sy, ex, ey, z0, z1, mHide]) => (
              <div
                key={txt}
                className={`bb-formula${mHide ? ' bb-m-hide' : ''}`}
                style={{ left: `${l}%`, top: `${tp}%`, fontSize: size }}
              >
                <span
                  className="inner"
                  style={{
                    '--delay': `${delay}s`, '--dur': `${dur}s`, '--op': op,
                    '--sx': sx, '--sy': sy, '--ex': ex, '--ey': ey,
                    '--z0': `${z0}px`, '--z1': `${z1}px`,
                  } as React.CSSProperties}
                >
                  {fmtFormula(txt, isF)}
                </span>
              </div>
            ))}
            {/* Le beat "Xe · 131.293" — l'élément qui signe le X */}
            <div className="bb-formula hero">
              <span
                className="inner"
                style={{
                  '--delay': '1.55s', '--dur': '1.8s', '--op': 0.97,
                  '--sx': '-2vw', '--sy': '1vh', '--ex': '4vw', '--ey': '-5vh',
                  '--z0': '-160px', '--z1': '230px',
                } as React.CSSProperties}
              >
                Xe<span className="weight">131.293</span>
              </span>
            </div>
          </div>
        )}

        {/* Fragment du tableau périodique */}
        {!reduced && step >= 1 && (
          <div className={`bb-table visible${step >= 3 ? ' dissolve' : ''}`}>
            <div className="bb-grid">
              {ROWS.flatMap((row, ri) =>
                row.map(([sym, num], ci) => {
                  const keep = sym in IGNITE_DELAY;
                  return (
                    <div
                      key={sym}
                      ref={keep ? (el) => { gridRefs.current[sym] = el; } : undefined}
                      className={`bb-cell${keep ? ' keep' : ''}${keep && step >= 2 ? ' lit' : ''}`}
                      style={{
                        '--dd': `${DISSOLVE_DELAYS[ri * 15 + ci]}s`,
                        '--ig': keep ? IGNITE_DELAY[sym] : undefined,
                        visibility: keep && step >= 4 ? 'hidden' : undefined,
                      } as React.CSSProperties}
                    >
                      <span className="num">{num}</span>
                      <span className="sym">{sym}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Wordmark [Mo][V][I][Xe] + tagline */}
        <div className={`bb-logo${step >= 8 ? ' consumed' : ''}`}>
          <div className={`bb-logo-inner${!reduced && step >= 5 ? ' afloat' : ''}`}>
            <div className="bb-wordmark">
              {TILES.map(({ sym, num, gld, gt }) => (
                <div
                  key={sym}
                  ref={(el) => { tileRefs.current[sym] = el; }}
                  className={`bb-tile${!reduced && step >= 4 ? ' glide' : ''}${!reduced && step >= 5 ? ' landed' : ''}`}
                  style={{ '--gld': gld, '--gt': gt } as React.CSSProperties}
                >
                  <span className="num">{num}</span>
                  <span className="sym">{sym}</span>
                </div>
              ))}
            </div>
            <div className={`bb-tagline${step >= 6 ? ' in' : ''}`}>{t('introAnimation.tagline')}</div>
          </div>
        </div>

        {/* Wisp de fumée qui traverse le logo */}
        {!reduced && <div className={`bb-wisp${step >= 7 ? ' go' : ''}`} />}

        <div className="bb-vignette" />
        <div className="bb-grain" />
      </div>

      {/* Fumée finale qui avale le titre */}
      {!reduced && (
        <div className={`bb-consume${step >= 8 ? ' go' : ''}`}>
          {PUFFS.map(([po, pd, size, l, tp, rgb, tex], i) => (
            <div
              key={i}
              className={`bb-puff${tex ? ' tex' : ''}`}
              style={{
                '--po': po,
                '--pd': `${pd}s`,
                width: `${size}vmax`,
                height: `${size}vmax`,
                left: `calc(${l}% - ${size / 2}vmax)`,
                top: `calc(${tp}% - ${size / 2}vmax)`,
                background: `radial-gradient(circle, rgba(${rgb},0.85) 0%, rgba(${rgb},0.4) 42%, transparent 68%)`,
              } as React.CSSProperties}
            />
          ))}
        </div>
      )}

      {/* Passer */}
      <button
        onClick={() => { haptic('selection'); skipIntro(); }}
        className="absolute top-5 right-5 sm:top-6 sm:right-6 text-white/20 hover:text-white/60 text-[10px] sm:text-xs
                  px-3 py-1.5 sm:px-4 sm:py-2 transition-all duration-300 hover:bg-white/5 rounded
                  border border-white/[0.06] hover:border-white/15 z-[100000] font-mono tracking-widest uppercase"
      >
        {t('introAnimation.skip')}
      </button>
    </div>
  );
};

/* ============================================================
   CSS — title card Breaking Bad v2
   ============================================================ */
const KEYFRAMES = `
  .bb-scene { position: absolute; inset: 0; animation: bbCameraPull 8.8s cubic-bezier(0.25, 0.1, 0.25, 1) forwards; }
  @keyframes bbCameraPull { 0% { transform: scale(1.09); } 100% { transform: scale(1); } }

  .bb-haze {
    position: absolute; inset: 0;
    background:
      radial-gradient(120vmax 90vmax at 38% 42%, rgba(10,62,46,0.36) 0%, transparent 60%),
      radial-gradient(90vmax 70vmax at 70% 68%, rgba(6,44,36,0.32) 0%, transparent 65%),
      radial-gradient(70vmax 55vmax at 20% 85%, rgba(8,50,38,0.25) 0%, transparent 60%),
      #010806;
  }
  .bb-vignette {
    position: absolute; inset: 0; z-index: 9; pointer-events: none;
    background: radial-gradient(ellipse at center, transparent 32%, rgba(0,0,0,0.64) 80%, rgba(0,0,0,0.9) 100%);
  }
  .bb-grain {
    position: absolute; inset: -50%; z-index: 10; pointer-events: none;
    opacity: 0.055;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    animation: bbGrainShift 0.9s steps(3) infinite;
  }
  @keyframes bbGrainShift {
    0% { transform: translate(0,0); } 33% { transform: translate(-6%,4%); }
    66% { transform: translate(5%,-5%); } 100% { transform: translate(0,0); }
  }

  .bb-smoke { position: absolute; border-radius: 50%; will-change: transform; pointer-events: none; }
  .bb-smoke.back { z-index: 1; filter: url(#bbTurbA) blur(16px); }
  .bb-smoke.front { z-index: 5; filter: url(#bbTurbA) blur(14px); }
  @keyframes bbSmokeA {
    0% { transform: translate(0,0) rotate(0) scale(1); }
    50% { transform: translate(10vmin,-8vmin) rotate(40deg) scale(1.25); }
    100% { transform: translate(-7vmin,5vmin) rotate(-28deg) scale(0.92); }
  }
  @keyframes bbSmokeB {
    0% { transform: translate(0,0) rotate(0) scale(1); }
    50% { transform: translate(-12vmin,6vmin) rotate(-48deg) scale(1.32); }
    100% { transform: translate(8vmin,-7vmin) rotate(34deg) scale(0.88); }
  }

  .bb-formulas { position: absolute; inset: 0; z-index: 2; perspective: 900px; perspective-origin: 50% 46%; }
  .bb-formula {
    position: absolute;
    color: rgba(226,244,236,0.9);
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-weight: 500; letter-spacing: 0.05em; white-space: nowrap;
    text-shadow: 0 0 14px rgba(190,240,214,0.55);
  }
  .bb-formula sub { font-size: 0.62em; }
  .bb-formula .inner {
    display: inline-block; opacity: 0;
    animation: bbFlyBy var(--dur,2.2s) cubic-bezier(0.25,0.3,0.55,1) var(--delay,0s) forwards;
    will-change: transform, opacity;
  }
  @keyframes bbFlyBy {
    0% { opacity: 0; transform: translate3d(var(--sx),var(--sy),var(--z0,-420px)); filter: blur(2.5px); }
    18% { opacity: var(--op,0.85); filter: blur(0.6px); }
    58% { opacity: var(--op,0.85); filter: blur(0.3px); }
    100% { opacity: 0; transform: translate3d(var(--ex),var(--ey),var(--z1,420px)); filter: blur(4px); }
  }
  .bb-formula.hero {
    left: 50%; top: 28%; transform: translateX(-50%);
    font-size: clamp(24px, 5.2vw, 46px); font-weight: 700;
    color: rgba(242,252,246,0.97);
    text-shadow: 0 0 20px rgba(214,250,230,0.75), 0 0 80px rgba(120,220,165,0.45);
  }
  .bb-formula.hero .weight { font-size: 0.5em; font-weight: 400; opacity: 0.85; margin-left: 0.55em; letter-spacing: 0.1em; }

  .bb-table {
    position: absolute; inset: 0; z-index: 3;
    display: flex; align-items: center; justify-content: center;
    perspective: 1100px;
  }
  .bb-grid { display: grid; grid-template-columns: repeat(15, var(--cell)); gap: calc(var(--cell) * 0.13); opacity: 0; }
  .bb-table.visible .bb-grid { animation: bbTableIn 0.85s cubic-bezier(0.2,0.6,0.3,1) forwards; }
  @keyframes bbTableIn {
    from { opacity: 0; transform: rotateX(10deg) scale(1.07); }
    to { opacity: 1; transform: rotateX(0) scale(1); }
  }
  .bb-cell {
    position: relative; width: var(--cell); height: var(--cell);
    border: 1px solid rgba(146,220,176,0.20); border-radius: 2px;
    background: rgba(7,42,24,0.38);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: rgba(196,232,209,0.52);
  }
  .bb-cell .sym { font-size: calc(var(--cell) * 0.38); font-weight: 600; letter-spacing: -0.01em; }
  .bb-cell .num { position: absolute; top: 5%; left: 8%; font-size: calc(var(--cell) * 0.19); opacity: 0.75; }
  .bb-table.dissolve .bb-cell:not(.keep) { animation: bbCellOut 0.6s ease-out var(--dd,0s) forwards; }
  @keyframes bbCellOut { to { opacity: 0; filter: blur(2px); } }

  .bb-cell.keep.lit { z-index: 2; animation: bbIgnite 0.55s ease-out var(--ig,0s) both; }
  .bb-cell.keep.lit .num { opacity: 0.95; }
  @keyframes bbIgnite {
    0% {
      border-color: rgba(146,220,176,0.20);
      background: rgba(7,42,24,0.38);
      color: rgba(196,232,209,0.52);
      filter: brightness(1);
      box-shadow: none;
    }
    22% {
      border-color: rgba(255,255,255,1);
      background: linear-gradient(180deg, var(--bb-hi) 0%, var(--bb) 55%, var(--bb-lo) 100%);
      color: #fff;
      filter: brightness(3.4);
      box-shadow: 0 0 30px 8px rgba(140,240,180,0.55);
    }
    100% {
      border-color: rgba(250,255,252,0.92);
      background: linear-gradient(180deg, var(--bb-hi) 0%, var(--bb) 55%, var(--bb-lo) 100%);
      color: #fff;
      filter: brightness(1);
      box-shadow: 0 0 26px 5px rgba(96,214,148,0.4), 0 0 90px 12px rgba(40,160,95,0.25);
    }
  }

  .bb-logo {
    position: absolute; inset: 0; z-index: 4;
    display: flex; align-items: center; justify-content: center;
  }
  .bb-logo.consumed { animation: bbLogoConsumed 0.9s ease-in 0.15s forwards; }
  @keyframes bbLogoConsumed { to { opacity: 0; filter: blur(9px); } }
  .bb-logo-inner { display: flex; flex-direction: column; align-items: center; gap: clamp(18px, 4vh, 34px); }
  .bb-logo-inner.afloat { animation: bbLogoFloat 7s ease-in-out infinite; }
  @keyframes bbLogoFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-0.6vh); } }
  .bb-wordmark { display: flex; align-items: center; gap: calc(var(--tile) * 0.06); }

  .bb-tile {
    position: relative;
    width: var(--tile); height: var(--tile);
    border: 2px solid rgba(250,255,252,0.95); border-radius: 5px;
    background: linear-gradient(180deg, var(--bb-hi) 0%, var(--bb) 55%, var(--bb-lo) 100%);
    box-shadow:
      0 0 34px 6px rgba(96,214,148,0.34),
      0 0 110px 16px rgba(40,160,95,0.20),
      inset 0 1px 0 rgba(255,255,255,0.28),
      inset 0 -10px 22px rgba(0,30,12,0.35);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #fff;
    opacity: 0;
    transform-origin: top left;
    will-change: transform;
    overflow: hidden;
  }
  .bb-tile .sym {
    font-size: calc(var(--tile) * 0.46); font-weight: 700; letter-spacing: -0.02em;
    text-shadow: 0 0 16px rgba(255,255,255,0.35);
    transform: translateY(3%);
  }
  .bb-tile .num { position: absolute; top: 6.5%; left: 8.5%; font-size: calc(var(--tile) * 0.16); font-weight: 600; }

  .bb-tile::after {
    content: '';
    position: absolute; inset: -30%;
    background: linear-gradient(105deg, transparent 42%, rgba(255,255,255,0.42) 50%, transparent 58%);
    transform: translateX(-120%);
    opacity: 0;
  }
  .bb-tile.landed::after { animation: bbGlint 0.9s ease-out calc(var(--gt,0s) + 0.3s) forwards; }
  @keyframes bbGlint {
    0% { opacity: 1; transform: translateX(-120%) skewX(-8deg); }
    100% { opacity: 0.9; transform: translateX(120%) skewX(-8deg); }
  }

  .bb-tile.glide { animation: bbTileGlide 0.9s cubic-bezier(0.6,0.05,0.22,1) var(--gld,0s) both; }
  .bb-tile.glide.landed {
    animation:
      bbTileGlide 0.9s cubic-bezier(0.6,0.05,0.22,1) var(--gld,0s) both,
      bbTilePulse 3s ease-in-out 1.3s infinite;
  }
  @keyframes bbTileGlide {
    from { opacity: 1; transform: translate(var(--dx,0px),var(--dy,0px)) scale(var(--s,0.4)); }
    to { opacity: 1; transform: translate(0,0) scale(1); }
  }
  @keyframes bbTilePulse {
    0%, 100% { box-shadow: 0 0 34px 6px rgba(96,214,148,0.34), 0 0 110px 16px rgba(40,160,95,0.20), inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -10px 22px rgba(0,30,12,0.35); }
    50% { box-shadow: 0 0 46px 10px rgba(96,214,148,0.48), 0 0 150px 24px rgba(40,160,95,0.30), inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -10px 22px rgba(0,30,12,0.35); }
  }

  .bb-tagline {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: clamp(10px, 1.6vw, 14px);
    letter-spacing: 0.52em; text-indent: 0.52em; text-transform: uppercase;
    color: rgba(255,255,255,0); text-align: center; max-width: 94vw;
  }
  .bb-tagline.in { animation: bbTaglineIn 1s ease-out forwards; }
  @keyframes bbTaglineIn {
    0% { opacity: 0; color: rgba(255,255,255,0.55); transform: translateY(8px); letter-spacing: 0.75em; }
    100% { opacity: 1; color: rgba(255,255,255,0.55); transform: translateY(0); letter-spacing: 0.52em; }
  }

  .bb-wisp {
    position: absolute; z-index: 6; pointer-events: none;
    width: 120vw; height: 30vh;
    left: -10vw; top: 42%;
    background: radial-gradient(ellipse 60% 50% at 50% 50%, rgba(190,228,204,0.5) 0%, rgba(150,200,170,0.22) 45%, transparent 70%);
    filter: url(#bbTurbB) blur(20px);
    opacity: 0;
    will-change: transform, opacity;
  }
  .bb-wisp.go { animation: bbWispCross 2.6s cubic-bezier(0.3,0.2,0.6,1) forwards; }
  @keyframes bbWispCross {
    0% { opacity: 0; transform: translateX(-55vw) rotate(-2deg); }
    30% { opacity: 0.16; }
    70% { opacity: 0.13; }
    100% { opacity: 0; transform: translateX(60vw) rotate(2deg); }
  }

  .bb-consume { position: absolute; inset: 0; z-index: 8; pointer-events: none; }
  .bb-puff { position: absolute; border-radius: 50%; filter: blur(34px); opacity: 0; will-change: transform, opacity; }
  .bb-puff.tex { filter: url(#bbTurbB) blur(24px); }
  .bb-consume.go .bb-puff { animation: bbPuffIn 1.6s cubic-bezier(0.2,0.5,0.3,1) var(--pd,0s) forwards; }
  @keyframes bbPuffIn {
    0% { opacity: 0; transform: translate(26%,30%) scale(0.22) rotate(0); }
    28% { opacity: var(--po,0.6); }
    100% { opacity: var(--po,0.6); transform: translate(-14%,-16%) scale(2.2) rotate(22deg); }
  }

  @media (max-width: 560px) {
    .bb-cell .num { display: none; }
    .bb-tagline { font-size: 9px; letter-spacing: 0.32em; text-indent: 0.32em; }
    .bb-m-hide { display: none; }
    .bb-smoke.back, .bb-smoke.front { filter: blur(26px); }
    .bb-wisp { filter: blur(18px); }
    .bb-puff.tex { filter: blur(22px); }
  }

  /* Version reduced-motion : wordmark statique, aucune animation */
  .bb-rm .bb-scene, .bb-rm .bb-smoke, .bb-rm .bb-grain { animation: none !important; }
  .bb-rm .bb-tile { opacity: 1; }
  .bb-rm .bb-tagline.in { animation: none; opacity: 1; color: rgba(255,255,255,0.55); }
`;

export default IntroAnimation;
