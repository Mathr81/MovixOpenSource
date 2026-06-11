import React, { useEffect, useLayoutEffect, useState, useRef, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigationType, useNavigate, matchPath } from 'react-router-dom';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import Header from './components/Header';
import Home from './pages/Home';
import DnsBlockBanner from './components/DnsBlockBanner';
import { AdFreePopupProvider } from './context/AdFreePopupContext';
import { SearchProvider } from './context/SearchContext';
import { AuthProvider } from './context/AuthContext';
import { AdWarningProvider } from './context/AdWarningContext';
import { VipModalProvider } from './context/VipModalContext';
import { ProfileProvider, useProfile } from './context/ProfileContext';
import { TurnstileProvider } from './context/TurnstileContext';
import { LightModeProvider, useLightMode } from './context/LightModeContext';

import NotFound from './pages/NotFound';
import 'video.js/dist/video-js.css';
import './styles/videojs-custom.css';
import axios from 'axios';
import Footer from './components/Footer';
import CreateAccount from './pages/CreateAccount';
import LoginBip39 from './pages/LoginBip39';
import { AlertService } from './services/alertService';
import NotificationToast from './components/NotificationToast';
import { NotificationData } from './types/alerts';
import RedirectPopup from './components/RedirectPopup';
import { TopProgressBar } from './components/TopProgressBar';
import SmoothScroll from './components/SmoothScroll';
import AprilFoolsAdminPage from './pages/AprilFoolsAdminPage';
import ProfileSelection from './pages/ProfileSelection';
import { ROUTES, type RouteEntry } from './routing/registry';
import { DelayedSuspense } from './components/DelayedSuspense';
import { RouteProgressBar } from './components/RouteProgressBar';
import ScreenSaver from './components/ScreenSaver';
import { useIdleTimer } from './hooks/useIdleTimer';
import { startVipVerification } from './utils/vipUtils';
import { broadcastAuthChange, clearStoredAuthSession, getResolvedAccountContext } from './utils/accountAuth';
import { isSyncableStorageKey, SYNC_OUTBOX_STORAGE_KEY } from './utils/syncStorage';
import i18n, { detectInitialLanguage } from './i18n';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import IntroAnimation from './components/IntroAnimation';
import { IntroProvider, useIntro } from './context/IntroContext';
import { APRIL_FOOLS_ADMIN_PATH, isAprilFoolsAdminEnabled } from './utils/aprilFools';
import {
  pushPriorityToExtension,
  subscribeToPriorityChanges,
} from './utils/sourcePriorityPrefs';

const DEBUG_APP_LOGS = import.meta.env.VITE_DEBUG_APP === 'true';

const debugAppLog = (...args: unknown[]) => {
  if (!DEBUG_APP_LOGS) return;
  console.log(...args);
};

// Démarrer la vérification périodique du VIP au lancement de l'app
startVipVerification();

// Detect and set language on first visit (browser language + IP geolocation)
detectInitialLanguage();

// Global 401 handler: on any 401 from axios, clear storage and redirect to /
// 403 is NOT intercepted here — it can come from Turnstile, admin checks, etc.
// Uses __forceClearInProgress flag to prevent sync operations during forced clear
(function setupAxios401Handler() {
  if ((window as any).__axios401Set) return;
  (window as any).__axios401Set = true;
  axios.interceptors.response.use(
    (resp) => resp,
    (error) => {
      const status = error?.response?.status;
      if (status === 401) {
        // Déterminer le domaine de la requête ayant échoué
        const cfg = error?.config || error?.response?.config || {};
        const baseURL = cfg.baseURL || '';
        const urlPart = cfg.url || '';
        let fullUrl = '';
        try {
          fullUrl = urlPart && /^https?:\/\//i.test(urlPart)
            ? urlPart
            : (baseURL ? new URL(urlPart || '', baseURL).toString() : (urlPart || ''));
        } catch {
          fullUrl = urlPart || '';
        }
        let hostname = '';
        try { hostname = fullUrl ? new URL(fullUrl).hostname : ''; } catch { hostname = ''; }

        // Vérifier si c'est la route /api/admin/check - ne pas déconnecter pour cette route
        const isAdminCheckRoute = fullUrl.includes('/api/admin/check') || urlPart.includes('/api/admin/check');

        // N'appliquer le clear/redirect que pour le domaine API configuré et pas pour /api/admin/check
        if (API_HOSTNAME && hostname === API_HOSTNAME && !isAdminCheckRoute) {
          // Marquer qu'on est en train de faire un clear forcé pour éviter le sync
          (window as any).__forceClearInProgress = true;

          try {
            clearStoredAuthSession();
            broadcastAuthChange();
          } catch { }
          try { sessionStorage.clear(); } catch { }

          // Réinitialiser le flag après un court délai
          setTimeout(() => {
            (window as any).__forceClearInProgress = false;
          }, 1000);

          window.location.href = '/';
        }
      }
      return Promise.reject(error);
    }
  );
})();

// Get API URL from environment variable
const API_URL = import.meta.env.VITE_MAIN_API
const API_HOSTNAME = (() => {
  try {
    return API_URL ? new URL(API_URL).hostname : '';
  } catch {
    return '';
  }
})();

// Component to manage episode alerts notifications
const AlertNotificationManager: React.FC = () => {
  const [notifications, setNotifications] = useState<NotificationData[]>([]);

  // Function to check and display alerts
  const checkAlerts = (forceCheck = false) => {
    debugAppLog('Checking alerts...', forceCheck ? '(forced)' : '');

    // Only proceed if it's time to check (unless forced)
    if (!forceCheck && !AlertService.shouldRunCheck()) {
      debugAppLog('Not time to check yet, skipping...');
      return;
    }

    const { alertsToShow, alertsToRemove } = AlertService.checkAlertsToTrigger();

    debugAppLog('Alerts to show:', alertsToShow);
    debugAppLog('Alerts to remove:', alertsToRemove);

    // Remove expired alerts
    alertsToRemove.forEach(alertId => {
      AlertService.removeAlert(alertId);
    });

    // Show new notifications and mark them as notified
    if (alertsToShow.length > 0) {
      // Double-check that none of the alerts are dismissed before showing
      const validAlerts = alertsToShow.filter(alert => {
        const alertData = AlertService.getAlert(alert.showId, alert.season, alert.episode);
        return alertData && !alertData.dismissed;
      });

      if (validAlerts.length > 0) {
        setNotifications(prev => [...prev, ...validAlerts]);
        // Mark alerts as notified
        validAlerts.forEach(alert => {
          AlertService.markAsNotified(alert.id);
        });
      }
    }

    // Update last check time
    AlertService.updateLastCheckTime();
  };

  useEffect(() => {
    // Force check immediately on mount/refresh (regardless of last check time)
    checkAlerts(true);

    // Set up interval to check every 5 minutes after the initial check
    const interval = setInterval(() => checkAlerts(false), 5 * 60 * 1000); // 5 minutes

    return () => clearInterval(interval);
  }, []);

  const handleDismissNotification = (notificationId: string) => {
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
    // Dismiss the alert permanently (only when user explicitly clicks "Ignorer")
    AlertService.dismissAlert(notificationId);
  };

  const handleRemindLater = (notificationId: string) => {
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
    // Reset notification status so it can be shown again later
    AlertService.resetNotificationStatus(notificationId);
  };

  const handleGoToShow = (showId: string, notificationId: string) => {
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
    // Mark as dismissed since user took action
    AlertService.dismissAlert(notificationId);
    window.location.href = `/tv/${showId}`;
  };

  return (
    <>
      {notifications.map(notification => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={() => handleDismissNotification(notification.id)}
          onGoToShow={() => handleGoToShow(notification.showId, notification.id)}
          onRemindLater={() => handleRemindLater(notification.id)}
        />
      ))}
    </>
  );
};

// Helper function to detect iOS standalone mode (added to home screen)
const isInStandaloneMode = () => {
  return (
    ('standalone' in window.navigator) &&
    ((window.navigator as any).standalone === true) ||
    window.matchMedia('(display-mode: standalone)').matches
  );
};

const shouldPreserveScrollOnBack = () => localStorage.getItem('settings_disable_auto_scroll') === 'true';

const shouldDisableRouteScrollToTop = () => localStorage.getItem('settings_disable_route_scroll_to_top') === 'true';

const isSmoothScrollEnabled = () => localStorage.getItem('settings_smooth_scroll') !== 'false';

const shouldAnimateScrollToTop = () => {
  if (!isSmoothScrollEnabled()) {
    return false;
  }

  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

const syncHistoryScrollRestoration = () => {
  const preserveScrollOnBack = shouldPreserveScrollOnBack();
  const disableRouteScrollToTop = shouldDisableRouteScrollToTop();

  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = preserveScrollOnBack || disableRouteScrollToTop ? 'auto' : 'manual';
  }

  return {
    preserveScrollOnBack,
    disableRouteScrollToTop
  };
};

const resetNestedScrollableContainers = () => {
  const scrollableElements = document.querySelectorAll<HTMLElement>(
    '[data-scroll="true"], [data-radix-scroll-area-viewport], .overflow-y-auto, .overflow-y-scroll, .overflow-auto, .overflow-scroll'
  );

  scrollableElements.forEach((element) => {
    if (element.scrollTop !== 0) {
      element.scrollTop = 0;
    }
  });
};

const forceViewportTop = () => {
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
};

const scrollViewportToTop = (mode: 'smooth' | 'instant') => {
  const lenis = (window as any).lenis;

  if (lenis?.scrollTo) {
    lenis.scrollTo(0, {
      immediate: mode === 'instant',
      duration: mode === 'smooth' ? 0.55 : undefined,
      force: true
    });
  } else {
    window.scrollTo({ top: 0, left: 0, behavior: mode === 'smooth' ? 'smooth' : 'auto' });
  }

  if (mode === 'instant') {
    forceViewportTop();
  }
};

// Composant pour faire défiler automatiquement vers le haut lors des changements de route
const ScrollToTop = () => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const prevPathRef = React.useRef(location.pathname);

  useEffect(() => {
    const handleRestorationSync = (event?: StorageEvent) => {
      if (
        event instanceof StorageEvent &&
        event.key &&
        event.key !== 'settings_disable_auto_scroll' &&
        event.key !== 'settings_disable_route_scroll_to_top'
      ) {
        return;
      }

      syncHistoryScrollRestoration();
    };

    handleRestorationSync();

    window.addEventListener('storage', handleRestorationSync);
    window.addEventListener('settings_auto_scroll_changed', handleRestorationSync as EventListener);
    window.addEventListener('settings_route_scroll_changed', handleRestorationSync as EventListener);

    return () => {
      window.removeEventListener('storage', handleRestorationSync);
      window.removeEventListener('settings_auto_scroll_changed', handleRestorationSync as EventListener);
      window.removeEventListener('settings_route_scroll_changed', handleRestorationSync as EventListener);
      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'auto';
      }
    };
  }, []);

  useLayoutEffect(() => {
    const { preserveScrollOnBack, disableRouteScrollToTop } = syncHistoryScrollRestoration();
    const isBackOrForward = navigationType === 'POP';

    // Sur /search, ne pas scroll to top si seuls les query params changent (pagination)
    const pathChanged = prevPathRef.current !== location.pathname;
    prevPathRef.current = location.pathname;
    if (!pathChanged && location.pathname === '/search') {
      return undefined;
    }

    if (disableRouteScrollToTop) {
      return undefined;
    }

    if (preserveScrollOnBack && isBackOrForward) {
      return undefined;
    }

    let cancelled = false;
    let frameId = 0;
    let nestedFrameId = 0;
    let settleTimeout = 0;
    let userInteracted = false;

    const cancelPendingAdjustments = () => {
      userInteracted = true;
      window.clearTimeout(settleTimeout);
    };

    const handleUserInteraction = () => {
      if (!cancelled) {
        cancelPendingAdjustments();
      }
    };

    const scrollToTop = (mode: 'smooth' | 'instant') => {
      try {
        scrollViewportToTop(mode);
        resetNestedScrollableContainers();
      } catch (error) {
        console.warn('ScrollToTop: Error during scroll operation', error);
      }
    };

    const shouldAnimate = shouldAnimateScrollToTop();

    window.addEventListener('wheel', handleUserInteraction, { passive: true });
    window.addEventListener('touchstart', handleUserInteraction, { passive: true });
    window.addEventListener('touchmove', handleUserInteraction, { passive: true });
    window.addEventListener('pointerdown', handleUserInteraction, { passive: true });
    window.addEventListener('keydown', handleUserInteraction);

    frameId = requestAnimationFrame(() => {
      if (cancelled) return;

      scrollToTop(shouldAnimate ? 'smooth' : 'instant');

      nestedFrameId = requestAnimationFrame(() => {
        if (cancelled || userInteracted) return;
        resetNestedScrollableContainers();
      });

      if (!shouldAnimate) {
        settleTimeout = window.setTimeout(() => {
          if (cancelled || userInteracted) return;
          scrollToTop('instant');
          resetNestedScrollableContainers();
        }, 120);
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(nestedFrameId);
      window.clearTimeout(settleTimeout);
      window.removeEventListener('wheel', handleUserInteraction);
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('touchmove', handleUserInteraction);
      window.removeEventListener('pointerdown', handleUserInteraction);
      window.removeEventListener('keydown', handleUserInteraction);
    };
  }, [location.pathname, location.search, navigationType]);

  return null;
};

// iOS standalone mode handler component
const IOSHomeScreenHandler = () => {
  useEffect(() => {
    // Handle iOS standalone mode
    if (!isInStandaloneMode()) return;

    // Prevent standard link behavior in standalone mode
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const closestLink = target.closest('a');

      if (closestLink &&
        !closestLink.getAttribute('target') &&
        closestLink.getAttribute('href')?.indexOf('http') === 0) {
        e.preventDefault();
        window.location.href = closestLink.href;
      }
    };
    document.addEventListener('click', handleClick);

    // Add class to body when in standalone mode for specific styling if needed
    document.body.classList.add('ios-standalone');

    // The previous version registered the click listener with no cleanup —
    // any remount (Strict Mode double-invoke, error-boundary recovery, route
    // guard remount) stacked another listener and ran handlers N times per
    // click. — perf
    return () => {
      document.removeEventListener('click', handleClick);
      document.body.classList.remove('ios-standalone');
    };
  }, []);

  return null;
};

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
  const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
  const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';
  const isVipUser = localStorage.getItem('is_vip') === 'true';

  // Vérifier l'ancienne méthode d'authentification VIP (pour compatibilité)
  let isVipAuth = false;
  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const authObj = JSON.parse(authStr);
      if (authObj.userProfile && authObj.userProfile.provider === 'access_code') {
        isVipAuth = true;
      }
    } catch { }
  }

  const isAuthenticated = isDiscordAuth || isGoogleAuth || isBip39Auth || isVipAuth || isVipUser;
  return isAuthenticated ? children : <Navigate to="/login" />;
};

// Cache module-level des composants Lazy par path. Sans ça, chaque appel à
// renderRouteEntry (ROUTES.map à chaque render d'App) créerait une nouvelle
// instance lazy() avec son propre cache de chunk → instabilité d'identité.
const lazyComponentCache = new Map<string, React.LazyExoticComponent<React.ComponentType<unknown>>>();
const getCachedLazy = (entry: RouteEntry) => {
  let cached = lazyComponentCache.get(entry.path);
  if (!cached) {
    cached = lazy(entry.loader as () => Promise<{ default: React.ComponentType<unknown> }>);
    lazyComponentCache.set(entry.path, cached);
  }
  return cached;
};

// Wrapper qui injecte `key={location.pathname}` sur le composant lazy. Sans ça,
// quand l'utilisateur navigue entre deux URLs matchant le même Route pattern
// (ex. /movie/abc → /movie/xyz), React Router réutilise l'instance composant
// avec juste les params updated. Les useState de la page (movie, cast, crew,
// loading…) gardent les valeurs de l'ancien id pendant que le nouveau fetch
// tourne — l'utilisateur voit l'ancien film tant que TMDB répond pas.
// Avec key={pathname}, la clé change → React remount le composant → state reset
// → loader/skeleton affiché jusqu'au nouveau fetch.
const RouteLazyContent: React.FC<{
  Lazy: React.LazyExoticComponent<React.ComponentType<unknown>>;
  fallback: React.ReactNode;
}> = ({ Lazy, fallback }) => {
  const location = useLocation();
  return (
    <DelayedSuspense fallback={fallback}>
      <Lazy key={location.pathname} />
    </DelayedSuspense>
  );
};

const renderRouteEntry = (entry: RouteEntry) => {
  const Lazy = getCachedLazy(entry);
  let element: React.ReactNode = (
    <RouteLazyContent
      Lazy={Lazy}
      fallback={entry.fallback ?? <RouteProgressBar />}
    />
  );
  if (entry.guard === 'private') {
    element = <PrivateRoute>{element}</PrivateRoute>;
  }
  return <Route key={entry.path} path={entry.path} element={element} />;
};

// PersistenceManager component to sync localStorage with backend (disabled for guests and VIP)
const PersistenceManager = () => {
  const [isInitialSyncDone, setIsInitialSyncDone] = useState<boolean>(false);
  const location = useLocation();

  // Delta-sync queues
  const generalOpsRef = useRef<any[]>([]);
  const progressOpsMapRef = useRef<Map<string, any>>(new Map());
  const suppressSyncRef = useRef<boolean>(false);

  const MAX_SYNC_OPS_PER_REQUEST = 100;
  const isProgressKey = (k: string) => k.startsWith('progress_');

  // Track if we're in the middle of loading profile data to avoid sync.
  // Init à true volontairement : sur un origin vide (ex: nouveau miroir après
  // block FAI), des composants peuvent écrire des valeurs "défaut vide" dans
  // localStorage AVANT que loadProfileData ait pu hydrater depuis le serveur.
  // La garde reste fermée jusqu'à ce que ProfileContext.loadProfiles ait
  // tranché (charger un profil, en créer un, ou abandonner si pas auth).
  const isProfileDataLoadingRef = useRef<boolean>(true);

  // Expose function to control profile data loading state
  React.useEffect(() => {
    (window as any).setProfileDataLoading = (loading: boolean) => {
      isProfileDataLoadingRef.current = loading;
      const diag = (window as unknown as { __syncDiag?: Record<string, unknown> }).__syncDiag;
      if (diag) diag.gateLastSetTo = loading;
      debugAppLog('Profile data loading state changed:', loading);
    };

    return () => {
      delete (window as any).setProfileDataLoading;
    };
  }, []);

  // Check if we're on a watch route - if so, disable initial data loading but allow sync
  const isWatchRoute = location.pathname.startsWith('/watch/') || location.pathname.startsWith('/watchparty/room/');

  // Store current user info in a ref to track changes
  const currentUserInfo = React.useRef<{ type: string | null, id: string | null }>(
    { type: null, id: null }
  );

  // Store auth states in refs to avoid dependency issues
  const discordAuth = React.useRef(localStorage.getItem('discord_auth') === 'true');
  const googleAuth = React.useRef(localStorage.getItem('google_auth') === 'true');

  // Track user authentication changes
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent | null) => {
      // Process auth changes (now allowed on watch routes)

      // Check if this is a relevant auth change
      const isAuthChange = e === null || // null means manual trigger
        e.key === 'auth' ||
        e.key === 'discord_auth' ||
        e.key === 'google_auth' ||
        e.key === 'discord_user' ||
        e.key === 'google_user' ||
        e.key === 'is_vip' ||
        e.key === 'access_code' ||
        e.key === 'access_code_expires' ||
        e.key === 'auth_token'; // Also watch for auth_token changes

      // Update auth refs
      discordAuth.current = localStorage.getItem('discord_auth') === 'true';
      googleAuth.current = localStorage.getItem('google_auth') === 'true';

      // Check if user type has changed
      if (isAuthChange) {
        const newUserInfo = getUserInfo();
        const oldUserInfo = currentUserInfo.current;

        // Update the current user info
        currentUserInfo.current = newUserInfo;

        // If user type or ID changed, reset sync state for new load
        if (newUserInfo.type !== oldUserInfo.type || newUserInfo.id !== oldUserInfo.id) {
          debugAppLog('Auth changed. Resetting sync state and refreshing user info.');
          // Add a small delay to ensure auth process is complete
          setTimeout(() => {
            setIsInitialSyncDone(false);
          }, 1000); // Wait 1 second before triggering sync
        }
      }
    };

    const handleAuthChanged = () => handleStorageChange(null);

    // Initialize current user info
    currentUserInfo.current = getUserInfo();

    // Listen for storage events from other tabs/windows
    window.addEventListener('storage', handleStorageChange);

    // Listen for our custom event for changes within this tab
    window.addEventListener('auth_changed', handleAuthChanged);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('auth_changed', handleAuthChanged);
    };
  }, [isWatchRoute]); // Add isWatchRoute as dependency

  // Delta-sync: capture and buffer granular localStorage changes
  useEffect(() => {
    // Setup localStorage sync (now allowed on watch routes)

    // Diagnostic counters (window.__syncDiag) — readable from remote inspector
    // to pinpoint which guard silently drops sync ops on Firefox mobile.
    const syncDiag = ((window as unknown as { __syncDiag?: Record<string, unknown> }).__syncDiag = {
      setItemIntercepted: 0,
      removeItemIntercepted: 0,
      diffsQueued: 0,
      diffsDrained: 0,
      skipSuppress: 0,
      skipNotSyncable: 0,
      skipNoop: 0,
      skipForceClear: 0,
      skipGateSet: 0,
      skipGateRemove: 0,
      skipGateEnqueue: 0,
      opsEnqueued: 0,
      flushGeneralCalled: 0,
      flushGeneralBlockedGate: 0,
      sendOpsCalled: 0,
      sendOpsEmpty: 0,
      sendOpsBlockedForceClear: 0,
      sendOpsBlockedGate: 0,
      sendOpsBlockedUserInfo: 0,
      sendOpsBlockedNoToken: 0,
      sendOpsAttempted: 0,
      sendOpsSuccess: 0,
      sendOpsError: 0,
      lastSkippedKey: '',
      lastUserInfo: '',
      lastError: '',
      gateInitialState: undefined as boolean | undefined,
      gateLastSetTo: undefined as boolean | undefined,
      profileLoadingExposed: typeof (window as unknown as { setProfileDataLoading?: unknown }).setProfileDataLoading === 'function'
    });
    syncDiag.gateInitialState = isProfileDataLoadingRef.current;

    // Initialize snapshot of current localStorage
    const prevValues = new Map<string, string | null>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) prevValues.set(k, localStorage.getItem(k));
    }

    const prevValuesRefLocal = { current: prevValues } as { current: Map<string, string | null> };

    const generalFlushTimeoutRef = { current: null as any };

    // Detect Safari and Firefox/Librewolf browsers and check localStorage availability
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isFirefox = /firefox/i.test(navigator.userAgent) || /librewolf/i.test(navigator.userAgent);
    debugAppLog('Browser detection - Safari:', isSafari, 'Firefox/Librewolf:', isFirefox);

    // Check if localStorage is available and working (important for Safari private mode)
    const isLocalStorageAvailable = (() => {
      try {
        const testKey = '__localStorage_test__';
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        return true;
      } catch (e) {
        console.warn('localStorage not available:', e);
        return false;
      }
    })();

    debugAppLog('localStorage available:', isLocalStorageAvailable);

    const enqueueGeneralOp = (op: any) => {
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) { syncDiag.skipGateEnqueue++; return; }

      generalOpsRef.current.push(op);
      syncDiag.opsEnqueued++;
      if (generalFlushTimeoutRef.current) return;
      generalFlushTimeoutRef.current = setTimeout(() => {
        flushGeneralOps();
        generalFlushTimeoutRef.current = null;
      }, 1000); // coalesce <1s into one POST
    };

    const sendOps = async (ops: any[]) => {
      if (!ops.length) { syncDiag.sendOpsEmpty++; return; }
      syncDiag.sendOpsCalled++;

      // Vérifier si un clear forcé est en cours (erreur 401)
      if ((window as any).__forceClearInProgress) {
        syncDiag.sendOpsBlockedForceClear++;
        debugAppLog('Skipping sync - force clear in progress');
        return;
      }

      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) {
        syncDiag.sendOpsBlockedGate++;
        debugAppLog('Skipping sync - profile data loading in progress');
        return;
      }

      const userInfo = getUserInfo();
      // Only sync for oauth and bip39 users with a selected profile
      if (!userInfo.type || !userInfo.profileId || !['oauth', 'bip39'].includes(userInfo.type)) {
        syncDiag.sendOpsBlockedUserInfo++;
        syncDiag.lastUserInfo = JSON.stringify(userInfo);
        return;
      }

      const authToken = localStorage.getItem('auth_token');
      if (!authToken) {
        syncDiag.sendOpsBlockedNoToken++;
        debugAppLog('Skipping sync - no auth token available');
        return;
      }
      syncDiag.sendOpsAttempted++;

      try {
        for (let index = 0; index < ops.length; index += MAX_SYNC_OPS_PER_REQUEST) {
          const batch = ops.slice(index, index + MAX_SYNC_OPS_PER_REQUEST);
          const syncPayload: any = {
            userType: userInfo.type,
            profileId: userInfo.profileId,
            ops: batch
          };

          if (userInfo.id) {
            syncPayload.userId = userInfo.id;
          }

          debugAppLog(`Sending sync request (${batch.length} operations) - route: ${location.pathname}`);
          await axios.post(`${API_URL}/api/sync`, syncPayload, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
        }

        // NOTE: don't clear SYNC_OUTBOX_STORAGE_KEY here. The outbox holds
        // un-replayed ops from previous sessions; in-session sendOps only
        // sees current-session ops. The two sets are disjoint, so clearing
        // here would silently drop a previous session's ops that hadn't yet
        // succeeded a replay. ProfileContext.replayOutboxIfAny owns the
        // outbox lifecycle; backend ops are idempotent so leaving stale
        // outbox entries doesn't cause incorrect state, only one extra POST
        // on next boot.

        syncDiag.sendOpsSuccess++;
        debugAppLog('Sync request successful');
        window.dispatchEvent(new CustomEvent('sync_storage_updated'));
      } catch (e) {
        syncDiag.sendOpsError++;
        syncDiag.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        console.error('Delta sync failed', e);
      }
    };

    const flushGeneralOps = () => {
      syncDiag.flushGeneralCalled++;
      const ops = generalOpsRef.current;
      generalOpsRef.current = [];
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) {
        syncDiag.flushGeneralBlockedGate++;
        return;
      }
      if (ops.length) sendOps(ops);
    };

    const flushProgressOps = () => {
      if (progressOpsMapRef.current.size === 0) return;
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) return;

      const ops: any[] = [];
      for (const [key, deltaOrValue] of progressOpsMapRef.current.entries()) {
        // deltaOrValue is { set: {...}, remove: [...] }
        const delta = deltaOrValue?.delta;
        if (delta && (Object.keys(delta.set || {}).length || (delta.remove || []).length)) {
          ops.push({ op: 'objPatch', key, delta });
        } else if (deltaOrValue && typeof deltaOrValue.value === 'string') {
          ops.push({ op: 'set', key, value: deltaOrValue.value });
        }
      }
      progressOpsMapRef.current.clear();
      if (ops.length) sendOps(ops);
    };

    const getArrayItemIdentity = (item: any) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      if (typeof item.shareCode === 'string' && item.shareCode) {
        return `shareCode:${item.shareCode}`;
      }

      if (typeof item.key === 'string' && item.key) {
        return `key:${item.key}`;
      }

      const parts: string[] = [];

      if ((typeof item.type === 'string' || typeof item.type === 'number') && item.type !== '') {
        parts.push(`type:${String(item.type)}`);
      }

      if ((typeof item.id === 'string' || typeof item.id === 'number') && item.id !== '') {
        parts.push(`id:${String(item.id)}`);
      }

      if (item.episodeInfo && typeof item.episodeInfo === 'object') {
        const { season, episode } = item.episodeInfo;
        if (typeof season === 'string' || typeof season === 'number') {
          parts.push(`season:${String(season)}`);
        }
        if (typeof episode === 'string' || typeof episode === 'number') {
          parts.push(`episode:${String(episode)}`);
        }
      }

      return parts.length ? parts.join('|') : null;
    };

    const computeArrayDiffOps = (key: string, oldStr: string | null, newStr: string) => {
      let oldArr: any[] = [];
      let newArr: any[] = [];
      try { oldArr = oldStr ? JSON.parse(oldStr) : []; } catch { }
      try { newArr = newStr ? JSON.parse(newStr) : []; } catch { }
      // Only handle true top-level arrays; for objects or non-arrays, let object patch handle
      if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return null as any;

      const oldMapById = new Map<string, any>();
      oldArr.forEach((it: any) => {
        const identity = getArrayItemIdentity(it);
        if (identity) {
          oldMapById.set(identity, it);
        }
      });

      const ops: any[] = [];

      // Additions and updates
      newArr.forEach((it: any) => {
        const identity = getArrayItemIdentity(it);
        if (identity && oldMapById.has(identity)) {
          const prev = oldMapById.get(identity);
          if (JSON.stringify(prev) !== JSON.stringify(it)) {
            // Model as remove then add for updated item
            ops.push({ op: 'arrayRemove', key, value: prev });
            ops.push({ op: 'arrayAdd', key, value: it });
          }
        } else if (identity) {
          ops.push({ op: 'arrayAdd', key, value: it });
        } else {
          // Primitive arrays or objects without id - fallback to full set
          ops.length = 0;
          ops.push({ op: 'set', key, value: newStr });
        }
      });

      // Removals
      const newIds = new Set(
        newArr
          .map((item: any) => getArrayItemIdentity(item))
          .filter((identity): identity is string => Boolean(identity))
      );
      oldArr.forEach((it: any) => {
        const identity = getArrayItemIdentity(it);
        if (identity && !newIds.has(identity)) {
          ops.push({ op: 'arrayRemove', key, value: it });
        }
      });

      return ops.length ? ops : [{ op: 'set', key, value: newStr }];
    };

    const computeObjectPatch = (oldStr: string | null, newStr: string) => {
      let oldObj: any = {};
      let newObj: any = {};
      try { oldObj = oldStr ? JSON.parse(oldStr) : {}; } catch { }
      try { newObj = newStr ? JSON.parse(newStr) : {}; } catch { }
      if (typeof oldObj !== 'object' || typeof newObj !== 'object') return null;
      const set: any = {};
      const remove: string[] = [];
      const oldKeys = new Set(Object.keys(oldObj));
      const newKeys = new Set(Object.keys(newObj));

      // Generic nested array diff for any array valued field with identifiable ids
      for (const k of newKeys) {
        const oldVal = oldObj[k];
        const newVal = newObj[k];
        if (Array.isArray(newVal)) {
          const oldArr = Array.isArray(oldVal) ? oldVal : [];
          const newArr = newVal;

          // Build id maps
          const oldById = new Map<any, any>();
          oldArr.forEach((it: any) => {
            const identity = getArrayItemIdentity(it);
            if (identity) {
              oldById.set(identity, it);
            }
          });
          const newById = new Map<any, any>();
          newArr.forEach((it: any) => {
            const identity = getArrayItemIdentity(it);
            if (identity) {
              newById.set(identity, it);
            }
          });

          // If items don't have ids, fallback to full set
          const canId = newArr.every((it: any) => !it || Boolean(getArrayItemIdentity(it)));
          if (!canId) {
            if (JSON.stringify(oldArr) !== JSON.stringify(newArr)) set[k] = newArr;
            continue;
          }

          const add: any[] = [];
          const update: any[] = [];
          const removeIds: Array<string | number> = [];

          newArr.forEach((it: any) => {
            const id = getArrayItemIdentity(it);
            if (!id) return;
            const prev = oldById.get(id);
            if (!prev) add.push(it);
            else if (JSON.stringify(prev) !== JSON.stringify(it)) update.push(it);
          });
          oldArr.forEach((it: any) => {
            const id = getArrayItemIdentity(it);
            if (!id) return;
            if (!newById.has(id)) removeIds.push(id);
          });

          if (add.length || update.length || removeIds.length) {
            set[k] = { __arrayPatch: { add, update, removeIds } };
          }
        }
      }
      // Changed or added (fallback generic for non-array fields)
      for (const k of newKeys) {
        if (Array.isArray(newObj[k])) continue; // handled above
        if (!oldKeys.has(k) || JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k])) {
          set[k] = newObj[k];
        }
      }
      // Removed
      for (const k of oldKeys) {
        if (!newKeys.has(k)) remove.push(k);
      }
      if (Object.keys(set).length || remove.length) return { set, remove };
      return null;
    };

    const processSet = (key: string, oldVal: string | null, newVal: string) => {
      if (suppressSyncRef.current) { syncDiag.skipSuppress++; return; }
      if (!isSyncableStorageKey(key)) { syncDiag.skipNotSyncable++; return; }
      if (oldVal === newVal) { syncDiag.skipNoop++; return; }
      // Vérifier si un clear forcé est en cours (erreur 401)
      if ((window as any).__forceClearInProgress) { syncDiag.skipForceClear++; return; }
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) { syncDiag.skipGateSet++; syncDiag.lastSkippedKey = key; return; }
      if (isProgressKey(key)) {
        // Accumulate latest patch for progress keys
        const delta = computeObjectPatch(oldVal, newVal);
        if (delta) {
          const existing = progressOpsMapRef.current.get(key) || { delta: { set: {}, remove: [] as string[] } };
          existing.delta.set = { ...existing.delta.set, ...delta.set };
          existing.delta.remove = Array.from(new Set([...(existing.delta.remove || []), ...delta.remove]));
          progressOpsMapRef.current.set(key, existing);
        } else {
          // If cannot diff, fallback to set
          progressOpsMapRef.current.set(key, { value: newVal });
        }
        return;
      }

      // Try array diff first
      const arrayOps = computeArrayDiffOps(key, oldVal, newVal);
      if (arrayOps && arrayOps.length) {
        arrayOps.forEach(enqueueGeneralOp);
        return;
      }

      // Try object patch with generic nested array support
      const delta = computeObjectPatch(oldVal, newVal);
      if (delta) {
        enqueueGeneralOp({ op: 'objPatch', key, delta });
      } else {
        enqueueGeneralOp({ op: 'set', key, value: newVal });
      }
    };

    const processRemove = (key: string) => {
      if (suppressSyncRef.current) { syncDiag.skipSuppress++; return; }
      if (!isSyncableStorageKey(key)) { syncDiag.skipNotSyncable++; return; }
      // Vérifier si un clear forcé est en cours (erreur 401)
      if ((window as any).__forceClearInProgress) { syncDiag.skipForceClear++; return; }
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) { syncDiag.skipGateRemove++; syncDiag.lastSkippedKey = key; return; }
      enqueueGeneralOp({ op: 'remove', key });
      if (isProgressKey(key)) {
        progressOpsMapRef.current.delete(key);
      }
    };

    // Microtask diff queue: defer JSON.parse + computeArrayDiffOps + computeObjectPatch
    // off the synchronous setItem/removeItem path. Writes still hit localStorage
    // synchronously; only the diff/sync work is batched into a microtask drain.
    const pendingDiffs: Array<{ key: string; oldVal: string | null; newVal: string | null }> = [];
    let diffQueueScheduled = false;
    const scheduleDiffDrain = () => {
      if (diffQueueScheduled) return;
      diffQueueScheduled = true;
      queueMicrotask(() => {
        diffQueueScheduled = false;
        const batch = pendingDiffs.splice(0);
        syncDiag.diffsDrained += batch.length;
        for (const entry of batch) {
          if (entry.newVal === null) {
            processRemove(entry.key);
          } else {
            processSet(entry.key, entry.oldVal, entry.newVal);
          }
        }
      });
    };

    // BroadcastChannel for cross-tab sync. Receivers ONLY refresh prev so
    // future local diffs are correct against shared localStorage state — they
    // must NOT enqueue sync ops here. The originating tab handles its own
    // sync; re-syncing in receivers races with this tab's pending 1s flush
    // and can interleave a `remove` between a user's `arrayAdd X` and the
    // backing `arrayAdd A,B,C,D` (when another tab's loadProfileData wipes
    // and re-applies the syncable keys), losing X from the backend.
    const supportsBroadcastChannel = typeof BroadcastChannel !== 'undefined';
    let channel: BroadcastChannel | null = null;
    if (supportsBroadcastChannel && isLocalStorageAvailable) {
      try {
        channel = new BroadcastChannel('movix-storage-sync');
        channel.onmessage = (e: MessageEvent) => {
          const data = e.data ?? {};
          const key = data.key;
          const value = data.value as string | null | undefined;
          if (typeof key !== 'string') return;
          const newVal = (value === undefined ? null : value) as string | null;
          if (newVal === null) {
            prevValuesRefLocal.current.delete(key);
          } else {
            prevValuesRefLocal.current.set(key, newVal);
          }
        };
      } catch (error) {
        console.warn('BroadcastChannel init failed:', error);
        channel = null;
      }
    }

    // Fallback poll for browsers without BroadcastChannel support (rare on Safari/Firefox today,
    // but kept for safety on older versions). Single 2s interval replaces the prior 2s + 5s pair.
    const browserPollingInterval = (!channel && (isSafari || isFirefox) && isLocalStorageAvailable) ? setInterval(() => {
      try {
        // Check for changes in localStorage
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;

          const currentValue = localStorage.getItem(key);
          const prevValue = prevValuesRefLocal.current.get(key);

          if (currentValue !== prevValue) {
            debugAppLog(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} detected localStorage change for key: ${key}`, {
              oldValue: prevValue,
              newValue: currentValue
            });

            // Process changes (sync is now allowed on watch routes)
            if (currentValue === null) {
              // Key was removed
              processRemove(key);
              prevValuesRefLocal.current.delete(key);
            } else {
              // Key was added or changed
              processSet(key, prevValue || null, currentValue);
              prevValuesRefLocal.current.set(key, currentValue);
            }
          }
        }

        // Check for removed keys
        const currentKeys = new Set<string>();
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) currentKeys.add(key);
        }

        prevValuesRefLocal.current.forEach((_, key) => {
          if (!currentKeys.has(key)) {
              debugAppLog(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} detected localStorage key removal: ${key}`);
            // Process key removal (sync is now allowed on watch routes)
            processRemove(key);
            prevValuesRefLocal.current.delete(key);
          }
        });
      } catch (error) {
        console.warn(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} localStorage polling error:`, error);
      }
    }, 2000) : null; // Poll every 2 seconds for Safari and Firefox/Librewolf without BroadcastChannel

    // Patch Storage.prototype, NOT the localStorage instance. On Firefox,
    // `localStorage` is a LegacyPlatformObject with a named-property setter:
    // assigning `localStorage.setItem = fn` is interpreted as
    // `setItem("setItem", fn.toString())` and stores the function as a
    // localStorage entry — leaving the original prototype method in place,
    // so writes are never intercepted and zero sync requests fire. Patching
    // the prototype (a plain object, no named-property handler) works on
    // every engine. The `this === localStorage` guard keeps sessionStorage
    // writes on the unmodified path.
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const originalClear = Storage.prototype.clear;

    // Past versions of this code attempted `localStorage.setItem = fn` and
    // accidentally seeded junk entries on Firefox users. Drop them once.
    for (const junkKey of ['setItem', 'removeItem', 'clear']) {
      const v = localStorage.getItem(junkKey);
      if (v && v.startsWith('function')) {
        originalRemoveItem.call(localStorage, junkKey);
        prevValuesRefLocal.current.delete(junkKey);
      }
    }

    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this !== localStorage) return originalSetItem.call(this, key, value);
      if (!isLocalStorageAvailable) return;

      syncDiag.setItemIntercepted++;
      const oldVal = prevValuesRefLocal.current.get(key) ?? localStorage.getItem(key);
      originalSetItem.call(localStorage, key, value);
      prevValuesRefLocal.current.set(key, value);

      // Notify other tabs synchronously (cheap; deferred work happens in microtask).
      try { channel?.postMessage({ key, value }); } catch { /* noop */ }

      // Defer JSON-diff cost off the synchronous write path.
      if (!isProfileDataLoadingRef.current) {
        pendingDiffs.push({ key, oldVal, newVal: value });
        syncDiag.diffsQueued++;
        scheduleDiffDrain();
      } else {
        syncDiag.skipGateSet++;
        syncDiag.lastSkippedKey = key;
      }
    } as any;

    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (this !== localStorage) return originalRemoveItem.call(this, key);
      if (!isLocalStorageAvailable) return;

      syncDiag.removeItemIntercepted++;
      const oldVal = prevValuesRefLocal.current.get(key) ?? null;
      originalRemoveItem.call(localStorage, key);
      prevValuesRefLocal.current.delete(key);

      // Notify other tabs synchronously.
      try { channel?.postMessage({ key, value: null }); } catch { /* noop */ }

      // Defer downstream sync work into the microtask drain.
      if (!isProfileDataLoadingRef.current) {
        pendingDiffs.push({ key, oldVal, newVal: null });
        syncDiag.diffsQueued++;
        scheduleDiffDrain();
      } else {
        syncDiag.skipGateRemove++;
        syncDiag.lastSkippedKey = key;
      }
    } as any;

    Storage.prototype.clear = function (this: Storage) {
      if (this !== localStorage) return originalClear.call(this);
      if (!isLocalStorageAvailable) return;

      // Snapshot keys (with their previous values) before wiping localStorage.
      const cleared: Array<{ key: string; oldVal: string | null }> = [];
      prevValuesRefLocal.current.forEach((v, k) => cleared.push({ key: k, oldVal: v }));
      originalClear.call(localStorage);

      // Notify other tabs synchronously, even on forced clear.
      if (channel) {
        for (const entry of cleared) {
          try { channel.postMessage({ key: entry.key, value: null }); } catch { /* noop */ }
        }
      }

      // Vérifier si un clear forcé est en cours (erreur 401)
      if (!(window as any).__forceClearInProgress && !isProfileDataLoadingRef.current) {
        for (const entry of cleared) {
          pendingDiffs.push({ key: entry.key, oldVal: entry.oldVal, newVal: null });
        }
        if (cleared.length) scheduleDiffDrain();
      }

      prevValuesRefLocal.current.clear();
    } as any;

    // Same rule as the BroadcastChannel handler: refresh prev only, never
    // enqueue sync ops. See the channel.onmessage comment above for the
    // race that re-syncing here re-introduces.
    const storageListener = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.newValue === null) {
        prevValuesRefLocal.current.delete(e.key);
      } else {
        prevValuesRefLocal.current.set(e.key, e.newValue);
      }
    };
    window.addEventListener('storage', storageListener);

    const progressInterval = setInterval(() => {
      // Skip sync during profile data loading (but allow on watch routes)
      if (!isProfileDataLoadingRef.current) {
        flushProgressOps();
      }
    }, 10000); // every 10s

    // Flush any pending debounced ops when the tab is hidden or unloaded so
    // fast refresh / close after a toggle doesn't silently drop the change.
    // Uses fetch with keepalive so the request survives page unload.
    const flushPendingOpsSync = () => {
      if (isProfileDataLoadingRef.current) return;
      if ((window as unknown as { __forceClearInProgress?: boolean }).__forceClearInProgress) return;

      // Synchronously drain pendingDiffs FIRST. The microtask scheduled by
      // the wrapped setItem/removeItem may not have run yet on Firefox: its
      // unload sequencing can fire pagehide before the microtask checkpoint
      // when the user refreshes immediately after a write (e.g., F5 right
      // after submitting a VIP key). Without this explicit drain, in-flight
      // diffs would never reach generalOpsRef and the outbox + keepalive
      // path below would have nothing to flush — losing the user's write
      // across reload. Chrome reliably drains microtasks before pagehide,
      // which is why this manifests as "Firefox-only data loss".
      if (pendingDiffs.length) {
        const batch = pendingDiffs.splice(0);
        for (const entry of batch) {
          if (entry.newVal === null) {
            processRemove(entry.key);
          } else {
            processSet(entry.key, entry.oldVal, entry.newVal);
          }
        }
      }

      if (generalFlushTimeoutRef.current) {
        clearTimeout(generalFlushTimeoutRef.current);
        generalFlushTimeoutRef.current = null;
      }
      const pending: Array<Record<string, unknown>> = [];
      if (generalOpsRef.current.length) {
        pending.push(...generalOpsRef.current);
        generalOpsRef.current = [];
      }
      for (const [key, deltaOrValue] of progressOpsMapRef.current.entries()) {
        const delta = deltaOrValue?.delta;
        if (delta && (Object.keys(delta.set || {}).length || (delta.remove || []).length)) {
          pending.push({ op: 'objPatch', key, delta });
        } else if (deltaOrValue && typeof deltaOrValue.value === 'string') {
          pending.push({ op: 'set', key, value: deltaOrValue.value });
        }
      }
      progressOpsMapRef.current.clear();
      if (!pending.length) return;

      const userInfo = getUserInfo();
      if (!userInfo.type || !userInfo.profileId || !['oauth', 'bip39'].includes(userInfo.type)) return;
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      // Persist a recovery outbox to localStorage BEFORE the keepalive fetch.
      // fetch keepalive is best-effort: on Firefox the Authorization header
      // triggers a CORS preflight that the browser may drop on unload, and
      // both engines cap inflight keepalive bytes. If the request never lands
      // server-side, the next page load would otherwise wipe localStorage and
      // restore stale backend state — losing the user's write. ProfileContext
      // .replayOutboxIfAny reads this on boot and POSTs before the wipe runs.
      //
      // We MERGE with any existing outbox for the same user/profile rather
      // than overwriting. Without merge, a chain of partial failures (replay
      // 5xx → next-session writes → next unload) would silently drop the
      // older un-replayed ops every cycle. A hard cap on op count prevents
      // unbounded growth across many failed cycles; oldest ops are dropped
      // first since newer ops reflect later state and ops are idempotent.
      try {
        const MAX_OUTBOX_OPS = 10000;
        let mergedOps: Array<Record<string, unknown>> = pending;
        try {
          const existingRaw = localStorage.getItem(SYNC_OUTBOX_STORAGE_KEY);
          if (existingRaw) {
            const parsed = JSON.parse(existingRaw) as {
              userType?: string;
              profileId?: string;
              ops?: unknown;
            } | null;
            if (parsed
                && parsed.userType === userInfo.type
                && parsed.profileId === userInfo.profileId
                && Array.isArray(parsed.ops)
                && parsed.ops.length > 0) {
              mergedOps = [
                ...(parsed.ops as Array<Record<string, unknown>>),
                ...pending
              ];
            }
          }
        } catch { /* noop */ }

        if (mergedOps.length > MAX_OUTBOX_OPS) {
          mergedOps = mergedOps.slice(mergedOps.length - MAX_OUTBOX_OPS);
        }

        const outboxPayload = {
          userType: userInfo.type,
          profileId: userInfo.profileId,
          userId: userInfo.id || undefined,
          ops: mergedOps,
          ts: Date.now()
        };
        localStorage.setItem(SYNC_OUTBOX_STORAGE_KEY, JSON.stringify(outboxPayload));
      } catch (outboxErr) {
        // Quota exceeded or other write error — proceed with keepalive anyway.
        console.warn('[outbox] failed to persist outbox at unload:', outboxErr);
      }

      try {
        for (let index = 0; index < pending.length; index += MAX_SYNC_OPS_PER_REQUEST) {
          const batch = pending.slice(index, index + MAX_SYNC_OPS_PER_REQUEST);
          const syncPayload: Record<string, unknown> = {
            userType: userInfo.type,
            profileId: userInfo.profileId,
            ops: batch
          };
          if (userInfo.id) syncPayload.userId = userInfo.id;

          fetch(`${API_URL}/api/sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`
            },
            body: JSON.stringify(syncPayload),
            keepalive: true,
            credentials: 'omit'
          }).catch(() => undefined);
        }
      } catch {
        // fire and forget on unload
        void 0;
      }
    };

    const handlePageHide = () => flushPendingOpsSync();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingOpsSync();
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('storage', storageListener);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (generalFlushTimeoutRef.current) clearTimeout(generalFlushTimeoutRef.current);
      clearInterval(progressInterval);
      if (browserPollingInterval) clearInterval(browserPollingInterval);
      try { channel?.close(); } catch { /* noop */ }
      channel = null;
      Storage.prototype.setItem = originalSetItem;
      Storage.prototype.removeItem = originalRemoveItem;
      Storage.prototype.clear = originalClear;
    };
  }, [isWatchRoute]); // Add isWatchRoute as dependency

  // Determine user type, ID, and profile ID (only oauth and bip39 users can sync)
  const getUserInfo = () => {
    const profileId = localStorage.getItem('selected_profile_id');
    const account = getResolvedAccountContext();

    if (!account.userType) {
      return { type: null, id: null, profileId: null };
    }

    return {
      type: account.userType,
      id: account.userId,
      profileId,
    };
  };

  // Guest UUID generation removed - no sync for guests

  // Load user data when authenticated via OAuth/BIP39 - only once when auth status changes
  useEffect(() => {
    // Skip if initial sync is already done
    if (isInitialSyncDone) {
      return;
    }

    // Skip initial data loading on watch routes (but allow sync)
    if (isWatchRoute) {
      debugAppLog("Skipping initial data loading - on watch route");
      return;
    }

    const userInfo = getUserInfo();

    // Only load data for oauth and bip39 users with a selected profile
    // Note: ProfileContext now handles loading profile data, so we just mark sync as done
    if (userInfo.type && userInfo.id && userInfo.profileId && ['oauth', 'bip39'].includes(userInfo.type)) {
      // ProfileContext will handle loading the profile data
      debugAppLog("Profile data loading handled by ProfileContext");
      setIsInitialSyncDone(true);
    } else {
      // For users without sync capability, just mark sync as done
      setIsInitialSyncDone(true);
    }
  }, [isInitialSyncDone, isWatchRoute]); // Add isWatchRoute as dependency



  return null;
};



// Nudge popup when user still has the default profile
const DefaultProfileNudge: React.FC = () => {
  let currentProfile = null;
  let profiles: any[] = [];
  try {
    const ctx = useProfile();
    currentProfile = ctx.currentProfile;
    profiles = ctx.profiles;
  } catch {
    // ProfileProvider might not be available
  }
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Show nudge when user still has the default name AND default avatar
  const defaultNames = [t('nav.profile').toLowerCase(), 'profil', 'profile'];
  const isDefault =
    currentProfile &&
    profiles.length === 1 &&
    defaultNames.includes(currentProfile.name?.toLowerCase().trim()) &&
    currentProfile.avatar === '/avatars/disney/disney_avatar_1.png';

  useEffect(() => {
    if (!isDefault || dismissed) { setVisible(false); return; }
    // Don't show if already dismissed
    if (sessionStorage.getItem('profile_nudge_dismissed')) { return; }
    const timer = setTimeout(() => setVisible(true), 2500);
    return () => clearTimeout(timer);
  }, [isDefault, dismissed]);

  const handleDismiss = () => {
    setDismissed(true);
    setVisible(false);
    sessionStorage.setItem('profile_nudge_dismissed', 'true');
  };

  const handleCustomize = () => {
    handleDismiss();
    navigate('/profile');
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          className="fixed bottom-6 right-4 sm:right-6 z-[10000] max-w-xs w-[calc(100vw-32px)] sm:w-80"
        >
          <div className="bg-gray-900/95 backdrop-blur-md border border-gray-700/80 rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-red-500/50 flex-shrink-0">
                  <img
                    src="/avatars/disney/disney_avatar_1.png"
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">{t('profile.defaultProfileNudgeTitle')}</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{t('profile.defaultProfileNudgeMessage')}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={handleCustomize}
                  className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  {t('profile.defaultProfileNudgeCta')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={handleDismiss}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors"
                >
                  {t('profile.defaultProfileNudgeDismiss')}
                </motion.button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// Profile Gate Component - checks if user needs to select a profile
const ProfileGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentProfile, profiles, isLoading } = useProfile();
  const location = useLocation();
  const [loadingTimedOut, setLoadingTimedOut] = React.useState(false);

  // Skip profile gate on watch routes and BIP39 link flows
  const isWatchRoute = location.pathname.startsWith('/watch/');
  const isBip39LinkRoute = location.pathname.startsWith('/link-bip39');
  const isOauthAuthorizeRoute = location.pathname.startsWith('/oauth/authorize');

  // Check if user is authenticated
  const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
  const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
  const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';
  const isVipUser = localStorage.getItem('is_vip') === 'true';

  // Vérifier l'ancienne méthode d'authentification VIP (pour compatibilité)
  let isVipAuth = false;
  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const authObj = JSON.parse(authStr);
      if (authObj.userProfile && authObj.userProfile.provider === 'access_code') {
        isVipAuth = true;
      }
    } catch { }
  }

  const isAuthenticated = isDiscordAuth || isGoogleAuth || isBip39Auth || isVipAuth || isVipUser;

  // Timeout mechanism: if loading takes more than 5 seconds, continue without profiles
  React.useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (isLoading || (profiles.length === 0 && isAuthenticated && !loadingTimedOut)) {
      timeoutId = setTimeout(() => {
        console.warn('ProfileGate: Loading timeout reached (5s), continuing without profile data');
        setLoadingTimedOut(true);
      }, 5000);
    }

    // Reset timeout state when loading completes successfully
    if (!isLoading && profiles.length > 0) {
      setLoadingTimedOut(false);
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isLoading, profiles.length, isAuthenticated, loadingTimedOut]);

  // Don't show profile gate for non-authenticated users, VIP users, watch routes, or BIP39 link flows
  if (!isAuthenticated || isVipUser || isVipAuth || isWatchRoute || isBip39LinkRoute || isOauthAuthorizeRoute) {
    if (isWatchRoute || isBip39LinkRoute || isOauthAuthorizeRoute) {
      debugAppLog('ProfileGate: Skipping profile gate for route:', location.pathname);
    }
    return <>{children}</>;
  }

  // If loading timed out, continue without profile data
  if (loadingTimedOut) {
    debugAppLog('ProfileGate: Timeout reached, skipping profile gate');
    return <>{children}</>;
  }

  // Show loading while profiles are being loaded or created
  if (isLoading || (profiles.length === 0 && isAuthenticated)) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mx-auto mb-4"></div>
          <p className="text-white">{i18n.t('profile.loadingProfiles')}</p>
        </div>
      </div>
    );
  }

  // If no profiles exist or no profile is selected, show profile selection
  if (profiles.length === 0 || !currentProfile) {
    return <ProfileSelection />;
  }

  // User has selected a profile, show the app
  return <>{children}</>;
};

const AppWithIntro: React.FC = () => {
  const location = useLocation();
  const [showRedirectPopup, setShowRedirectPopup] = useState(false);
  const { showIntro, completeIntro } = useIntro();

  // Détecter si on est sur une route /watch ou la page 404
  const isWatchRoute = location.pathname.startsWith('/watch/') || location.pathname.startsWith('/watchparty/room/') || location.pathname.startsWith('/ftv/watch/');
  const isScreensaverDisabledRoute = isWatchRoute || location.pathname.startsWith('/live-tv');

  // Screensaver logic
  const [screensaverEnabled, setScreensaverEnabled] = useState(() => localStorage.getItem('screensaver_enabled') === 'true');
  const [screensaverTimeout, setScreensaverTimeout] = useState(() => {
    const saved = localStorage.getItem('screensaver_timeout');
    return saved ? parseInt(saved, 10) : 60;
  });

  const shouldEnableScreensaver = screensaverEnabled && !isScreensaverDisabledRoute;
  const { isIdle, wake } = useIdleTimer(screensaverTimeout * 1000, shouldEnableScreensaver);

  // Listen for settings changes from Profile page
  React.useEffect(() => {
    const handleSettingsChange = () => {
      setScreensaverEnabled(localStorage.getItem('screensaver_enabled') === 'true');
      const t = localStorage.getItem('screensaver_timeout');
      setScreensaverTimeout(t ? parseInt(t, 10) : 60);
    };
    window.addEventListener('screensaver_settings_changed', handleSettingsChange);
    return () => window.removeEventListener('screensaver_settings_changed', handleSettingsChange);
  }, []);
  // Pages avec hero header (pas d'espace top): Home, ProviderContent, Movies, TVShows
  const currentPath = location.pathname;
  const isHeroHeaderPage =
    currentPath === '/' ||
    currentPath === '/movies' ||
    currentPath === '/anime' ||
    currentPath === '/tv-shows' ||
    currentPath.startsWith('/provider/');
  const isWrappedRoute = currentPath === '/wrapped' || currentPath.startsWith('/wrapped/');
  const shouldShowHeader = !isWatchRoute && !isWrappedRoute;
  const isAprilFoolsAdminRouteEnabled = isAprilFoolsAdminEnabled(location.search);
  const isNoFooterPage = isWatchRoute;
  React.useEffect(() => {
    // Masquer le footer uniquement sur les routes lecteur
    const footer = document.querySelector('footer');
    if (footer) {
      if (isNoFooterPage) {
        footer.style.display = 'none';
      } else {
        footer.style.display = '';
      }
    }
    // Nettoyage au démontage
    return () => {
      if (footer) footer.style.display = '';
    };
  }, [isNoFooterPage]);

  // Apply profile page styles
  React.useEffect(() => {
    const isProfilePage = currentPath === '/profile-selection' || currentPath === '/profile-management';

    if (isProfilePage) {
      document.body.classList.add('profile-page');
      document.documentElement.classList.add('profile-page');
    } else {
      document.body.classList.remove('profile-page');
      document.documentElement.classList.remove('profile-page');
    }

    // Cleanup
    return () => {
      document.body.classList.remove('profile-page');
      document.documentElement.classList.remove('profile-page');
    };
  }, [currentPath]);

  // Scroll to top when ad popup is accepted (lecture click)
  React.useEffect(() => {
    const onAccepted = () => {
      try {
        scrollViewportToTop(shouldAnimateScrollToTop() ? 'smooth' : 'instant');
      } catch { }
    };
    window.addEventListener('ad_popup_accepted', onAccepted);
    return () => window.removeEventListener('ad_popup_accepted', onAccepted);
  }, []);

  // Check for redirect parameter
  React.useEffect(() => {
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('redirect') !== null) {
      setShowRedirectPopup(true);
    }
  }, [location.search]);

  // Source priority prefs ↔ extension sync (Milestone 9.1).
  // Push current prefs on mount (extension may already be ready by then), and
  // subscribe to later local changes so the extension mirror stays in sync.
  // Both calls are no-op if the extension isn't installed — see
  // `pushPriorityToExtension` for the swallowed-failure contract.
  React.useEffect(() => {
    void pushPriorityToExtension();
    return subscribeToPriorityChanges((prefs) => {
      void pushPriorityToExtension(prefs);
    });
  }, []);

  // Idle prefetch (Milestone 6): preload high-traffic route chunks shortly
  // after mount via requestIdleCallback (setTimeout fallback for Safari/FF).
  useEffect(() => {
    const IDLE_PREFETCH = ['/movies', '/tv-shows', '/anime', '/search'];
    // @ts-expect-error - requestIdleCallback not in all TS DOM lib versions
    const ric = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1500));
    ric(() => {
      for (const path of IDLE_PREFETCH) {
        const entry = ROUTES.find(r => matchPath(r.path, path));
        entry?.loader({ silent: true }).catch(() => {/* swallow — best-effort prefetch */});
      }
    }, { timeout: 3000 });
  }, []);

  return (
    <div className="min-h-screen bg-black text-white relative overflow-hidden">
      {/* Intro overlay — le site charge derrière */}
      {showIntro && <IntroAnimation onAnimationComplete={completeIntro} />}
      {/* Global styles for profile pages */}
      <style>
        {`
          body.profile-page {
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
          }
          html.profile-page {
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
          }
        `}
      </style>
      {/* Composant pour faire défiler vers le haut lors des changements de route */}
      <ScrollToTop />
      {/* Animation de scroll fluide globale (Lenis) */}
      <SmoothScroll />
      {/* Ne pas afficher le Header sur les routes lecteur et Wrapped */}
      {shouldShowHeader && <Header />}
      <PersistenceManager />
      <div className={shouldShowHeader && !isHeroHeaderPage ? 'pt-20' : ''}>
        <AlertNotificationManager />
        <DefaultProfileNudge />
        <ProfileGate>
          <Routes>
            {/* Eager — landing page, kept in main bundle */}
            <Route path="/" element={<Home />} />

            {/* Routes spéciales avec props ou logique conditionnelle */}
            <Route path="/login-bip39" element={<LoginBip39 />} />
            <Route path="/create-account" element={<CreateAccount />} />
            <Route path="/link-bip39" element={<LoginBip39 mode="link" />} />
            <Route path="/link-bip39/create" element={<CreateAccount mode="link" />} />
            <Route path="/terms" element={<Navigate to="/terms-of-service" replace />} />
            <Route path="/profile-selection" element={<ProfileSelection />} />
            <Route
              path={APRIL_FOOLS_ADMIN_PATH}
              element={isAprilFoolsAdminRouteEnabled
                ? <AprilFoolsAdminPage />
                : <Navigate to="/" replace />}
            />

            {/* Toutes les autres routes — depuis le registry */}
            {ROUTES.map(renderRouteEntry)}

            {/* 404 — eager (frequently entered cold) */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ProfileGate>
        {!isWatchRoute && <Footer />}
      </div>

      {/* Redirect Popup */}
      <RedirectPopup
        isOpen={showRedirectPopup}
        onClose={() => setShowRedirectPopup(false)}
      />

      {/* Screensaver */}
      {shouldEnableScreensaver && <ScreenSaver isIdle={isIdle} onWake={wake} />}
    </div>
  );
};

const MAINTENANCE_MODE = false; // Mettre à `false` pour désactiver le mode maintenance

// Composant pour bloquer l'embed depuis wavewatch.xyz
const EmbedBlockPage = () => (
  <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 text-center sm:p-6 lg:p-8">
    <h1 className="text-4xl font-bold mb-4 sm:text-5xl lg:text-6xl">{i18n.t('embed.blocked')}</h1>
    <div className="border-2 border-red-700 bg-red-950/60 rounded-lg p-6 max-w-md w-full shadow-lg sm:max-w-lg lg:max-w-2xl">
      <h2 className="text-2xl font-semibold mb-3 sm:text-3xl lg:text-4xl">{i18n.t('embed.unauthorized')}</h2>
      <p className="text-base mb-4 sm:text-lg lg:text-xl">
        {i18n.t('embed.message')}
      </p>
      <a
        href="https://movix.tax"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition sm:py-3 sm:px-6 lg:py-4 lg:px-8"
      >
        {i18n.t('embed.goToSite')}
      </a>
    </div>
  </div>
);

const MaintenancePage = ({ onContinue }: { onContinue: () => void }) => (
  <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 text-center sm:p-6 lg:p-8">
    <h1 className="text-4xl font-bold mb-4 sm:text-5xl lg:text-6xl">{i18n.t('maintenance.title')}</h1>
    <div className="border-2 border-red-700 bg-red-950/60 rounded-lg p-6 max-w-md w-full shadow-lg sm:max-w-lg lg:max-w-2xl">
      <h2 className="text-2xl font-semibold mb-3 sm:text-3xl lg:text-4xl">{i18n.t('maintenance.subtitle')}</h2>
      <p className="text-base mb-4 sm:text-lg lg:text-xl">
        {i18n.t('maintenance.message')}
      </p>
      <button
        onClick={onContinue}
        className="mt-2 inline-block bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded transition sm:py-3 sm:px-6 lg:py-4 lg:px-8"
      >
        {i18n.t('maintenance.continueAnyway')}
      </button>
    </div>
  </div>
);

// Wraps the tree in a <MotionConfig> tied to the Mode léger / animation prefs.
// When `transitions` is disabled (manually or because Mode léger is on),
// framer-motion treats EVERY animation as if `prefers-reduced-motion: reduce`
// were set — initial/animate/exit are skipped on transform/opacity for free.
const AnimationMotionConfig: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { effectivePrefs } = useLightMode();
  return (
    <MotionConfig reducedMotion={effectivePrefs.transitions ? 'user' : 'always'}>
      {children}
    </MotionConfig>
  );
};

function App() {
  const [forceContinue, setForceContinue] = React.useState(false);

  // Vérifier si le site est embarqué depuis wavewatch.xyz (DÉSACTIVÉ)
  const isEmbeddedFromWavewatch = React.useMemo(() => {
    try {
      return false; // Désactivé - ne bloque plus l'embed
      // return document.referrer && document.referrer.includes('embed.wavewatch.xyz');
    } catch (error) {
      return false;
    }
  }, []);

  // Bloquer l'accès si embarqué depuis wavewatch.xyz (DÉSACTIVÉ)
  if (isEmbeddedFromWavewatch) {
    return <EmbedBlockPage />;
  }

  if (MAINTENANCE_MODE && !forceContinue) {
    return <MaintenancePage onContinue={() => setForceContinue(true)} />;
  }

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <TooltipProvider delayDuration={300}>
      <LightModeProvider>
      <AnimationMotionConfig>
      <SearchProvider>
        <AdFreePopupProvider>
          <AuthProvider>
            <AdWarningProvider>
              <VipModalProvider>
                <ProfileProvider>
                  <TurnstileProvider>
                    <IntroProvider>
                      <IOSHomeScreenHandler />
                      <AppWithIntro />
                      <TopProgressBar />
                      <Toaster position="bottom-right" richColors />
                      <DnsBlockBanner />
                    </IntroProvider>
                  </TurnstileProvider>
                </ProfileProvider>
              </VipModalProvider>
            </AdWarningProvider>
          </AuthProvider>
        </AdFreePopupProvider>
      </SearchProvider>
      </AnimationMotionConfig>
      </LightModeProvider>
      </TooltipProvider>
    </BrowserRouter>
  );
};

export default App;
