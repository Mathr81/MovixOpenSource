import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Settings, Crown, ShieldCheck, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useProfile } from '../context/ProfileContext';
import AvatarSelector from '../components/AvatarSelector';

const ProfileSelection: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { profiles, selectProfile, createProfile, isLoading } = useProfile();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAvatarSelector, setShowAvatarSelector] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState('');
  const [newAgeRestriction, setNewAgeRestriction] = useState(0);
  const [isFading, setIsFading] = useState(false);

  // Custom dropdown state
  const [ageDropdownOpen, setAgeDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const ageRestrictionOptions = [
    { value: 0, label: t('profile.noRestriction'), color: 'text-green-400' },
    { value: 7, label: '7+', color: 'text-lime-400' },
    { value: 12, label: '12+', color: 'text-yellow-400' },
    { value: 16, label: '16+', color: 'text-orange-400' },
    { value: 18, label: '18+', color: 'text-red-400' },
  ];

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setAgeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentSelectedOption = ageRestrictionOptions.find(o => o.value === newAgeRestriction) || ageRestrictionOptions[0];

  const handleProfileSelect = (profileId: string) => {
    setIsFading(true);
    setTimeout(async () => {
      let navigated = false;
      try {
        const selected = await selectProfile(profileId);
        if (selected) {
          navigate('/');
          navigated = true;
        }
      } catch (error) {
        console.error('Profile selection failed:', error);
      } finally {
        if (!navigated) setIsFading(false);
      }
    }, 500);
  };

  const handleCreateProfile = async () => {
    if (newProfileName.trim() && selectedAvatar) {
      await createProfile(newProfileName.trim(), selectedAvatar, newAgeRestriction);
      setShowCreateModal(false);
      setNewProfileName('');
      setSelectedAvatar('');
      setNewAgeRestriction(0);
    }
  };

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
    setNewProfileName('');
    setSelectedAvatar('');
    setNewAgeRestriction(0);
    setAgeDropdownOpen(false);
  };

  const handleAvatarSelect = (avatarUrl: string) => {
    setSelectedAvatar(avatarUrl);
    setShowAvatarSelector(false);
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>{t('profile.loadingProfiles')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col items-center justify-center overflow-hidden">
      <AnimatePresence mode="wait">
        {!isFading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-6xl px-4"
          >
            {/* Header */}
            <div className="text-center mb-6 xs:mb-8 sm:mb-12">
              <h1 className="text-2xl xs:text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-2 xs:mb-4">
                {t('profile.whoIsWatching')}
              </h1>
            </div>

            {/* Profiles Grid */}
            <div className="flex flex-wrap justify-center gap-4 xs:gap-6 sm:gap-8 md:gap-12 mb-8 sm:mb-12">
              {profiles.map((profile) => (
                <motion.div
                  key={profile.id}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="flex flex-col items-center cursor-pointer group"
                  onClick={() => handleProfileSelect(profile.id)}
                >
                  <div className="relative">
                    <div className="w-20 h-20 xs:w-24 xs:h-24 sm:w-28 sm:h-28 md:w-32 md:h-32 lg:w-36 lg:h-36 xl:w-40 xl:h-40 rounded-lg overflow-hidden ring-2 xs:ring-4 ring-transparent group-hover:ring-red-600 transition-all duration-300">
                      <img
                        src={profile.avatar}
                        alt={profile.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    {/* Icône profil par défaut */}
                    {profile.isDefault && (
                      <div className="absolute -top-1 -right-1 xs:-top-1.5 xs:-right-1.5 bg-yellow-500 rounded-full p-1 xs:p-1.5 sm:p-2 shadow-lg shadow-yellow-500/30">
                        <Crown className="w-3.5 h-3.5 xs:w-4 xs:h-4 sm:w-5 sm:h-5 text-white" />
                      </div>
                    )}
                    {/* Badge restriction d'âge */}
                    {(profile.ageRestriction ?? 0) > 0 && (
                      <div className="absolute -bottom-1 -right-1 xs:-bottom-1.5 xs:-right-1.5 bg-red-600 rounded-full px-1.5 xs:px-2 py-0.5 z-10 flex items-center gap-0.5 shadow-lg shadow-red-600/30">
                        <ShieldCheck className="w-2.5 h-2.5 xs:w-3 xs:h-3 text-white" />
                        <span className="text-[9px] xs:text-[11px] font-bold text-white">{profile.ageRestriction}+</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 xs:mt-3 sm:mt-4 text-sm xs:text-base sm:text-lg md:text-xl text-gray-300 group-hover:text-white transition-colors">
                    {profile.name}
                  </p>
                  {/* Age restriction text under name */}
                  {(profile.ageRestriction ?? 0) > 0 && (
                    <p className="text-[10px] xs:text-xs text-red-400 flex items-center gap-1 mt-0.5">
                      <ShieldCheck className="w-3 h-3" />
                      {profile.ageRestriction}+
                    </p>
                  )}
                </motion.div>
              ))}

              {/* Add Profile Button */}
              {profiles.length < 5 && (
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="flex flex-col items-center cursor-pointer group"
                  onClick={() => setShowCreateModal(true)}
                >
                  <div className="w-20 h-20 xs:w-24 xs:h-24 sm:w-28 sm:h-28 md:w-32 md:h-32 lg:w-36 lg:h-36 xl:w-40 xl:h-40 rounded-lg border-2 border-dashed border-gray-600 flex items-center justify-center group-hover:border-red-600 transition-colors">
                    <Plus className="w-6 h-6 xs:w-8 xs:h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-gray-400 group-hover:text-red-600 transition-colors" />
                  </div>
                  <p className="mt-2 xs:mt-3 sm:mt-4 text-sm xs:text-base sm:text-lg md:text-xl text-gray-300 group-hover:text-white transition-colors">
                    {t('profile.addProfile')}
                  </p>
                </motion.div>
              )}
            </div>

            {/* Manage Profiles Button */}
            <div className="text-center">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => navigate('/profile-management')}
                className="flex items-center gap-2 px-6 py-3 border border-gray-600 rounded-lg hover:border-white transition-colors mx-auto"
              >
                <Settings className="w-5 h-5" />
                <span>{t('profile.manageProfiles')}</span>
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create Profile Modal - Same style as ProfileManagement edit modal */}
      <AnimatePresence>
        {showCreateModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 bg-black/80 flex items-center justify-center p-2 sm:p-4 z-[100000]"
            onClick={(e) => {
              if (e.target === e.currentTarget) handleCloseCreateModal();
            }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="bg-gray-900 rounded-2xl p-4 sm:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto"
            >
              <h3 className="text-lg sm:text-xl font-bold text-white mb-4 sm:mb-6">{t('profile.createProfile')}</h3>

              <div className="space-y-4 sm:space-y-6">
                {/* Avatar section */}
                <div className="flex flex-col items-center">
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    {t('profile.profilePhoto')}
                  </label>
                  <div className="relative">
                    <motion.div
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="w-28 h-28 sm:w-32 sm:h-32 rounded-full overflow-hidden cursor-pointer border-2 border-gray-600 hover:border-red-600 transition-colors"
                      onClick={() => setShowAvatarSelector(true)}
                    >
                      {selectedAvatar ? (
                        <img
                          src={selectedAvatar}
                          alt={t('profile.selectedAvatar')}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                          <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                          </svg>
                        </div>
                      )}
                    </motion.div>

                    {/* Age restriction badge preview on avatar */}
                    {newAgeRestriction > 0 && (
                      <div className="absolute -bottom-2 -right-2 bg-red-600 rounded-full px-2.5 py-1 z-10 flex items-center gap-1 shadow-lg shadow-red-600/40">
                        <ShieldCheck className="w-4 h-4 text-white" />
                        <span className="text-sm font-bold text-white">{newAgeRestriction}+</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Nom d'utilisateur */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('profile.username')}
                  </label>
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder={t('profile.enterName')}
                    className="w-full p-3 bg-gray-800 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-600"
                    maxLength={20}
                  />
                </div>

                {/* Restriction d'âge - Custom dropdown */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('profile.ageRestriction')}
                  </label>
                  <div className="relative" ref={dropdownRef}>
                    <button
                      type="button"
                      onClick={() => setAgeDropdownOpen(!ageDropdownOpen)}
                      className="w-full p-3 bg-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-red-600 flex items-center justify-between cursor-pointer hover:bg-gray-750 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ShieldCheck className={`w-4 h-4 ${currentSelectedOption.color}`} />
                        <span>{currentSelectedOption.label}</span>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${ageDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    <AnimatePresence>
                      {ageDropdownOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4 }}
                          transition={{ duration: 0.15 }}
                          className="absolute bottom-full left-0 right-0 mb-1 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden z-50 shadow-xl"
                        >
                          {ageRestrictionOptions.map((option) => (
                            <button
                              key={option.value}
                              onClick={() => {
                                setNewAgeRestriction(option.value);
                                setAgeDropdownOpen(false);
                              }}
                              className={`w-full px-3 py-2.5 flex items-center gap-2 hover:bg-gray-700 transition-colors text-left ${
                                newAgeRestriction === option.value ? 'bg-gray-700/50' : ''
                              }`}
                            >
                              <ShieldCheck className={`w-4 h-4 ${option.color}`} />
                              <span className="text-white">{option.label}</span>
                              {newAgeRestriction === option.value && (
                                <span className="ml-auto text-red-500 text-sm">&#10003;</span>
                              )}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{t('profile.ageRestrictionDesc')}</p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 mt-6">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleCloseCreateModal}
                  className="flex-1 px-4 py-2 border border-gray-600 rounded-lg hover:border-white transition-colors"
                >
                  {t('common.cancel')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleCreateProfile}
                  disabled={!newProfileName.trim() || !selectedAvatar}
                  className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                >
                  {t('common.create')}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Avatar Selector */}
      {showAvatarSelector && (
        <AvatarSelector
          isOpen={showAvatarSelector}
          onClose={() => setShowAvatarSelector(false)}
          onAvatarSelect={handleAvatarSelect}
          currentAvatar={selectedAvatar}
        />
      )}
    </div>
  );
};

export default ProfileSelection;
