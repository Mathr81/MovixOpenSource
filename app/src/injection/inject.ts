import { buildBridgeRuntime } from './bridge-runtime';
import { buildCastShim } from './cast-shim';
import { USERSCRIPT_SOURCE } from './userscript-source';

export interface InjectOptions {
  /**
   * Quand false, GM_xmlhttpRequest court-circuite le bridge natif et exécute
   * les requêtes directement dans le WebView (cookies de la page, soumis au
   * CORS). Utile quand le proxy natif casse certaines sources.
   */
  proxyEnabled?: boolean;
}

export function buildInjectedJavaScript(options: InjectOptions = {}): string {
  const { proxyEnabled = true } = options;
  const bridge = buildBridgeRuntime();
  const castShim = buildCastShim();

  // Flag lu par le bridge runtime (avant sa définition de GM_xmlhttpRequest).
  const proxyFlag = `window.__MOVIX_PROXY_ENABLED = ${proxyEnabled ? 'true' : 'false'};`;

  // Cast shim FIRST — must be on window before any page JS runs.
  return `
${proxyFlag}

${castShim}

${bridge}

// --- Userscript Movix ---
${USERSCRIPT_SOURCE}

true;
`;
}
