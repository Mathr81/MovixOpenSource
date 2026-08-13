import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { useTranslation } from 'react-i18next';

const TelegramPromotion: React.FC = () => {
  const { t } = useTranslation();
  // Gate le halo animé par la visibilité — sans ça `animate` avec `repeat:
  // Infinity` tourne en continu (tick rAF permanent) même quand la section
  // est hors écran. `once: false` (défaut) : l'animation se coupe/reprend à
  // chaque sortie/entrée du viewport.
  const haloRef = useRef<HTMLDivElement>(null);
  const isHaloInView = useInView(haloRef, { amount: 0.1 });
  return (
    <motion.div
      className="px-4 md:px-8"
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{
        duration: 0.7,
        ease: "easeOut",
        delay: 0.2
      }}
    >
      <motion.div
        className="relative overflow-hidden rounded-xl bg-gradient-to-r from-sky-600 via-blue-600 to-sky-800"
        initial={{ scale: 0.95, opacity: 0.8 }}
        whileInView={{ scale: 1, opacity: 1 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.5, delay: 0.3 }}
      >
        <div className="flex flex-col md:flex-row items-center justify-between p-6 md:p-8">
          <motion.div
            className="mb-6 md:mb-0 md:mr-8 text-white"
            initial={{ x: -50, opacity: 0 }}
            whileInView={{ x: 0, opacity: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <motion.h2
              className="text-2xl md:text-3xl font-bold mb-2"
              initial={{ y: -20, opacity: 0 }}
              whileInView={{ y: 0, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.5 }}
            >
              {t('telegram.joinCommunity')}
            </motion.h2>
            <motion.p
              className="text-sky-200 text-sm md:text-base mb-4"
              initial={{ y: 20, opacity: 0 }}
              whileInView={{ y: 0, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.6 }}
            >
              <span dangerouslySetInnerHTML={{ __html: t('telegram.officialAnnouncements') }} />
              <br />
              👉 <strong>{t('telegram.joinUsNow')}</strong>
            </motion.p>
            <div className="flex flex-col sm:flex-row gap-3">
              {/* Bouton Telegram seulement */}

              {/* Bouton Telegram */}
              <motion.a
                href="https://t.me/movix_site"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-sky-500 text-white font-medium px-6 py-3 rounded-lg transition-all"
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{
                  duration: 0.5,
                  delay: 0.8,
                  type: 'spring',
                  stiffness: 400,
                  damping: 10
                }}
                whileHover={{
                  backgroundColor: 'rgba(14, 165, 233, 1)',
                  scale: 1.05,
                  boxShadow: '0 0 15px rgba(14, 165, 233, 0.6)'
                }}
                whileTap={{ scale: 0.95 }}
              >
                <motion.div
                  initial={{ rotate: 0 }}
                  whileHover={{ rotate: [0, -10, 10, -10, 0] }}
                  transition={{ duration: 0.5 }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" className="w-5 h-5" viewBox="0 0 16 16">
                    <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8.287 5.906q-1.168.486-4.666 2.01-.567.225-.595.442c-.03.243.275.339.69.47l.175.055c.408.133.958.288 1.243.294q.39.01.868-.32 3.269-2.206 3.374-2.23c.05-.012.12-.026.166.016s.042.12.037.141c-.03.129-1.227 1.241-1.846 1.817-.193.18-.33.307-.358.336a8 8 0 0 1-.188.186c-.38.366-.664.64.015 1.088.327.216.589.393.85.571.284.194.568.387.936.629q.14.092.27.187c.331.236.63.448.997.414.214-.02.435-.22.547-.82.265-1.417.786-4.486.906-5.751a1.4 1.4 0 0 0-.013-.315.34.34 0 0 0-.114-.217.53.53 0 0 0-.31-.093c-.3.005-.763.166-2.984 1.09" />
                  </svg>
                </motion.div>
                <motion.span
                  initial={{ opacity: 0.9 }}
                  whileHover={{ opacity: 1 }}
                  className="relative"
                >
                  {t('telegram.joinTelegram')}
                </motion.span>
              </motion.a>



            </div>
          </motion.div>
          <motion.div
            className="relative w-40 h-40 md:w-48 md:h-48 flex-shrink-0"
            initial={{ x: 50, opacity: 0, rotate: 10 }}
            whileInView={{ x: 0, opacity: 1, rotate: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 20,
              delay: 0.5
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" className="absolute w-full h-full object-contain z-10 drop-shadow-lg" viewBox="0 0 16 16">
              <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8.287 5.906q-1.168.486-4.666 2.01-.567.225-.595.442c-.03.243.275.339.69.47l.175.055c.408.133.958.288 1.243.294q.39.01.868-.32 3.269-2.206 3.374-2.23c.05-.012.12-.026.166.016s.042.12.037.141c-.03.129-1.227 1.241-1.846 1.817-.193.18-.33.307-.358.336a8 8 0 0 1-.188.186c-.38.366-.664.64.015 1.088.327.216.589.393.85.571.284.194.568.387.936.629q.14.092.27.187c.331.236.63.448.997.414.214-.02.435-.22.547-.82.265-1.417.786-4.486.906-5.751a1.4 1.4 0 0 0-.013-.315.34.34 0 0 0-.114-.217.53.53 0 0 0-.31-.093c-.3.005-.763.166-2.984 1.09" />
            </svg>
            <motion.div
              ref={haloRef}
              className="absolute -inset-4 bg-sky-500 rounded-full blur-2xl opacity-30"
              animate={isHaloInView ? {
                scale: [1, 1.2, 1],
                opacity: [0.3, 0.5, 0.3]
              } : {
                scale: 1,
                opacity: 0.3
              }}
              transition={isHaloInView ? {
                duration: 3,
                repeat: Infinity,
                repeatType: "reverse"
              } : {
                duration: 0.3
              }}
            ></motion.div>
          </motion.div>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default TelegramPromotion;