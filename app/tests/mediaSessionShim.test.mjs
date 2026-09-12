import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function loadMediaSessionBuilder() {
  const sourceUrl = new URL('../src/injection/media-session.ts', import.meta.url);
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

/**
 * Values built inside the VM realm carry that realm's prototypes, so a strict
 * deep comparison against a host literal fails on identity alone. Comparing
 * the plain projection keeps the assertions about structure.
 */
const plain = value => JSON.parse(JSON.stringify(value ?? null));

class EventTarget {
  #listeners = new Map();

  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.#listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class HarnessVideoElement {
  constructor({ poster = '', duration = 100, currentTime = 30 } = {}) {
    this.poster = poster;
    this.duration = duration;
    this.currentTime = currentTime;
    this.playbackRate = 1;
    this.paused = true;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.fastSeekCalls = [];
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  fastSeek(value) {
    this.fastSeekCalls.push(value);
    this.currentTime = value;
  }
}

class FakeMediaSession {
  constructor() {
    this.metadata = null;
    this.playbackState = 'none';
    this.handlers = new Map();
    this.positionStates = [];
  }

  setActionHandler(action, handler) {
    this.handlers.set(action, handler);
  }

  setPositionState(state) {
    this.positionStates.push(state ?? null);
  }

  get lastPositionState() {
    return this.positionStates.at(-1);
  }
}

/**
 * `meta` maps a querySelector selector to the element it should resolve to, so
 * a test states exactly which document metadata exists.
 */
async function createHarness({
  mediaSession = new FakeMediaSession(),
  title = 'Dune — Movix',
  meta = {},
  withMediaSession = true,
} = {}) {
  const { buildMediaSession } = await loadMediaSessionBuilder();
  const window = {};
  const document = new EventTarget();
  document.title = title;
  document.querySelector = selector => meta[selector] ?? null;

  const context = {
    window,
    document,
    navigator: withMediaSession ? { mediaSession } : {},
    location: { href: 'https://movix.tax/watch/1', origin: 'https://movix.tax' },
    HTMLVideoElement: HarnessVideoElement,
    MediaMetadata: class MediaMetadata {
      constructor(init) {
        Object.assign(this, init);
      }
    },
    URL,
    Math,
    Infinity,
    isFinite,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(buildMediaSession(), context);

  const dispatch = (type, target) => {
    const event = { type, target };
    document.dispatchEvent(event);
    return event;
  };

  return { window, document, mediaSession, dispatch, context, buildMediaSession };
}

test('media session stays out of the way when the page has no media session', async () => {
  const { window } = await createHarness({ withMediaSession: false });

  assert.equal(window.__MOVIX_MEDIA_SESSION_INSTALLED__, undefined);
});

test('media session installs once and ignores a second injection', async () => {
  const { window, mediaSession, context, buildMediaSession } = await createHarness();

  assert.equal(window.__MOVIX_MEDIA_SESSION_INSTALLED__, true);
  const handlerCount = mediaSession.handlers.size;
  assert.ok(handlerCount > 0);

  mediaSession.handlers.clear();
  vm.runInContext(buildMediaSession(), context);

  assert.equal(mediaSession.handlers.size, 0);
});

test('playing a video publishes the title, the poster artwork and the position', async () => {
  const { dispatch, mediaSession } = await createHarness();
  const video = new HarnessVideoElement({
    poster: 'https://image.tmdb.org/poster.jpg',
    duration: 7200,
    currentTime: 42,
  });

  dispatch('play', video);

  assert.equal(mediaSession.metadata.title, 'Dune');
  assert.equal(mediaSession.metadata.artist, 'Movix');
  assert.deepEqual(plain(mediaSession.metadata.artwork), [
    { src: 'https://image.tmdb.org/poster.jpg', sizes: '512x512' },
  ]);
  assert.equal(mediaSession.playbackState, 'playing');
  assert.deepEqual(plain(mediaSession.lastPositionState), {
    duration: 7200,
    position: 42,
    playbackRate: 1,
  });
});

test('artwork falls back to og:image and rejects non-http sources', async () => {
  const blobHarness = await createHarness({
    meta: { 'meta[property="og:image"]': { content: 'https://movix.tax/cover.png' } },
  });
  blobHarness.dispatch('play', new HarnessVideoElement({ poster: 'blob:https://movix.tax/abc' }));
  assert.deepEqual(plain(blobHarness.mediaSession.metadata.artwork), [
    { src: 'https://movix.tax/cover.png', sizes: '512x512' },
  ]);

  const hostileHarness = await createHarness({
    meta: { 'meta[property="og:image"]': { content: 'javascript:alert(1)' } },
  });
  hostileHarness.dispatch('play', new HarnessVideoElement({ poster: '' }));
  assert.deepEqual(plain(hostileHarness.mediaSession.metadata.artwork), []);
});

test('the title prefers og:title and never exposes an empty label', async () => {
  const tagged = await createHarness({
    title: 'ignored',
    meta: { 'meta[property="og:title"]': { content: 'Blade Runner 2049 | Movix' } },
  });
  tagged.dispatch('play', new HarnessVideoElement());
  assert.equal(tagged.mediaSession.metadata.title, 'Blade Runner 2049');

  const bare = await createHarness({ title: ' - Movix' });
  bare.dispatch('play', new HarnessVideoElement());
  assert.equal(bare.mediaSession.metadata.title, 'Movix');
});

test('an unknown duration clears the position state instead of publishing a bogus one', async () => {
  const { dispatch, mediaSession } = await createHarness();

  dispatch('play', new HarnessVideoElement({ duration: NaN }));

  assert.equal(mediaSession.lastPositionState, null);
});

test('the position state is clamped inside the media duration', async () => {
  const { dispatch, mediaSession } = await createHarness();
  const video = new HarnessVideoElement({ duration: 100, currentTime: 250 });

  dispatch('play', video);

  assert.deepEqual(plain(mediaSession.lastPositionState), {
    duration: 100,
    position: 100,
    playbackRate: 1,
  });
});

test('system commands drive the active video', async () => {
  const { dispatch, mediaSession } = await createHarness();
  const video = new HarnessVideoElement({ duration: 100, currentTime: 50 });
  dispatch('play', video);

  mediaSession.handlers.get('pause')();
  assert.equal(video.pauseCalls, 1);

  mediaSession.handlers.get('play')();
  assert.equal(video.playCalls, 1);

  mediaSession.handlers.get('seekbackward')({ seekOffset: 15 });
  assert.equal(video.currentTime, 35);

  mediaSession.handlers.get('seekforward')(undefined);
  assert.equal(video.currentTime, 45);

  mediaSession.handlers.get('seekto')({ seekTime: 90 });
  assert.equal(video.currentTime, 90);

  mediaSession.handlers.get('seekto')({ seekTime: 10, fastSeek: true });
  assert.deepEqual(video.fastSeekCalls, [10]);
});

test('seeking never leaves the media bounds', async () => {
  const { dispatch, mediaSession } = await createHarness();
  const video = new HarnessVideoElement({ duration: 100, currentTime: 5 });
  dispatch('play', video);

  mediaSession.handlers.get('seekbackward')({ seekOffset: 30 });
  assert.equal(video.currentTime, 0);

  mediaSession.handlers.get('seekforward')({ seekOffset: 500 });
  assert.equal(video.currentTime, 100);

  mediaSession.handlers.get('seekto')({ seekTime: -20 });
  assert.equal(video.currentTime, 0);

  mediaSession.handlers.get('seekto')({ seekTime: Number.POSITIVE_INFINITY });
  assert.equal(video.currentTime, 0);
});

test('pausing and ending move the playback state without losing the session', async () => {
  const { dispatch, mediaSession } = await createHarness();
  const video = new HarnessVideoElement();
  dispatch('play', video);

  dispatch('pause', video);
  assert.equal(mediaSession.playbackState, 'paused');

  dispatch('ended', video);
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(mediaSession.lastPositionState, null);
});

test('an SPA episode change hands the session to the newly playing video', async () => {
  const { dispatch, mediaSession } = await createHarness();
  const first = new HarnessVideoElement({ poster: 'https://image.tmdb.org/one.jpg' });
  const second = new HarnessVideoElement({ poster: 'https://image.tmdb.org/two.jpg' });

  dispatch('play', first);
  dispatch('play', second);

  assert.deepEqual(plain(mediaSession.metadata.artwork), [
    { src: 'https://image.tmdb.org/two.jpg', sizes: '512x512' },
  ]);

  // The replaced element must no longer be able to move the system state.
  dispatch('pause', first);
  assert.equal(mediaSession.playbackState, 'playing');

  mediaSession.handlers.get('pause')();
  assert.equal(second.pauseCalls, 1);
  assert.equal(first.pauseCalls, 0);
});

test('the shim publishes nothing over the React Native bridge', async () => {
  const posted = [];
  const { window, dispatch, mediaSession } = await createHarness();
  window.ReactNativeWebView = { postMessage: raw => posted.push(raw) };
  const video = new HarnessVideoElement();

  dispatch('play', video);
  dispatch('pause', video);
  mediaSession.handlers.get('seekforward')({ seekOffset: 5 });

  assert.deepEqual(posted, []);
});

test('the injected bundle carries the media session shim', async () => {
  const source = await readFile(
    new URL('../src/injection/inject.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /import \{ buildMediaSession \} from '\.\/media-session';/);
  assert.match(source, /const mediaSession = buildMediaSession\(\);/);
  assert.match(source, /\$\{mediaSession\}/);
});
