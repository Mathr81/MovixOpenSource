// API/Mainapi/utils/__tests__/classifyCloudflare429.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyCloudflare429 } = require('../proxyManager');

// 'worker' => le worker Cloudflare a hit SA limite => roter aide.
test('classifyCloudflare429: page Cloudflare 1015 => worker', () => {
  const cf1015 = '<html><body><h1>You are being rate limited</h1>'
    + '<p>error code: 1015</p></body></html>';
  assert.equal(classifyCloudflare429(cf1015), 'worker');
});

test('classifyCloudflare429: limite journaliere 1027 => worker', () => {
  assert.equal(classifyCloudflare429('error code: 1027 daily request limit'), 'worker');
});

// 'site' => 429 forwarde depuis le site Coflix => NE PAS roter (rate-limit global).
test('classifyCloudflare429: 429 du site coflix (pas de marqueur 1015) => site', () => {
  assert.equal(classifyCloudflare429('Too Many Requests'), 'site');
  assert.equal(classifyCloudflare429('{"error":"rate limited by coflix"}'), 'site');
});

test('classifyCloudflare429: body vide / non-string => site (defaut sur)', () => {
  assert.equal(classifyCloudflare429(''), 'site');
  assert.equal(classifyCloudflare429(undefined), 'site');
  assert.equal(classifyCloudflare429(null), 'site');
  assert.equal(classifyCloudflare429({}), 'site');
});
