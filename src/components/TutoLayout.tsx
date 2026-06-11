import { ReactNode, ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { SquareBackground } from './ui/square-background';
import TutoFeedback from './TutoFeedback';

// Section data model — each tuto page passes an array of these.
export type TutoSection =
  | {
      kind: 'text';
      titleKey?: string;
      bodyKey: string;
      components?: Record<string, ReactElement>;
      /** Optional Lucide/SVG icon rendered inline before the title text */
      titleIcon?: ReactNode;
    }
  | { kind: 'visual'; render: () => ReactNode; captionKey?: string }
  | {
      kind: 'steps';
      titleKey: string;
      stepKeys: string[];
      /** Optional Trans components shared across all step bodies (inline icons, links, etc.) */
      components?: Record<string, ReactElement>;
    }
  | {
      kind: 'table';
      titleKey: string;
      introKey?: string;
      headerKeys: [string, string];
      rowKeys: Array<[string, string]>;
      noteKey?: string;
    }
  | {
      kind: 'causes';
      introKey?: string;
      causes: Array<{
        icon: ReactNode;
        titleKey: string;
        bodyKey: string;
        /** Optional i18next Trans components mapping for inline tooltips. */
        bodyComponents?: Record<string, ReactElement>;
        ctas?: Array<{ labelKey: string; href: string; external?: boolean }>;
      }>;
    };

interface TutoLayoutProps {
  icon: ReactNode;
  title: string;
  heroSub: string;
  sections: TutoSection[];
  backHref?: string;
  backLabelKey?: string;
}

const TutoLayout: React.FC<TutoLayoutProps> = ({
  icon,
  title,
  heroSub,
  sections,
  backHref = '/help',
  backLabelKey = 'help.common.back',
}) => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const slug = pathname.replace(/^\/help\/?/, '').replace(/\/$/, '');

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, y: 0 },
  };

  const renderSection = (s: TutoSection) => {
    switch (s.kind) {
      case 'text':
        return (
          <>
            {s.titleKey && (
              <h2 className="text-xl font-bold text-white mb-3 flex items-center gap-2">
                {s.titleIcon && (
                  <span className="shrink-0" aria-hidden="true">
                    {s.titleIcon}
                  </span>
                )}
                <span>{t(s.titleKey)}</span>
              </h2>
            )}
            <p className="text-zinc-300 leading-relaxed">
              {s.components ? (
                <Trans i18nKey={s.bodyKey} components={s.components} />
              ) : (
                t(s.bodyKey)
              )}
            </p>
          </>
        );
      case 'visual':
        return (
          <div>
            {s.render()}
            {s.captionKey && (
              <p className="mt-3 text-sm text-zinc-400 text-center italic">
                {t(s.captionKey)}
              </p>
            )}
          </div>
        );
      case 'steps':
        return (
          <>
            <h2 className="text-xl font-bold text-white mb-4">{t(s.titleKey)}</h2>
            <ol className="space-y-3">
              {s.stepKeys.map((key, idx) => (
                <li key={idx} className="flex gap-3">
                  <span className="shrink-0 w-7 h-7 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 text-sm font-semibold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <span className="flex-1 text-zinc-300 leading-relaxed pt-0.5">
                    {s.components ? (
                      <Trans i18nKey={key} components={s.components} />
                    ) : (
                      t(key)
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </>
        );
      case 'table':
        return (
          <>
            <h2 className="text-xl font-bold text-white mb-3">{t(s.titleKey)}</h2>
            {s.introKey && (
              <p className="text-zinc-300 leading-relaxed mb-4">{t(s.introKey)}</p>
            )}
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-white/5">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold text-zinc-200">
                      {t(s.headerKeys[0])}
                    </th>
                    <th className="px-4 py-2 text-left font-semibold text-zinc-200">
                      {t(s.headerKeys[1])}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.rowKeys.map(([labelKey, valueKey], idx) => (
                    <tr
                      key={idx}
                      className="border-t border-white/10 hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-2 text-zinc-200">{t(labelKey)}</td>
                      <td className="px-4 py-2 text-zinc-300">{t(valueKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.noteKey && (
              <p className="mt-3 text-xs text-zinc-400 italic">{t(s.noteKey)}</p>
            )}
          </>
        );
      case 'causes':
        return (
          <>
            {s.introKey && (
              <p className="text-zinc-300 leading-relaxed mb-5">{t(s.introKey)}</p>
            )}
            <ol className="space-y-4">
              {s.causes.map((c, idx) => (
                <li
                  key={idx}
                  className="rounded-lg border border-white/10 bg-white/5 p-4"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className="shrink-0 w-8 h-8 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 text-sm font-semibold flex items-center justify-center">
                      {idx + 1}
                    </span>
                    <span className="shrink-0 text-red-400 flex items-center justify-center">
                      {c.icon}
                    </span>
                    <h3 className="font-semibold text-white flex-1 leading-tight">
                      {t(c.titleKey)}
                    </h3>
                  </div>
                  <p className="text-sm text-zinc-300 leading-relaxed mb-3 pl-11">
                    {c.bodyComponents ? (
                      <Trans i18nKey={c.bodyKey} components={c.bodyComponents} />
                    ) : (
                      t(c.bodyKey)
                    )}
                  </p>
                  {c.ctas && c.ctas.length > 0 && (
                    <div className="pl-11 flex flex-wrap gap-x-5 gap-y-2">
                      {c.ctas.map((cta) =>
                        cta.external ? (
                          <a
                            key={cta.href}
                            href={cta.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-red-400 hover:text-red-300 underline-offset-2 hover:underline"
                          >
                            {t(cta.labelKey)}
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <Link
                            key={cta.href}
                            to={cta.href}
                            className="inline-flex items-center gap-1 text-sm text-red-400 hover:text-red-300 underline-offset-2 hover:underline"
                          >
                            {t(cta.labelKey)}
                          </Link>
                        )
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        );
    }
  };

  return (
    <SquareBackground className="min-h-screen">
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="max-w-3xl mx-auto px-4 sm:px-6 py-10"
      >
        <motion.div variants={itemVariants} className="mb-6">
          <Link
            to={backHref}
            className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            {t(backLabelKey)}
          </Link>
        </motion.div>

        <motion.header variants={itemVariants} className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            {icon}
            <h1 className="text-3xl sm:text-4xl font-bold text-white">{title}</h1>
          </div>
          <p className="text-lg text-zinc-300">{heroSub}</p>
        </motion.header>

        {sections.map((s, i) => (
          <motion.section variants={itemVariants} key={i} className="mb-8">
            {renderSection(s)}
          </motion.section>
        ))}

        {slug && (
          <motion.div variants={itemVariants}>
            <TutoFeedback slug={slug} />
          </motion.div>
        )}

        <motion.div
          variants={itemVariants}
          className="pt-4 mt-8 border-t border-white/10"
        >
          <Link
            to={backHref}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 hover:bg-red-400 text-white font-semibold text-sm transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t(backLabelKey)}
          </Link>
        </motion.div>
      </motion.div>
    </SquareBackground>
  );
};

export default TutoLayout;
