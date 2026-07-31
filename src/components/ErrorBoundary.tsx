import React from 'react';
import { isChunkLoadError, reloadForChunkFailure } from '../routing/lazyWithRetry';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  sending: boolean;
  sent: boolean;
  sendError: boolean;
  recoverable: boolean;
  reloadScheduled: boolean;
}

/**
 * Recoverable = not a code bug, fixable by a reload:
 *  - stale dynamic-import chunks after a deploy (isChunkLoadError)
 *  - React + browser auto-translate DOM race (removeChild/insertBefore)
 *  - React #306: a lazy element resolved to `undefined` (failed/stale chunk)
 *  - the raw TypeError React.lazy throws when a chunk resolved to `undefined`
 *    and it reads `.default` off it ("Cannot read properties of undefined
 *    (reading 'default')" / "e._result is undefined") — same stale-chunk cause,
 *    fires before #306. lazyWithRetry now prevents this upstream, but keep it as
 *    a net for any lazy element that resolves undefined by another path.
 * These get a friendly "updating" screen + guarded auto-reload instead of the
 * crash report UI, so they no longer flood the crash channel.
 */
const isRecoverableError = (error: Error | null | undefined): boolean => {
  if (!error) return false;
  if (isChunkLoadError(error)) return true;
  const msg = String(error.message || '');
  return /removeChild|insertBefore|not a child of this node|Minified React error #306|invariant=306|_result|reading 'default'|reading "default"/i.test(msg);
};

const DISCORD_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1514627721916055654/hRzr4oYG8-D44WR0UDpHfwtrE7D1uomP0NcVazRjB2DKOEfxuhK2g6DQD52qrYOuMYVJ';

function getDeviceInfo() {
  const ua = navigator.userAgent;

  let browser = 'Inconnu';
  if (ua.includes('Firefox/')) {
    browser = 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] ?? '');
  } else if (ua.includes('Edg/')) {
    browser = 'Edge ' + (ua.match(/Edg\/([\d.]+)/)?.[1] ?? '');
  } else if (ua.includes('OPR/') || ua.includes('Opera/')) {
    browser = 'Opera ' + (ua.match(/(?:OPR|Opera)\/([\d.]+)/)?.[1] ?? '');
  } else if (ua.includes('Chrome/')) {
    browser = 'Chrome ' + (ua.match(/Chrome\/([\d.]+)/)?.[1] ?? '');
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    browser = 'Safari ' + (ua.match(/Version\/([\d.]+)/)?.[1] ?? '');
  }

  let os = 'Inconnu';
  if (ua.includes('Windows NT 10')) os = 'Windows 10/11';
  else if (ua.includes('Windows NT')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS ' + (ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.') ?? '');
  else if (ua.includes('Android')) os = 'Android ' + (ua.match(/Android ([\d.]+)/)?.[1] ?? '');
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS ' + (ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, '.') ?? '');
  else if (ua.includes('Linux')) os = 'Linux';

  let device = 'Desktop';
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
    device = /iPad|Tablet/i.test(ua) ? 'Tablette' : 'Mobile';
  }

  return {
    browser,
    os,
    device,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
    url: window.location.href,
    timestamp: new Date().toISOString(),
    userAgent: ua,
    online: navigator.onLine,
    memory: (performance as any).memory
      ? `${Math.round((performance as any).memory.usedJSHeapSize / 1048576)}MB / ${Math.round((performance as any).memory.jsHeapSizeLimit / 1048576)}MB`
      : 'N/A',
  };
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, sending: false, sent: false, sendError: false, recoverable: false, reloadScheduled: true };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Decide recoverability synchronously so the soft screen renders on the
    // first frame — no flash of the crash UI before componentDidCatch runs.
    return { hasError: true, error, recoverable: isRecoverableError(error) };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    if (isRecoverableError(error)) {
      // Not a code bug — recover quietly with a guarded reload (the budget in
      // reloadForChunkFailure caps attempts so this can never loop).
      const reloadScheduled = reloadForChunkFailure();
      this.setState({ recoverable: true, reloadScheduled });
      return;
    }
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleSendReport = async () => {
    const { error, errorInfo } = this.state;
    this.setState({ sending: true, sendError: false });

    const info = getDeviceInfo();
    const stack = error?.stack ?? 'Aucune stack trace';
    const componentStack = errorInfo?.componentStack ?? 'N/A';

    const truncate = (str: string, max: number) => (str.length > max ? str.slice(0, max) + '...' : str);

    const embeds = [
      {
        title: ':rotating_light: Crash Report — Movix',
        color: 0xdc2626,
        fields: [
          { name: 'Erreur', value: '```\n' + truncate(error?.message ?? 'Erreur inconnue', 900) + '\n```', inline: false },
          { name: 'Stack Trace', value: '```\n' + truncate(stack, 900) + '\n```', inline: false },
          { name: 'Component Stack', value: '```\n' + truncate(componentStack, 900) + '\n```', inline: false },
          { name: 'Navigateur', value: info.browser, inline: true },
          { name: 'OS', value: info.os, inline: true },
          { name: 'Appareil', value: info.device, inline: true },
          { name: 'Ecran', value: info.screen, inline: true },
          { name: 'Viewport', value: info.viewport, inline: true },
          { name: 'Langue', value: info.language, inline: true },
          { name: 'En ligne', value: info.online ? 'Oui' : 'Non', inline: true },
          { name: 'Memoire JS', value: info.memory, inline: true },
          { name: 'URL', value: truncate(info.url, 200), inline: false },
        ],
        footer: { text: info.timestamp + ' • ' + truncate(info.userAgent, 150) },
      },
    ];

    try {
      const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Movix Crash Reporter',
          embeds,
        }),
      });
      this.setState({ sending: false, sent: res.ok, sendError: !res.ok });
    } catch {
      this.setState({ sending: false, sendError: true });
    }
  };

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    // Recoverable errors (stale chunk after deploy, translate DOM race, #306):
    // friendly "updating" screen + guarded auto-reload — no crash report.
    if (this.state.recoverable) {
      const { error, reloadScheduled } = this.state;
      const isChunk = isChunkLoadError(error);
      const title = isChunk ? 'Mise à jour de Movix' : 'Rechargement';
      const body = reloadScheduled
        ? isChunk
          ? 'Une nouvelle version est disponible. Rechargement en cours…'
          : 'Un souci d’affichage temporaire est survenu. Rechargement en cours…'
        : 'Le rechargement automatique a échoué. Réessaie manuellement.';
      return (
        <div style={{ minHeight: '100vh', backgroundColor: '#000', color: '#f3f4f6', fontFamily: 'ui-sans-serif, system-ui, sans-serif', padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 32, fontWeight: 900, color: '#dc2626', letterSpacing: '0.1em', marginBottom: 24 }}>MOVIX</div>
            {reloadScheduled && (
              <div style={{ width: 40, height: 40, margin: '0 auto 24px', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#dc2626', borderRadius: '50%', animation: 'movix-eb-spin 0.8s linear infinite' }} />
            )}
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff' }}>{title}</h1>
            <p style={{ margin: '12px 0 0', fontSize: 14, color: '#9ca3af', lineHeight: 1.5 }}>{body}</p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24 }}>
              <button onClick={this.handleReload} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer', backgroundColor: '#dc2626', color: '#fff' }}>Recharger</button>
              <button onClick={this.handleGoHome} style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #333', fontWeight: 600, fontSize: 14, cursor: 'pointer', backgroundColor: 'transparent', color: '#9ca3af' }}>Accueil</button>
            </div>
          </div>
          <style>{`@keyframes movix-eb-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      );
    }

    const { error, errorInfo, sending, sent, sendError } = this.state;
    const info = getDeviceInfo();

    return (
      <div style={{ minHeight: '100vh', backgroundColor: '#000', color: '#f3f4f6', fontFamily: 'ui-sans-serif, system-ui, sans-serif', padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 700, width: '100%' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#fff' }}>Movix a rencontré une erreur</h1>
              <p style={{ margin: '4px 0 0', fontSize: 14, color: '#9ca3af' }}>Une erreur inattendue s'est produite. Les détails sont affichés ci-dessous.</p>
            </div>
          </div>

          {/* Error message */}
          <div style={{ backgroundColor: '#1c1c1c', border: '1px solid #dc2626', borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#dc2626', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Erreur</p>
            <p style={{ margin: '8px 0 0', fontSize: 15, color: '#fca5a5', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
              {error?.message ?? 'Erreur inconnue'}
            </p>
          </div>

          {/* Stack trace */}
          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#9ca3af', padding: '8px 0' }}>Stack Trace</summary>
            <pre style={{ backgroundColor: '#111', borderRadius: 8, padding: 12, fontSize: 12, color: '#d4d4d8', overflow: 'auto', maxHeight: 240, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {error?.stack ?? 'Aucune stack trace disponible'}
            </pre>
          </details>

          {/* Component stack */}
          {errorInfo?.componentStack && (
            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#9ca3af', padding: '8px 0' }}>Component Stack</summary>
              <pre style={{ backgroundColor: '#111', borderRadius: 8, padding: 12, fontSize: 12, color: '#d4d4d8', overflow: 'auto', maxHeight: 200, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {errorInfo.componentStack}
              </pre>
            </details>
          )}

          {/* Device info */}
          <details style={{ marginBottom: 24 }} open>
            <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#9ca3af', padding: '8px 0' }}>Informations de l'appareil</summary>
            <div style={{ backgroundColor: '#111', borderRadius: 8, padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, fontSize: 13 }}>
              {[
                ['Navigateur', info.browser],
                ['Systeme', info.os],
                ['Appareil', info.device],
                ['Ecran', info.screen],
                ['Viewport', info.viewport],
                ['Langue', info.language],
                ['En ligne', info.online ? 'Oui' : 'Non'],
                ['Memoire', info.memory],
              ].map(([label, value]) => (
                <div key={label}>
                  <p style={{ margin: 0, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
                  <p style={{ margin: '2px 0 0', color: '#e5e7eb' }}>{value}</p>
                </div>
              ))}
              <div style={{ gridColumn: '1 / -1' }}>
                <p style={{ margin: 0, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>URL</p>
                <p style={{ margin: '2px 0 0', color: '#e5e7eb', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{info.url}</p>
              </div>
            </div>
          </details>

          {/* Actions */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <button
              onClick={this.handleSendReport}
              disabled={sending || sent}
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: 'none',
                fontWeight: 600,
                fontSize: 14,
                cursor: sending || sent ? 'default' : 'pointer',
                backgroundColor: sent ? '#16a34a' : sendError ? '#dc2626' : '#dc2626',
                color: '#fff',
                opacity: sending ? 0.6 : 1,
                transition: 'opacity 0.2s, background-color 0.2s',
              }}
            >
              {sending ? 'Envoi...' : sent ? 'Rapport envoyé !' : sendError ? 'Erreur — Réessayer' : 'Envoyer le rapport'}
            </button>

            <button
              onClick={this.handleReload}
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: '1px solid #333',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
                backgroundColor: 'transparent',
                color: '#e5e7eb',
              }}
            >
              Recharger la page
            </button>

            <button
              onClick={this.handleGoHome}
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: '1px solid #333',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
                backgroundColor: 'transparent',
                color: '#9ca3af',
              }}
            >
              Retour à l'accueil
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
