import React, { useEffect, useMemo, useState } from 'react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Clock3,
  ExternalLink,
  FolderClock,
  Loader2,
  RefreshCcw
} from 'lucide-react';

import AnimatedBorderCard from '../components/ui/animated-border-card';
import BlurText from '../components/ui/blur-text';
import { Button } from '../components/ui/button';
import ShinyText from '../components/ui/shiny-text';
import { SquareBackground } from '../components/ui/square-background';
import { getVipInvoice, listMyVipInvoices, type VipInvoice } from '../services/vipDonationsService';
import {
  formatVipDateTime,
  formatVipFiat,
  getVipPaymentLabel,
  getVipStatusMeta
} from '../utils/vipDonationsUi';
import { getStoredVipInvoiceHistory } from '../utils/vipInvoiceHistory';

const OPEN_STATUSES = new Set(['awaiting_payment', 'partial_payment', 'confirming', 'paid']);

const sortByCreatedAtDesc = (items: VipInvoice[]) => [...items].sort((left, right) => {
  const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
  const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
  return rightTime - leftTime;
});

const VipInvoicesPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [invoices, setInvoices] = useState<VipInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasAccountToken = useMemo(() => Boolean(localStorage.getItem('auth_token')), []);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let isMounted = true;

    const loadInvoices = async () => {
      try {
        if (refreshNonce === 0) {
          setIsLoading(true);
        } else {
          setIsRefreshing(true);
        }

        if (isMounted) {
          setError(null);
        }

        const localIds = getStoredVipInvoiceHistory();

        const localSettled = await Promise.allSettled(
          localIds.map((publicId) => getVipInvoice(publicId))
        );
        const localInvoices = localSettled
          .filter((result): result is PromiseFulfilledResult<VipInvoice> => result.status === 'fulfilled')
          .map((result) => result.value);

        let accountInvoices: VipInvoice[] = [];
        if (hasAccountToken) {
          try {
            accountInvoices = await listMyVipInvoices(50);
          } catch (loadError) {
            if (!localInvoices.length && isMounted) {
              setError(loadError instanceof Error ? loadError.message : t('vipDonations.history.loadError'));
            }
          }
        }

        const merged = new Map<string, VipInvoice>();
        for (const invoice of localInvoices) {
          merged.set(invoice.publicId, invoice);
        }
        for (const invoice of accountInvoices) {
          merged.set(invoice.publicId, invoice);
        }

        if (isMounted) {
          setInvoices(sortByCreatedAtDesc(Array.from(merged.values())));
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : t('vipDonations.history.loadError'));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    void loadInvoices();

    return () => {
      isMounted = false;
    };
  }, [hasAccountToken, refreshNonce, t]);

  const openInvoices = useMemo(
    () => invoices.filter((invoice) => OPEN_STATUSES.has(invoice.status)),
    [invoices]
  );
  const archivedInvoices = useMemo(
    () => invoices.filter((invoice) => !OPEN_STATUSES.has(invoice.status)),
    [invoices]
  );

  const renderInvoiceCard = (invoice: VipInvoice) => {
    const statusMeta = getVipStatusMeta(t, invoice.status);

    return (
      <AnimatedBorderCard
        key={invoice.publicId}
        highlightColor="234 179 8"
        backgroundColor="10 10 10"
        className="p-5 backdrop-blur-sm"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-2xl bg-white/[0.04] px-3 py-2 text-sm font-semibold text-white">
                {invoice.publicId}
              </code>
              <span className="inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-white/80">
                {statusMeta.label}
              </span>
            </div>

            <div className="grid gap-3 text-sm text-white/60 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                  {t('vipDonations.page.amountLabel')}
                </p>
                <p className="mt-1 font-semibold text-white">
                  {formatVipFiat(i18n.language, invoice.amountEur, 'EUR')}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                  {t('vipDonations.page.paymentLabel')}
                </p>
                <p className="mt-1 font-semibold text-white">
                  {getVipPaymentLabel(t, invoice.paymentMethod, invoice.coin)}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                  {t('vipDonations.history.createdAt')}
                </p>
                <p className="mt-1 font-semibold text-white">
                  {formatVipDateTime(i18n.language, invoice.createdAt)}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                  {t('vipDonations.page.recipientLabel')}
                </p>
                <p className="mt-1 font-semibold text-white">
                  {invoice.recipientMode === 'self'
                    ? t('vipDonations.page.recipientSelfShort')
                    : t('vipDonations.page.recipientGiftShort')}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:flex-row">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/58">
              {statusMeta.hint}
            </div>
            <Link to={invoice.invoicePath}>
              <Button className="h-12 w-full bg-yellow-500 text-black hover:bg-yellow-400 sm:w-auto">
                <ExternalLink className="mr-2 h-4 w-4" />
                {t('vipDonations.history.openInvoiceButton')}
              </Button>
            </Link>
          </div>
        </div>
      </AnimatedBorderCard>
    );
  };

  return (
    <SquareBackground
      squareSize={48}
      borderColor="rgba(234, 179, 8, 0.12)"
      className="min-h-screen bg-black text-white"
    >
      <div className="container mx-auto px-4 py-8 sm:px-6 sm:py-12 relative z-10">
        <Link to="/vip" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('vipDonations.invoice.backVip')}
        </Link>

        <div className="max-w-6xl mx-auto space-y-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center space-y-5"
          >
            <div className="inline-flex items-center justify-center p-3 bg-yellow-500/10 rounded-full ring-1 ring-yellow-500/50">
              <FolderClock className="w-8 h-8 text-yellow-500" />
            </div>
            <BlurText
              text={t('vipDonations.history.title')}
              delay={220}
              animateBy="words"
              direction="top"
              className="text-4xl md:text-6xl font-bold text-white justify-center"
            />
            <p className="mx-auto max-w-3xl text-base leading-relaxed text-white/60 md:text-lg">
              {t(hasAccountToken ? 'vipDonations.history.descriptionConnected' : 'vipDonations.history.descriptionGuest')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm font-semibold text-yellow-200">
                <Clock3 className="h-4 w-4 text-yellow-400" />
                {t('vipDonations.history.sourceLocal')}
              </span>
              {hasAccountToken && (
                <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100">
                  <RefreshCcw className="h-4 w-4 text-cyan-300" />
                  {t('vipDonations.history.sourceAccount')}
                </span>
              )}
            </div>
          </motion.div>

          <div className="flex justify-end">
            <Button
              variant="outline"
              className="h-11 border-white/15 bg-transparent text-white hover:bg-white/5"
              onClick={() => setRefreshNonce((value) => value + 1)}
              disabled={isLoading || isRefreshing}
            >
              {isRefreshing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('vipDonations.history.loading')}
                </>
              ) : (
                <>
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  {t('vipDonations.history.refreshButton')}
                </>
              )}
            </Button>
          </div>

          {isLoading ? (
            <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-10 text-center">
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-yellow-400" />
              <p className="mt-4 text-white/55">{t('vipDonations.history.loading')}</p>
            </AnimatedBorderCard>
          ) : error ? (
            <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="10 10 10" className="p-8 text-center">
              <p className="text-white">{error}</p>
            </AnimatedBorderCard>
          ) : invoices.length === 0 ? (
            <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-10 text-center">
              <ShinyText
                text={t('vipDonations.history.emptyTitle')}
                speed={2}
                color="#fbbf24"
                shineColor="#ffffff"
                className="text-2xl font-bold"
              />
              <p className="mt-3 text-white/55">{t('vipDonations.history.emptyDescription')}</p>
              <Link to="/vip/don" className="mt-6 inline-flex">
                <Button className="bg-yellow-500 text-black hover:bg-yellow-400">
                  {t('vipDonations.page.createButton')}
                </Button>
              </Link>
            </AnimatedBorderCard>
          ) : (
            <div className="space-y-8">
              <section className="space-y-4">
                <h2 className="text-xl font-semibold text-white">{t('vipDonations.history.openTitle')}</h2>
                {openInvoices.length > 0
                  ? openInvoices.map(renderInvoiceCard)
                  : (
                    <AnimatedBorderCard highlightColor="148 163 184" backgroundColor="10 10 10" className="p-6 text-white/50">
                      {t('vipDonations.history.noneOpen')}
                    </AnimatedBorderCard>
                  )}
              </section>

              <section className="space-y-4">
                <h2 className="text-xl font-semibold text-white">{t('vipDonations.history.archivedTitle')}</h2>
                {archivedInvoices.length > 0
                  ? archivedInvoices.map(renderInvoiceCard)
                  : (
                    <AnimatedBorderCard highlightColor="148 163 184" backgroundColor="10 10 10" className="p-6 text-white/50">
                      {t('vipDonations.history.noneArchived')}
                    </AnimatedBorderCard>
                  )}
              </section>
            </div>
          )}
        </div>
      </div>
    </SquareBackground>
  );
};

export default VipInvoicesPage;
