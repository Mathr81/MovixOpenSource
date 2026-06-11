import React, { createContext, useState, useEffect, useContext, useCallback, useMemo } from 'react';

type SupportPopupContextType = {
  isPopupVisible: boolean;
  hidePopup: () => void;
};

const SupportPopupContext = createContext<SupportPopupContextType | null>(null);

export const useSupportPopup = () => {
  const context = useContext(SupportPopupContext);
  if (!context) {
    throw new Error('useSupportPopup must be used within a SupportPopupProvider');
  }
  return context;
};

export const SupportPopupProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isPopupVisible, setIsPopupVisible] = useState(false);

  useEffect(() => {
    // Vérifier si le popup a déjà été affiché et fermé
    const hasSeenPopup = localStorage.getItem('support_popup_seen');
    
    if (!hasSeenPopup) {
      // Afficher le popup après 90 minutes (5400000 ms)
      const timer = setTimeout(() => {
        setIsPopupVisible(true);
      }, 5400000);
      
      return () => clearTimeout(timer);
    }
  }, []);

  const hidePopup = useCallback(() => {
    setIsPopupVisible(false);
    // Enregistrer que l'utilisateur a vu le popup
    localStorage.setItem('support_popup_seen', 'true');
  }, []);

  const value = useMemo(
    () => ({ isPopupVisible, hidePopup }),
    [isPopupVisible, hidePopup]
  );

  return (
    <SupportPopupContext.Provider value={value}>
      {children}
    </SupportPopupContext.Provider>
  );
};
