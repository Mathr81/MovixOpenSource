import { buildBridgeRuntime } from './bridge-runtime';
import { buildCastShim } from './cast-shim';
import { USERSCRIPT_SOURCE } from './userscript-source';

export interface InjectOptions {
  /**
   * Quand false, le userscript Movix n'est PAS injecté : le site ne détecte
   * alors plus l'extension (drapeaux __MOVIX_EXTENSION_INSTALLED, etc.) et
   * n'essaie pas de router ses requêtes via le proxy natif. Il retombe sur
   * son propre chemin réseau — utile pour les sources que le proxy casse.
   *
   * Le bridge runtime et le cast shim restent injectés (capture console de
   * debug + Chromecast).
   */
  proxyEnabled?: boolean;
}

export function buildInjectedJavaScript(options: InjectOptions = {}): string {
  const { proxyEnabled = true } = options;
  const bridge = buildBridgeRuntime();
  const castShim = buildCastShim();

  const userscript = proxyEnabled
    ? `// --- Userscript Movix ---\n${USERSCRIPT_SOURCE}`
    : '// --- Userscript Movix non injecté (proxy intégré désactivé) ---';

  // Cast shim FIRST — must be on window before any page JS runs.
  return `
${castShim}

${bridge}

${userscript}

true;
`;
}
