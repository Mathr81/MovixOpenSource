import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

type LightModeSetting = 'auto' | 'on' | 'off';

export type AnimationPrefKey =
  | 'bgAnimations'
  | 'loadingAnimations'
  | 'carouselAutoplay'
  | 'blurEffects'
  | 'transitions';

export interface AnimationPrefs {
  bgAnimations: boolean;
  loadingAnimations: boolean;
  carouselAutoplay: boolean;
  blurEffects: boolean;
  transitions: boolean;
}

interface LightModeContextType {
  isLightMode: boolean;
  lightModeSetting: LightModeSetting;
  setLightModeSetting: (setting: LightModeSetting) => void;
  prefs: AnimationPrefs;
  effectivePrefs: AnimationPrefs;
  setPref: (key: AnimationPrefKey, value: boolean) => void;
  resetPrefs: () => void;
}

const LightModeContext = createContext<LightModeContextType | undefined>(undefined);

// Each pref maps to a localStorage key and a `data-*` attribute on <html>.
// Keeping the attribute name short — it ends up on every CSS selector.
const PREF_META: Record<AnimationPrefKey, { storageKey: string; attr: string }> = {
  bgAnimations:      { storageKey: 'settings_anim_bg',         attr: 'data-no-bg-anim' },
  loadingAnimations: { storageKey: 'settings_anim_loading',    attr: 'data-no-loading-anim' },
  carouselAutoplay:  { storageKey: 'settings_anim_carousel',   attr: 'data-no-carousel-anim' },
  blurEffects:       { storageKey: 'settings_anim_blur',       attr: 'data-no-blur' },
  transitions:       { storageKey: 'settings_anim_transitions', attr: 'data-no-transitions' },
};

const DEFAULT_PREFS: AnimationPrefs = {
  bgAnimations: true,
  loadingAnimations: true,
  carouselAutoplay: true,
  blurEffects: true,
  transitions: true,
};

function readPref(key: AnimationPrefKey): boolean {
  const raw = localStorage.getItem(PREF_META[key].storageKey);
  if (raw === null) return DEFAULT_PREFS[key];
  return raw !== 'false';
}

function detectWeakDevice(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('tizen') || ua.includes('webos') || ua.includes('web0s') ||
      ua.includes('smarttv') || ua.includes('smart-tv') || ua.includes('nettv') ||
      ua.includes('appletv') || ua.includes('roku') || ua.includes('firetv') ||
      ua.includes('philipstv') || ua.includes('hbbtv')) {
    return true;
  }
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) {
    return true;
  }
  if ((navigator as Navigator & { deviceMemory?: number }).deviceMemory &&
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory! <= 2) {
    return true;
  }
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return true;
  }
  return false;
}

export const LightModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lightModeSetting, setLightModeSettingState] = useState<LightModeSetting>(() => {
    return (localStorage.getItem('settings_light_mode') as LightModeSetting) || 'auto';
  });

  const [prefs, setPrefsState] = useState<AnimationPrefs>(() => ({
    bgAnimations: readPref('bgAnimations'),
    loadingAnimations: readPref('loadingAnimations'),
    carouselAutoplay: readPref('carouselAutoplay'),
    blurEffects: readPref('blurEffects'),
    transitions: readPref('transitions'),
  }));

  const isLightMode = useMemo(() => {
    if (lightModeSetting === 'on') return true;
    if (lightModeSetting === 'off') return false;
    return detectWeakDevice();
  }, [lightModeSetting]);

  // Effective prefs: light mode ON forces every category to "disabled" (false)
  // regardless of the user's granular state. Granular state is preserved so the
  // user gets it back when they turn light mode off.
  const effectivePrefs: AnimationPrefs = useMemo(() => {
    if (isLightMode) {
      return {
        bgAnimations: false,
        loadingAnimations: false,
        carouselAutoplay: false,
        blurEffects: false,
        transitions: false,
      };
    }
    return prefs;
  }, [isLightMode, prefs]);

  const setLightModeSetting = useCallback((setting: LightModeSetting) => {
    setLightModeSettingState(setting);
    localStorage.setItem('settings_light_mode', setting);
  }, []);

  const setPref = useCallback((key: AnimationPrefKey, value: boolean) => {
    setPrefsState((prev) => ({ ...prev, [key]: value }));
    localStorage.setItem(PREF_META[key].storageKey, String(value));
  }, []);

  const resetPrefs = useCallback(() => {
    setPrefsState(DEFAULT_PREFS);
    (Object.keys(PREF_META) as AnimationPrefKey[]).forEach((key) => {
      localStorage.removeItem(PREF_META[key].storageKey);
    });
  }, []);

  // Sync HTML attributes whenever effective state changes. Attributes drive
  // the CSS in light-mode.css. Master `data-light-mode` is kept for legacy
  // selectors and for any third-party CSS that reads it.
  useEffect(() => {
    const root = document.documentElement;
    if (isLightMode) {
      root.setAttribute('data-light-mode', 'true');
    } else {
      root.removeAttribute('data-light-mode');
    }
    (Object.keys(PREF_META) as AnimationPrefKey[]).forEach((key) => {
      const attr = PREF_META[key].attr;
      if (!effectivePrefs[key]) {
        root.setAttribute(attr, 'true');
      } else {
        root.removeAttribute(attr);
      }
    });
  }, [isLightMode, effectivePrefs]);

  const value = useMemo(
    () => ({ isLightMode, lightModeSetting, setLightModeSetting, prefs, effectivePrefs, setPref, resetPrefs }),
    [isLightMode, lightModeSetting, setLightModeSetting, prefs, effectivePrefs, setPref, resetPrefs]
  );

  return (
    <LightModeContext.Provider value={value}>
      {children}
    </LightModeContext.Provider>
  );
};

export const useLightMode = () => {
  const context = useContext(LightModeContext);
  if (context === undefined) {
    throw new Error('useLightMode must be used within a LightModeProvider');
  }
  return context;
};
