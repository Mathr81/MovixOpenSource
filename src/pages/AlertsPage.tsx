import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { Bell, BellRing, Calendar, Clock, Trash2, Edit3, ExternalLink, ArrowLeft } from 'lucide-react';
import { AlertService } from '../services/alertService';
import { EpisodeAlert, NotifyBeforeDays } from '../types/alerts';
import SEO from '../components/SEO';

const AlertsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [alerts, setAlerts] = useState<EpisodeAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAlert, setEditingAlert] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<NotifyBeforeDays>(1);

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = () => {
    setLoading(true);
    const allAlerts = AlertService.getAllAlerts();
    const alertsList = Object.values(allAlerts).sort((a, b) => 
      new Date(a.airDate).getTime() - new Date(b.airDate).getTime()
    );
    setAlerts(alertsList);
    setLoading(false);
  };

  const handleDeleteAlert = (alertId: string) => {
    if (AlertService.removeAlert(alertId)) {
      setAlerts(prev => prev.filter(alert => alert.id !== alertId));
    }
  };

  const handleEditAlert = (alertId: string, currentDays: NotifyBeforeDays) => {
    setEditingAlert(alertId);
    setSelectedDays(currentDays);
  };

  const handleSaveEdit = (alertId: string) => {
    const alert = alerts.find(a => a.id === alertId);
    if (alert && AlertService.updateAlert(alert.showId, alert.season, alert.episode, selectedDays)) {
      setAlerts(prev => prev.map(a => 
        a.id === alertId ? { ...a, notifyBeforeDays: selectedDays } : a
      ));
      setEditingAlert(null);
    }
  };

  const handleCancelEdit = () => {
    setEditingAlert(null);
  };

  const formatAirDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const formattedDate = date.toLocaleDateString(i18n.language, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    if (diffDays < 0) {
      return { text: formattedDate, status: 'passed', daysText: t('alerts.alreadyReleased') };
    } else if (diffDays === 0) {
      return { text: formattedDate, status: 'today', daysText: t('alerts.todayRelease') };
    } else if (diffDays === 1) {
      return { text: formattedDate, status: 'soon', daysText: t('alerts.tomorrowRelease') };
    } else {
      return { text: formattedDate, status: 'upcoming', daysText: t('alerts.inDays', { count: diffDays }) };
    }
  };

  const getNotificationText = (days: NotifyBeforeDays) => {
    if (days === 0) return t('alerts.onSameDay');
    return t('alerts.nDaysBefore', { count: days });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'passed':
        return 'text-gray-500';
      case 'today':
        return 'text-green-500';
      case 'soon':
        return 'text-yellow-500';
      case 'upcoming':
        return 'text-blue-500';
      default:
        return 'text-gray-400';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white">
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-500"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <SEO 
        title={t('alerts.seoTitle')}
        description={t('alerts.seoDescription')}
      />
      
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link 
            to="/"
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-3 bg-yellow-500/20 rounded-xl">
              <Bell className="w-8 h-8 text-yellow-500" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">{t('alerts.myAlerts')}</h1>
              <p className="text-gray-400">
                {t('alerts.alertsConfigured', { count: alerts.length })}
              </p>
            </div>
          </div>
        </div>

        {/* Alerts List */}
        {alerts.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-16"
          >
            <div className="p-4 bg-gray-800/50 rounded-full w-20 h-20 mx-auto mb-6 flex items-center justify-center">
              <BellRing className="w-10 h-10 text-gray-500" />
            </div>
            <h2 className="text-xl font-semibold mb-2">{t('alerts.noAlerts')}</h2>
            <p className="text-gray-400 mb-6">
              {t('alerts.noAlertsDesc')}
            </p>
            <Link
              to="/tv-shows"
              className="inline-flex items-center gap-2 px-6 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded-xl font-medium transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              {t('alerts.browseShows')}
            </Link>
          </motion.div>
        ) : (
          <div className="space-y-4">
            <AnimatePresence>
              {alerts.map((alert, index) => {
                const dateInfo = formatAirDate(alert.airDate);
                const isEditing = editingAlert === alert.id;

                return (
                  <motion.div
                    key={alert.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ delay: index * 0.1 }}
                    className="bg-gray-900/50 border border-gray-700 rounded-2xl p-6 hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        {/* Show Info */}
                        <div className="mb-4">
                          <Link
                            to={`/tv/${alert.showId}`}
                            className="text-xl font-bold text-white hover:text-yellow-500 transition-colors"
                          >
                            {alert.showName}
                          </Link>
                          <div className="text-gray-300 mt-1">
                            {t('alerts.season', 'Saison')} {alert.season}, {t('alerts.episode', 'Épisode')} {alert.episode}
                            {alert.episodeName && ` - ${alert.episodeName}`}
                          </div>
                        </div>

                        {/* Date Info */}
                        <div className="flex items-center gap-4 mb-4 text-sm">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-4 h-4 text-gray-400" />
                            <span className="text-gray-400">{t('alerts.releasesOn')}</span>
                            <span className={getStatusColor(dateInfo.status)}>
                              {dateInfo.text}
                            </span>
                          </div>
                          <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                            dateInfo.status === 'passed' ? 'bg-gray-600/50 text-gray-400' :
                            dateInfo.status === 'today' ? 'bg-green-600/50 text-green-400' :
                            dateInfo.status === 'soon' ? 'bg-yellow-600/50 text-yellow-400' :
                            'bg-blue-600/50 text-blue-400'
                          }`}>
                            {dateInfo.daysText}
                          </div>
                        </div>

                        {/* Notification Settings */}
                        <div className="flex items-center gap-2 text-sm">
                          <Clock className="w-4 h-4 text-gray-400" />
                          <span className="text-gray-400">{t('alerts.alertLabel')}</span>
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <select
                                value={selectedDays}
                                onChange={(e) => setSelectedDays(Number(e.target.value) as NotifyBeforeDays)}
                                className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-sm"
                              >
                                <option value={0}>{t('alerts.onSameDay')}</option>
                                <option value={1}>{t('alerts.nDaysBefore', { count: 1 })}</option>
                                <option value={2}>{t('alerts.nDaysBefore', { count: 2 })}</option>
                                <option value={3}>{t('alerts.nDaysBefore', { count: 3 })}</option>
                                <option value={4}>{t('alerts.nDaysBefore', { count: 4 })}</option>
                                <option value={5}>{t('alerts.nDaysBefore', { count: 5 })}</option>
                                <option value={6}>{t('alerts.nDaysBefore', { count: 6 })}</option>
                                <option value={7}>{t('alerts.nDaysBefore', { count: 7 })}</option>
                              </select>
                              <button
                                onClick={() => handleSaveEdit(alert.id)}
                                className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs transition-colors"
                              >
                                {t('alerts.saveAlert')}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white rounded text-xs transition-colors"
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          ) : (
                            <span className="text-yellow-500 font-medium">
                              {getNotificationText(alert.notifyBeforeDays)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      {!isEditing && (
                        <div className="flex items-center gap-2">
                          <motion.button
                            onClick={() => handleEditAlert(alert.id, alert.notifyBeforeDays)}
                            className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-yellow-500"
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            title={t('alerts.editAlert')}
                          >
                            <Edit3 className="w-4 h-4" />
                          </motion.button>
                          <motion.button
                            onClick={() => handleDeleteAlert(alert.id)}
                            className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-red-500"
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            title={t('alerts.deleteAlertTooltip')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </motion.button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
};

export default AlertsPage;
