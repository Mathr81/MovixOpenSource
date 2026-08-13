const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PROXY_A = { type: 'socks5h', host: 'Proxy.Example', port: 1080, auth: 'user:secret' };
const PROXY_B = { type: 'socks5', host: '198.51.100.22', port: 1081 };

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createRedisDouble() {
  const values = new Map();
  const calls = [];
  return {
    calls,
    values,
    async get(key) { calls.push(['get', key]); return values.get(key) ?? null; },
    async mget(...keys) {
      calls.push(['mget', ...keys]);
      return keys.map((key) => values.get(key) ?? null);
    },
    async set(key, value, ...args) {
      calls.push(['set', key, String(value), ...args]);
      values.set(key, String(value));
      return 'OK';
    },
    async eval(script, keyCount, key, now, interval) {
      calls.push(['eval', script, keyCount, key, now, interval]);
      const requestedAt = Number(now);
      const spacing = Number(interval);
      const current = Number(values.get(key) || 0);
      const slot = Math.max(requestedAt, current);
      values.set(key, String(slot + spacing));
      return slot - requestedAt;
    },
    async del(...keys) {
      calls.push(['del', ...keys]);
      for (const key of keys) values.delete(key);
      return keys.length;
    },
  };
}

function selectionDouble(snapshots = [[PROXY_A]]) {
  let index = 0;
  const calls = { snapshots: [], reserves: [] };
  return {
    calls,
    async getProxyCandidates(options) {
      calls.snapshots.push(options);
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return snapshot;
    },
    async reserveProxy(proxy, options) {
      calls.reserves.push([proxy, options]);
      return true;
    },
  };
}

test('reservations consume one rotated snapshot and atomically space only the selected proxy', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const selection = selectionDouble([[PROXY_A, PROXY_B], [PROXY_B, PROXY_A]]);
  const policy = createKisskhProxyPolicy({
    redis: createRedisDouble(),
    ...selection,
    now: () => 10_000,
  });
  assert.equal(await policy.reserve(), PROXY_A);
  assert.equal(await policy.reserve(), PROXY_B);
  assert.equal(selection.calls.snapshots.length, 2);
  assert.equal(selection.calls.reserves.length, 2);
  assert.ok(selection.calls.reserves.every(([, options]) => options.minIntervalMs === 1000));
});

test('global metadata spacing is process-local and independent for each worker', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  const workerASleeps = [];
  const workerBSleeps = [];
  const workerA = createKisskhProxyPolicy({
    redis,
    ...selectionDouble([[PROXY_A, PROXY_B]]),
    now: () => 10_000,
    async sleep(milliseconds) { workerASleeps.push(milliseconds); },
  });
  const workerB = createKisskhProxyPolicy({
    redis,
    ...selectionDouble([[PROXY_A, PROXY_B]]),
    now: () => 10_000,
    async sleep(milliseconds) { workerBSleeps.push(milliseconds); },
  });

  await Promise.all([workerA.reserveGlobal(), workerA.reserveGlobal(), workerA.reserveGlobal()]);
  await workerB.reserveGlobal();

  assert.deepEqual(workerASleeps, [1, 2]);
  assert.deepEqual(workerBSleeps, []);
  assert.equal(redis.calls.filter(([command]) => command === 'eval').length, 0);
});

test('global metadata reservation never waits for Redis', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  let redisCalls = 0;
  const policy = createKisskhProxyPolicy({
    redis: { async eval() { redisCalls += 1; return new Promise(() => {}); } },
    ...selectionDouble(),
  });

  const outcome = await Promise.race([
    policy.reserveGlobal().then(() => 'settled'),
    delay(50).then(() => 'stalled'),
  ]);

  assert.equal(outcome, 'settled');
  assert.equal(redisCalls, 0);
});

test('transport failures quarantine exponentially and cap at 900 seconds', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  let clock = 1_000;
  const selection = selectionDouble([[PROXY_A, PROXY_B], [PROXY_A, PROXY_B]]);
  const policy = createKisskhProxyPolicy({
    redis,
    ...selection,
    now: () => clock,
    quarantineBaseMs: 30_000,
    quarantineMaxMs: 900_000,
  });

  await policy.recordFailure(PROXY_A, 'timeout');
  clock = 30_999;
  assert.equal(await policy.reserve(), PROXY_B);
  clock = 31_000;
  assert.equal(await policy.reserve(), PROXY_A);

  for (let failure = 0; failure < 10; failure += 1) await policy.recordFailure(PROXY_A, 'transport');
  const quarantineWrite = redis.calls.filter((call) => call[0] === 'set' && call[1].endsWith(':quarantine')).at(-1);
  assert.equal(Number(quarantineWrite[2]) - clock, 900_000);
});

test('success resets failure count and quarantine', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  let clock = 5_000;
  const policy = createKisskhProxyPolicy({
    redis,
    ...selectionDouble(),
    now: () => clock,
    quarantineBaseMs: 30_000,
  });
  await policy.recordFailure(PROXY_A, 'timeout');
  await policy.recordFailure(PROXY_A, 'timeout');
  await policy.recordSuccess(PROXY_A);
  clock = 10_000;
  await policy.recordFailure(PROXY_A, 'transport');
  const quarantineWrite = redis.calls.filter((call) => call[0] === 'set' && call[1].endsWith(':quarantine')).at(-1);
  assert.equal(Number(quarantineWrite[2]) - clock, 30_000);
});

test('429 quarantines only the selected proxy for exactly 60 seconds', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  let clock = 100_000;
  const selection = selectionDouble([[PROXY_A, PROXY_B], [PROXY_A, PROXY_B], [PROXY_A, PROXY_B]]);
  const policy = createKisskhProxyPolicy({
    redis,
    ...selection,
    now: () => clock,
  });
  assert.equal(await policy.record429(PROXY_A, { 'Retry-After': '120' }), 160_000);
  await policy.assertCircuitClosed();
  assert.equal(await policy.reserve(), PROXY_B);
  const quarantineWrite = redis.calls.find((call) => call[0] === 'set' && call[1].endsWith(':quarantine'));
  assert.equal(quarantineWrite[2], '160000');
  assert.deepEqual(quarantineWrite.slice(3), ['PX', 60_000]);

  clock = 159_999;
  assert.equal(await policy.reserve(), PROXY_B);
  clock = 160_000;
  assert.equal(await policy.reserve(), PROXY_A);
});

test('Redis proxy identities are normalized SHA-256 digests and never raw proxy material', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  const policy = createKisskhProxyPolicy({
    redis,
    ...selectionDouble(),
    now: () => 10_000,
  });
  await policy.recordFailure(PROXY_A, 'timeout');
  await policy.recordSuccess(PROXY_A);
  const serialized = JSON.stringify(redis.calls);
  assert.doesNotMatch(serialized, /Proxy\.Example|user|secret|1080/i);
  const proxyKeys = redis.calls.flatMap((call) => call.slice(1))
    .filter((value) => typeof value === 'string' && value.includes('kisskh:metadata:proxy:'));
  assert.ok(proxyKeys.length > 0);
  assert.ok(proxyKeys.every((key) => /:[a-f0-9]{64}(?::|$)/.test(key)));
});

test('reservation batches quarantine state and reaches a healthy candidate after 39 quarantines', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  const proxies = Array.from({ length: 40 }, (_, index) => ({
    type: 'socks5',
    host: `198.51.100.${index + 1}`,
    port: 1080,
  }));
  const selection = selectionDouble([proxies]);
  const policy = createKisskhProxyPolicy({
    redis,
    ...selection,
    now: () => 10_000,
  });
  for (const proxy of proxies.slice(0, -1)) await policy.recordFailure(proxy, 'transport');

  const selected = await policy.reserve();

  assert.equal(selected, proxies.at(-1));
  assert.equal(selection.calls.snapshots.length, 1);
  assert.deepEqual(selection.calls.reserves.map(([proxy]) => proxy), [proxies.at(-1)]);
  const quarantineReads = redis.calls.filter(([command]) => command === 'mget');
  assert.equal(quarantineReads.length, 1);
  assert.equal(quarantineReads[0].length - 1, proxies.length);
});

test('a 1000-entry snapshot with repeats is deduplicated and processed with bounded Redis work', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const redis = createRedisDouble();
  const unique = Array.from({ length: 500 }, (_, index) => ({
    type: 'socks5',
    host: `203.0.${Math.floor(index / 250)}.${(index % 250) + 1}`,
    port: 1080,
  }));
  const selection = selectionDouble([[...unique, ...unique]]);
  const policy = createKisskhProxyPolicy({
    redis,
    ...selection,
    now: () => 20_000,
  });
  for (const proxy of unique.slice(0, -1)) await policy.recordFailure(proxy, 'transport');
  const beforeReserve = redis.calls.length;

  const selected = await policy.reserve();

  assert.equal(selected, unique.at(-1));
  assert.equal(selection.calls.snapshots.length, 1);
  assert.deepEqual(selection.calls.reserves.map(([proxy]) => proxy), [unique.at(-1)]);
  const reserveRedisCalls = redis.calls.slice(beforeReserve);
  const quarantineReads = reserveRedisCalls.filter(([command]) => command === 'mget');
  assert.equal(quarantineReads.length, 1);
  assert.equal(quarantineReads[0].length - 1, unique.length);
});

test('reservation enforces hard candidate and wall-clock bounds', async () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  assert.throws(() => createKisskhProxyPolicy({
    redis: createRedisDouble(),
    ...selectionDouble(),
    maxCandidates: 1001,
  }), TypeError);

  const startedAt = Date.now();
  const policy = createKisskhProxyPolicy({
    redis: createRedisDouble(),
    getProxyCandidates: () => new Promise(() => {}),
    reserveProxy: async () => true,
    reservationDeadlineMs: 20,
  });
  assert.equal(await policy.reserve(), null);
  assert.ok(Date.now() - startedAt < 500);
});

test('direct transport is allowed only when no KissKH proxy source is configured', () => {
  const { createKisskhProxyPolicy } = require('../proxyPolicy');
  const directPolicy = createKisskhProxyPolicy({
    redis: createRedisDouble(),
    ...selectionDouble([[]]),
    isProxyConfigured: () => false,
  });
  const configuredPolicy = createKisskhProxyPolicy({
    redis: createRedisDouble(),
    ...selectionDouble([[]]),
    isProxyConfigured: () => true,
  });

  assert.equal(directPolicy.allowsDirectTransport(), true);
  assert.equal(configuredPolicy.allowsDirectTransport(), false);
});

test('proxyManager exposes a distinct rotated snapshot and atomic KissKH reservation API', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../utils/proxyManager.js'), 'utf8');
  assert.match(source, /function getKisskhProxyCandidates\(options = \{\}\)/);
  assert.match(source, /function reserveKisskhProxy\(proxy, options = \{\}\)/);
  assert.match(source, /function pickNextKisskhProxy\(options = \{\}\)/);
  assert.match(source, /function isKisskhProxyConfigured\(\)/);
  assert.match(source, /const KISSKH_PROXY_CONFIGURATION_PRESENT\s*=/);
  assert.match(source, /PROXYSCRAPE_API_TOKEN\s*\|\|\s*PROXYSCRAPE_ACCOUNT_ID/);
  assert.match(source, /process\.env\.SOCKS5_PROXIES/);
  assert.match(source, /poolName:\s*["']KISSKH_METADATA["']/);
  assert.match(source, /minIntervalMs:\s*1000/);
  assert.match(source, /digestIdentity:\s*true/);
  assert.match(source, /getKisskhProxyCandidates,/);
  assert.match(source, /reserveKisskhProxy,/);
  assert.match(source, /pickNextKisskhProxy,/);
  assert.match(source, /isKisskhProxyConfigured,/);
  const snapshot = source.match(/async function getKisskhProxyCandidates[\s\S]*?\n\}/)?.[0] || '';
  assert.match(snapshot, /reserveProxyWindow/);
  assert.match(snapshot, /new Set\(\)/);
  assert.doesNotMatch(snapshot, /reserveRateLimitedProxy/);
  const reservation = source.match(/function reserveKisskhProxy[\s\S]*?\n\}/)?.[0] || '';
  assert.match(reservation, /reserveRateLimitedProxy/);
});

test('ProxyScrape account refresh requests authenticated online proxy lines', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../utils/proxyManager.js'), 'utf8');
  const accountRequest = source.match(/function buildProxyScrapeCandidates[\s\S]*?\n\}/)?.[0] || '';
  assert.match(accountRequest, /format:\s*["']credentials["']/);
  assert.match(accountRequest, /credential_format:\s*2/);
  assert.match(accountRequest, /status:\s*["']online["']/);
  assert.doesNotMatch(accountRequest, /format:\s*["']normal["']/);
});
