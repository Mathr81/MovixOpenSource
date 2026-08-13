import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const bridgeSource = await readFile(
  new URL('../src/services/bridge.ts', import.meta.url),
  'utf8',
);
const castLoadSingleFlightSource = await readFile(
  new URL('../src/services/castLoadSingleFlight.ts', import.meta.url),
  'utf8',
);
const castLoadSingleFlightOutput = ts.transpileModule(castLoadSingleFlightSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

function loadCastLoadSingleFlight() {
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(module,exports){${castLoadSingleFlightOutput}\n})`,
    {},
  )(module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

function loadBridge(pipOverrides = {}, runtimeOverrides = {}) {
  let pipListener = null;
  const calls = { awake: [], pipPlayback: [], enter: 0, exit: 0 };
  const output = ts.transpileModule(bridgeSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const require = id => {
    if (id === 'react-native') {
      return {
        NativeModules: {
          PlaybackAwake: {
            setLocalPlaybackAwake: active => calls.awake.push(active),
          },
        },
      };
    }
    if (id === './cast') {
      return {
        getCastCapabilities: async () => ({}),
        getCastStatus: async () => ({}),
        getRelayDisclosurePreference: async () => false,
        isCastSupported: async () => true,
        loadCastMedia: async () => {},
        openCastBatterySettings: async () => {},
        pauseCast: async () => {},
        playCast: async () => {},
        requestCastRelayNotificationPermission: () => {},
        seekCastTo: async () => {},
        setRelayDisclosureSuppressed: async () => {},
        stopCast: async () => {},
        subscribeCastStatus: () => () => {},
      };
    }
    if (id === './castLoadSingleFlight') return loadCastLoadSingleFlight();
    if (id === './mediaProxyHeaders') {
      return { applyMediaProxyHeaderRules: (_url, headers) => ({ ...headers }) };
    }
    if (id === './pictureInPicture') {
      return {
        enterPictureInPicture: async () => { calls.enter += 1; },
        exitPictureInPicture: async () => { calls.exit += 1; },
        isPictureInPictureSupported: async () => true,
        setPictureInPicturePlaybackActive: active => calls.pipPlayback.push(active),
        subscribePictureInPicture: listener => {
          pipListener = listener;
          return () => { pipListener = null; };
        },
        ...pipOverrides,
      };
    }
    throw new Error(`Unexpected bridge dependency: ${id}`);
  };
  vm.runInNewContext(
    `(function(require,module,exports){${output}\n})`,
    {
      URL,
      AbortController,
      Headers,
      Response,
      fetch,
      setTimeout,
      clearTimeout,
      ...runtimeOverrides,
    },
  )(require, module, module.exports);
  return {
    bridge: module.exports,
    calls,
    emitPip(event) {
      assert.ok(pipListener, 'PiP listener must be active');
      pipListener(event);
    },
  };
}

test('trusted bridge provenance does not depend on React Native URL properties', async () => {
  class IncompleteReactNativeURL {
    constructor() {}
    get protocol() { throw new Error('URL.protocol is not implemented'); }
    get origin() { throw new Error('URL.origin is not implemented'); }
  }
  const { bridge, calls } = loadBridge({}, { URL: IncompleteReactNativeURL });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };

  await registerPip(bridge, ref, 'f'.repeat(32));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'rn-url-enter', capability: 'f'.repeat(32),
  }), ref, trustedContext);

  assert.equal(calls.enter, 1);
  assert.equal(injected.length, 1);
});

const trustedContext = {
  sourceUrl: 'https://movix.example/watch/1',
  trustedOrigins: ['https://movix.example'],
  isTopFrame: true,
};
const untrustedContext = {
  sourceUrl: 'https://attacker.example/',
  trustedOrigins: ['https://movix.example'],
  isTopFrame: true,
};
const sameOriginSubframeContext = {
  sourceUrl: 'https://movix.example/embed/1',
  trustedOrigins: ['https://movix.example'],
  isTopFrame: false,
};

async function registerPip(bridge, ref, capability, context = trustedContext) {
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_REGISTER_CAPABILITY',
    capability,
  }), ref, context);
}

test('trusted current PiP capability can enter and gets its matching response', async () => {
  const { bridge, calls } = loadBridge();
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, 'a'.repeat(32));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'pip-1', capability: 'a'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 1);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /__MOVIX_PIP_SHIM__/);
  assert.match(injected[0], /pip-1/);
});

test('untrusted and wrong-capability commands are ignored', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await registerPip(bridge, ref, 'b'.repeat(32), untrustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'pip-2', capability: 'b'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 0);
});

test('same-origin subframes and missing frame identity cannot register PiP or set playback state', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  const capability = 'd'.repeat(32);
  await registerPip(bridge, ref, capability, sameOriginSubframeContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'subframe-enter', capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: true,
  }), ref, sameOriginSubframeContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: true,
  }), ref, {
    sourceUrl: 'https://movix.example/watch/1',
    trustedOrigins: ['https://movix.example'],
  });
  assert.equal(calls.enter, 0);
  assert.deepEqual(calls.awake, []);
  assert.deepEqual(calls.pipPlayback, []);
});

test('a registered PiP capability rejects a different capability', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await registerPip(bridge, ref, 'e'.repeat(32));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'wrong-capability', capability: 'f'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 0);
});

test('rejected native enter and exit return only the generic PiP rejection code', async () => {
  const secret = 'native failure https://token.example/?token=secret';
  const { bridge } = loadBridge({
    enterPictureInPicture: async () => { throw new Error(secret); },
    exitPictureInPicture: async () => { throw new Error(secret); },
  });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '1'.repeat(32);
  await registerPip(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'enter-rejected', capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_EXIT', id: 'exit-rejected', capability,
  }), ref, trustedContext);
  assert.equal(injected.length, 2);
  for (const script of injected) {
    assert.match(script, /PIP_REQUEST_REJECTED/);
    assert.doesNotMatch(script, /native failure|token\.example|secret/);
  }
});

test('malformed PiP capabilities and request IDs are ignored', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await registerPip(bridge, ref, 'A'.repeat(32));
  await registerPip(bridge, ref, 'short');
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: '', capability: 'a'.repeat(32),
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'x'.repeat(129), capability: 'a'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 0);
});

test('playback transition updates awake and PiP eligibility together', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: true,
  }), ref, trustedContext);
  assert.deepEqual(calls.awake, [true]);
  assert.deepEqual(calls.pipPlayback, [true]);
});

test('inactive playback transition clears awake and PiP eligibility together', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: false,
  }), ref, trustedContext);
  assert.deepEqual(calls.awake, [false]);
  assert.deepEqual(calls.pipPlayback, [false]);
});

test('current PiP capability receives native events and the React listener', async () => {
  const { bridge, emitPip } = loadBridge();
  const injected = [];
  const received = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, '2'.repeat(32));
  const stop = bridge.startPictureInPictureEventForwarding(ref, event => received.push(event));
  emitPip({ kind: 'state', active: true });
  stop();
  assert.equal(injected.length, 1);
  assert.match(injected[0], /NATIVE_EVENT/);
  assert.match(injected[0], /"active":true/);
  assert.deepEqual(received, [{ kind: 'state', active: true }]);
});

test('native events cannot cross navigation into a new capability', async () => {
  const { bridge, emitPip } = loadBridge();
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, 'c'.repeat(32));
  assert.equal(typeof bridge.startPictureInPictureEventForwarding, 'function');
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  bridge.clearBridgeCapabilities(ref);
  emitPip({ kind: 'state', active: true });
  stop();
  assert.deepEqual(injected, []);
});

test('an async PiP command response cannot cross navigation into a new capability', async () => {
  const enter = deferred();
  const { bridge } = loadBridge({ enterPictureInPicture: () => enter.promise });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, '3'.repeat(32));
  const pending = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'old-pip-request', capability: '3'.repeat(32),
  }), ref, trustedContext);
  bridge.clearBridgeCapabilities(ref);
  await registerPip(bridge, ref, '4'.repeat(32));
  enter.resolve();
  await pending;
  assert.deepEqual(injected, []);
});

test('PiP action events are parsed and forwarded to the trusted shim', async () => {
  const { bridge, emitPip } = loadBridge();
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, 'e'.repeat(32));
  const received = [];
  const stop = bridge.startPictureInPictureEventForwarding(ref, event => received.push(event));
  emitPip({ kind: 'action', action: 'seek-forward' });
  stop();
  assert.deepEqual(received, [{ kind: 'action', action: 'seek-forward' }]);
  assert.match(injected.at(-1), /seek-forward/);
});
