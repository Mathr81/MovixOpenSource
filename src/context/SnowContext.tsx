import React, { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react';

interface SnowContextType {
  isSnowEnabled: boolean;
  toggleSnow: () => void;
}

const SnowContext = createContext<SnowContextType | undefined>(undefined);

export const SnowProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isSnowEnabled, setIsSnowEnabled] = useState(() => {
    const saved = localStorage.getItem('snow_enabled');
    return saved ? JSON.parse(saved) : false;
  });

  useEffect(() => {
    localStorage.setItem('snow_enabled', JSON.stringify(isSnowEnabled));
  }, [isSnowEnabled]);

  const toggleSnow = useCallback(() => {
    setIsSnowEnabled(prev => !prev);
  }, []);

  const value = useMemo(
    () => ({ isSnowEnabled, toggleSnow }),
    [isSnowEnabled, toggleSnow]
  );

  return (
    <SnowContext.Provider value={value}>
      {children}
    </SnowContext.Provider>
  );
};

export const useSnow = () => {
  const context = useContext(SnowContext);
  if (context === undefined) {
    throw new Error('useSnow must be used within a SnowProvider');
  }
  return context;
};
