import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import VipModal from '../components/VipModal';

interface VipModalContextType {
  isVipModalOpen: boolean;
  openVipModal: () => void;
  closeVipModal: () => void;
}

const VipModalContext = createContext<VipModalContextType | undefined>(undefined);

export const useVipModal = () => {
  const context = useContext(VipModalContext);
  if (context === undefined) {
    throw new Error('useVipModal must be used within a VipModalProvider');
  }
  return context;
};

export const VipModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isVipModalOpen, setIsVipModalOpen] = useState(false);

  const openVipModal = useCallback(() => {
    setIsVipModalOpen(true);
  }, []);

  const closeVipModal = useCallback(() => {
    setIsVipModalOpen(false);
  }, []);

  const value = useMemo(
    () => ({ isVipModalOpen, openVipModal, closeVipModal }),
    [isVipModalOpen, openVipModal, closeVipModal]
  );

  return (
    <VipModalContext.Provider value={value}>
      {children}
      <VipModal isOpen={isVipModalOpen} onClose={closeVipModal} />
    </VipModalContext.Provider>
  );
}; 