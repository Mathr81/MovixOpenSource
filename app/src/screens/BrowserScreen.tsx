import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  BackHandler,
  Platform,
  StatusBar,
  Modal,
  TouchableOpacity,
  Image,
  Animated,
  AppState,
  DeviceEventEmitter,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WebViewNavigation } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

import WebViewBrowser, { type WebViewBrowserRef } from '../components/WebViewBrowser';
import BrowserToolbar from '../components/BrowserToolbar';
import MiniPill from '../components/MiniPill';
import MirrorErrorScreen from '../components/MirrorErrorScreen';
import { setLocalPlaybackAwake } from '../services/playbackAwake';
import { setPictureInPicturePlaybackActive } from '../services/pictureInPicture';
import { useBrowserUIPrefs } from '../hooks/useBrowserUIPrefs';
import { useAddress } from '../context/AddressContext';
import SettingsScreen from './SettingsScreen';

const STORAGE_SNAPSHOT_KEY = '@movix/site_storage_snapshot';

export default function BrowserScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebViewBrowserRef>(null);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const { prefs: uiPrefs } = useBrowserUIPrefs();
  const { config, isLoading, refresh } = useAddress();

  const navBarHidden = !uiPrefs.showNavBar;
  const toolbarHidden = !uiPrefs.showUrlBar && !uiPrefs.showNavBar;

  const urlChain = useMemo(() => {
    if (!config) return [];
    return [config.primaryUrl, ...config.mirrors];
  }, [config]);

  // Hôtes du site (domaine actif + miroirs) : la navigation y reste dans la
  // WebView ; tout le reste s'ouvre dans le navigateur système (cf. C, pubs).
  const allowedHosts = useMemo(() => {
    const hosts: string[] = [];
    for (const u of urlChain) {
      try {
        hosts.push(new URL(u).hostname);
      } catch {
        // URL invalide — ignorée.
      }
    }
    return hosts;
  }, [urlChain]);

  const [mirrorIndex, setMirrorIndex] = useState(0);
  const [allMirrorsFailed, setAllMirrorsFailed] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentUrl, setCurrentUrl] = useState('');
  const [dnsEnabled, setDnsEnabled] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [webViewReady, setWebViewReady] = useState(false);
  const [storageSnapshot, setStorageSnapshot] = useState<Record<string, string> | null>(null);
  const splashFade = useRef(new Animated.Value(1)).current;
  const [isPictureInPictureActive, setIsPictureInPictureActive] = useState(false);

  const activeUrl = urlChain[mirrorIndex] ?? '';

  // Charge l'instantané de session du dernier domaine actif (cf. D, persistance
  // inter-domaines) avant le premier chargement de la WebView.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_SNAPSHOT_KEY).then(raw => {
      if (!raw) return;
      try {
        setStorageSnapshot(JSON.parse(raw));
      } catch {
        // Donnée corrompue — ignorée.
      }
    });
  }, []);

  const onStorageSnapshot = useCallback((data: Record<string, string>) => {
    setStorageSnapshot(data);
    AsyncStorage.setItem(STORAGE_SNAPSHOT_KEY, JSON.stringify(data)).catch(() => {});
  }, []);

  // Réinitialisation des données du site (déclenchée depuis les Réglages) :
  // vide localStorage/sessionStorage de la WebView + l'instantané persisté
  // (sinon il serait re-restauré au prochain chargement) puis recharge la page.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('MOVIX_CLEAR_SITE_DATA', () => {
      setStorageSnapshot(null);
      AsyncStorage.removeItem(STORAGE_SNAPSHOT_KEY).catch(() => {});
      webViewRef.current?.injectJavaScript(`
        (function() {
          try { localStorage.clear(); } catch (e) {}
          try { sessionStorage.clear(); } catch (e) {}
          try { location.reload(); } catch (e) {}
        })();
        true;
      `);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    AsyncStorage.getItem('dns_enabled').then(val => {
      setDnsEnabled(val === 'true');
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (settingsVisible) {
        setSettingsVisible(false);
        return true;
      }
      if (canGoBack) {
        webViewRef.current?.goBack();
        return true;
      }
      return false;
    });

    return () => handler.remove();
  }, [canGoBack, settingsVisible]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        webViewRef.current?.refreshCastShimStatus();
      }
    });
    return () => subscription.remove();
  }, [activeUrl]);

  useEffect(() => () => {
    setPictureInPicturePlaybackActive(false);
    setLocalPlaybackAwake(false);
  }, []);

  const onPictureInPictureModeChange = useCallback((active: boolean) => {
    if (active) {
      setSettingsVisible(false);
    }
    setIsPictureInPictureActive(active);
  }, []);

  const onMediaPlayback = useCallback((playing: boolean) => {
    setIsVideoPlaying(playing);
  }, []);

  // iOS : barre de statut et toolbar masquées pendant la lecture vidéo.
  // UIViewControllerBasedStatusBarAppearance = false → StatusBar.setHidden
  // est global et fonctionne même en mode plein-écran WebView.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    StatusBar.setHidden(isVideoPlaying && !settingsVisible, 'slide');
  }, [isVideoPlaying, settingsVisible]);

  // Restaure la barre de statut en quittant l'écran.
  useEffect(() => {
    return () => {
      if (Platform.OS === 'ios') StatusBar.setHidden(false, 'none');
    };
  }, []);

  const onNavigationStateChange = useCallback((state: WebViewNavigation) => {
    setCanGoBack(state.canGoBack);
    setCanGoForward(state.canGoForward);
    setLoading(state.loading ?? false);
    if (state.url) setCurrentUrl(state.url);
  }, []);

  const onWebViewError = useCallback(
    (description: string) => {
      console.warn('[BrowserScreen] WebView error', description, 'on', activeUrl);
      if (mirrorIndex + 1 < urlChain.length) {
        setMirrorIndex(i => i + 1);
      } else {
        setAllMirrorsFailed(true);
      }
    },
    [activeUrl, mirrorIndex, urlChain.length],
  );

  const onWebViewLoadEnd = useCallback(() => {
    if (webViewReady) return;
    Animated.timing(splashFade, {
      toValue: 0,
      duration: 400,
      useNativeDriver: true,
    }).start(() => setWebViewReady(true));
  }, [webViewReady, splashFade]);

  const closeSettings = useCallback(() => {
    setSettingsVisible(false);
    AsyncStorage.getItem('dns_enabled').then(val => {
      setDnsEnabled(val === 'true');
    });
  }, []);

  const onRetry = useCallback(async () => {
    setAllMirrorsFailed(false);
    setMirrorIndex(0);
    setWebViewReady(false);
    splashFade.setValue(1);
    await refresh();
  }, [refresh, splashFade]);

  const showWebView = !isLoading && !!config && !allMirrorsFailed;
  const showSplash = (!webViewReady || isLoading || !config) && !allMirrorsFailed;

  // Mode immersif : pas de toolbar, pas de paddingTop (vidéo bord à bord).
  // iOS : pendant la lecture vidéo. Android : pendant le Picture-in-Picture
  // (la fenêtre flottante ne doit afficher que la WebView, sans la barre de
  // paramètres ni le padding de status bar).
  const immersive =
    (Platform.OS === 'ios' && isVideoPlaying && !settingsVisible) ||
    isPictureInPictureActive;

  return (
    <View style={[styles.container, { paddingTop: immersive ? 0 : insets.top }]}>
      {showWebView && (
        <View style={styles.webViewContainer}>
          <WebViewBrowser
            key={`${activeUrl}:${uiPrefs.proxyEnabled ? 'proxy' : 'direct'}:${uiPrefs.castMode}`}
            ref={webViewRef}
            url={activeUrl}
            proxyEnabled={uiPrefs.proxyEnabled}
            castMode={uiPrefs.castMode}
            allowedHosts={allowedHosts}
            storageSnapshot={storageSnapshot}
            onNavigationStateChange={onNavigationStateChange}
            onError={onWebViewError}
            onLoadEnd={onWebViewLoadEnd}
            onMediaPlayback={onMediaPlayback}
            onStorageSnapshot={onStorageSnapshot}
            onPictureInPictureModeChange={onPictureInPictureModeChange}
          />
        </View>
      )}

      {allMirrorsFailed && config && (
        <MirrorErrorScreen telegramUrl={config.telegramUrl} onRetry={onRetry} />
      )}

      {!isPictureInPictureActive && !toolbarHidden && showWebView && !immersive && (
        <View style={{ paddingBottom: insets.bottom }}>
          <BrowserToolbar
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            loading={loading}
            currentUrl={currentUrl}
            dnsEnabled={dnsEnabled}
            showUrlBar={uiPrefs.showUrlBar}
            showNavBar={uiPrefs.showNavBar}
            onGoBack={() => webViewRef.current?.goBack()}
            onGoForward={() => webViewRef.current?.goForward()}
            onReload={() => webViewRef.current?.reload()}
            onHome={() => webViewRef.current?.loadUrl(activeUrl)}
            onSettings={() => setSettingsVisible(true)}
          />
        </View>
      )}

      {showWebView && (
        <Modal
          visible={!isPictureInPictureActive && settingsVisible}
          animationType="slide"
          onRequestClose={closeSettings}>
          <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={closeSettings} style={styles.closeButton}>
                <Text style={styles.closeText}>Fermer</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Paramètres</Text>
              <View style={styles.closeButton} />
            </View>
            <SettingsScreen />
          </View>
        </Modal>
      )}

      {!isPictureInPictureActive && navBarHidden && showWebView && !immersive && (
        <MiniPill onPress={() => setSettingsVisible(true)} />
      )}

      {showSplash && (
        <Animated.View
          style={[StyleSheet.absoluteFillObject, styles.splash, { opacity: splashFade }]}
          pointerEvents="none">
          <Image
            source={require('../../assets/movix512.png')}
            style={styles.splashLogo}
            resizeMode="contain"
          />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  webViewContainer: {
    flex: 1,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#111111',
    borderBottomWidth: 1,
    borderBottomColor: '#1f1f1f',
  },
  modalTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '600',
  },
  closeButton: {
    width: 60,
  },
  closeText: {
    color: '#8b5cf6',
    fontSize: 15,
    fontWeight: '500',
  },
  splash: {
    backgroundColor: '#B5302C',
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashLogo: {
    width: 150,
    height: 150,
  },
});
