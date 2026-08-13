import React from 'react';
import { useTranslation } from 'react-i18next';
import { HeartHandshake } from 'lucide-react';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';

type CostItem = {
  key: string;
  amount: string;
  monthly?: boolean;
  noteKey?: string;
};

type CostSection = {
  key: string;
  items: CostItem[];
};

const SECTIONS: CostSection[] = [
  {
    key: 'infrastructure',
    items: [
      { key: 'server', amount: '110 €', monthly: true },
      { key: 'proxies', amount: '35 €', monthly: true },
      { key: 'domains', amount: '≈ 5 €', noteKey: 'costs.items.domainsNote' },
    ],
  },
  {
    key: 'ai',
    items: [
      { key: 'ai', amount: '225 – 275 €', monthly: true, noteKey: 'costs.items.aiNote' },
    ],
  },
  {
    key: 'sources',
    items: [
      { key: 'debrid', amount: '≈ 20 €', monthly: true },
      { key: 'iptv', amount: '10 €', monthly: true },
    ],
  },
];

const CostsPage: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="w-full relative z-10 px-10">
        <div className="mt-32 pb-20 relative w-full max-w-[640px] mx-auto">
          <span className="sm:text-5xl text-4xl font-bold mb-6 text-white text-center block">
            {t('costs.title')}
          </span>

          <p className="text-gray-300 font-medium mt-10 opacity-75">
            {t('costs.intro')}
          </p>

          {SECTIONS.map((section) => (
            <div key={section.key} className="mt-10">
              <h2 className="text-xl font-semibold text-white mb-2">
                {t(`costs.sections.${section.key}`)}
              </h2>
              {section.items.map((item) => (
                <div
                  key={item.key}
                  className="flex items-baseline justify-between gap-4 border-b border-white/10 py-3"
                >
                  <div>
                    <span className="text-gray-200 font-medium">
                      {t(`costs.items.${item.key}`)}
                    </span>
                    {item.noteKey && (
                      <p className="text-sm text-gray-400">{t(item.noteKey)}</p>
                    )}
                  </div>
                  <span className="text-white font-semibold whitespace-nowrap">
                    {item.amount}
                    {item.monthly && t('costs.perMonth')}
                  </span>
                </div>
              ))}
            </div>
          ))}

          <div className="flex items-baseline justify-between gap-4 mt-10 rounded-lg bg-white/5 border border-white/10 px-4 py-4">
            <div>
              <span className="text-white font-bold">{t('costs.totalLabel')}</span>
              <p className="text-sm text-gray-400">{t('costs.totalNote')}</p>
            </div>
            <span className="text-white font-bold text-lg whitespace-nowrap">
              ≈ 400 – 450 €{t('costs.perMonth')}
            </span>
          </div>

          <p className="text-gray-300 font-medium mt-10 opacity-75">
            {t('costs.supportText')}
          </p>

          <Link className="mt-6 block w-fit" to="/vip/don">
            <button className="flex items-center justify-center font-medium whitespace-nowrap relative overflow-hidden transition-all h-10 text-sm px-4 rounded-md bg-white text-black hover:bg-white/80 focus-visible:outline-white cursor-pointer">
              <HeartHandshake className="size-4 mr-2" />
              {t('costs.supportCta')}
            </button>
          </Link>
        </div>
      </div>
    </div>
  );
};

export default CostsPage;
