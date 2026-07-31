// Toggle that controls whether the ad popup opens the +18 ad creative or the
// SFW one. Default = true (+18) per product decision. Users can opt out via
// settings, which writes 'false' to localStorage. Absent key = default (on).

export const AD_POPUP_ADULT_KEY = 'settings_ad_popup_adult';
export const AD_POPUP_ADULT_CHANGED_EVENT = 'ad_popup_adult_changed';

// +18: les 2 directlinks s'ouvrent ensemble au clic (1 fenêtre par URL).
export const AD_URLS_ADULT = [
  'https://ustashewasputtin.com/?tiWc1=1197390',
];
export const AD_URL_SFW =
  'https://endedstrung.com/c7c9gpr0q?key=6b8520a3e98e4cd1228e9319d751b237';

export const isAdultAdsEnabled = (): boolean => {
  try {
    // Default on: only an explicit 'false' opts out.
    return localStorage.getItem(AD_POPUP_ADULT_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const setAdultAdsEnabled = (enabled: boolean): void => {
  try {
    if (enabled) localStorage.removeItem(AD_POPUP_ADULT_KEY);
    else localStorage.setItem(AD_POPUP_ADULT_KEY, 'false');
    window.dispatchEvent(new CustomEvent(AD_POPUP_ADULT_CHANGED_EVENT, { detail: { enabled } }));
  } catch { /* noop */ }
};

export const subscribeToAdultAdsChanges = (cb: (enabled: boolean) => void): (() => void) => {
  const onCustom = () => cb(isAdultAdsEnabled());
  const onStorage = (e: StorageEvent) => {
    if (e.key === AD_POPUP_ADULT_KEY) cb(isAdultAdsEnabled());
  };
  window.addEventListener(AD_POPUP_ADULT_CHANGED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(AD_POPUP_ADULT_CHANGED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
};

export const getAdTargetUrls = (): string[] =>
  isAdultAdsEnabled() ? AD_URLS_ADULT : [AD_URL_SFW];
