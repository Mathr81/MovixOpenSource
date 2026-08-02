// API/Mainapi/utils/__tests__/hydrackerLive.test.js
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { _createLimit } = require('../hydrackerLive');

test('createLimit: caps in-flight executions at the configured limit', async () => {
  const limit = _createLimit(2);
  let inFlight = 0;
  let peak = 0;
  const work = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
  };
  await Promise.all(Array.from({ length: 10 }, () => limit(work)));
  assert.equal(peak, 2);
});

test('createLimit: propagates result values and rejections', async () => {
  const limit = _createLimit(1);
  assert.equal(await limit(async () => 42), 42);
  await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
});

const { _withRedisLock } = require('../hydrackerLive');

function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    set: mock.fn(async (key, val, ...args) => {
      const flags = new Set(args);
      if (flags.has('NX') && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
    }),
    del: mock.fn(async (key) => { store.delete(key); return 1; }),
    get: mock.fn(async (key) => store.get(key) ?? null),
    eval: mock.fn(async (_script, _numKeys, key, expected) => {
      if (store.get(key) === expected) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

test('withRedisLock: runs work when lock is acquired and releases it', async () => {
  const redis = makeFakeRedis();
  const result = await _withRedisLock(redis, 'lock:test', 30, async () => 'done', {
    waitMs: 100, pollMs: 10, onWaitCheck: async () => null,
  });
  assert.deepEqual(result, { owned: true, value: 'done' });
  assert.equal(redis.eval.mock.callCount(), 1);
  assert.equal(redis.eval.mock.calls[0].arguments[2], 'lock:test');
});

test('withRedisLock: releases the lock even when work throws', async () => {
  const redis = makeFakeRedis();
  await assert.rejects(
    _withRedisLock(redis, 'lock:err', 30, async () => { throw new Error('fail'); }, {
      waitMs: 100, pollMs: 10, onWaitCheck: async () => null,
    }),
    /fail/,
  );
  assert.equal(redis.eval.mock.callCount(), 1);
  assert.equal(redis.eval.mock.calls[0].arguments[2], 'lock:err');
});

test('withRedisLock: waiter returns cache value produced by holder', async () => {
  const redis = makeFakeRedis();
  redis.store.set('lock:hot', '1'); // holder already in flight
  let calls = 0;
  const result = await _withRedisLock(redis, 'lock:hot', 30, async () => 'unused', {
    waitMs: 200,
    pollMs: 20,
    onWaitCheck: async () => (++calls >= 2 ? { fromCache: true } : null),
  });
  assert.deepEqual(result, { owned: false, value: { fromCache: true } });
  assert.ok(calls >= 2);
});

test('withRedisLock: waiter times out when cache never populates', async () => {
  const redis = makeFakeRedis();
  redis.store.set('lock:cold', '1');
  const result = await _withRedisLock(redis, 'lock:cold', 30, async () => 'unused', {
    waitMs: 80, pollMs: 20, onWaitCheck: async () => null,
  });
  assert.deepEqual(result, { owned: false, value: null, timedOut: true });
});

const { _fetchHydrackerLien } = require('../hydrackerLive');

function makeAxiosStub(handler) {
  return { get: mock.fn(handler) };
}

const fetchDeps = () => ({
  axios: null,
  limit: (fn) => fn(),
  cookies: 'SERVERID=S1',
  xsrf: 'xsrf-token',
  timeoutMs: 20000,
});

test('fetchHydrackerLien: returns the directDL and metadata on success', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async (url, cfg) => {
    assert.equal(url, 'https://hydracker.com/api/v1/content/liens/18780524');
    assert.equal(cfg.timeout, 20000);
    assert.equal(cfg.headers.cookie, 'SERVERID=S1');
    assert.equal(cfg.headers['x-xsrf-token'], 'xsrf-token');
    return { status: 200, data: {
      lien: { id: 18780524, taille: 1658392158, created_at: '2025-12-16T12:56:27.000000Z' },
      directDL: 'https://n3zy9n.debrid.it/dl/4p9xcom427a/F.mkv',
    }};
  });
  const out = await _fetchHydrackerLien(18780524, deps);
  assert.deepEqual(out, {
    ok: true,
    directDL: 'https://n3zy9n.debrid.it/dl/4p9xcom427a/F.mkv',
    rawUrl: null,
    taille: 1658392158,
    created_at: '2025-12-16T12:56:27.000000Z',
  });
});

test('fetchHydrackerLien: returns ok=false with code live_no_directdl when directDL is null', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => ({ status: 200, data: { lien: { id: 1 }, directDL: null }}));
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_no_directdl' });
});

test('fetchHydrackerLien: returns code live_hydracker_error on 5xx', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => { const e = new Error('500'); e.response = { status: 500 }; throw e; });
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_hydracker_error', status: 500 });
});

test('fetchHydrackerLien: returns code live_hydracker_error on 429', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => { const e = new Error('429'); e.response = { status: 429 }; throw e; });
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_hydracker_error', status: 429 });
});

test('fetchHydrackerLien: returns code live_hydracker_error on network failure', async () => {
  const deps = fetchDeps();
  deps.axios = makeAxiosStub(async () => { throw new Error('ECONNRESET'); });
  const out = await _fetchHydrackerLien(1, deps);
  assert.deepEqual(out, { ok: false, code: 'live_hydracker_error', status: 0 });
});

test('fetchHydrackerLien: runs the request through the limit wrapper', async () => {
  const deps = fetchDeps();
  const calls = [];
  deps.limit = (fn) => { calls.push('wrapped'); return fn(); };
  deps.axios = makeAxiosStub(async () => ({ status: 200, data: { directDL: 'https://x/' }}));
  await _fetchHydrackerLien(1, deps);
  assert.deepEqual(calls, ['wrapped']);
});

const { createHydrackerLive } = require('../hydrackerLive');

function setupLive(overrides = {}) {
  const redis = makeFakeRedis();
  const cacheStore = new Map();
  const axios = {
    get: mock.fn(async (url) => {
      if (url.startsWith('https://hydracker.com/')) {
        return { status: 200, data: {
          lien: { id: 42, taille: 1234, created_at: '2025-01-01T00:00:00Z' },
          raw_url: 'https://1fichier.com/?raw42',
          directDL: 'https://1fichier.com/?raw42',
        }};
      }
      throw new Error(`unexpected url ${url}`);
    }),
  };
  const deps = {
    redis,
    axios,
    cookies: 'c',
    xsrf: 'x',
    concurrency: 6,
    timeoutMs: 20000,
    cacheGet: async (_, k) => cacheStore.get(k) ?? null,
    cacheSet: async (_, k, v) => { cacheStore.set(k, v); },
    cacheKeyFor: (id) => `darkiworld_decode_v2_${id}`,
    cacheDir: '/tmp',
    lockPollMs: 5,
    lockWaitMs: 500,
    ...overrides,
  };
  const live = createHydrackerLive(deps);
  return { live, redis, axios, cacheStore };
}

test('resolveLien: returns success payload with raw URL on happy path', async () => {
  const { live, axios } = setupLive();
  const out = await live.resolveLien(42);
  assert.ok(out.payload, 'expected payload');
  assert.equal(out.payload.success, true);
  assert.equal(out.payload.id, '42');
  assert.equal(out.payload.provider, 'hydracker-live');
  assert.equal(out.payload.embed_url.lien, 'https://1fichier.com/?raw42');
  assert.equal(out.payload.embed_url.taille, 1234);
  assert.equal(out.payload.source, 'live');
  assert.equal(axios.get.mock.callCount(), 1);
});

test('resolveLien: returns failed marker live_no_directdl when hydracker has no directDL', async () => {
  const { live } = setupLive({
    axios: { get: mock.fn(async () => ({ status: 200, data: { lien: { id: 42 }, directDL: null }})) },
  });
  const out = await live.resolveLien(42);
  assert.equal(out.payload, undefined);
  assert.equal(out.failed.failed, true);
  assert.equal(out.failed.debug, 'live_no_directdl');
});

test('resolveLien: returns failed marker live_hydracker_error on hydracker 5xx', async () => {
  const { live } = setupLive({
    axios: { get: mock.fn(async () => { const e = new Error('500'); e.response = { status: 500 }; throw e; }) },
  });
  const out = await live.resolveLien(42);
  assert.equal(out.failed.failed, true);
  assert.equal(out.failed.debug, 'live_hydracker_error');
});

test('resolveLien: concurrent calls for the same id fetch hydracker at most once', async () => {
  const { live, axios } = setupLive();
  const [a, b, c] = await Promise.all([live.resolveLien(42), live.resolveLien(42), live.resolveLien(42)]);
  const hydrackerCalls = axios.get.mock.calls.filter((call) =>
    call.arguments[0].startsWith('https://hydracker.com/')
  ).length;
  assert.ok(hydrackerCalls <= 1, `expected <=1 hydracker fetch, got ${hydrackerCalls}`);
  assert.ok(a.payload || a.failed);
  assert.ok(b.payload || b.failed);
  assert.ok(c.payload || c.failed);
});

test('withRedisLock: fenced release only deletes lock when token matches', async () => {
  const redis = makeFakeRedis();
  // Pre-populate the lock with someone else's token to simulate
  // holder-TTL-expired-and-another-worker-acquired scenario.
  redis.store.set('lock:fenced', 'someone-elses-token');
  const result = await _withRedisLock(redis, 'lock:fenced', 30, async () => 'work-done', {
    waitMs: 50, pollMs: 10, onWaitCheck: async () => null,
  });
  // We never acquired — work didn't run, returned timed-out result.
  assert.equal(result.owned, false);
  assert.equal(result.timedOut, true);
  // The other worker's lock is still there — we did NOT del it.
  assert.equal(redis.store.get('lock:fenced'), 'someone-elses-token');
});

test('withRedisLock: returns redisDown when redis.set throws', async () => {
  const brokenRedis = {
    store: new Map(),
    set: async () => { throw new Error('ECONNREFUSED'); },
    del: async () => 0,
    get: async () => null,
    eval: async () => 0,
  };
  let workCalls = 0;
  const result = await _withRedisLock(brokenRedis, 'lock:down', 30, async () => {
    workCalls++;
    return 'should-not-run';
  }, { waitMs: 50, pollMs: 10, onWaitCheck: async () => null });
  assert.deepEqual(result, { owned: false, value: null, redisDown: true });
  assert.equal(workCalls, 0, 'work must not run when Redis is down');
});

test('resolveLien: ignores stale pre-existing sqlite_miss marker in cache and runs hydracker fetch', async () => {
  const { live, axios, cacheStore } = setupLive();
  cacheStore.set('darkiworld_decode_v2_42', {
    failed: true, failedAt: Date.now() - (60 * 1000),
    id: '42', error: 'Lien indisponible', debug: 'sqlite_miss',
  });
  const out = await live.resolveLien(42);
  assert.ok(out.payload, 'expected the live path to run past the stale marker');
  assert.equal(out.payload.embed_url.lien, 'https://1fichier.com/?raw42');
  assert.equal(axios.get.mock.callCount(), 1);
  assert.equal(cacheStore.get('darkiworld_decode_v2_42').success, true);
});

test('resolveLien: second call for the same id reuses cached hydracker response (Redis hydracker:lien cache)', async () => {
  const { live, axios } = setupLive();
  await live.resolveLien(42);
  const hydrackerCallsAfterFirst = axios.get.mock.calls.filter(
    (c) => c.arguments[0].startsWith('https://hydracker.com/'),
  ).length;
  await live.resolveLien(42);
  const hydrackerCallsAfterSecond = axios.get.mock.calls.filter(
    (c) => c.arguments[0].startsWith('https://hydracker.com/'),
  ).length;
  assert.equal(hydrackerCallsAfterFirst, 1);
  assert.equal(hydrackerCallsAfterSecond, 1, 'hydracker must not be hit twice within hydrackerLienCacheTtl');
});

test('resolveLien: returns live_redis_down failure when redis is unreachable', async () => {
  const brokenRedis = {
    store: new Map(),
    set: async () => { throw new Error('ECONNREFUSED'); },
    del: async () => 0,
    get: async () => null,
    eval: async () => 0,
  };
  const axiosThatShouldNotBeCalled = { get: mock.fn(async () => { throw new Error('do not call'); }) };
  const cacheStore = new Map();
  const live = createHydrackerLive({
    redis: brokenRedis,
    axios: axiosThatShouldNotBeCalled,
    cookies: 'c', xsrf: 'x',
    concurrency: 6, timeoutMs: 20000,
    apikey: 'k', agent: 'movix', historyTtl: 60,
    cacheGet: async (_, k) => cacheStore.get(k) ?? null,
    cacheSet: async (_, k, v) => { cacheStore.set(k, v); },
    cacheKeyFor: (id) => `darkiworld_decode_v2_${id}`,
    cacheDir: '/tmp',
  });
  const out = await live.resolveLien(99);
  assert.equal(out.failed.failed, true);
  assert.equal(out.failed.debug, 'live_redis_down');
  assert.equal(axiosThatShouldNotBeCalled.get.mock.callCount(), 0);
});
