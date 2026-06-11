import React, { createContext, useContext, useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { useWebHaptics } from 'web-haptics/react';

interface HapticsContextValue {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  triggerHaptic: (pattern?: string | number | number[]) => void;
}

const HapticsContext = createContext<HapticsContextValue>({
  enabled: true,
  setEnabled: () => {},
  triggerHaptic: () => {},
});

export const useHaptics = () => useContext(HapticsContext);

const STORAGE_KEY = 'settings_haptics_enabled';

// Selectors for interactive elements that should trigger haptic feedback
const INTERACTIVE_SELECTOR = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], a[href], input[type="checkbox"], input[type="radio"], select, .haptic-trigger';

export const HapticsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [enabled, setEnabledState] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  });
  const enabledRef = useRef(enabled);
  const { trigger } = useWebHaptics();

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    enabledRef.current = v;
    localStorage.setItem(STORAGE_KEY, String(v));
    window.dispatchEvent(new CustomEvent('haptics_settings_changed'));
  }, []);

  const triggerHaptic = useCallback((pattern?: string | number | number[]) => {
    if (!enabledRef.current) return;
    try {
      trigger(pattern ?? 'nudge');
    } catch {
      // Silently fail on unsupported devices
    }
  }, [trigger]);

  // Global click interceptor for all interactive elements
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      const target = e.target as HTMLElement;
      if (!target) return;

      const interactive = target.closest(INTERACTIVE_SELECTOR);
      if (!interactive) return;

      // Don't haptic on disabled elements
      if ((interactive as HTMLButtonElement).disabled) return;

      // Choose pattern based on element type
      const tag = interactive.tagName.toLowerCase();
      const role = interactive.getAttribute('role');

      if (tag === 'select' || role === 'option') {
        trigger('nudge');
      } else if (interactive.classList.contains('destructive') || interactive.getAttribute('data-variant') === 'destructive') {
        trigger('error');
      } else {
        trigger('nudge');
      }
    };

    document.addEventListener('click', handler, { passive: true, capture: true });
    return () => document.removeEventListener('click', handler, true);
  }, [enabled, trigger]);

  // Sync with localStorage changes from other tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const v = e.newValue !== 'false';
        setEnabledState(v);
        enabledRef.current = v;
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(
    () => ({ enabled, setEnabled, triggerHaptic }),
    [enabled, setEnabled, triggerHaptic]
  );

  return (
    <HapticsContext.Provider value={value}>
      {children}
    </HapticsContext.Provider>
  );
};
