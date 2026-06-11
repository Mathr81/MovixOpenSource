import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Crown } from 'lucide-react';
import AccessCodeForm from './AccessCodeForm';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';

interface VipModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const VipModal: React.FC<VipModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 300);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence mode="wait">
      {isOpen && !isClosing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-gray-800/90 backdrop-blur-lg rounded-2xl p-6 max-w-md w-full relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={handleClose}
              className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
            >
              <X size={24} />
            </button>

            <div className="mt-4">
              <AccessCodeForm isModal={true} />

              <div className="mt-6 pt-6 border-t border-white/10 text-center">
                <Link
                  to="/vip"
                  onClick={handleClose}
                  className="inline-flex items-center gap-2 text-sm text-yellow-500 hover:text-yellow-400 font-medium transition-colors"
                >
                  <Crown className="w-4 h-4" />
                  {t('vip.discoverBenefits')}
                </Link>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default VipModal; 