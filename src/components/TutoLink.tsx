import { PrefetchLink as Link } from '@/routing/PrefetchLink';

interface TutoLinkProps {
  /** React Router route path (e.g. '/extension', '/app'). */
  to: string;
  /** Inherited when used through i18next <Trans> — the link text. */
  children?: React.ReactNode;
}

/**
 * Inline styled Link used inside tuto body paragraphs to point at another
 * Movix route. Rendered through i18next <Trans> numeric placeholders:
 *
 *   "bodyText": "Download on the <1>/app</1> page."
 *
 *   <Trans i18nKey="bodyText" components={{
 *     1: <TutoLink to="/app" />,
 *   }} />
 */
const TutoLink: React.FC<TutoLinkProps> = ({ to, children }) => (
  <Link
    to={to}
    className="font-medium text-indigo-400 hover:text-indigo-300 underline underline-offset-2 decoration-indigo-500/40 hover:decoration-indigo-400"
  >
    {children}
  </Link>
);

export default TutoLink;
