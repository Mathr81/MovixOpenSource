export type AdPopupMode = 'normal' | 'auto' | 'click-anywhere';

export const AD_POPUP_MODE_KEY = 'settings_ad_popup_mode';
export const AD_POPUP_MODE_CHANGED_EVENT = 'ad_popup_mode_changed';

export const getAdPopupMode = (): AdPopupMode => {
  try {
    const v = localStorage.getItem(AD_POPUP_MODE_KEY);
    if (v === 'auto' || v === 'click-anywhere') return v;
  } catch { /* localStorage may be unavailable (SSR / privacy) */ }
  return 'normal';
};

export const setAdPopupMode = (mode: AdPopupMode): void => {
  try {
    if (mode === 'normal') localStorage.removeItem(AD_POPUP_MODE_KEY);
    else localStorage.setItem(AD_POPUP_MODE_KEY, mode);
    window.dispatchEvent(new CustomEvent(AD_POPUP_MODE_CHANGED_EVENT, { detail: { mode } }));
  } catch { /* noop */ }
};

export const subscribeToAdPopupModeChanges = (cb: (mode: AdPopupMode) => void): (() => void) => {
  const onCustom = () => cb(getAdPopupMode());
  const onStorage = (e: StorageEvent) => {
    if (e.key === AD_POPUP_MODE_KEY) cb(getAdPopupMode());
  };
  window.addEventListener(AD_POPUP_MODE_CHANGED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(AD_POPUP_MODE_CHANGED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
};
