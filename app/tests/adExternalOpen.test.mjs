import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

async function loadPopupRedirectBuilder() {
  const sourceUrl = new URL('../src/injection/popup-redirect.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
  return import(dataUrl);
}

/** Page Movix minimale : juste ce que le shim touche. */
async function createPage(pageUrl = 'https://movix.tax/film/42') {
  const { buildPopupRedirectScript } = await loadPopupRedirectBuilder();
  const posted = [];
  const nativeOpens = [];
  const documentListeners = new Map();
  const windowEvents = [];

  const location = { href: pageUrl, hostname: new URL(pageUrl).hostname };
  const context = {
    URL,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    location,
    document: {
      hidden: false,
      addEventListener(type, handler) {
        if (!documentListeners.has(type)) documentListeners.set(type, new Set());
        documentListeners.get(type).add(handler);
      },
      dispatchEvent(event) {
        for (const handler of documentListeners.get(event.type) || []) handler(event);
      },
    },
  };
  context.window = context;
  context.window.ReactNativeWebView = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      posted.push(message);
      // Le natif (WebViewBrowser.openExternal) ouvre l'URL hors app.
      if (message.type === 'OPEN_EXTERNAL') nativeOpens.push(message.url);
    },
  };
  context.window.dispatchEvent = event => {
    windowEvents.push(event.type);
  };
  context.window.open = () => {
    throw new Error('window.open natif ne doit pas être atteint pour un hôte tiers');
  };

  vm.runInNewContext(buildPopupRedirectScript(), context);
  return { context, posted, nativeOpens, windowEvents, documentListeners };
}

test('une pub tierce part au natif et le site reçoit un popup crédible', async () => {
  const page = await createPage();

  const popup = page.context.window.open('https://ad-network.example/watch?id=7', '_blank');

  assert.deepEqual(page.nativeOpens, ['https://ad-network.example/watch?id=7']);
  assert.ok(popup, 'la gate publicitaire teste la valeur de retour de window.open');
  assert.equal(popup.closed, false);
});

test('le popup différé route aussi la pub assignée après coup', async () => {
  const page = await createPage();

  // Motif fréquent des gates : window.open() vide, puis w.location.href = adUrl.
  const popup = page.context.window.open('', '_blank');
  assert.deepEqual(page.nativeOpens, []);

  popup.location.href = 'https://ad-network.example/late';
  assert.deepEqual(page.nativeOpens, ['https://ad-network.example/late']);
});

test('un hôte du site ou OAuth garde le comportement natif', async () => {
  const page = await createPage();
  const nativeCalls = [];
  page.context.window.open = (...args) => {
    nativeCalls.push(args[0]);
    return { native: true };
  };
  // Réinstalle le shim par-dessus le window.open de test.
  const { buildPopupRedirectScript } = await loadPopupRedirectBuilder();
  page.context.window.__MOVIX_POPUP_REDIRECT_READY = false;
  vm.runInNewContext(buildPopupRedirectScript(), page.context);

  page.context.window.open('https://movix.tax/compte', '_blank');
  page.context.window.open('https://discord.com/oauth2/authorize', '_blank');

  assert.deepEqual(page.nativeOpens, [], 'aucune externalisation pour ces hôtes');
  assert.deepEqual(nativeCalls, [
    'https://movix.tax/compte',
    'https://discord.com/oauth2/authorize',
  ]);
});

test('le retour depuis le navigateur système débloque la gate sans recharger', async () => {
  const page = await createPage();
  const popup = page.context.window.open('https://ad-network.example/watch', '_blank');
  assert.equal(popup.closed, false);

  // Signal poussé par le natif au retour au premier plan (AppState -> active).
  assert.equal(
    typeof page.context.window.__movixNotifyExternalReturn,
    'function',
    'WebViewBrowser appelle ce hook après une ouverture externe',
  );
  page.context.window.__movixNotifyExternalReturn();

  assert.equal(popup.closed, true, 'les gates débloquent à la fermeture du popup');
  assert.ok(page.windowEvents.includes('focus'));
  assert.ok(page.windowEvents.includes('pageshow'));
  // Aucune navigation déclenchée : c'est le rechargement qui ramenait la gate.
  assert.equal(page.context.location.href, 'https://movix.tax/film/42');
});

test('WebViewBrowser externalise les pubs sur les deux plateformes', async () => {
  const source = await read('src/components/WebViewBrowser.tsx');

  // iOS : une cible _blank ne passe jamais par onShouldStartLoadWithRequest,
  // WebKit annule la navigation et n'appelle que onOpenWindow.
  assert.match(source, /onOpenWindow=\{onOpenWindow\}/);
  assert.doesNotMatch(
    source,
    /onOpenWindow=\{\(\)\s*=>\s*\{\}\}/,
    'un onOpenWindow vide fait disparaître la pub sans que le site le sache',
  );
  assert.match(source, /const onOpenWindow = useCallback\([\s\S]*?openExternal\(target\)/);

  // Android : isTopFrame est absent de l'évènement sans le patch — le traiter
  // comme faux laissait TOUTE navigation hors site s'ouvrir dans la WebView.
  assert.match(source, /const topFrame = isTopFrame !== false;/);
  assert.match(source, /if \(!hostname \|\| !topFrame \|\| isAllowedHost\(hostname, allowedHosts\)\)/);

  // Retour dans l'app après la pub : on notifie la page, on ne recharge pas.
  assert.match(source, /AppState\.addEventListener\([\s\S]*?__movixNotifyExternalReturn/);
});

test('le patch Android expose la frame sur shouldStartLoad', async () => {
  const patch = await read('patches/react-native-webview+13.16.1.patch');

  assert.match(patch, /public boolean shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\)/);
  assert.match(patch, /mIsForMainFrame = request\.isForMainFrame\(\)/);
  assert.match(patch, /\+\s*event\.putBoolean\("isTopFrame", isForMainFrame\)/);
});
