const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureTableGroup } = require('../runtimeEnsure');

test('runtime ensure renders only tables from the requested group', async () => {
  const executed = [];
  const pool = { execute: async (sql) => { executed.push(sql); } };
  const tables = [
    { name: 'oauth_clients', group: 'oauth-apps' },
    { name: 'oauth_app_stats', group: 'oauth-apps' },
    { name: 'comments', group: 'community' },
  ];

  await ensureTableGroup(pool, 'oauth-apps', {
    tables,
    renderCreateTable: (table) => `CREATE TABLE IF NOT EXISTS ${table.name}`,
  });

  assert.deepEqual(executed, [
    'CREATE TABLE IF NOT EXISTS oauth_clients',
    'CREATE TABLE IF NOT EXISTS oauth_app_stats',
  ]);
});

test('runtime ensure creates exactly the OAuth manifest tables without injected tables or renderer', async () => {
  const executed = [];
  const pool = { execute: async (sql) => { executed.push(sql); } };

  await ensureTableGroup(pool, 'oauth');

  assert.deepEqual(
    executed.map((sql) => sql.match(/^CREATE TABLE IF NOT EXISTS `([^`]+)`/)[1]),
    [
      'oauth_clients',
      'oauth_app_stats',
      'oauth_vip_grants',
      'oauth_authorization_codes',
      'oauth_authorization_requests',
      'oauth_access_tokens',
    ],
  );
});

test('runtime ensure rejects a pool without execute', async () => {
  await assert.rejects(
    ensureTableGroup(null, 'oauth-apps'),
    /Pool MySQL invalide pour le bootstrap du schéma/,
  );
});
