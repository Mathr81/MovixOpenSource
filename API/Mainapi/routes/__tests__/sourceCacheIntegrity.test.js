const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const ROUTES_DIR = path.join(__dirname, '..');

function installModuleStubs(stubs) {
  const snapshots = [];

  for (const [request, exports] of Object.entries(stubs)) {
    const resolved = require.resolve(request);
    snapshots.push([resolved, require.cache[resolved]]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }

  return () => {
    for (const [resolved, previous] of snapshots.reverse()) {
      if (previous) require.cache[resolved] = previous;
      else delete require.cache[resolved];
    }
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSerializedLock() {
  let tail = Promise.resolve();

  return async () => {
    const previous = tail;
    let releaseCurrent;
    tail = new Promise((resolve) => { releaseCurrent = resolve; });
    await previous;
    return { release: async () => releaseCurrent() };
  };
}

test('TMDB/Coflix keeps playable cached links when a refresh finds no result', async () => {
  const routePath = path.join(ROUTES_DIR, 'tmdb.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const cloneLinksPath = path.join(__dirname, '..', '..', 'utils', 'cloneLinks.js');
  const redisLockPath = path.join(__dirname, '..', '..', 'utils', 'redisLock.js');
  const writes = [];
  const cached = {
    tmdb_details: { id: 42, title: 'Film test' },
    player_links: [{ decoded_url: 'https://cached.example/embed' }],
    _coflixRefreshedAt: 0,
  };

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { COFLIX: 'coflix-test-cache' },
      generateCacheKey: () => 'tmdb-movie-42',
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => ({
        id: 42,
        title: 'Film test',
        original_title: 'Film test',
        release_date: '2022-01-01',
      }),
      searchTmdb: async () => null,
    },
    [cloneLinksPath]: {
      applyCloneUrlsToPlayerLinks: async ({ playerLinks }) => playerLinks,
      syncCloneLinksForPlayerLinks: async ({ playerLinks }) => playerLinks,
    },
    [redisLockPath]: { acquireRedisLock: createSerializedLock() },
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    router.configure({
      TMDB_API_KEY: 'test-key',
      TMDB_API_URL: 'https://tmdb.test',
      getFromCacheNoExpiration: async () => cached,
      saveToCache: async (_dir, _key, value) => { writes.push(value); },
      searchCoflixByTitle: async () => [],
      getMovieDataFromCoflix: async () => ({ player_links: [] }),
      getTvDataFromCoflix: async () => ({ seasons: [], current_episode: null }),
      filterEmmmmbedReaders: (value) => value,
    });

    const app = express();
    app.use('/api', router);
    ({ server, url } = await listen(app));

    const response = await fetch(`${url}/api/tmdb/movie/42`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).player_links, cached.player_links);

    await delay(75);
    assert.equal(
      writes.some((value) => value && value.message === 'Contenu non disponible'),
      false,
      'a negative refresh must not replace playable cached links',
    );
  } finally {
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
  }
});

test('TMDB/Coflix cannot overwrite a concurrently refreshed playable cache with an older empty result', async () => {
  const routePath = path.join(ROUTES_DIR, 'tmdb.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const cloneLinksPath = path.join(__dirname, '..', '..', 'utils', 'cloneLinks.js');
  const redisLockPath = path.join(__dirname, '..', '..', 'utils', 'redisLock.js');
  const playable = {
    tmdb_details: { id: 42, title: 'Film test' },
    player_links: [{ decoded_url: 'https://fresh.example/embed' }],
    _coflixRefreshedAt: Date.now(),
  };
  let cache = null;
  let searchCalls = 0;
  let markFirstSearchStarted;
  let releaseFirstSearch;
  const firstSearchStarted = new Promise((resolve) => { markFirstSearchStarted = resolve; });
  const firstSearchGate = new Promise((resolve) => { releaseFirstSearch = resolve; });

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { COFLIX: 'coflix-test-cache' },
      generateCacheKey: () => 'tmdb-movie-42',
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => ({
        id: 42,
        title: 'Film test',
        original_title: 'Film test',
        release_date: '2022-01-01',
      }),
      searchTmdb: async () => null,
    },
    [cloneLinksPath]: {
      applyCloneUrlsToPlayerLinks: async ({ playerLinks }) => playerLinks,
      syncCloneLinksForPlayerLinks: async ({ playerLinks }) => playerLinks,
    },
    [redisLockPath]: { acquireRedisLock: createSerializedLock() },
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    router.configure({
      TMDB_API_KEY: 'test-key',
      TMDB_API_URL: 'https://tmdb.test',
      getFromCacheNoExpiration: async () => cache,
      saveToCache: async (_dir, _key, value) => { cache = value; },
      searchCoflixByTitle: async () => {
        searchCalls += 1;
        if (searchCalls === 1) {
          markFirstSearchStarted();
          await firstSearchGate;
          return [];
        }
        return [{ url: 'https://coflix.test/film-test', similarity: 1 }];
      },
      getMovieDataFromCoflix: async () => ({ player_links: playable.player_links }),
      getTvDataFromCoflix: async () => ({ seasons: [], current_episode: null }),
      filterEmmmmbedReaders: (value) => value,
    });

    const app = express();
    app.use('/api', router);
    ({ server, url } = await listen(app));

    const olderEmptyRequest = fetch(`${url}/api/tmdb/movie/42`);
    await firstSearchStarted;

    const freshPlayableResponse = await fetch(`${url}/api/tmdb/movie/42`);
    assert.equal(freshPlayableResponse.status, 200);
    assert.deepEqual((await freshPlayableResponse.json()).player_links, playable.player_links);
    assert.deepEqual(cache.player_links, playable.player_links);

    releaseFirstSearch();
    const olderEmptyResponse = await olderEmptyRequest;
    assert.equal(olderEmptyResponse.status, 200);
    await olderEmptyResponse.json();

    assert.deepEqual(
      cache.player_links,
      playable.player_links,
      'the late empty refresh must preserve the newer playable cache',
    );
  } finally {
    releaseFirstSearch();
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
  }
});

test('TMDB/Coflix clone sync cannot replace a newer playable refresh with its stale snapshot', async () => {
  const routePath = path.join(ROUTES_DIR, 'tmdb.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const cloneLinksPath = path.join(__dirname, '..', '..', 'utils', 'cloneLinks.js');
  const redisLockPath = path.join(__dirname, '..', '..', 'utils', 'redisLock.js');
  const staleTimestamp = Date.now();
  const staleCache = {
    tmdb_details: { id: 42, title: 'Film test' },
    player_links: [{ decoded_url: 'https://stale.example/embed' }],
    _coflixRefreshedAt: staleTimestamp,
  };
  const newerCache = {
    tmdb_details: { id: 42, title: 'Film test' },
    player_links: [{ decoded_url: 'https://newer.example/embed' }],
    _coflixRefreshedAt: staleTimestamp + 1000,
  };
  let cache = staleCache;
  let markCloneSyncStarted;
  let releaseCloneSync;
  const cloneSyncStarted = new Promise((resolve) => { markCloneSyncStarted = resolve; });
  const cloneSyncGate = new Promise((resolve) => { releaseCloneSync = resolve; });

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { COFLIX: 'coflix-test-cache' },
      generateCacheKey: () => 'tmdb-movie-42',
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => staleCache.tmdb_details,
      searchTmdb: async () => null,
    },
    [cloneLinksPath]: {
      applyCloneUrlsToPlayerLinks: async ({ playerLinks }) => playerLinks,
      syncCloneLinksForPlayerLinks: async ({ playerLinks }) => {
        markCloneSyncStarted();
        await cloneSyncGate;
        return playerLinks;
      },
    },
    [redisLockPath]: { acquireRedisLock: createSerializedLock() },
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    router.configure({
      TMDB_API_KEY: 'test-key',
      TMDB_API_URL: 'https://tmdb.test',
      getFromCacheNoExpiration: async () => cache,
      saveToCache: async (_dir, _key, value) => { cache = value; },
      searchCoflixByTitle: async () => { throw new Error('recent cache must not refresh Coflix'); },
      getMovieDataFromCoflix: async () => ({ player_links: [] }),
      getTvDataFromCoflix: async () => ({ seasons: [], current_episode: null }),
      filterEmmmmbedReaders: (value) => value,
    });

    const app = express();
    app.use('/api', router);
    ({ server, url } = await listen(app));

    const response = await fetch(`${url}/api/tmdb/movie/42`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).player_links, staleCache.player_links);
    await cloneSyncStarted;

    cache = newerCache;
    releaseCloneSync();
    await delay(75);

    assert.deepEqual(
      cache,
      newerCache,
      'the delayed clone sync must not replace a newer playable payload',
    );
  } finally {
    releaseCloneSync();
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
  }
});

test('TMDB/Coflix skips cache writes when the Redis lock is unavailable', async () => {
  const routePath = path.join(ROUTES_DIR, 'tmdb.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const cloneLinksPath = path.join(__dirname, '..', '..', 'utils', 'cloneLinks.js');
  const redisLockPath = path.join(__dirname, '..', '..', 'utils', 'redisLock.js');
  const cached = {
    tmdb_details: { id: 42, title: 'Film test' },
    player_links: [{ decoded_url: 'https://cached.example/embed' }],
    _coflixRefreshedAt: Date.now(),
  };
  let writes = 0;

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { COFLIX: 'coflix-test-cache' },
      generateCacheKey: () => 'tmdb-movie-42',
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => cached.tmdb_details,
      searchTmdb: async () => null,
    },
    [cloneLinksPath]: {
      applyCloneUrlsToPlayerLinks: async ({ playerLinks }) => playerLinks,
      syncCloneLinksForPlayerLinks: async ({ playerLinks }) => playerLinks,
    },
    [redisLockPath]: { acquireRedisLock: async () => null },
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    router.configure({
      TMDB_API_KEY: 'test-key',
      TMDB_API_URL: 'https://tmdb.test',
      getFromCacheNoExpiration: async () => cached,
      saveToCache: async () => { writes += 1; },
      searchCoflixByTitle: async () => { throw new Error('recent cache must not refresh Coflix'); },
      getMovieDataFromCoflix: async () => ({ player_links: [] }),
      getTvDataFromCoflix: async () => ({ seasons: [], current_episode: null }),
      filterEmmmmbedReaders: (value) => value,
    });

    const app = express();
    app.use('/api', router);
    ({ server, url } = await listen(app));

    const response = await fetch(`${url}/api/tmdb/movie/42`);
    assert.equal(response.status, 200);
    await response.json();
    await delay(75);

    assert.equal(writes, 0, 'cache writes must fail closed without the distributed lock');
  } finally {
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
  }
});

test('Cpasmal keeps playable cached links when a background refresh is empty', async () => {
  const routePath = path.join(ROUTES_DIR, 'cpasmal.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const redisPath = path.join(__dirname, '..', '..', 'config', 'redis.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const redisLockPath = path.join(__dirname, '..', '..', 'utils', 'redisLock.js');
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'movix-cpasmal-cache-'));
  const cacheKey = 'movie_42';
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
  const cached = {
    title: 'Film test',
    links: { vf: [{ server: 'voe', url: 'https://cached.example/embed' }], vostfr: [] },
  };
  const memoryWrites = [];

  await fs.writeFile(cacheFile, JSON.stringify(cached), 'utf8');
  const oldTime = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(cacheFile, oldTime, oldTime);

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { CPASMAL: cacheDir },
      generateCacheKey: (value) => value,
    },
    [redisPath]: {
      memoryCache: {
        set: async (key, value) => { memoryWrites.push([key, value]); },
      },
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => ({
        title: 'Film test',
        release_date: '2022-01-01',
      }),
    },
    [redisLockPath]: { acquireRedisLock: createSerializedLock() },
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    router.configure({
      CPASMAL_BASE_URL: 'https://cpasmal.test',
      TMDB_API_URL: 'https://tmdb.test',
      TMDB_API_KEY: 'test-key',
      getFromCacheNoExpiration: async () => cached,
      shouldUpdateCache: async () => true,
      makeCpasmalRequest: async (requestUrl) => {
        if (requestUrl.endsWith('/index.php')) {
          return {
            data: [
              '<div class="thumb">',
              '<a class="th-img" href="https://cpasmal.test/film-test.html"></a>',
              '<div class="th-desc"><span class="th-capt">Film test</span><span class="th-year">2022</span></div>',
              '<span class="th-Film"></span>',
              '</div>',
            ].join(''),
          };
        }
        return {
          data: '<article><ul><li><span class="info">Date de sortie</span><span class="infos">2022</span></li></ul></article>',
        };
      },
    });

    const app = express();
    app.use('/api/cpasmal', router);
    ({ server, url } = await listen(app));

    const response = await fetch(`${url}/api/cpasmal/movie/42`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).links.vf.length, 1);

    await delay(125);
    assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, 'utf8')), cached);
    assert.equal(memoryWrites.length, 0, 'empty refresh must not replace the memory cache');
  } finally {
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('Cpasmal cannot overwrite a concurrently refreshed playable cache with an older notFound result', async () => {
  const routePath = path.join(ROUTES_DIR, 'cpasmal.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const redisPath = path.join(__dirname, '..', '..', 'config', 'redis.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const redisLockPath = path.join(__dirname, '..', '..', 'utils', 'redisLock.js');
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'movix-cpasmal-race-'));
  const cacheKey = 'movie_42';
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
  const playable = {
    title: 'Film test',
    links: { vf: [{ server: 'voe', url: 'https://fresh.example/embed' }], vostfr: [] },
  };
  let cacheState = { notFound: true, timestamp: 1 };
  let markSearchStarted;
  let releaseSearch;
  let searchRequests = 0;
  const searchStarted = new Promise((resolve) => { markSearchStarted = resolve; });
  const searchGate = new Promise((resolve) => { releaseSearch = resolve; });

  await fs.writeFile(cacheFile, JSON.stringify(cacheState), 'utf8');

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { CPASMAL: cacheDir },
      generateCacheKey: (value) => value,
    },
    [redisPath]: {
      memoryCache: {
        set: async (_key, value) => { cacheState = value; },
      },
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => ({
        title: 'Film test',
        release_date: '2022-01-01',
      }),
    },
    [redisLockPath]: { acquireRedisLock: createSerializedLock() },
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    router.configure({
      CPASMAL_BASE_URL: 'https://cpasmal.test',
      TMDB_API_URL: 'https://tmdb.test',
      TMDB_API_KEY: 'test-key',
      getFromCacheNoExpiration: async () => cacheState,
      shouldUpdateCache: async () => true,
      makeCpasmalRequest: async () => {
        searchRequests += 1;
        if (searchRequests === 1) {
          markSearchStarted();
          await searchGate;
        }
        return { data: '' };
      },
    });

    const app = express();
    app.use('/api/cpasmal', router);
    ({ server, url } = await listen(app));

    const response = await fetch(`${url}/api/cpasmal/movie/42`);
    assert.equal(response.status, 404);
    await response.json();
    await searchStarted;

    cacheState = playable;
    await fs.writeFile(cacheFile, JSON.stringify(playable), 'utf8');
    releaseSearch();
    await delay(150);

    assert.deepEqual(
      JSON.parse(await fs.readFile(cacheFile, 'utf8')),
      playable,
      'the late notFound refresh must preserve the newer playable cache',
    );
  } finally {
    releaseSearch();
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('FStream chooses the exact FROM season before parsing its VF payload', async () => {
  const routePath = path.join(ROUTES_DIR, 'fstream.js');
  const cacheManagerPath = path.join(__dirname, '..', '..', 'utils', 'cacheManager.js');
  const tmdbCachePath = path.join(__dirname, '..', '..', 'utils', 'tmdbCache.js');
  const axiosHelpersPath = path.join(__dirname, '..', '..', 'utils', 'axiosHelpers.js');
  const proxyManagerPath = path.join(__dirname, '..', '..', 'utils', 'proxyManager.js');
  const axiosPath = require.resolve('axios');

  const searchItem = (title, link) => [
    `<div class="search-item" onclick="location.href='${link}'">`,
    `<div class="search-title">${title}</div>`,
    '</div>',
  ].join('');

  const specificSearch = searchItem(
    'From Me to You Kimi ni Todoke - Saison 1',
    '/15113824-from-me-to-you-kimi-ni-todoke-saison-1.html',
  );
  const titleOnlySearch = [
    specificSearch,
    searchItem('FROM - Saison 1', '/15110779-from-saison-1.html'),
  ].join('');

  const axiosStub = async (config) => {
    if (config.url.includes('/static/series/15110779.js')) {
      return {
        status: 200,
        data: {
          vf: { 1: { premium: 'https://fsvid.lol/embed-correct.html' } },
          vostfr: {},
          vo: {},
          info: { 1: { title: 'Voyage au bout du jour' } },
        },
      };
    }
    if (config.url.includes('/static/series/15113824.js')) {
      return {
        status: 200,
        data: {
          vf: {},
          vostfr: { 1: { uqload: 'https://uqload.example/wrong.html' } },
          vo: {},
        },
      };
    }
    throw new Error(`unexpected axios URL: ${config.url}`);
  };

  const axiosFStreamRequest = async (config) => {
    const query = config.data && typeof config.data.get === 'function'
      ? config.data.get('query')
      : null;
    if (query === 'FROM - Saison 1') return { status: 200, data: specificSearch };
    if (query === 'FROM') return { status: 200, data: titleOnlySearch };
    if (query === 'FROM (2022) - Saison 1') return { status: 200, data: '' };
    throw new Error(`unexpected FStream query: ${query}`);
  };

  const wrongCachedResult = {
    success: true,
    source: 'FStream',
    type: 'tv',
    tmdb: { id: 124364, title: 'FROM' },
    search: {
      bestMatch: {
        title: 'From Me to You Kimi ni Todoke - Saison 1',
        originalTitle: 'From Me to You Kimi ni Todoke - Saison 1',
        link: 'https://french-stream.one/15113824-from-me-to-you-kimi-ni-todoke-saison-1.html',
        seasonNumber: 1,
      },
    },
    episodes: {
      1: {
        number: 1,
        languages: { VF: [], VOSTFR: [{ url: 'https://wrong.example/embed' }], VOENG: [], Default: [] },
      },
    },
    total: 1,
  };

  const restore = installModuleStubs({
    [cacheManagerPath]: {
      CACHE_DIR: { FSTREAM: 'fstream-test-cache' },
      generateFStreamCacheKey: () => 'tv_124364_s1',
      getFStreamFromCache: async () => wrongCachedResult,
      saveFStreamToCache: async () => true,
      ongoingFStreamRequests: new Map(),
      getOrCreateFStreamRequest: async (_key, request) => request(),
    },
    [tmdbCachePath]: {
      fetchTmdbDetails: async () => ({
        id: 124364,
        name: 'FROM',
        original_name: 'FROM',
        first_air_date: '2022-02-20',
        overview: 'Test',
      }),
    },
    [axiosHelpersPath]: {
      axiosFStreamRequest,
      configure: () => {},
    },
    [proxyManagerPath]: {
      PROXIES: ['test-proxy'],
      DARKINO_PROXIES: [],
      getProxyAgent: () => null,
      getDarkinoHttpProxyAgent: () => null,
    },
    [axiosPath]: axiosStub,
  });

  delete require.cache[require.resolve(routePath)];
  let server;
  let url;
  try {
    const router = require(routePath);
    const app = express();
    app.use('/api/fstream', router);
    ({ server, url } = await listen(app));

    const response = await fetch(`${url}/api/fstream/tv/124364/season/1`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.search.bestMatch.link, /15110779-from-saison-1/);
    assert.equal(payload.episodes['1'].languages.VF.length, 1);
    assert.equal(payload.episodes['1'].languages.VF[0].player, 'Premium');
  } finally {
    if (server) await close(server);
    delete require.cache[require.resolve(routePath)];
    restore();
  }
});
