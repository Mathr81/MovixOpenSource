import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

interface AdWarningContextType {
  showAdWarning: boolean;
  setShowAdWarning: (show: boolean) => void;
  handleAccept: () => void;
}

const AdWarningContext = createContext<AdWarningContextType | undefined>(undefined);

export const AdWarningProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [showAdWarning, setShowAdWarning] = useState(false);

  useEffect(() => {
    const adWarningAccepted = localStorage.getItem('adWarningAccepted');
    setShowAdWarning(!adWarningAccepted);
  }, []);

  const handleAccept = useCallback(() => {
    localStorage.setItem('adWarningAccepted', 'true');
    setShowAdWarning(false);
  }, []);

  const value = useMemo(
    () => ({ showAdWarning, setShowAdWarning, handleAccept }),
    [showAdWarning, setShowAdWarning, handleAccept]
  );

  return (
    <AdWarningContext.Provider value={value}>
      {children}
    </AdWarningContext.Provider>
  );
};

export const useAdWarning = () => {
  const context = useContext(AdWarningContext);
  if (context === undefined) {
    throw new Error('useAdWarning must be used within an AdWarningProvider');
  }
  return context;
};
