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
import { handleBridgeMessage, type BridgeMessageOptions } from '../services/bridge';
import { buildInjectedJavaScript, type InjectOptions } from '../injection/inject';
import { CONFIG } from '../config';

export interface WebViewBrowserRef {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  loadUrl: (url: string) => void;
  injectJavaScript: (script: string) => void;
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
    },
    ref,
  ) => {
    const webViewRef = useRef<WebView>(null);
    const injectedJS = useMemo(
      () => buildInjectedJavaScript({ proxyEnabled, castMode, storageSnapshot }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [proxyEnabled, castMode],
    );

    useImperativeHandle(ref, () => ({
      goBack: () => webViewRef.current?.goBack(),
      goForward: () => webViewRef.current?.goForward(),
      reload: () => webViewRef.current?.reload(),
      loadUrl: (newUrl: string) => {
        webViewRef.current?.injectJavaScript(
          `window.location.href = ${JSON.stringify(newUrl)}; true;`,
        );
      },
      injectJavaScript: (script: string) => {
        webViewRef.current?.injectJavaScript(script);
      },
    }));

    const bridgeOptions = useMemo<BridgeMessageOptions>(
      () => ({ onMediaPlayback, onStorageSnapshot }),
      [onMediaPlayback, onStorageSnapshot],
    );

    const onMessage = useCallback(
      (event: WebViewMessageEvent) => {
        handleBridgeMessage(event.nativeEvent.data, webViewRef, bridgeOptions);
      },
      [bridgeOptions],
    );

    const onHttpError = useCallback(
      (event: any) => {
        onError?.(
          `HTTP ${event.nativeEvent.statusCode}: ${event.nativeEvent.url}`,
        );
      },
      [onError],
    );

    const onShouldStartLoadWithRequest = useCallback(
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
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
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
