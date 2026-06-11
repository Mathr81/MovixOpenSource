import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  BackHandler,
  Platform,
  Modal,
  TouchableOpacity,
  Image,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WebViewNavigation } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

import WebViewBrowser, { type WebViewBrowserRef } from '../components/WebViewBrowser';
import BrowserToolbar from '../components/BrowserToolbar';
import MiniPill from '../components/MiniPill';
import MirrorErrorScreen from '../components/MirrorErrorScreen';
import { startCastShimEventForwarding } from '../services/bridge';
import { useBrowserUIPrefs } from '../hooks/useBrowserUIPrefs';
import { useAddress } from '../context/AddressContext';
import SettingsScreen from './SettingsScreen';

export default function BrowserScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebViewBrowserRef>(null);
  const { prefs: uiPrefs } = useBrowserUIPrefs();
  const { config, isLoading, refresh } = useAddress();

  const navBarHidden = !uiPrefs.showNavBar;
  const toolbarHidden = !uiPrefs.showUrlBar && !uiPrefs.showNavBar;

  const urlChain = useMemo(() => {
    if (!config) return [];
    return [config.primaryUrl, ...config.mirrors];
  }, [config]);

  const [mirrorIndex, setMirrorIndex] = useState(0);
  const [allMirrorsFailed, setAllMirrorsFailed] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentUrl, setCurrentUrl] = useState('');
  const [dnsEnabled, setDnsEnabled] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [webViewReady, setWebViewReady] = useState(false);
  const splashFade = useRef(new Animated.Value(1)).current;

  const activeUrl = urlChain[mirrorIndex] ?? '';

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
    const unsub = startCastShimEventForwarding(webViewRef);
    return unsub;
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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {showWebView && (
        <View style={styles.webViewContainer}>
          <WebViewBrowser
            key={activeUrl}
            ref={webViewRef}
            url={activeUrl}
            onNavigationStateChange={onNavigationStateChange}
            onError={onWebViewError}
            onLoadEnd={onWebViewLoadEnd}
          />
        </View>
      )}

      {allMirrorsFailed && config && (
        <MirrorErrorScreen telegramUrl={config.telegramUrl} onRetry={onRetry} />
      )}

      {!toolbarHidden && showWebView && (
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
          visible={settingsVisible}
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

      {navBarHidden && showWebView && (
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
