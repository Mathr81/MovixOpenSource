import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { Linking, Platform } from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewMessageEvent,
  ShouldStartLoadRequest,
} from 'react-native-webview/lib/WebViewTypes';
import {
  clearBridgeCapabilities,
  handleBridgeMessage,
  refreshCastShimStatus,
  startCastShimEventForwarding,
  startPictureInPictureEventForwarding,
} from '../services/bridge';
import { setLocalPlaybackAwake } from '../services/playbackAwake';
import { setPictureInPicturePlaybackActive } from '../services/pictureInPicture';
import { buildInjectedJavaScript, type InjectOptions } from '../injection/inject';
import { CONFIG } from '../config';

export interface WebViewBrowserRef {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadUrl: (url: string) => void;
  injectJavaScript: (script: string) => void;
  refreshCastShimStatus: () => void;
}

interface WebViewBrowserProps {
  url: string;
  proxyEnabled?: boolean;
  castMode?: InjectOptions['castMode'];
  // Hôtes considérés comme "le site" (domaine actif + miroirs) : la navigation
  // y reste dans la WebView. Tout le reste (pubs, redirections tierces) est
  // ouvert dans le navigateur système — voir onShouldStartLoadWithRequest.
  allowedHosts?: string[];
  // Instantané localStorage du précédent domaine actif, réinjecté dans ce
  // domaine s'il n'a pas déjà sa propre session (cf. site-storage-sync).
  storageSnapshot?: Record<string, string> | null;
  onNavigationStateChange?: (state: WebViewNavigation) => void;
  onError?: (error: string) => void;
  onLoadEnd?: () => void;
  onMediaPlayback?: (playing: boolean) => void;
  onStorageSnapshot?: (data: Record<string, string>) => void;
  onPictureInPictureModeChange?: (active: boolean) => void;
}

// Domaines tiers légitimes qui doivent rester dans la WebView même s'ils ne
// font pas partie du site : OAuth (Discord/Google, cf. flux d'auth Movix) et
// Cloudflare Turnstile (anti-bot). Sans ça, le blocage des pubs casserait le
// login.
const AUXILIARY_ALLOWED_HOSTS = [
  'discord.com',
  'discordapp.com',
  'accounts.google.com',
  'challenges.cloudflare.com',
];

function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const all = [...allowedHosts, ...AUXILIARY_ALLOWED_HOSTS];
  return all.some(
    host => hostname === host || hostname.endsWith(`.${host}`),
  );
}

function isUsableHttpUrl(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && !/[\u0000-\u0020\\]/.test(value)
    && /^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)
  );
}

const WebViewBrowser = forwardRef<WebViewBrowserRef, WebViewBrowserProps>(
  (
    {
      url,
      proxyEnabled = true,
      castMode,
      allowedHosts = [],
      storageSnapshot,
      onNavigationStateChange,
      onError,
      onLoadEnd,
      onMediaPlayback,
      onStorageSnapshot,
      onPictureInPictureModeChange,
    },
    ref,
  ) => {
    const webViewRef = useRef<WebView>(null);
    const topLevelUrlRef = useRef(url);
    const injectedJS = useMemo(
      () =>
        buildInjectedJavaScript({
          proxyEnabled,
          castMode,
          pictureInPictureEnabled:
            Platform.OS === 'android' && Number(Platform.Version) >= 26,
          storageSnapshot,
        }),
      // storageSnapshot volontairement hors deps : il n'est lu qu'au premier
      // rendu du document, une remontée d'instantané ne doit pas réinjecter le
      // script (ce qui rechargerait la WebView en cours de session).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [proxyEnabled, castMode],
    );

    React.useEffect(() => {
      topLevelUrlRef.current = url;
    }, [url]);

    React.useEffect(() => {
      const stopCastStatusForwarding = startCastShimEventForwarding(webViewRef);
      const stopPictureInPictureForwarding = startPictureInPictureEventForwarding(
        webViewRef,
        event => {
          if (event.kind === 'prepare') onPictureInPictureModeChange?.(true);
          if (event.kind === 'state') onPictureInPictureModeChange?.(event.active);
          if (event.kind === 'error') onPictureInPictureModeChange?.(false);
        },
      );
      return () => {
        clearBridgeCapabilities(webViewRef);
        stopCastStatusForwarding();
        stopPictureInPictureForwarding();
        setPictureInPicturePlaybackActive(false);
        setLocalPlaybackAwake(false);
      };
    }, [onPictureInPictureModeChange]);

    useImperativeHandle(ref, () => ({
      goBack: () => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.goBack();
      },
      goForward: () => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.goForward();
      },
      reload: () => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.reload();
      },
      loadUrl: (newUrl: string) => {
        clearBridgeCapabilities(webViewRef);
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(newUrl)}; true;`,
        );
      },
      injectJavaScript: (script: string) => {
        webViewRef.current?.injectJavaScript(script);
      },
      refreshCastShimStatus: () => {
        void refreshCastShimStatus(webViewRef);
      },
    }));

    const onMessage = useCallback((event: WebViewMessageEvent) => {
      const isTopFrame = event.nativeEvent.isTopFrame === true;
      const reportedSourceUrl =
        typeof event.nativeEvent.url === 'string' ? event.nativeEvent.url : '';
      const hasUsableReportedOrigin = isUsableHttpUrl(reportedSourceUrl);
      const sourceUrl = hasUsableReportedOrigin
        ? reportedSourceUrl
        : isTopFrame
          ? topLevelUrlRef.current
          : '';
      handleBridgeMessage(event.nativeEvent.data, webViewRef, {
        sourceUrl,
        trustedOrigins: [url],
        isTopFrame: event.nativeEvent.isTopFrame === true,
        onMediaPlayback,
        onStorageSnapshot,
      });
    }, [url, onMediaPlayback, onStorageSnapshot]);

    const onHttpError = useCallback(
      (event: any) => {
        onError?.(
          `HTTP ${event.nativeEvent.statusCode}: ${event.nativeEvent.url}`,
        );
      },
      [onError],
    );

    // Filtrage des schémas : le web reste dans la WebView, le reste part vers
    // l'app correspondante (deep links).
    const allowNavigation = useCallback(
      (request: ShouldStartLoadRequest) => {
        const { url, navigationType, isTopFrame } = request;
        if (url.startsWith('about:') || url.startsWith('blob:')) {
          return true;
        }
        if (url.startsWith('https://') || url.startsWith('http://')) {
          let hostname = '';
          try {
            hostname = new URL(url).hostname;
          } catch {
            return true;
          }
          // isTopFrame n'est fiable que sur iOS (Android le force toujours à
          // true) — y laisser passer les sous-frames hors site (captcha,
          // embeds) sans les bloquer ; sur Android cette distinction n'existe
          // pas, on s'appuie alors uniquement sur l'allowlist d'hôtes.
          if (!hostname || !isTopFrame || isAllowedHost(hostname, allowedHosts)) {
            return true;
          }
          // Hôte hors site (pub, redirection tierce) : ouvert dans le
          // navigateur système plutôt que dans la WebView, qui sinon piège
          // l'utilisateur sans moyen fiable de revenir en arrière.
          Linking.openURL(url).catch(() => {});
          return false;
        }
        // Ouvre uniquement les deep links déclenchés par un vrai clic utilisateur.
        // Les redirections automatiques (pubs, iframes) sont silencieusement bloquées.
        if (navigationType === 'click') {
          Linking.openURL(url).catch(() => {});
        }
        return false;
      },
      [allowedHosts],
    );

    const onWebViewError = useCallback(
      (event: WebViewErrorEvent) => {
        onError?.(event.nativeEvent.description);
      },
      [onError],
    );

    const userAgent =
      Platform.OS === 'ios' ? CONFIG.USER_AGENT_IOS : CONFIG.USER_AGENT;

    return (
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={{ flex: 1, backgroundColor: '#0a0a0a' }}
        // Injection du bridge + userscript avant le chargement
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        // Réinjection après chaque navigation
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={true}
        // Bridge messages
        onMessage={onMessage}
        // Navigation
        onShouldStartLoadWithRequest={(request) => {
          // Une navigation de la frame principale invalide les capabilities du
          // document précédent (cast shim, PiP shim) et met à jour l'origine de
          // confiance utilisée pour valider les messages du bridge.
          if (request.isTopFrame !== false) {
            if (isUsableHttpUrl(request.url)) {
              topLevelUrlRef.current = request.url;
            }
            clearBridgeCapabilities(webViewRef);
          }
          return allowNavigation(request);
        }}
        onNavigationStateChange={onNavigationStateChange}
        // Errors
        onError={onWebViewError}
        onHttpError={onHttpError}
        onLoadEnd={onLoadEnd}
        // Config
        userAgent={userAgent}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        allowsFullscreenVideo={true}
        // Picture-in-Picture : permet de garder la vidéo flottante quand on
        // quitte l'app (iOS auto-PiP via video.autoPictureInPicture).
        allowsPictureInPictureMediaPlayback={true}
        // AirPlay natif depuis le lecteur web.
        allowsAirPlayForMediaPlayback={true}
        allowsBackForwardNavigationGestures={true}
        // Sécurité
        originWhitelist={['https://*', 'http://*', 'about:*', 'blob:*']}
        mixedContentMode="compatibility"
        // Cache
        cacheEnabled={true}
        // Désactive le zoom pour un rendu app-like
        scalesPageToFit={true}
        // Android — bloque les fenêtres popup (window.open())
        setSupportMultipleWindows={false}
        onOpenWindow={() => {}}
        overScrollMode="never"
        thirdPartyCookiesEnabled={true}
        // iOS
        sharedCookiesEnabled={true}
        contentMode="mobile"
      />
    );
  },
);

WebViewBrowser.displayName = 'WebViewBrowser';
export default WebViewBrowser;
