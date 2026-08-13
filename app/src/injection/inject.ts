import { Platform } from 'react-native';
import { buildBridgeRuntime } from './bridge-runtime';
import { buildCastShim } from './cast-shim';
import { buildMediaSession } from './media-session';
import { buildPictureInPictureShim } from './picture-in-picture-shim';
import { buildPlaybackAwakeShim } from './playback-awake-shim';
import { buildPopupRedirectScript } from './popup-redirect';
import { buildStorageCaptureScript, buildStorageRestoreScript } from './site-storage-sync';
import { USERSCRIPT_SOURCE } from './userscript-source';

export interface InjectOptions {
  /**
   * Quand false, le userscript Movix n'est PAS injecté : le site ne détecte
   * alors plus l'extension (drapeaux __MOVIX_EXTENSION_INSTALLED, etc.) et
   * n'essaie pas de router ses requêtes via le proxy natif. Il retombe sur
   * son propre chemin réseau — utile pour les sources que le proxy casse.
   *
   * Le bridge runtime et le cast shim restent injectés (capture console de
   * debug + Chromecast).
   */
  proxyEnabled?: boolean;
  /**
   * iOS uniquement. 'airplay' (défaut) : le cast shim n'est PAS injecté —
   * le site ne voit pas MovixAndroidCast et affiche le bouton AirPlay natif.
   * 'chromecast' : le shim est injecté et le module natif iOS Cast prend le
   * relais pour router vers Chromecast.
   */
  castMode?: 'airplay' | 'chromecast';
  /**
   * Android uniquement : expose une surface Web Picture-in-Picture adossée au
   * PiP natif de l'Activity (le WebView système n'implémente pas l'API Web).
   * Sur iOS, WebKit fournit déjà `requestPictureInPicture()`.
   */
  pictureInPictureEnabled?: boolean;
  /**
   * Instantané localStorage du précédent domaine actif (cf. site-storage-sync) —
   * réinjecté si le domaine en cours n'a pas déjà sa propre session, pour
   * survivre aux changements de domaine miroir sans déconnexion.
   */
  storageSnapshot?: Record<string, string> | null;
}

export function buildInjectedJavaScript(options: InjectOptions = {}): string {
  const {
    proxyEnabled = true,
    castMode = 'airplay',
    pictureInPictureEnabled = false,
    storageSnapshot,
  } = options;
  const bridge = buildBridgeRuntime();
  const mediaSession = buildMediaSession();
  const pipShim = buildPictureInPictureShim(pictureInPictureEnabled === true);
  const playbackAwakeShim = buildPlaybackAwakeShim();
  const storageRestore = buildStorageRestoreScript(storageSnapshot);
  const storageCapture = buildStorageCaptureScript();
  const popupRedirect = buildPopupRedirectScript();

  const userscript = proxyEnabled
    ? `// --- Userscript Movix ---\n${USERSCRIPT_SOURCE}`
    : '// --- Userscript Movix non injecté (proxy intégré désactivé) ---';

  // Sur iOS en mode AirPlay, on n'injecte pas le shim Cast : le site ne détecte
  // pas MovixAndroidCast et affiche le bouton AirPlay natif de WebKit.
  // Sur Android et iOS/Chromecast, le shim est toujours présent.
  const injectCastShim = Platform.OS !== 'ios' || castMode === 'chromecast';
  const castShimBlock = injectCastShim ? buildCastShim() : '// Cast shim omis (AirPlay mode)';

  // Restauration de session AVANT tout : doit écrire dans localStorage avant
  // que le moindre script du site n'y lise quoi que ce soit.
  // Cast shim ensuite — must be on window before any page JS runs.
  // Media Session : toujours injecté (jaquette notif + contrôles écran
  // verrouillé + auto-PiP iOS), indépendant du proxy.
  return `
${storageRestore}

${popupRedirect}

${castShimBlock}

${pipShim}

${playbackAwakeShim}

${bridge}

${mediaSession}

${storageCapture}

${userscript}

true;
`;
}
